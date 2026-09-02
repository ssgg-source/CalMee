import { emit, listen } from '@tauri-apps/api/event';
import { resourcesOverlap } from './refresh-state';

type Change = { origin: string; sequence: number; resources: string[] };
const origin = Math.random().toString(36).slice(2);
let sequence = 0;
const seen = new Map<string, number>();
const listeners = new Set<(resources: string[]) => void>();
const revisions = new Map<string, number>();
function accept(change: Change) {
  if (!change || typeof change.origin !== 'string' || !Number.isSafeInteger(change.sequence) || !Array.isArray(change.resources)) return;
  if ((seen.get(change.origin) || 0) >= change.sequence) return;
  seen.set(change.origin, change.sequence);
  if (seen.size > 64) seen.delete(seen.keys().next().value!);
  const resources = change.resources.filter(value => typeof value === 'string');
  resources.forEach(key => revisions.set(key, (revisions.get(key) || 0) + 1));
  listeners.forEach(listener => listener(resources));
}
export function dataRevision(key: string) {
  let value = 0;
  revisions.forEach((revision, resource) => { if (resourcesOverlap(resource, key)) value += revision; });
  return value;
}
export function publishDataChanges(resources: string[]) {
  if (!resources.length) return;
  const change = { origin, sequence: ++sequence, resources: [...new Set(resources)] };
  accept(change);
  // Only resource IDs cross windows; never documents, credentials or configuration.
  void emit('calmee-data-changed', change).catch(() => undefined);
}
export function subscribeDataChanges(resources: string[], callback: () => void, delay = 50) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = (changed: string[]) => {
    if (!changed.some(key => resources.some(resource => resourcesOverlap(resource, key)))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(callback, delay);
  };
  listeners.add(listener);
  return () => { listeners.delete(listener); if (timer) clearTimeout(timer); };
}
export function startDataChangeBridge() {
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const add = async (event: string, handler: (payload: any) => void) => {
    const off = await listen(event, message => handler(message.payload));
    if (disposed) off(); else cleanups.push(off);
  };
  void Promise.all([
    add('calmee-data-changed', accept),
    ...['retranscription-complete', 'speaker-recluster-complete', 'transcript-refinement-finished', 'summary-ai-complete', 'meeting-record-ai-complete'].map(event => add(event, payload => {
      const id = payload?.meetingId || payload?.meeting_id;
      if (typeof id !== 'string') return;
      // Native job events already reach every window. Do not re-broadcast them.
      const resources = event === 'retranscription-complete' || event === 'speaker-recluster-complete'
        ? ['meetings', `transcripts:${id}`, `speakers:${id}`, 'people']
        : event === 'transcript-refinement-finished' ? [`refinement:${id}`] : [`documents:${id}`, 'meetings'];
      accept({ origin: `${origin}:jobs`, sequence: ++sequence, resources });
    })),
  ]).catch(() => undefined);
  const focus = () => publishDataChanges(['meetings', 'calendar', 'people', 'hotwords', 'models']);
  window.addEventListener('focus', focus);
  return () => { disposed = true; cleanups.forEach(off => off()); window.removeEventListener('focus', focus); };
}
