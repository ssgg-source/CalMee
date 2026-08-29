import { invoke } from '@tauri-apps/api/core';

type CacheEntry = {
  requestedAt: number;
  request: Promise<any>;
};

const summaryRequests = new Map<string, CacheEntry>();
const DEDUPE_WINDOW_MS = 1_000;

/**
 * Coalesces the parent document load and the background-job restore check that
 * run together when a meeting workspace mounts. The short window avoids stale
 * UI while preventing two identical SQLite commands during first paint.
 */
export function getMeetingSummary(meetingId: string, force = false): Promise<any> {
  const now = Date.now();
  const cached = summaryRequests.get(meetingId);
  if (!force && cached && now - cached.requestedAt < DEDUPE_WINDOW_MS) {
    return cached.request;
  }

  const request = invoke('api_get_summary', { meetingId });
  summaryRequests.set(meetingId, { requestedAt: now, request });
  return request;
}

export function invalidateMeetingSummary(meetingId: string) {
  summaryRequests.delete(meetingId);
}
