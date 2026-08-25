type Navigate = (url: string) => void;

export type MeetingTab={id:string;title:string;source?:string};
const STORAGE_KEY='calmee-meeting-tabs';
const EVENT_NAME='calmee-meeting-tabs-changed';
const validMeetingId=(value:unknown):value is string=>typeof value==='string'&&Boolean(value.trim())&&value!=='undefined'&&value!=='null';

export function meetingUrl(meetingId:string,source?:string){if(!validMeetingId(meetingId))return '/';const params=new URLSearchParams({id:meetingId});if(source)params.set('source',source);return `/meeting-details?${params.toString()}`;}

export function readMeetingTabs():MeetingTab[]{
  if(typeof window==='undefined')return [];
  try{const value=JSON.parse(sessionStorage.getItem(STORAGE_KEY)||'[]');return Array.isArray(value)?value.filter(item=>validMeetingId(item?.id)&&item?.title):[];}catch{return [];}
}

export function writeMeetingTabs(tabs:MeetingTab[]){
  if(typeof window==='undefined')return;
  sessionStorage.setItem(STORAGE_KEY,JSON.stringify(tabs));
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function addMeetingTab(tab:MeetingTab){
  const tabs=readMeetingTabs();const existing=tabs.findIndex(item=>item.id===tab.id);
  if(existing>=0)tabs[existing]={...tabs[existing],...tab};else tabs.push(tab);
  writeMeetingTabs(tabs.slice(-12));
}

export function removeMeetingTab(meetingId:string){const tabs=readMeetingTabs();const index=tabs.findIndex(item=>item.id===meetingId);const next=tabs[index>0?index-1:index+1];writeMeetingTabs(tabs.filter(item=>item.id!==meetingId));return next;}

export function subscribeMeetingTabs(listener:()=>void){if(typeof window==='undefined')return()=>{};window.addEventListener(EVENT_NAME,listener);window.addEventListener('storage',listener);return()=>{window.removeEventListener(EVENT_NAME,listener);window.removeEventListener('storage',listener);};}

export async function openMeetingWorkspace(meetingId:string,navigate:Navigate,options?:{source?:string;title?:string}){
  if(!validMeetingId(meetingId)){navigate('/');return;}
  addMeetingTab({id:meetingId,title:options?.title||'Untitled meeting',source:options?.source});
  navigate(meetingUrl(meetingId,options?.source));
}

export async function closeMeetingWorkspaceOrNavigate(navigate:Navigate,meetingId?:string){
  if(meetingId){const next=removeMeetingTab(meetingId);navigate(next?meetingUrl(next.id,next.source):'/');return;}
  navigate('/');
}
