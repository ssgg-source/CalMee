import { invoke } from './data-invoke';
import { readLiveMeetingNotes } from './live-meeting-notes';
import type { LinkedCalendarEvent } from '@/components/MeetingWorkspace/CalendarLinkDialog';

const KEY='calmee.recording-calendar-selection';
type RecordingCalendarSelection=LinkedCalendarEvent & {selectionToken:string};
export const calendarRetryKey=(meetingId:string)=>`calmee.calendar-link-retry:${meetingId}`;
export function readRecordingCalendarSelection():RecordingCalendarSelection|null {
  if(typeof window==='undefined')return null;
  try { const value=JSON.parse(sessionStorage.getItem(KEY)||'null');return value?.sessionId===(readLiveMeetingNotes().sessionId||'legacy')&&typeof value.token==='string'?{...value.event,selectionToken:value.token}:null; } catch {return null;}
}
export function selectRecordingCalendar(event:LinkedCalendarEvent|null) {
  if(!event){sessionStorage.removeItem(KEY);return;}
  sessionStorage.setItem(KEY,JSON.stringify({sessionId:readLiveMeetingNotes().sessionId||'legacy',token:crypto.randomUUID(),event}));
}
export async function attachRecordingCalendar(meetingId:string,event:RecordingCalendarSelection|null) {
  if(!event)return;
  try {
    await invoke('api_link_meeting_calendar_event',{meetingId,eventId:event.id,replaceExisting:false,linkMethod:'recording',syncSchedule:false,expectedOccupiedMeetingId:null,expectedCurrentEventId:''});
    localStorage.removeItem(calendarRetryKey(meetingId));
  } catch(error) {
    // A failed association must never lose the recording or notes. Persist the
    // intended event ID so the meeting's link picker can offer an explicit retry.
    localStorage.setItem(calendarRetryKey(meetingId),event.id);
    throw error;
  } finally {
    try {const current=JSON.parse(sessionStorage.getItem(KEY)||'null');if(current?.token===event.selectionToken)sessionStorage.removeItem(KEY);}catch{/* preserve unknown state */}
  }
}
