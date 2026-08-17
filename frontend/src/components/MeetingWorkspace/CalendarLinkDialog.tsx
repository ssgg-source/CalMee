"use client";

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CalendarDays, Check, Link2Off, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';

type CalendarEvent = { id:string; title:string; startAt:string; endAt?:string; calendarId?:string; calendarName?:string; source:string; location?:string; meetingId?:string };
type CalendarCollection = { id:string; name:string; color:string };

export function CalendarLinkDialog({ open, onOpenChange, meetingId, meetingTime, currentEventId, onLinked }: { open:boolean; onOpenChange:(open:boolean)=>void; meetingId:string; meetingTime?:string; currentEventId?:string|null; onLinked:(event:CalendarEvent|null)=>void }) {
  const [events,setEvents]=useState<CalendarEvent[]>([]);
  const [collections,setCollections]=useState<CalendarCollection[]>([]);
  const [query,setQuery]=useState('');
  const [loading,setLoading]=useState(false);
  useEffect(()=>{if(!open)return;setLoading(true);const center=meetingTime?new Date(meetingTime):new Date();const start=new Date(center);start.setDate(start.getDate()-30);const end=new Date(center);end.setDate(end.getDate()+30);Promise.all([
    invoke<CalendarEvent[]>('api_get_calendar_events',{startAt:start.toISOString(),endAt:end.toISOString()}),
    invoke<CalendarCollection[]>('api_get_calendar_collections')
  ]).then(([items,cals])=>{setEvents(items);setCollections(cals);}).catch(error=>toast.error('读取日程失败',{description:String(error)})).finally(()=>setLoading(false));},[open,meetingTime]);
  const colorById=useMemo(()=>new Map(collections.map(item=>[item.id,item.color])),[collections]);
  const filtered=useMemo(()=>events.filter(event=>!query.trim()||`${event.title} ${event.calendarName||''} ${event.location||''}`.toLowerCase().includes(query.toLowerCase())),[events,query]);
  const link=async(event:CalendarEvent|null)=>{try{await invoke('api_link_meeting_calendar_event',{meetingId,eventId:event?.id||null});onLinked(event);onOpenChange(false);toast.success(event?'日程已关联':'已解除日程关联');}catch(error){toast.error('关联日程失败',{description:String(error)});}};
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>关联日程</DialogTitle></DialogHeader>
    <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3"><Search className="h-4 w-4 text-slate-400"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索最近 60 天的日程" className="flex-1 border-0 py-2.5 text-sm outline-none"/></div>
    <div className="max-h-[430px] space-y-1 overflow-y-auto py-1">{loading?<div className="py-16 text-center text-sm text-slate-400">正在读取日程…</div>:filtered.length===0?<div className="py-16 text-center text-sm text-slate-400">没有找到日程</div>:filtered.map(event=>{const linked=currentEventId===event.id;return <button key={event.id} onClick={()=>void link(event)} className={`flex w-full items-center gap-3 rounded-xl p-3 text-left transition hover:bg-violet-50 ${linked?'bg-violet-50':''}`}><span className="flex h-9 w-9 items-center justify-center rounded-lg" style={{backgroundColor:`${colorById.get(event.calendarId||'')||'#8B5CF6'}18`,color:colorById.get(event.calendarId||'')||'#8B5CF6'}}><CalendarDays className="h-4 w-4"/></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-800">{event.title}</span><span className="mt-0.5 block text-xs text-slate-400">{new Date(event.startAt).toLocaleString()} · {event.calendarName||event.source}</span></span>{linked&&<Check className="h-4 w-4 text-violet-600"/>}</button>})}</div>
    {currentEventId&&<button onClick={()=>void link(null)} className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-100 px-3 py-2 text-sm text-red-600 hover:bg-red-50"><Link2Off className="h-4 w-4"/>解除关联</button>}
  </DialogContent></Dialog>;
}
