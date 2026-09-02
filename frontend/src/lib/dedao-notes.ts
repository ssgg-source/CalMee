export type DedaoNote = {
  noteId: string;
  title: string;
  contentPreview: string;
  createdAt?: string;
  imported: boolean;
  hasAudio: boolean;
};

export type DedaoPage = { notes: DedaoNote[]; cursor?: string; hasMore: boolean };
export type DedaoImportResult = { imported: number; skipped: number; failed: number; processedNoteIds: string[] };

// Refresh the shared list even if the import view was closed, all rows already
// existed, or the command failed after committing part of a batch.
export async function runDedaoImport(
  importNotes: () => Promise<DedaoImportResult>,
  refreshMeetings: () => Promise<void>,
): Promise<DedaoImportResult> {
  try {
    return await importNotes();
  } finally {
    await refreshMeetings();
  }
}

export type DedaoFilters = {
  query: string;
  from: string;
  to: string;
  status: 'all' | 'pending' | 'imported';
  recordingOnly: boolean;
};

export function mergeDedaoNotes(current: DedaoNote[], incoming: DedaoNote[]): DedaoNote[] {
  return [...new Map([...current, ...incoming].map(note => [note.noteId, note])).values()];
}

export function filterDedaoNotes(notes: DedaoNote[], filters: DedaoFilters): DedaoNote[] {
  if (filters.from && filters.to && filters.from > filters.to) return [];
  const start = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : -Infinity;
  const end = filters.to ? new Date(`${filters.to}T00:00:00`) : null;
  // The end date includes its entire local day, including DST transitions.
  if (end) end.setDate(end.getDate() + 1);
  const query = filters.query.trim().toLocaleLowerCase();
  return notes.filter(note => {
    if (filters.recordingOnly && !note.hasAudio) return false;
    if (filters.status === 'pending' && note.imported) return false;
    if (filters.status === 'imported' && !note.imported) return false;
    if (query && !`${note.title}\n${note.contentPreview}`.toLocaleLowerCase().includes(query)) return false;
    if (filters.from || filters.to) {
      const timestamp = note.createdAt ? new Date(note.createdAt).getTime() : NaN;
      if (!Number.isFinite(timestamp) || timestamp < start || (end && timestamp >= end.getTime())) return false;
    }
    return true;
  });
}

export function toggleDedaoSelection(selected: Set<string>, visible: DedaoNote[]): Set<string> {
  const result = new Set(selected);
  const remove = visible.length > 0 && visible.every(note => result.has(note.noteId));
  visible.forEach(note => remove ? result.delete(note.noteId) : result.add(note.noteId));
  return result;
}

export function nextDedaoCursor(page: DedaoPage, seen: Set<string>): string | null {
  if (!page.hasMore) return null;
  const cursor = page.cursor?.trim();
  if (!cursor || seen.has(cursor)) throw new Error('Dedao pagination cursor did not advance');
  return cursor;
}

export async function readDedaoPages(options: {
  cursor: string | null;
  all: boolean;
  seen: Set<string>;
  fetchPage: (cursor: string | null) => Promise<DedaoPage>;
  onPage: (page: DedaoPage, nextCursor: string | null) => void;
  stopped: () => boolean;
}) {
  let cursor = options.cursor;
  for (let count = 0; count < 1000; count++) {
    if (options.stopped()) return;
    const page = await options.fetchPage(cursor);
    if (options.stopped()) return;
    if (cursor !== null) options.seen.add(cursor);
    const next = nextDedaoCursor(page, options.seen);
    options.onPage(page, next);
    if (!options.all || next === null) return;
    cursor = next;
  }
  throw new Error('Dedao pagination safety limit reached');
}
