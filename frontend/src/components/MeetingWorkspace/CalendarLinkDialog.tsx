"use client";

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import { CalendarDays, Check, Link2Off, Loader2, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ProductButton, ProductEmptyState, ProductInput } from '@/components/ui/ProductControls';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';
import { subscribeDataChanges } from '@/lib/data-events';
import { calendarRetryKey } from '@/lib/recording-calendar';

export type LinkedCalendarEvent = { id:string; title:string; startAt:string; endAt?:string; calendarId?:string; calendarName?:string; source:string; location?:string; meetingId?:string; allDay?:boolean };
type Candidate = { event:LinkedCalendarEvent; score:number; reasonCodes:string[]; occupiedByMeetingId?:string; occupiedByTitle?:string };
type Collection = { id:string; color:string };
type LinkResult = { event:LinkedCalendarEvent|null; displacedMeetingId?:string; revision:number };

export function CalendarLinkDialog({ open, onOpenChange, meetingId, meetingTime, meetingTitle, currentEventId, onLinked }: {
  open:boolean; onOpenChange:(open:boolean)=>void; meetingId?:string; meetingTime?:string; meetingTitle?:string;
  currentEventId?:string|null; onLinked:(event:LinkedCalendarEvent|null)=>void;
}) {
  const { locale }=useLanguage(); const zh=locale==='zh-CN';
  const [candidates,setCandidates]=useState<Candidate[]>([]);
  const [collections,setCollections]=useState<Collection[]>([]);
  const [query,setQuery]=useState(''); const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false); const [syncSchedule,setSyncSchedule]=useState(false);
  const [transfer,setTransfer]=useState<Candidate|null>(null);
  const [reviewCount,setReviewCount]=useState(0); const [refresh,setRefresh]=useState(0);
  const sequence=useRef(0);
  useEffect(()=>{if(open){setTransfer(null);setSyncSchedule(false);}},[open,meetingId]);
  useEffect(()=>{
    if(!open)return;
    return subscribeDataChanges(['calendar'],()=>setRefresh(value=>value+1));
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const token=++sequence.current; setLoading(true);
    const timer=setTimeout(()=>{
      void Promise.all([
        invoke<Candidate[]>('api_get_calendar_link_candidates',{meetingId:meetingId||null,centerTime:meetingTime||null,title:meetingTitle||null,query:query.trim()||null}),
        invoke<Collection[]>('api_get_calendar_collections'),
        meetingId?invoke<number>('api_get_calendar_link_review_count',{meetingId}):Promise.resolve(0),
      ]).then(([items,cals,review])=>{if(token===sequence.current){setCandidates(items);setCollections(cals);setReviewCount(review);}})
        .catch(error=>{if(token!==sequence.current)return;reportTechnicalError('calendar-link-load',error);toast.error(zh?'无法读取日程':'Could not load calendar events',{description:toUserFacingError(error,locale).message});})
        .finally(()=>{if(token===sequence.current)setLoading(false);});
    },query.trim()?180:0);
    return()=>{clearTimeout(timer);sequence.current++;};
  },[open,meetingId,meetingTime,meetingTitle,query,refresh,locale,zh]);

  const link=async(candidate:Candidate|null,replace=false)=>{
    if(saving)return;
    if(!meetingId){onLinked(candidate?.event||null);onOpenChange(false);return;}
    setSaving(true);
    try{
      const result=await invoke<LinkResult>('api_link_meeting_calendar_event',{
        meetingId,eventId:candidate?.event.id||null,replaceExisting:replace,
        expectedOccupiedMeetingId:replace?candidate?.occupiedByMeetingId||null:null,
        expectedCurrentEventId:currentEventId||'',
        linkMethod:'manual',syncSchedule,
      });
      onLinked(result.event);onOpenChange(false);
      localStorage.removeItem(calendarRetryKey(meetingId));
      toast.success(candidate?(zh?'日程已关联':'Calendar event linked'):(zh?'已解除日程关联':'Calendar link removed'));
    }catch(error){
      const raw=String(error);
      if(raw.includes('CALENDAR_LINK_CONFLICT')||raw.includes('CALENDAR_LINK_CHANGED')){
        setTransfer(null);setRefresh(value=>value+1);
        toast.warning(zh?'关联状态已变化，请重新选择':'The link changed. Please select again.');
      }else{reportTechnicalError('calendar-link-save',error);toast.error(zh?'无法关联日程':'Could not link calendar event',{description:toUserFacingError(error,locale).message});}
    }finally{setSaving(false);}
  };
  return <Dialog open={open} onOpenChange={value=>{if(!saving)onOpenChange(value);}}><DialogContent className="max-w-2xl">
    <DialogHeader><DialogTitle>{zh?'关联日程':'Link calendar event'}</DialogTitle><DialogDescription>{zh?'优先推荐时间接近的日程；搜索可查找其他已同步日程。关联不会修改源日历。':'Nearby events are suggested first. Search other synced events. Linking does not modify your source calendar.'}</DialogDescription></DialogHeader>
    {reviewCount>0&&<p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{zh?'旧版关联存在冲突，原始记录已保留。请重新选择日程或确认解除关联。':'A legacy link conflict was preserved for review. Choose an event or explicitly remove the link.'}</p>}
    {meetingId&&typeof window!=='undefined'&&localStorage.getItem(calendarRetryKey(meetingId))&&<p role="status" className="text-xs text-amber-700">{zh?'此前保存会议成功，但关联未完成。请重新选择日程重试。':'The meeting was saved, but its calendar link failed. Select an event to retry.'}</p>}
    <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground"/><ProductInput value={query} onChange={event=>setQuery(event.target.value)} placeholder={zh?'搜索日程标题或日历':'Search event title or calendar'} className="w-full pl-9"/></div>
    <div className="max-h-[390px] space-y-1 overflow-y-auto py-1" aria-busy={loading}>
      {loading?<div className="flex justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>{zh?'正在读取日程…':'Loading events…'}</div>:candidates.length===0?<ProductEmptyState icon={<CalendarDays className="h-5 w-5"/>} title={zh?'没有找到日程':'No events found'} description={zh?'可以搜索其他日期的日程，或先同步日历。':'Search other dates or sync your calendars first.'}/>:candidates.map((candidate,index)=>{
        const event=candidate.event, linked=currentEventId===event.id;
        const occupied=Boolean(candidate.occupiedByMeetingId&&candidate.occupiedByMeetingId!==meetingId);
        const color=collections.find(item=>item.id===event.calendarId)?.color||'#8B5CF6';
        return <button key={event.id} disabled={saving||(!meetingId&&occupied)} onClick={()=>occupied?setTransfer(candidate):void link(candidate)} className={`flex w-full items-center gap-3 rounded-lg p-3 text-left transition hover:bg-accent/65 disabled:opacity-50 ${linked?'bg-primary/8':''}`}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{backgroundColor:`${color}18`,color}}><CalendarDays className="h-4 w-4"/></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{event.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{new Date(event.startAt).toLocaleString(locale)}{event.allDay?(zh?' · 全天':' · All day'):''} · {event.calendarName||event.source}</span>{occupied&&<span className="mt-1 block truncate text-xs text-amber-700">{zh?'已关联：':'Linked to: '}{candidate.occupiedByTitle}</span>}</span>
          {linked?<Check className="h-4 w-4 text-primary"/>:!query&&index<3&&!occupied&&candidate.score>=55&&<span className="shrink-0 text-[11px] text-primary">{zh?'推荐':'Suggested'}</span>}
        </button>;
      })}
    </div>
    {meetingId&&<label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={syncSchedule} disabled={saving} onChange={event=>setSyncSchedule(event.target.checked)}/>{zh?'同时采用日程计划时间（不修改会议标题）':'Also use the scheduled time (keep the meeting title)'}</label>}
    {transfer&&<div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"><p>{zh?`此日程已关联“${transfer.occupiedByTitle}”。转移后，原会议将变为待关联，其录音和笔记不会删除。`:`This event is linked to “${transfer.occupiedByTitle}”. Transfer removes that link but keeps its audio and notes.`}</p><div className="flex justify-end gap-2"><ProductButton disabled={saving} onClick={()=>setTransfer(null)}>{zh?'取消':'Cancel'}</ProductButton><ProductButton variant="primary" disabled={saving} onClick={()=>void link(transfer,true)}>{zh?'转移关联':'Transfer link'}</ProductButton></div></div>}
    {(currentEventId||reviewCount>0)&&<DialogFooter><ProductButton variant="ghost" disabled={saving} onClick={()=>void link(null)}><Link2Off className="h-4 w-4"/>{zh?'解除关联':'Remove link'}</ProductButton></DialogFooter>}
  </DialogContent></Dialog>;
}
