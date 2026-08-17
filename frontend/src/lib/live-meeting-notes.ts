import { invoke } from "@tauri-apps/api/core";

export const LIVE_MEETING_NOTES_KEY = "calmee.active-live-meeting-notes";
export const LIVE_MEETING_NOTES_EVENT = "calmee-live-meeting-notes-changed";

export type LiveMeetingNotesState = {
  markdown: string;
  updatedAt: string;
};

export function readLiveMeetingNotes(): LiveMeetingNotesState {
  if (typeof window === "undefined") return { markdown: "", updatedAt: "" };
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(LIVE_MEETING_NOTES_KEY) || "{}",
    );
    return {
      markdown: typeof parsed.markdown === "string" ? parsed.markdown : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return { markdown: "", updatedAt: "" };
  }
}

export function writeLiveMeetingNotes(markdown: string) {
  if (typeof window === "undefined") return;
  const value: LiveMeetingNotesState = {
    markdown,
    updatedAt: new Date().toISOString(),
  };
  window.localStorage.setItem(LIVE_MEETING_NOTES_KEY, JSON.stringify(value));
  window.dispatchEvent(
    new CustomEvent(LIVE_MEETING_NOTES_EVENT, { detail: value }),
  );
}

export function clearLiveMeetingNotes() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LIVE_MEETING_NOTES_KEY);
  window.dispatchEvent(
    new CustomEvent(LIVE_MEETING_NOTES_EVENT, {
      detail: { markdown: "", updatedAt: "" },
    }),
  );
}

export async function persistLiveMeetingNotes(meetingId: string) {
  const notes = readLiveMeetingNotes();
  if (!notes.markdown.trim()) {
    clearLiveMeetingNotes();
    return false;
  }
  await invoke("api_save_meeting_notes", {
    meetingId,
    notesMarkdown: notes.markdown,
    notesJson: JSON.stringify({ source: "live-recording", ...notes }),
  });
  clearLiveMeetingNotes();
  return true;
}
