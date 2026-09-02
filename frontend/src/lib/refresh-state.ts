/** Pure state primitives shared by queries and editors; no user content is logged. */
export class RequestGate {
  private generation = 0;
  next() { return ++this.generation; }
  current(token: number) { return token === this.generation; }
}

export class StaleResultError extends Error {}

export function createResourceCache<T>() {
  let generation = 0;
  const values = new Map<string, T>();
  const pending = new Map<string, Promise<T>>();
  return {
    peek: (key: string) => values.get(key),
    invalidate() { generation++; values.clear(); pending.clear(); },
    async read(key: string, fetch: () => Promise<T>): Promise<T> {
      if (values.has(key)) return values.get(key)!;
      if (pending.has(key)) return pending.get(key)!;
      const token = generation;
      const request = fetch().then(value => {
        if (token !== generation) throw new StaleResultError('Superseded resource read');
        values.set(key, value);
        if (values.size > 24) values.delete(values.keys().next().value!);
        return value;
      }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
      pending.set(key, request);
      return request;
    },
  };
}

const writes = new Map<string, Promise<unknown>>();
const writeRevisions = new Map<string, number>();
export const resourceWriteRevision = (key: string) => writeRevisions.get(key) || 0;
export function queueResourceWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
  writeRevisions.set(key, resourceWriteRevision(key) + 1);
  const next = (writes.get(key) || Promise.resolve()).catch(() => undefined).then(write);
  writes.set(key, next);
  void next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => undefined);
  return next;
}
export async function waitForResourceWrites(key: string) {
  while (writes.has(key)) await writes.get(key)!.catch(() => undefined);
}

export function mutationResources(command: string, args: Record<string, unknown> = {}): string[] {
  const id = typeof args.meetingId === 'string' ? args.meetingId : '*';
  if (command === 'api_delete_meeting') return ['meetings', `deleted:${id}`, 'calendar', 'people', 'hotwords'];
  if (command === 'api_link_meeting_calendar_event') return ['meetings', 'meeting:*', 'calendar'];
  if (/^api_(assign_meeting_speaker|assign_meeting_record_block_person|set_transcript_speaker_overrides?)$/.test(command))
    return [`speakers:${id}`, 'people', 'hotwords'];
  if (/^api_(save_meeting_title|update_meeting_schedule|link_meeting_calendar_event)$/.test(command))
    return ['meetings', `meeting:${id}`, 'calendar'];
  if (command === 'api_save_meeting_notes' || command === 'api_create_notes_only_meeting') return ['meetings', `notes:${id}`];
  if (/^api_(save_meeting_document|save_meeting_summary|restore_meeting_document)$/.test(command))
    return ['meetings', `documents:${id}`];
  if (command === 'api_batch_correct_meeting_documents') return [`transcripts:${id}`, `documents:${id}`, 'hotwords'];
  if (/^api_(create_person|delete_person|update_person_profile|set_person_auto_identify)$/.test(command))
    return ['people', 'hotwords', 'speakers:*'];
  if (/^api_(upsert_hotword|import_hotwords|set_hotwords_enabled|set_hotwords_tags|delete_hotwords|apply_legacy_hotword_disposition)$/.test(command))
    return ['hotwords'];
  if (/^api_(save_custom_model_profile|delete_custom_model_profile)$/.test(command)) return ['models'];
  if (/^api_(sync_calendars|save_calendar_event|delete_calendar_event|set_calendar_enabled|save_calendar_settings)$/.test(command))
    return ['calendar', 'meetings', 'meeting:*'];
  if (/^api_(import_dedao_notes|import_legacy_calmee_data|import_external_meeting_record|delete_meeting)$/.test(command))
    return ['meetings', 'meeting:*', 'calendar', 'people', 'hotwords', 'documents:*'];
  return [];
}

export function resourcesOverlap(a: string, b: string) {
  return a === b || (a.endsWith(':*') && b.startsWith(a.slice(0, -1))) || (b.endsWith(':*') && a.startsWith(b.slice(0, -1)));
}
