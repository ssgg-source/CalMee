'use client';

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { CalendarDays, FileText, LayoutDashboard, Mic2, Settings, Upload, X } from 'lucide-react';
import { meetingUrl, readMeetingTabs, removeMeetingTab, subscribeMeetingTabs } from '@/lib/meeting-window';
import { useLanguage } from '@/contexts/LanguageContext';

const baseMeta=(route:string)=>{
  if(route.startsWith('/recording'))return {labelKey:'nav.recording' as const,icon:Mic2};
  if(route.startsWith('/upload'))return {labelKey:'nav.upload' as const,icon:Upload};
  if(route.startsWith('/calendar'))return {labelKey:'nav.calendar' as const,icon:CalendarDays};
  if(route.startsWith('/knowledge'))return {labelKey:'nav.settings' as const,icon:Settings};
  if(route.startsWith('/settings'))return {labelKey:'nav.settings' as const,icon:Settings};
  if(route.startsWith('/about'))return {labelKey:'nav.settings' as const,icon:Settings};
  return {labelKey:'nav.home' as const,icon:LayoutDashboard};
};

export function MeetingTabs(){
  const router=useRouter(),params=useSearchParams(),pathname=usePathname(),activeId=params.get('id');
  const { t, locale } = useLanguage();
  const isMeeting=pathname.startsWith('/meeting-details');
  // The server cannot see browser storage. Start from the same empty snapshot
  // on both server and client, then restore persisted meeting tabs after mount
  // to avoid a different number of <button> elements during hydration.
  const [tabs,setTabs]=useState<ReturnType<typeof readMeetingTabs>>([]);
  const [taskProgress,setTaskProgress]=useState<Record<string,{asr?:number;ai?:number}>>({});
  const [pendingUrl,setPendingUrl]=useState<string|null>(null);
  const [baseRoute,setBaseRoute]=useState('/');
  useEffect(()=>{
    setTabs(readMeetingTabs());
    return subscribeMeetingTabs(()=>setTabs(readMeetingTabs()));
  },[]);
  useEffect(()=>{
    if(pathname.startsWith('/meeting-details')){
      setBaseRoute(sessionStorage.getItem('calmee-base-tab-route')||'/');
      return;
    }
    setBaseRoute(pathname);
    sessionStorage.setItem('calmee-base-tab-route',pathname);
  },[pathname]);
  useEffect(()=>{setPendingUrl(null);},[pathname,activeId]);
  useEffect(()=>{router.prefetch(baseRoute);tabs.forEach(tab=>router.prefetch(meetingUrl(tab.id,tab.source)));},[router,baseRoute,tabs]);
  useEffect(()=>{let live=true;void Promise.all(tabs.flatMap(tab=>[
    invoke<any>('get_retranscription_status_command',{meetingId:tab.id}).then(job=>{if(live&&job.status==='processing')setTaskProgress(current=>({...current,[tab.id]:{...current[tab.id],asr:job.progress?.determinate===false?-1:(job.progress?.progress_percentage||1)}}));}).catch(()=>undefined),
    invoke<any>('api_get_transcript_refinement_status',{meetingId:tab.id}).then(job=>{if(live&&job.status==='processing')setTaskProgress(current=>({...current,[tab.id]:{...current[tab.id],ai:job.progress?.determinate?(job.progress.percentage||1):-1}}));}).catch(()=>undefined),
  ]));return()=>{live=false};},[tabs]);
  useEffect(()=>{let disposed=false;const cleanups:Array<()=>void>=[];void Promise.all([
    listen<any>('retranscription-progress',event=>setTaskProgress(current=>({...current,[event.payload.meeting_id]:{...current[event.payload.meeting_id],asr:event.payload.determinate===false?-1:(event.payload.progress_percentage||1)}}))),
    listen<any>('retranscription-complete',event=>setTaskProgress(current=>({...current,[event.payload.meeting_id]:{...current[event.payload.meeting_id],asr:undefined}}))),
    listen<any>('retranscription-error',event=>setTaskProgress(current=>({...current,[event.payload.meeting_id]:{...current[event.payload.meeting_id],asr:undefined}}))),
    listen<any>('transcript-refinement-progress',event=>setTaskProgress(current=>({...current,[event.payload.meetingId]:{...current[event.payload.meetingId],ai:event.payload.determinate?(event.payload.percentage||1):-1}}))),
    listen<any>('transcript-refinement-finished',event=>setTaskProgress(current=>({...current,[event.payload.meetingId]:{...current[event.payload.meetingId],ai:undefined}}))),
  ]).then(items=>{if(disposed)items.forEach(item=>item());else cleanups.push(...items);});return()=>{disposed=true;cleanups.forEach(item=>item());};},[]);
  const navigate=(url:string)=>{if(pendingUrl===url)return;setPendingUrl(url);router.push(url);};
  const pointerNavigate=(event:ReactPointerEvent<HTMLElement>,url:string)=>{if(event.button!==0)return;event.preventDefault();navigate(url);};
  const close=(id:string)=>{const wasActive=id===activeId,next=removeMeetingTab(id);setTabs(readMeetingTabs());if(wasActive)router.push(next?meetingUrl(next.id,next.source):baseRoute);};
  const meta=baseMeta(baseRoute),BaseIcon=meta.icon;
  return <div className="flex h-11 shrink-0 items-end gap-1 overflow-x-auto bg-[#e7e7eb] pl-[78px] pr-2 pt-1 select-none">
    <div onPointerDown={event=>pointerNavigate(event,baseRoute)} className={`calmee-browser-tab ${!isMeeting||pendingUrl===baseRoute?'calmee-browser-tab-active':'calmee-browser-tab-inactive'} flex h-10 min-w-[150px] max-w-[210px] shrink-0 cursor-pointer items-center gap-2 px-4 text-xs`}><button onClick={event=>{if(event.detail===0)navigate(baseRoute);}} className="flex min-w-0 flex-1 items-center gap-2 text-left"><BaseIcon className="h-3.5 w-3.5 shrink-0"/><span className="truncate">{t(meta.labelKey)}</span></button></div>
    {tabs.map(tab=>{const url=meetingUrl(tab.id,tab.source),active=pendingUrl?pendingUrl===url:tab.id===activeId;const task=taskProgress[tab.id];const progress=task?.asr??task?.ai;const ai=task?.asr==null&&task?.ai!=null;const indeterminate=progress===-1;return <div key={tab.id} onPointerDown={event=>pointerNavigate(event,url)} className={`calmee-browser-tab ${active?'calmee-browser-tab-active':'calmee-browser-tab-inactive'} group flex h-10 min-w-[150px] max-w-[240px] shrink-0 cursor-pointer items-center gap-2 px-4 text-xs`}><button onClick={event=>{if(event.detail===0)navigate(url);}} className="flex min-w-0 flex-1 items-center gap-2 text-left">{progress!=null?<span className={`relative flex h-[18px] w-[18px] shrink-0 items-center justify-center ${ai?'text-violet-500':'text-slate-500'}`} title={indeterminate?(locale==='zh-CN'?(ai?'AI 正在处理':'正在转写'):(ai?'AI processing':'ASR processing')):`${ai?'AI':'ASR'} · ${Math.round(progress)}%`}><svg className={`absolute h-[18px] w-[18px] -rotate-90 ${indeterminate?'animate-spin':''}`} viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeOpacity=".16" strokeWidth="2"/><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={indeterminate?'12 35.12':'47.12'} strokeDashoffset={indeterminate?0:47.12*(1-Math.max(0,Math.min(100,progress))/100)}/></svg>{!indeterminate&&<span className="text-[6.5px] font-semibold tabular-nums">{Math.round(progress)}</span>}</span>:<FileText className="h-3.5 w-3.5 shrink-0"/>}<span className="truncate">{tab.title}</span></button><button onPointerDown={event=>event.stopPropagation()} onClick={()=>close(tab.id)} className="shrink-0 cursor-default rounded p-0.5 opacity-50 hover:bg-slate-300/60 hover:opacity-100" aria-label={t('tabs.close',{title:tab.title})}><X className="h-3 w-3"/></button></div>;})}
    <div data-tauri-drag-region className="h-full min-w-10 flex-1"/>
  </div>;
}
