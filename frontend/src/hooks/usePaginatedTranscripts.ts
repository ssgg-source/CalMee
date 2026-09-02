import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { invoke } from '@/lib/data-invoke';
import { subscribeDataChanges } from '@/lib/data-events';
import { RequestGate } from '@/lib/refresh-state';
import type { Transcript, MeetingMetadata, PaginatedTranscriptsResponse } from '@/types';

const PAGE_SIZE = 250;
type Snapshot = { metadata: MeetingMetadata | null; transcripts: Transcript[]; totalCount: number; hasMore: boolean };
const snapshots = new Map<string, Snapshot>();
const empty = (): Snapshot => ({ metadata: null, transcripts: [], totalCount: 0, hasMore: false });

export function usePaginatedTranscripts({ meetingId }: { meetingId: string | null; initialTimestamp?: number }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => snapshots.get(meetingId || '') || empty());
  const [isLoading, setIsLoading] = useState(!snapshot.metadata);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(snapshot);
  const activeId = useRef(meetingId);
  activeId.current = meetingId;
  const gate = useRef(new RequestGate());
  const metadataGate = useRef(new RequestGate());
  const loadingMore = useRef(false);
  const refreshing = useRef(false);
  const publish = useCallback((value: Snapshot) => {
    current.current = value;
    setSnapshot(value);
    if (meetingId) {
      snapshots.delete(meetingId);
      snapshots.set(meetingId, value);
      if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
    }
  }, [meetingId]);

  const refreshMetadata = useCallback(async () => {
    if (!meetingId) return;
    const token = metadataGate.current.next();
    try {
      const metadata = await invoke<MeetingMetadata>('api_get_meeting_metadata', { meetingId });
      if (activeId.current === meetingId && metadataGate.current.current(token)) publish({ ...current.current, metadata });
    } catch { /* Background failure must not erase the last successful snapshot. */ }
  }, [meetingId, publish]);

  const refetch = useCallback(async () => {
    if (!meetingId) return;
    const token = gate.current.next();
    const metaToken = metadataGate.current.next();
    const valid = () => activeId.current === meetingId && gate.current.current(token);
    const size = Math.max(PAGE_SIZE, current.current.transcripts.length);
    refreshing.current = true;
    loadingMore.current = false;
    setIsLoadingMore(false);
    setIsLoading(!current.current.metadata);
    try {
      const [metadata, first] = await Promise.all([
        invoke<MeetingMetadata>('api_get_meeting_metadata', { meetingId }),
        invoke<PaginatedTranscriptsResponse>('api_get_meeting_transcripts', { meetingId, limit: PAGE_SIZE, offset: 0 }),
      ]);
      let response = first;
      const transcripts = [...first.transcripts];
      while (valid() && response.has_more && transcripts.length < size) {
        response = await invoke<PaginatedTranscriptsResponse>('api_get_meeting_transcripts', { meetingId, limit: PAGE_SIZE, offset: transcripts.length });
        if (!response.transcripts.length) break;
        transcripts.push(...response.transcripts);
      }
      if (!valid()) return;
      publish({ metadata: metadataGate.current.current(metaToken) ? metadata : current.current.metadata, transcripts, totalCount: response.total_count, hasMore: response.has_more });
      setError(null);
    } catch {
      if (valid()) setError('Failed to refresh meeting data');
    } finally {
      if (valid()) { setIsLoading(false); refreshing.current = false; }
    }
  }, [meetingId, publish]);

  const loadMore = useCallback(async () => {
    if (!meetingId || loadingMore.current || refreshing.current || !current.current.hasMore) return;
    const token = gate.current.next();
    loadingMore.current = true;
    setIsLoadingMore(true);
    try {
      const response = await invoke<PaginatedTranscriptsResponse>('api_get_meeting_transcripts', { meetingId, limit: PAGE_SIZE, offset: current.current.transcripts.length });
      if (activeId.current !== meetingId || !gate.current.current(token)) return;
      const transcripts = [...new Map([...current.current.transcripts, ...response.transcripts].map(row => [row.id, row])).values()];
      publish({ ...current.current, transcripts, totalCount: response.total_count, hasMore: response.has_more && response.transcripts.length > 0 });
    } catch { if (activeId.current === meetingId && gate.current.current(token)) setError('Failed to load more transcripts'); }
    finally { if (activeId.current === meetingId && gate.current.current(token)) { loadingMore.current = false; setIsLoadingMore(false); } }
  }, [meetingId, publish]);

  const reset = useCallback(() => { gate.current.next(); metadataGate.current.next(); publish(empty()); }, [publish]);
  useEffect(() => {
    publish(snapshots.get(meetingId || '') || empty());
    void refetch();
    return () => { gate.current.next(); metadataGate.current.next(); };
  }, [meetingId, publish, refetch]);
  useEffect(() => subscribeDataChanges([`transcripts:${meetingId}`], () => { void refetch(); }), [meetingId, refetch]);
  useEffect(() => subscribeDataChanges([`meeting:${meetingId}`], () => { void refreshMetadata(); }), [meetingId, refreshMetadata]);
  useEffect(() => subscribeDataChanges([`deleted:${meetingId}`], () => { if (meetingId) snapshots.delete(meetingId); reset(); setIsLoading(false); setError('This meeting has been deleted'); }), [meetingId, reset]);

  const segments = useMemo(() => snapshot.transcripts.map(t => ({ id: t.id, timestamp: t.audio_start_time ?? 0, endTime: t.audio_end_time, text: t.text, confidence: t.confidence })), [snapshot.transcripts]);
  return { ...snapshot, segments, loadedCount: snapshot.transcripts.length, isLoading, isLoadingMore, error, loadMore, reset, refetch, refreshMetadata };
}
