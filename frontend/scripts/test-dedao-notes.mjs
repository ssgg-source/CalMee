import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterDedaoNotes, mergeDedaoNotes, nextDedaoCursor, readDedaoPages, runDedaoImport, toggleDedaoSelection } from '../src/lib/dedao-notes.ts';

const note = (id, overrides = {}) => ({ noteId: id, title: `Note ${id}`, contentPreview: 'Meeting preview', imported: false, hasAudio: true, ...overrides });
const filters = { query: '', from: '', to: '', status: 'all', recordingOnly: false };

test('import refreshes the shared home list before reporting completion', async () => {
  const database = [];
  let homeList = [];
  const result = { imported: 1, skipped: 0, failed: 0, processedNoteIds: ['a'] };
  assert.equal(await runDedaoImport(async () => {
    database.push(note('a', { imported: true }));
    return result;
  }, async () => { homeList = [...database]; }), result);
  assert.equal(homeList.length, 1);
});

test('skipped and partially failed imports also refresh existing meetings', async () => {
  for (const result of [
    { imported: 0, skipped: 1, failed: 0, processedNoteIds: ['a'] },
    { imported: 1, skipped: 0, failed: 1, processedNoteIds: ['a'] },
  ]) {
    let refreshes = 0;
    assert.equal(await runDedaoImport(async () => result, async () => { refreshes++; }), result);
    assert.equal(refreshes, 1);
  }
});

test('leaving the import view does not suppress the shared list refresh', async () => {
  let finishImport;
  let viewMounted = true;
  let refreshes = 0;
  let viewUpdates = 0;
  const operation = (async () => {
    await runDedaoImport(() => new Promise(resolve => { finishImport = resolve; }), async () => { refreshes++; });
    if (viewMounted) viewUpdates++;
  })();
  viewMounted = false;
  finishImport({ imported: 1, skipped: 0, failed: 0, processedNoteIds: ['a'] });
  await operation;
  assert.equal(refreshes, 1);
  assert.equal(viewUpdates, 0);
});

test('a command failure after partial writes still refreshes and preserves the error', async () => {
  const failure = new Error('batch interrupted');
  let refreshes = 0;
  await assert.rejects(runDedaoImport(async () => { throw failure; }, async () => { refreshes++; }), error => error === failure);
  assert.equal(refreshes, 1);
});

test('merging pages deduplicates IDs without losing earlier pages', () => {
  const merged = mergeDedaoNotes([note('a'), note('b')], [note('b', { imported: true }), note('c')]);
  assert.deepEqual(merged.map(n => n.noteId), ['a', 'b', 'c']);
  assert.equal(merged[1].imported, true);
});

test('date range includes the entire local end day and excludes unknown dates', () => {
  const rows = [note('before', { createdAt: '2026-09-01T23:59:59' }), note('start', { createdAt: '2026-09-02T00:00:00' }), note('end', { createdAt: '2026-09-02T23:59:59.999' }), note('after', { createdAt: '2026-09-03T00:00:00' }), note('unknown')];
  assert.deepEqual(filterDedaoNotes(rows, { ...filters, from: '2026-09-02', to: '2026-09-02' }).map(n => n.noteId), ['start', 'end']);
  assert.equal(filterDedaoNotes(rows, filters).length, 5);
  assert.deepEqual(filterDedaoNotes(rows, { ...filters, from: '2026-09-03', to: '2026-09-02' }), []);
});

test('search, recording and import filters combine', () => {
  const rows = [note('a'), note('b', { imported: true }), note('c', { hasAudio: false })];
  assert.deepEqual(filterDedaoNotes(rows, { ...filters, query: 'MEETING', status: 'pending', recordingOnly: true }).map(n => n.noteId), ['a']);
});

test('select all only toggles visible rows, preserving hidden selection', () => {
  const selected = toggleDedaoSelection(new Set(['hidden', 'a']), [note('a'), note('b')]);
  assert.deepEqual([...selected], ['hidden', 'a', 'b']);
  assert.deepEqual([...toggleDedaoSelection(selected, [note('a'), note('b')])], ['hidden']);
});

test('load all follows opaque cursors beyond the first 20 notes', async () => {
  const seen = new Set();
  const requests = [];
  let rows = [];
  let lastCursor;
  await readDedaoPages({ cursor: null, all: true, seen, stopped: () => false,
    fetchPage: async cursor => {
      requests.push(cursor);
      const offset = cursor === null ? 0 : cursor === 'page-b' ? 20 : 40;
      return { notes: Array.from({ length: 20 }, (_, i) => note(String(offset + i))), cursor: offset === 0 ? 'page-b' : 'page-c', hasMore: offset < 40 };
    },
    onPage: (page, cursor) => { rows = mergeDedaoNotes(rows, page.notes); lastCursor = cursor; },
  });
  assert.deepEqual(requests, [null, 'page-b', 'page-c']);
  assert.equal(rows.length, 60);
  assert.equal(lastCursor, null);
});

test('load more fetches one page; invalid and repeated cursors are rejected', async () => {
  let calls = 0;
  await readDedaoPages({ cursor: 'page-b', all: false, seen: new Set(), stopped: () => false,
    fetchPage: async () => { calls++; return { notes: [], cursor: 'page-c', hasMore: true }; }, onPage: () => {},
  });
  assert.equal(calls, 1);
  assert.throws(() => nextDedaoCursor({ notes: [], hasMore: true }, new Set()));
  assert.throws(() => nextDedaoCursor({ notes: [], cursor: 'repeat', hasMore: true }, new Set(['repeat'])));
});

test('a later network failure retains pages and cursor for retry', async () => {
  let rows = [];
  let nextCursor = null;
  await assert.rejects(readDedaoPages({ cursor: null, all: true, seen: new Set(), stopped: () => false,
    fetchPage: async cursor => { if (cursor !== null) throw new Error('offline'); return { notes: [note('a')], cursor: 'retry-here', hasMore: true }; },
    onPage: (page, cursor) => { rows = mergeDedaoNotes(rows, page.notes); nextCursor = cursor; },
  }));
  assert.equal(rows.length, 1);
  assert.equal(nextCursor, 'retry-here');
});

test('stop prevents further pages and ignores a response after cancellation', async () => {
  let stopped = false;
  let received = 0;
  await readDedaoPages({ cursor: null, all: true, seen: new Set(), stopped: () => stopped,
    fetchPage: async () => { stopped = true; return { notes: [note('a')], cursor: 'next', hasMore: true }; },
    onPage: () => { received++; },
  });
  assert.equal(received, 0);
});
