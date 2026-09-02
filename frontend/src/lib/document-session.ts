import { queueResourceWrite, waitForResourceWrites, resourceWriteRevision } from './refresh-state';

type Draft = { markdown: string };
const drafts = new Map<string, Draft>();
export const documentResourceKey = (meetingId: string, kind: string, context = '') => `${meetingId}:${kind}:${context}`;
export function rememberDocumentDraft(key: string, markdown: string) { drafts.set(key, { markdown }); }
export function readDocumentDraft(key: string) { return drafts.get(key); }
export function acknowledgeDocumentDraft(key: string, markdown: string) {
  if (drafts.get(key)?.markdown === markdown) drafts.delete(key);
}
export async function readAfterDocumentWrites<T>(key: string, read: () => Promise<T>) {
  for (;;) {
    await waitForResourceWrites(key);
    const revision = resourceWriteRevision(key);
    const value = await read();
    if (resourceWriteRevision(key) === revision) return value;
  }
}
export function saveDocumentInOrder(key: string, markdown: string, save: () => Promise<void>) {
  return queueResourceWrite(key, async () => {
    await save();
    acknowledgeDocumentDraft(key, markdown);
  });
}
