import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = fileURLToPath(new URL('../src/', import.meta.url));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function loader(mocks = {}, globals = {}) {
  const cache = new Map();
  const load = file => {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = {exports:{}}; cache.set(file,module);
    const source = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
    const localRequire = name => {
      if (name in mocks) return mocks[name];
      if (name.startsWith('.') || name.startsWith('@/')) return load((name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(file),name))+'.ts');
      return require(name);
    };
    vm.runInNewContext(source,{module,exports:module.exports,require:localRequire,console,setTimeout,clearTimeout,ArrayBuffer,Uint8Array,...globals},{filename:file});
    return module.exports;
  };
  return load;
}
const core = loader()(path.join(root,'lib/refresh-state.ts'));
const sessions = loader()(path.join(root,'lib/document-session.ts'));

function recordingCalendarFixture(invoke=async()=>({})) {
  const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};};
  const localStorage=storage(),sessionStorage=storage();let sessionId='fixture-session',token=0;
  const api=loader({'./data-invoke':{invoke},'./live-meeting-notes':{readLiveMeetingNotes:()=>({sessionId})}},
    {window:{},localStorage,sessionStorage,crypto:{randomUUID:()=>String(++token)}})(path.join(root,'lib/recording-calendar.ts'));
  return {api,localStorage,sessionStorage,newSession:()=>{sessionId='next-session';}};
}
test('recording calendar selection cannot leak into a new notes session',()=>{
  const fixture=recordingCalendarFixture();
  fixture.api.selectRecordingCalendar({id:'fixture-event',title:'Fixture'});
  assert.equal(fixture.api.readRecordingCalendarSelection().id,'fixture-event');
  fixture.newSession(); assert.equal(fixture.api.readRecordingCalendarSelection(),null);
});
test('failed final association retains a retry intent without failing saved content',async()=>{
  const fixture=recordingCalendarFixture(async()=>{throw Error('fixture conflict');});
  fixture.api.selectRecordingCalendar({id:'fixture-event',title:'Fixture'});
  await assert.rejects(fixture.api.attachRecordingCalendar('fixture-meeting',fixture.api.readRecordingCalendarSelection()));
  assert.equal(fixture.localStorage.getItem(fixture.api.calendarRetryKey('fixture-meeting')),'fixture-event');
  assert.equal(fixture.api.readRecordingCalendarSelection(),null);
});
test('finishing an older association cannot clear a newer selection of the same event',async()=>{
  const pending=deferred();const fixture=recordingCalendarFixture(()=>pending.promise);
  fixture.api.selectRecordingCalendar({id:'fixture-event',title:'Fixture'});
  const old=fixture.api.readRecordingCalendarSelection();const work=fixture.api.attachRecordingCalendar('fixture-meeting',old);
  fixture.newSession();fixture.api.selectRecordingCalendar({id:'fixture-event',title:'Fixture'});
  pending.resolve({});await work;
  assert.notEqual(fixture.api.readRecordingCalendarSelection().selectionToken,old.selectionToken);
});

test('request gate rejects old meeting and old refresh generations', () => {
  const gate = new core.RequestGate(); const a=gate.next(), b=gate.next();
  assert.equal(gate.current(a),false); assert.equal(gate.current(b),true);
});
test('invalidated cache cannot be repopulated by an old in-flight request', async () => {
  const cache=core.createResourceCache(), slow=deferred();
  const old=cache.read('calendar',()=>slow.promise);
  cache.invalidate();
  assert.equal(await cache.read('calendar',async()=> 'new'),'new');
  slow.resolve('old'); await assert.rejects(old);
  assert.equal(cache.peek('calendar'),'new');
});
test('same-key reads deduplicate without cross-resource collisions', async()=>{
  const cache=core.createResourceCache(); let reads=0;
  await Promise.all([cache.read('a',async()=>++reads),cache.read('a',async()=>++reads)]);
  assert.equal(reads,1); assert.equal(await cache.read('b',async()=>2),2);
});
test('document writes survive instance changes and reads wait for the latest queued save', async()=>{
  const wait=deferred(); let stored='old';
  const first=sessions.saveDocumentInOrder('meeting:notes','one',async()=>{await wait.promise;stored='one';});
  const second=sessions.saveDocumentInOrder('meeting:notes','two',async()=>{stored='two';});
  const read=sessions.readAfterDocumentWrites('meeting:notes',async()=>stored);
  wait.resolve(); await Promise.all([first,second]); assert.equal(await read,'two');
});
test('acknowledging an older save cannot clear newer typing; failed writes retain drafts', async()=>{
  sessions.rememberDocumentDraft('draft','new typing');
  sessions.acknowledgeDocumentDraft('draft','old typing');
  assert.equal(sessions.readDocumentDraft('draft').markdown,'new typing');
  await assert.rejects(sessions.saveDocumentInOrder('draft','new typing',async()=>{throw new Error('disk full');}));
  assert.equal(sessions.readDocumentDraft('draft').markdown,'new typing');
  await sessions.saveDocumentInOrder('draft','new typing',async()=>{});
  assert.equal(sessions.readDocumentDraft('draft'),undefined);
});
test('a save started during an in-flight document read invalidates that response', async()=>{
  const pending=deferred(), entered=deferred(); let stored='before', calls=0;
  const read=sessions.readAfterDocumentWrites('late-read',async()=>{
    const snapshot=stored;
    if(++calls===1){entered.resolve();await pending.promise;}
    return snapshot;
  });
  await entered.promise;
  await sessions.saveDocumentInOrder('late-read','after',async()=>{stored='after';});
  pending.resolve();
  assert.equal(await read,'after'); assert.equal(calls,2);
});
test('mutation dependency matrix includes imports, metadata, identity, notes and calendar',()=>{
  const resources=(cmd)=>Array.from(core.mutationResources(cmd,{meetingId:'fixture'}));
  assert.ok(resources('api_import_legacy_calmee_data').includes('meetings'));
  assert.ok(resources('api_link_meeting_calendar_event').includes('calendar'));
  assert.ok(resources('api_save_meeting_notes').includes('notes:fixture'));
  assert.ok(resources('api_assign_meeting_speaker').includes('speakers:fixture'));
  assert.ok(!resources('api_assign_meeting_speaker').includes('transcripts:fixture'));
  assert.equal(resources('api_get_meeting_metadata').length,0);
  assert.ok(core.resourcesOverlap('speakers:*','speakers:fixture'));
  assert.ok(!core.resourcesOverlap('speakers:a','speakers:b'));
});
test('failed deletion cannot broadcast a tombstone; batch failure still reconciles lists',async()=>{
  const changes=[];
  const load=loader({'@tauri-apps/api/core':{invoke:async()=>{throw new Error('fixture failure');}},'./data-events':{publishDataChanges:keys=>changes.push(Array.from(keys))}});
  const api=load(path.join(root,'lib/data-invoke.ts'));
  await assert.rejects(api.invoke('api_delete_meeting',{meetingId:'a'}));
  assert.ok(!changes.flat().some(key=>key.startsWith('deleted:')));
  assert.ok(changes.flat().includes('meetings'));
});

// Exercise the actual calendar cache implementation with controlled local reads.
test('calendar force refresh and external revisions reject late old ranges',async()=>{
  let revision=0, value='old'; const slow=deferred(); let first=true;
  const source=fs.readFileSync(path.join(root,'app/calendar/page.tsx'),'utf8');
  const section=source.slice(source.indexOf('type ViewMode='),source.indexOf('const localDayKey='));
  const js=ts.transpileModule(section,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const get=new Function('invoke','dataRevision','StaleResultError',`${js};return fetchCalendarRange;`)(async cmd=>{
    if(cmd==='api_get_calendar_collections'&&first){first=false;await slow.promise;return ['old'];}return [value];
  },()=>revision,core.StaleResultError);
  const start=new Date('2026-01-01'),end=new Date('2026-02-01');
  const old=get(start,end); value='new'; revision++;
  const fresh=await get(start,end,true); slow.resolve(); await assert.rejects(old);
  assert.equal(fresh.events[0],'new'); assert.equal((await get(start,end)).events[0],'new');
});

function hookHarness(invoke) {
  const cells=[];let index=0,effects=[];
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>v===b[i]);
  const react={
    useRef:value=>{const i=index++;return cells[i]??=( {current:value} );},
    useState:value=>{const i=index++;if(!(i in cells))cells[i]=typeof value==='function'?value():value;return [cells[i],next=>{cells[i]=typeof next==='function'?next(cells[i]):next;}];},
    useMemo:(fn,deps)=>{const i=index++;if(!cells[i]||!equal(cells[i].deps,deps))cells[i]={deps,value:fn()};return cells[i].value;},
    useEffect:(fn,deps)=>{const i=index++;if(!cells[i]||!equal(cells[i].deps,deps)){const previous=cells[i];cells[i]={deps};effects.push(()=>{previous?.off?.();cells[i].off=fn();});}},
  };
  react.useCallback=(fn,deps)=>react.useMemo(()=>fn,deps);
  const load=loader({react,'@/lib/data-invoke':{invoke},'@/lib/data-events':{subscribeDataChanges:()=>()=>{}}});
  const hook=load(path.join(root,'hooks/usePaginatedTranscripts.ts')).usePaginatedTranscripts;
  return {render(id){index=0;const result=hook({meetingId:id});const run=effects;effects=[];run.forEach(fn=>fn());return result;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const page=id=>({transcripts:[{id,text:id,audio_start_time:1}],total_count:1,has_more:false});
test('meeting hook ignores late results after switching from A to B',async()=>{
  const slow=deferred();
  const h=hookHarness(async(cmd,{meetingId})=>{if(meetingId==='A')await slow.promise;return cmd==='api_get_meeting_metadata'?{id:meetingId,title:meetingId}:page(meetingId);});
  h.render('A');h.render('B');await tick();slow.resolve();await tick();
  const state=h.render('B');assert.equal(state.metadata.id,'B');assert.equal(state.transcripts[0].id,'B');
});
test('background refetch retains metadata and rows instead of switching to initial loading',async()=>{
  let wait=null;
  const h=hookHarness(async(cmd,{meetingId})=>{if(wait)await wait.promise;return cmd==='api_get_meeting_metadata'?{id:meetingId,title:meetingId}:page(meetingId);});
  h.render('A');await tick();let state=h.render('A');
  wait=deferred();const refreshed=state.refetch();state=h.render('A');
  assert.equal(state.isLoading,false);assert.equal(state.transcripts.length,1);assert.equal(state.metadata.id,'A');
  wait.resolve();await refreshed;assert.equal(h.render('A').isLoading,false);
});

test('live note revision checks prevent a stale window from overwriting newer notes',()=>{
  const storage=new Map();let identity=0;
  const notes=loader({'@/lib/data-invoke':{invoke:async()=>{}}},{window:{localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},dispatchEvent:()=>{}},CustomEvent:class{},crypto:{randomUUID:()=>String(++identity)}})(path.join(root,'lib/live-meeting-notes.ts'));
  notes.writeLiveMeetingNotes('initial'); const old=notes.readLiveMeetingNotes();
  notes.writeLiveMeetingNotes('newer');
  assert.equal(notes.writeLiveMeetingNotes('stale',old),false);
  assert.equal(notes.readLiveMeetingNotes().markdown,'newer');
  notes.clearLiveMeetingNotes(old);
  assert.equal(notes.readLiveMeetingNotes().markdown,'newer');
  const latest=notes.readLiveMeetingNotes();notes.clearLiveMeetingNotes(latest);
  assert.equal(notes.readLiveMeetingNotes().markdown,'');
  assert.notEqual(notes.readLiveMeetingNotes().sessionId,latest.sessionId);
});
test('paragraph anchors preserve viewport offsets after preceding groups change height',()=>{
  const view=loader()(path.join(root,'lib/view-state.ts'));
  const container={scrollTop:800,getBoundingClientRect:()=>({top:100})};
  let top=120;
  const paragraph={getBoundingClientRect:()=>({top,bottom:top+200})};
  const position=view.captureReadingPosition(container,[['utterance-42',paragraph]]);
  top=260;view.restoreReadingPosition(container,position,paragraph);
  assert.equal(container.scrollTop,940);
});
test('refresh of a fully loaded long transcript keeps all loaded rows',async()=>{
  const rows=Array.from({length:600},(_,i)=>({id:`row-${i}`,text:'fixture',audio_start_time:i}));
  const h=hookHarness(async(cmd,{meetingId,offset=0,limit=250})=>cmd==='api_get_meeting_metadata'?{id:meetingId,title:'fixture'}:{transcripts:rows.slice(offset,offset+limit),total_count:rows.length,has_more:offset+limit<rows.length});
  h.render('long');await tick();let state=h.render('long');
  await state.loadMore();state=h.render('long');await state.loadMore();state=h.render('long');
  assert.equal(state.transcripts.length,600);
  await state.refetch();state=h.render('long');assert.equal(state.transcripts.length,600);assert.equal(state.hasMore,false);
});
