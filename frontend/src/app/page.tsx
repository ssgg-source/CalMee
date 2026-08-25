'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brain, CalendarCheck2, Check, ChevronRight, Clock3, FileText, Link2, Search, SlidersHorizontal, Trash2, Unlink, X } from 'lucide-react';
import { toast } from 'sonner';
import { MeetingDeleteDialog } from '@/components/MeetingDeleteDialog';
import { CurrentMeeting, useSidebar } from '@/components/Sidebar/SidebarProvider';
import { openMeetingWorkspace } from '@/lib/meeting-window';
import { useLanguage } from '@/contexts/LanguageContext';

type Filter='all'|'unlinked'|'today'|'dedao';
type ListItem=CurrentMeeting&{matchContext?:string};

const meetingTime=(meeting:CurrentMeeting)=>meeting.meetingStartTime||meeting.createdAt;
const validDate=(value?:string)=>{if(!value)return null;const date=new Date(value);return Number.isNaN(date.getTime())?null:date;};
const dateKey=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;

export default function DashboardPage(){
  const router=useRouter();
  const {t,dateLocale}=useLanguage();
  const {meetings,searchTranscripts,searchResults,isSearching,deleteMeetings}=useSidebar();
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState<Filter>('all');
  const [selectedDateKey,setSelectedDateKey]=useState('');
  const [selectionMode,setSelectionMode]=useState(false);
  const [selectedIds,setSelectedIds]=useState<Set<string>>(new Set());
  const [pendingDeleteIds,setPendingDeleteIds]=useState<string[]>([]);
  const [deleting,setDeleting]=useState(false);

  useEffect(()=>{const timer=window.setTimeout(()=>void searchTranscripts(query),250);return()=>window.clearTimeout(timer);},[query,searchTranscripts]);
  useEffect(()=>{setSelectionMode(false);setSelectedIds(new Set());},[query,filter,selectedDateKey]);

  const todayKey=new Date().toDateString();
  const sorted=useMemo(()=>[...meetings].sort((a,b)=>(validDate(meetingTime(b))?.getTime()||0)-(validDate(meetingTime(a))?.getTime()||0)),[meetings]);
  const unlinked=useMemo(()=>meetings.filter(item=>!item.calendarEventId),[meetings]);
  const today=useMemo(()=>meetings.filter(item=>validDate(meetingTime(item))?.toDateString()===todayKey),[meetings,todayKey]);
  const dedao=useMemo(()=>meetings.filter(item=>item.source==='dedao'),[meetings]);
  const filtered=useMemo(()=>{const category=filter==='unlinked'?sorted.filter(item=>!item.calendarEventId):filter==='today'?sorted.filter(item=>validDate(meetingTime(item))?.toDateString()===todayKey):filter==='dedao'?sorted.filter(item=>item.source==='dedao'):sorted;return selectedDateKey?category.filter(item=>{const date=validDate(meetingTime(item));return date&&dateKey(date)===selectedDateKey;}):category;},[filter,sorted,todayKey,selectedDateKey]);
  const visible:ListItem[]=useMemo(()=>{
    if(!query.trim())return filtered;
    const meetingMap=new Map(meetings.map(item=>[item.id,item]));
    const seen=new Set<string>();
    return searchResults.filter(result=>{if(seen.has(result.id))return false;seen.add(result.id);return true;}).map(result=>({...meetingMap.get(result.id),id:result.id,title:result.title,matchContext:result.matchContext}));
  },[query,filtered,meetings,searchResults]);
  const visibleIds=visible.map(item=>item.id);
  const heatmap=useMemo(()=>{const counts=new Map<string,number>();meetings.forEach(item=>{const date=validDate(meetingTime(item));if(date){const key=dateKey(date);counts.set(key,(counts.get(key)||0)+1);}});const today=new Date();today.setHours(0,0,0,0);const currentMonday=new Date(today);currentMonday.setDate(today.getDate()-((today.getDay()+6)%7));const start=new Date(currentMonday);start.setDate(currentMonday.getDate()-77);return Array.from({length:84},(_,index)=>{const date=new Date(start);date.setDate(start.getDate()+index);const key=dateKey(date),future=date>today;return {date,key,count:future?0:counts.get(key)||0,future};});},[meetings]);
  const heatmapWeeks=useMemo(()=>Array.from({length:12},(_,index)=>heatmap.slice(index*7,index*7+7)),[heatmap]);

  const openMeeting=(meeting:ListItem)=>void openMeetingWorkspace(meeting.id,url=>router.push(url),{title:meeting.title});
  const toggle=(id:string)=>setSelectedIds(current=>{const next=new Set(current);next.has(id)?next.delete(id):next.add(id);return next;});
  const leaveSelection=()=>{setSelectionMode(false);setSelectedIds(new Set());};
  const confirmDeletion=async()=>{if(!pendingDeleteIds.length)return;setDeleting(true);const result=await deleteMeetings(pendingDeleteIds);setDeleting(false);setPendingDeleteIds([]);if(result.deletedIds.length)toast.success(t('dashboard.deleted',{count:result.deletedIds.length}));if(result.failed.length){setSelectedIds(new Set(result.failed.map(item=>item.id)));toast.error(t('dashboard.deleteFailed',{count:result.failed.length}));}else leaveSelection();};
  const pendingTitles=pendingDeleteIds.map(id=>meetings.find(item=>item.id===id)?.title||t('meeting.untitled'));

  const cards:[Filter,string,number,typeof FileText,string][]=[
    ['all',t('dashboard.all'),meetings.length,FileText,'text-violet-700 bg-violet-100'],
    ['unlinked',t('dashboard.unlinked'),unlinked.length,Unlink,'text-amber-700 bg-amber-100'],
    ['today',t('dashboard.today'),today.length,CalendarCheck2,'text-emerald-700 bg-emerald-100'],
    ['dedao',t('dashboard.dedao'),dedao.length,Brain,'text-sky-700 bg-sky-100'],
  ];

  return <div className="h-screen overflow-y-auto bg-[#f8f7fb] px-8 pb-12 pt-8 text-slate-900">
    <MeetingDeleteDialog open={pendingDeleteIds.length>0} meetingTitles={pendingTitles} deleting={deleting} onOpenChange={open=>!open&&setPendingDeleteIds([])} onConfirm={confirmDeletion}/>
    <div className="mx-auto max-w-6xl">
      <header className="mb-7"><p className="mb-2 text-sm font-medium text-violet-600">CalMee Dashboard</p><h1 className="text-3xl font-semibold tracking-tight">{t('dashboard.title')}</h1><p className="mt-2 text-slate-500">{t('dashboard.description')}</p></header>

      <section className="relative mb-6"><Search className="absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-violet-400"/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('dashboard.searchPlaceholder')} className="h-16 w-full rounded-2xl border border-violet-100 bg-white pl-14 pr-24 text-base shadow-sm outline-none transition focus:border-violet-300 focus:ring-4 focus:ring-violet-100"/>{isSearching&&<span className="absolute right-5 top-1/2 -translate-y-1/2 text-xs text-violet-500">{t('dashboard.searching')}</span>}</section>

      <section className="mb-6 grid gap-4 lg:grid-cols-[330px_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-3">{cards.map(([key,label,count,Icon,color])=><button key={key} onClick={()=>{setQuery('');setFilter(key);}} className={`flex min-h-[76px] items-center gap-3 rounded-xl border bg-white px-3.5 py-3 text-left shadow-sm transition hover:border-violet-200 ${filter===key&&!query?'border-violet-300 ring-2 ring-violet-100':'border-violet-100'}`}><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${color}`}><Icon className="h-4 w-4"/></span><span className="min-w-0 flex-1"><span className="block text-xl font-semibold leading-none text-slate-800">{count}</span><span className="mt-1 block text-[11px] leading-4 text-slate-500">{label}</span></span></button>)}</div>
        <div className="rounded-2xl border border-violet-100 bg-white px-5 py-4 shadow-sm"><div className="mb-3 flex items-start justify-between"><div><h2 className="text-sm font-semibold text-slate-700">{t('dashboard.heatmapTitle')}</h2><p className="mt-0.5 text-xs text-slate-400">{t('dashboard.heatmapDescription')}</p></div>{selectedDateKey&&<button onClick={()=>setSelectedDateKey('')} className="text-xs font-medium text-violet-600">{t('dashboard.clearFilter')}</button>}</div><div className="overflow-x-auto"><div className="w-[354px] min-w-[354px]"><div className="flex items-start gap-2"><div className="mt-[19px] grid w-4 shrink-0 grid-rows-7 gap-1 text-center text-[9px] leading-[14px] text-slate-400">{['M','T','W','T','F','S','S'].map((day,index)=><span key={`${day}-${index}`}>{day}</span>)}</div><div className="flex gap-1">{heatmapWeeks.map((week,weekIndex)=><div key={weekIndex} className="w-6 shrink-0"><div className="mb-1 h-[15px] text-center text-[9px] leading-[15px] text-slate-400">{week[0]?`${week[0].date.getMonth()+1}/${week[0].date.getDate()}`:''}</div><div className="flex flex-col items-center gap-1">{week.map(item=>{const level=item.future?'bg-slate-50':item.count===0?'bg-slate-100':item.count===1?'bg-violet-200':item.count<=3?'bg-violet-400':'bg-violet-700';return <button key={item.key} disabled={item.future} onClick={()=>setSelectedDateKey(current=>current===item.key?'':item.key)} title={t('dashboard.tooltip',{date:item.key,count:item.count})} className={`h-3.5 w-3.5 rounded-[3px] transition hover:ring-2 hover:ring-violet-300 disabled:opacity-50 ${level} ${selectedDateKey===item.key?'ring-2 ring-violet-700 ring-offset-1':''}`}/>})}</div></div>)}</div></div><div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-slate-400"><span>{t('dashboard.meetingCount')}</span><span className="h-3 w-3 rounded-[3px] bg-slate-100"/><span>0</span><span className="h-3 w-3 rounded-[3px] bg-violet-200"/><span>1</span><span className="h-3 w-3 rounded-[3px] bg-violet-400"/><span>2–3</span><span className="h-3 w-3 rounded-[3px] bg-violet-700"/><span>4+</span></div></div></div></div>
      </section>

      <section className="overflow-hidden rounded-3xl border border-violet-100 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4"><div><h2 className="text-lg font-semibold">{query.trim()?t('dashboard.searchResults'):selectedDateKey?t('dashboard.meetingsOn',{date:selectedDateKey}):cards.find(item=>item[0]===filter)?.[1]}</h2><p className="mt-1 text-sm text-slate-400">{t('dashboard.visibleCount',{count:visible.length})}{filter==='unlinked'&&!query&&t('dashboard.linkHint')}</p></div><div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-500"><SlidersHorizontal className="h-3.5 w-3.5"/><select value={filter} onChange={event=>setFilter(event.target.value as Filter)} className="bg-transparent font-medium text-slate-600 outline-none"><option value="all">{t('dashboard.allSources')}</option><option value="unlinked">{t('dashboard.unlinked')}</option><option value="today">{t('dashboard.today')}</option></select></label><input type="date" value={selectedDateKey} onChange={event=>setSelectedDateKey(event.target.value)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 outline-none"/>{selectionMode&&<><span className="text-xs text-slate-500">{t('dashboard.selected',{count:selectedIds.size})}</span><button onClick={()=>setSelectedIds(new Set(visibleIds))} disabled={!visible.length} className="rounded-lg px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">{t('common.selectAll')}</button><button onClick={()=>setPendingDeleteIds([...selectedIds])} disabled={!selectedIds.size} className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"><Trash2 className="h-3.5 w-3.5"/>{t('common.delete')}</button></>}<button onClick={()=>selectionMode?leaveSelection():setSelectionMode(true)} disabled={!selectionMode&&!visible.length} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">{selectionMode?<X className="h-3.5 w-3.5"/>:<Check className="h-3.5 w-3.5"/>}{selectionMode?t('common.done'):t('dashboard.batchManage')}</button></div></div>

        <div className="divide-y divide-slate-100">{visible.length===0&&!isSearching?<div className="py-16 text-center"><FileText className="mx-auto mb-3 h-9 w-9 text-slate-200"/><div className="text-sm text-slate-400">{query?t('dashboard.noResults'):t('dashboard.noMeetings')}</div></div>:visible.map(meeting=>{const checked=selectedIds.has(meeting.id);const time=validDate(meetingTime(meeting));return <div key={meeting.id} className={`group flex items-center gap-3 px-5 transition ${checked?'bg-red-50':'hover:bg-violet-50/50'}`}>
          {selectionMode&&<button onClick={()=>toggle(meeting.id)} className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${checked?'border-red-500 bg-red-500 text-white':'border-slate-300 bg-white'}`}>{checked&&<Check className="h-3.5 w-3.5"/>}</button>}
          <button onClick={()=>selectionMode?toggle(meeting.id):openMeeting(meeting)} className="flex min-w-0 flex-1 items-center gap-4 py-4 text-left"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><FileText className="h-5 w-5"/></span><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate font-medium text-slate-800">{meeting.title}</span>{meeting.calendarEventId?<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700"><Link2 className="h-3 w-3"/>{t('dashboard.linked')}</span>:<span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">{t('dashboard.pendingLink')}</span>}{meeting.source!=='calmee'&&<span className="shrink-0 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">{t('dashboard.externalImport')}</span>}</span>{meeting.matchContext?<span className="mt-1 block line-clamp-2 text-sm text-slate-500">{meeting.matchContext}</span>:<span className="mt-1 flex items-center gap-1 text-xs text-slate-400"><Clock3 className="h-3 w-3"/>{time?time.toLocaleString(dateLocale,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):t('dashboard.timePending')}</span>}</span>{!selectionMode&&<ChevronRight className="h-4 w-4 shrink-0 text-slate-300"/>}</button>
          {!selectionMode&&<button title={t('dashboard.deleteMeeting')} onClick={()=>setPendingDeleteIds([meeting.id])} className="rounded-lg p-2 text-slate-300 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"><Trash2 className="h-4 w-4"/></button>}
        </div>})}</div>
      </section>
    </div>
  </div>;
}
