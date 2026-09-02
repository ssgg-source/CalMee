import { invoke } from "@/lib/data-invoke";

export const LIVE_MEETING_NOTES_KEY = "calmee.active-live-meeting-notes";
export const LIVE_MEETING_NOTES_EVENT = "calmee-live-meeting-notes-changed";
export const LIVE_MEETING_NOTES_CHANNEL = "calmee-live-meeting-notes-sync";

export type LiveMeetingNotesState = {
  markdown: string;
  updatedAt: string;
  sessionId?: string;
  revision?: number;
};

/**
 * Draft editors can leave behind structural Markdown such as an empty heading,
 * checklist item, or CalMee's automatically inserted timestamp. None of those
 * should create a durable meeting on their own.
 */
export function hasMeaningfulLiveMeetingNotes(markdown: string) {
  const visibleContent = markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[^\n]*\n?\s*```/g, "")
    .replace(/\[(?:\d{1,3}:)?\d{2}:\d{2}\]/g, "")
    .replace(/\b(?:Highlight)\b/gi, "")
    .replace(/重点/g, "")
    .replace(/🔖/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[\s#>*_`~+\-[\]().:|\\]/g, "");
  return visibleContent.length > 0;
}

export function readLiveMeetingNotes(): LiveMeetingNotesState {
  if (typeof window === "undefined") return { markdown: "", updatedAt: "" };
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(LIVE_MEETING_NOTES_KEY) || "{}",
    );
    return {
      markdown: typeof parsed.markdown === "string" ? parsed.markdown : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : 'legacy',
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
    };
  } catch {
    return { markdown: "", updatedAt: "" };
  }
}

export function writeLiveMeetingNotes(markdown: string, expected?: LiveMeetingNotesState) {
  if (typeof window === "undefined") return;
  const previous = readLiveMeetingNotes();
  if (expected && (previous.sessionId !== expected.sessionId || previous.revision !== expected.revision)) return false;
  const value: LiveMeetingNotesState = {
    markdown,
    updatedAt: new Date().toISOString(),
    sessionId: previous.sessionId || 'legacy',
    revision: (previous.revision || 0) + 1,
  };
  window.localStorage.setItem(LIVE_MEETING_NOTES_KEY, JSON.stringify(value));
  window.dispatchEvent(
    new CustomEvent(LIVE_MEETING_NOTES_EVENT, { detail: value }),
  );
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(LIVE_MEETING_NOTES_CHANNEL);
    channel.postMessage(value);
    channel.close();
  }
  return true;
}

export function clearLiveMeetingNotes(expected?: LiveMeetingNotesState) {
  if (typeof window === "undefined") return;
  const current = readLiveMeetingNotes();
  if (expected && (current.sessionId !== expected.sessionId || current.revision !== expected.revision || current.markdown !== expected.markdown)) return;
  const cleared: LiveMeetingNotesState = { markdown: '', updatedAt: new Date().toISOString(), sessionId: crypto.randomUUID(), revision: 0 };
  window.localStorage.setItem(LIVE_MEETING_NOTES_KEY, JSON.stringify(cleared));
  window.dispatchEvent(
    new CustomEvent(LIVE_MEETING_NOTES_EVENT, {
      detail: cleared,
    }),
  );
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(LIVE_MEETING_NOTES_CHANNEL);
    channel.postMessage(cleared);
    channel.close();
  }
}

export async function persistLiveMeetingNotes(meetingId: string) {
  const notes = readLiveMeetingNotes();
  if (!hasMeaningfulLiveMeetingNotes(notes.markdown)) {
    clearLiveMeetingNotes(notes);
    return false;
  }
  await invoke("api_save_meeting_notes", {
    meetingId,
    notesMarkdown: notes.markdown,
    notesJson: JSON.stringify({ source: "live-recording", ...notes }),
  });
  clearLiveMeetingNotes(notes);
  return true;
}
