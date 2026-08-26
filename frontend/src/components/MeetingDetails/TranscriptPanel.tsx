"use client";

import { Transcript, TranscriptSegmentData } from '@/types';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MeetingRecordView, MeetingRecordViewRef } from './MeetingRecordView';
import { FileText, ListTree, Pencil } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ProductSelect } from '@/components/ui/ProductControls';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  customPrompt: string;
  onPromptChange: (value: string) => void;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Retranscription props
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
}

type Person = { id: string; name: string };
type SpeakerMeta = { blockId: string; localSpeaker?: string; personId?: string; name: string };
type RefinedSegment = { id:string; originalText:string; optimizedText:string; proposedText:string; safeToApply:boolean; warnings:string[] };
type RefinementResult = { changedCount:number; reviewCount:number; segments:RefinedSegment[]; warnings:string[] };
type RefinementJob = { status:'idle'|'processing'|'completed'|'error'; result?:RefinementResult; error?:string; progress?:{percentage:number;message:string} };

export function TranscriptPanel({
  transcripts,
  customPrompt,
  onPromptChange,
  onCopyTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
}: TranscriptPanelProps) {
  const { t, locale } = useLanguage();
  const [view, setView] = useState<'raw' | 'record'>('raw');
  const [rawVersion,setRawVersion]=useState<'original'|'optimized'>('original');
  const [refinement,setRefinement]=useState<RefinementResult|null>(null);
  const [refinementRunning,setRefinementRunning]=useState(false);
  const [refinementProgress,setRefinementProgress]=useState(0);
  const [optimizedDrafts,setOptimizedDrafts]=useState<Record<string,string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingRaw, setSavingRaw] = useState(false);
  const [recordDirty, setRecordDirty] = useState(false);
  const [savingRecord, setSavingRecord] = useState(false);
  const recordEditorRef = useRef<MeetingRecordViewRef>(null);
  const [speakerByTranscript, setSpeakerByTranscript] = useState<Record<string, SpeakerMeta>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [newPersonName, setNewPersonName] = useState('');
  // Convert transcripts to segments if pagination is not used but we want virtualization
  const convertedSegments = useMemo(() => {
    if (usePagination && segments) {
      return segments;
    }
    // Convert transcripts to segments for virtualization
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
    }));
  }, [transcripts, usePagination, segments]);

  useEffect(() => { setDrafts({});setOptimizedDrafts({});setRawVersion('original');setRefinement(null);if(meetingId)invoke<RefinementResult|null>('api_get_saved_transcript_refinement',{meetingId}).then(setRefinement).catch(()=>{}); }, [meetingId]);
  useEffect(()=>{if(!meetingId||!refinementRunning)return;let active=true;let timer:number|undefined;const poll=async()=>{try{const job=await invoke<RefinementJob>('api_get_transcript_refinement_status',{meetingId});if(!active)return;setRefinementProgress(job.progress?.percentage||0);if(job.status==='processing'){timer=window.setTimeout(()=>void poll(),1200);}else{setRefinementRunning(false);if(job.status==='completed'&&job.result){setRefinement(job.result);setRawVersion('optimized');}if(job.status==='error'){reportTechnicalError('transcript-refinement-job',job.error);toast.error(t('record.aiFailed'),{description:toUserFacingError(job.error,locale).message});}}}catch{timer=window.setTimeout(()=>void poll(),1800);}};void poll();return()=>{active=false;if(timer)window.clearTimeout(timer);};},[meetingId,refinementRunning,t,locale]);
  useEffect(() => {
    if (!meetingId) return;
    let active = true;
    Promise.all([invoke<any>('api_get_or_build_meeting_record', { meetingId }), invoke<Person[]>('api_list_people')]).then(([record, peopleRows]) => {
      if (!active) return;
      const speakers: Record<string, SpeakerMeta> = {};
      for (const block of record?.blocks || []) {
        const name = block.personName || block.localSpeaker || t('summary.speaker');
        for (const id of block.sourceTranscriptIds || []) speakers[id] = { blockId: block.id, localSpeaker: block.localSpeaker, personId: block.personId, name };
      }
      setSpeakerByTranscript(speakers);
      setPeople(peopleRows);
    }).catch(() => setSpeakerByTranscript({}));
    return () => { active = false; };
  }, [meetingId, t]);

  const assignSpeaker = async (transcriptId: string, person: Person) => {
    const meta = speakerByTranscript[transcriptId];
    if (!meta || !meetingId) return;
    try {
      if (meta.localSpeaker) {
        await invoke('api_assign_meeting_speaker', { meetingId, localSpeaker: meta.localSpeaker, personId: person.id, rememberVoice: true });
        setSpeakerByTranscript(current => Object.fromEntries(Object.entries(current).map(([id, item]) => [id, item.localSpeaker === meta.localSpeaker ? { ...item, personId: person.id, name: person.name } : item])));
      } else {
        await invoke('api_assign_meeting_record_block_person', { blockId: meta.blockId, personId: person.id });
        setSpeakerByTranscript(current => Object.fromEntries(Object.entries(current).map(([id, item]) => [id, item.blockId === meta.blockId ? { ...item, personId: person.id, name: person.name } : item])));
      }
      setEditingSpeaker(null);
      toast.success(t('record.personBound'));
    } catch (error) {
      reportTechnicalError('transcript-person-bind', error);
      toast.error(t('record.personBindFailed'), { description: toUserFacingError(error, locale).message });
    }
  };

  const createAndAssignSpeaker = async (transcriptId: string) => {
    const name = newPersonName.trim();
    if (!name) return;
    try {
      const person = await invoke<Person>('api_create_person', { name });
      setPeople(current => [...current, person]);
      setNewPersonName('');
      await assignSpeaker(transcriptId, person);
    } catch (error) {
      reportTechnicalError('transcript-person-create', error);
      toast.error(t('record.personCreateFailed'), { description: toUserFacingError(error, locale).message });
    }
  };

  const saveRawTranscript = async () => {
    const changes = Object.entries(drafts);
    if (!changes.length || savingRaw) return;
    setSavingRaw(true);
    try {
      await Promise.all(changes.map(([transcriptId, text]) => invoke('api_update_transcript_text', { transcriptId, text })));
      setDrafts({});
      await onRefetchTranscripts?.();
      toast.success(t('meeting.transcriptSaved'));
    } catch (error) {
      reportTechnicalError('transcript-save', error);
      toast.error(t('meeting.transcriptSaveFailed'), { description: toUserFacingError(error, locale).message });
      throw error;
    } finally {
      setSavingRaw(false);
    }
  };
  const saveOptimizedTranscript=async()=>{if(!meetingId)return;const changes=Object.entries(optimizedDrafts);if(!changes.length)return;setSavingRaw(true);try{await Promise.all(changes.map(([transcriptId,text])=>invoke('api_update_transcript_refinement_text',{meetingId,transcriptId,text})));setRefinement(current=>current?{...current,segments:current.segments.map(item=>optimizedDrafts[item.id]!==undefined?{...item,optimizedText:optimizedDrafts[item.id],proposedText:optimizedDrafts[item.id],safeToApply:true,warnings:[]}:item)}:current);setOptimizedDrafts({});toast.success(t('meeting.transcriptSaved'));}catch(error){reportTechnicalError('optimized-transcript-save',error);toast.error(t('meeting.transcriptSaveFailed'),{description:toUserFacingError(error,locale).message});}finally{setSavingRaw(false);}};

  const saveActiveDocument = async () => {
    if (view === 'raw') return rawVersion==='optimized'?saveOptimizedTranscript():saveRawTranscript();
    setSavingRecord(true);
    try { await recordEditorRef.current?.save(); }
    finally { setSavingRecord(false); }
  };

  const copyActiveDocument = async () => {
    if (view === 'raw'){if(rawVersion==='original')return onCopyTranscript();const map=new Map(refinement?.segments.map(item=>[item.id,optimizedDrafts[item.id]??item.optimizedText]));await navigator.clipboard.writeText(convertedSegments.map(segment=>map.get(segment.id)??segment.text).join('\n\n'));toast.success(t('meeting.transcriptCopied'));return;}
    await recordEditorRef.current?.copy();
  };

  const clock = (seconds?: number) => {
    const value = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
  };

  return (
    <div style={{ containerType: 'inline-size' }} className="flex h-full min-w-0 shrink-0 flex-col overflow-hidden rounded-3xl border border-violet-100 bg-white shadow-sm">
      {/* Title area */}
      <div className="border-b border-violet-100 p-4">
        <TranscriptButtonGroup
          transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
          onCopyTranscript={() => void copyActiveDocument()}
          onOpenMeetingFolder={onOpenMeetingFolder}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onRefetchTranscripts={onRefetchTranscripts}
          onSaveTranscript={saveActiveDocument}
          transcriptDirty={view === 'raw' ? Object.keys(rawVersion==='optimized'?optimizedDrafts:drafts).length > 0 : recordDirty}
          isSaving={view === 'raw' ? savingRaw : savingRecord}
          onRefinementStarted={() => {setView('raw');setRawVersion('optimized');setRefinementRunning(true);setRefinementProgress(1);}}
        />
        {meetingId && <div className="mt-3 flex items-center gap-2">
          <div className="grid min-w-0 flex-1 grid-cols-2 rounded-xl bg-violet-50 p-1 text-xs">
            <button title={t('meeting.rawTranscript')} aria-label={t('meeting.viewRawTranscript')} onClick={() => setView('raw')} className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 ${view === 'raw' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-violet-600'}`}><FileText className="h-4 w-4" /><span>{t('meeting.rawTranscript')}</span></button>
            <button title={t('meeting.record')} aria-label={t('meeting.viewRecord')} onClick={() => setView('record')} className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 ${view === 'record' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-violet-600'}`}><ListTree className="h-4 w-4" /><span>{t('meeting.record')}</span></button>
          </div>
        </div>}
      </div>

      <div className="flex-1 overflow-hidden pb-4">
        {view === 'record' && meetingId ? <MeetingRecordView ref={recordEditorRef} meetingId={meetingId} onDirtyChange={setRecordDirty} /> :
        <div className="h-full overflow-y-auto px-5 py-4">
          <div className="mx-auto max-w-3xl">
            <div className="sticky top-0 z-10 mb-4 flex items-center justify-between bg-white/95 py-1 backdrop-blur"><div className="flex rounded-lg bg-slate-100 p-1 text-xs"><button onClick={()=>setRawVersion('original')} className={`rounded-md px-3 py-1.5 ${rawVersion==='original'?'bg-white text-violet-700 shadow-sm':'text-slate-500'}`}>{t('meeting.rawTranscript')}</button><button disabled={!refinement&&!refinementRunning} onClick={()=>setRawVersion('optimized')} className={`rounded-md px-3 py-1.5 disabled:opacity-40 ${rawVersion==='optimized'?'bg-white text-violet-700 shadow-sm':'text-slate-500'}`}>{t('meeting.aiOptimizedVersion')}</button></div>{refinementRunning?<span className="text-xs text-violet-600">{refinementProgress}%</span>:refinement&&rawVersion==='optimized'?<span className="text-[11px] text-slate-400">{refinement.changedCount} {t('meeting.changed')} · {refinement.reviewCount} {t('meeting.needsReview')}</span>:null}</div>
            {convertedSegments.map(segment => {const optimized=refinement?.segments.find(item=>item.id===segment.id);const shownText=rawVersion==='optimized'?(optimizedDrafts[segment.id]??optimized?.optimizedText??segment.text):(drafts[segment.id]??segment.text);return <section key={segment.id} className="mb-7">
              <div className="mb-2 flex items-center gap-2 text-sm">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-sky-300 text-[10px] font-semibold text-sky-500">{(speakerByTranscript[segment.id]?.name || t('summary.speaker')).slice(0, 2)}</span>
                <span className="min-w-0 truncate font-semibold text-sky-500">{speakerByTranscript[segment.id]?.name || t('summary.speaker')}</span>
                <button onClick={()=>{setEditingSpeaker(current=>current===segment.id?null:segment.id);setNewPersonName('');}} className="shrink-0 rounded p-1 text-slate-400 hover:bg-violet-50 hover:text-violet-600" title={t('record.editSpeaker')} aria-label={t('record.editSpeaker')}><Pencil className="h-3.5 w-3.5" /></button>
                <span className="shrink-0 font-medium text-violet-500">{clock(segment.timestamp)}</span>
                {segment.confidence !== undefined && <span className="ml-auto text-[10px] text-slate-300">{Math.round(segment.confidence * 100)}%</span>}
              </div>
              {editingSpeaker===segment.id&&<div className="mb-2 ml-10 flex flex-wrap items-center gap-2 rounded-lg border border-violet-100 bg-violet-50/50 p-2">
                <ProductSelect value={speakerByTranscript[segment.id]?.personId||''} onChange={event=>{const person=people.find(item=>item.id===event.target.value);if(person)void assignSpeaker(segment.id,person);}} className="min-w-36 flex-1"><option value="">{t('record.selectExistingPerson')}</option>{people.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</ProductSelect>
                <input value={newPersonName} onChange={event=>setNewPersonName(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void createAndAssignSpeaker(segment.id);}} placeholder={t('record.personPlaceholder')} className="min-w-32 flex-1 rounded-md border border-violet-100 bg-white px-2 py-1.5 text-xs"/>
                <button disabled={!newPersonName.trim()} onClick={()=>void createAndAssignSpeaker(segment.id)} className="rounded-md bg-violet-600 px-2.5 py-1.5 text-xs text-white disabled:opacity-40">{t('record.createAndLink')}</button>
              </div>}
              {rawVersion==='optimized'&&optimized&&!optimized.safeToApply&&<div className="mb-1 ml-10 text-[11px] text-amber-600" title={optimized.warnings.join('\n')}>{t('meeting.originalPreservedNeedsReview')}</div>}
              <textarea
                value={shownText}
                onChange={event => {
                  const value = event.target.value;
                  const setter=rawVersion==='optimized'?setOptimizedDrafts:setDrafts;const base=rawVersion==='optimized'?(optimized?.optimizedText??segment.text):segment.text;setter(current => {
                    const next = { ...current };
                    if (value === base) delete next[segment.id]; else next[segment.id] = value;
                    return next;
                  });
                }}
                className="min-h-[88px] w-full resize-y [field-sizing:content] rounded-lg border-0 bg-transparent px-10 py-1 text-base leading-8 text-violet-600 outline-none transition focus:bg-violet-50/40 focus:ring-1 focus:ring-violet-100"
              />
            </section>})}
            <div className="pb-1 text-right text-[11px] text-slate-400">{convertedSegments.reduce((sum,segment)=>sum+(rawVersion==='optimized'?(optimizedDrafts[segment.id]??refinement?.segments.find(item=>item.id===segment.id)?.optimizedText??segment.text):drafts[segment.id]??segment.text).length,0)} {t('meeting.characters')}</div>
          </div>
          {(hasMore || isLoadingMore) && <div className="py-4 text-center"><button onClick={onLoadMore} disabled={isLoadingMore} className="rounded-lg border border-slate-200 px-4 py-2 text-xs text-slate-600 disabled:opacity-50">{isLoadingMore ? t('common.loading') : t('meeting.loadMoreTranscript',{loaded:loadedCount||convertedSegments.length,total:totalCount||convertedSegments.length})}</button></div>}
        </div>
        }
      </div>

    </div>
  );
}
