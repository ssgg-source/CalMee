'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CalendarDays, CheckCircle2, Cloud, Loader2, RefreshCw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';

type Settings = { localEnabled:boolean;caldavEnabled:boolean;caldavUrl?:string;caldavUsername?:string;caldavPassword?:string;caldavCalendarPath?:string;syncMode:string;lastSyncAt?:string };
const defaults:Settings={localEnabled:false,caldavEnabled:false,syncMode:'two_way'};

export function CalendarSettings(){
  const {t,dateLocale}=useLanguage();
  const [value,setValue]=useState<Settings>(defaults);
  const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [testing,setTesting]=useState(false);const [syncing,setSyncing]=useState(false);
  useEffect(()=>{invoke<Settings>('api_get_calendar_settings').then(setValue).catch(error=>toast.error(t('calendarSettings.loadFailed'),{description:String(error)})).finally(()=>setLoading(false));},[t]);
  const save=async()=>{setSaving(true);try{await invoke('api_save_calendar_settings',{settings:value});toast.success(t('calendarSettings.saved'));}catch(error){toast.error(t('calendar.saveFailed'),{description:String(error)});}finally{setSaving(false);}};
  const test=async()=>{await save();setTesting(true);try{toast.success(await invoke<string>('api_test_caldav'));}catch(error){toast.error(t('calendarSettings.connectionFailed'),{description:String(error)});}finally{setTesting(false);}};
  const sync=async()=>{await save();setSyncing(true);try{const now=new Date(),start=new Date(now.getFullYear(),now.getMonth()-1,1),end=new Date(now.getFullYear(),now.getMonth()+2,1);const result=await invoke<any>('api_sync_calendars',{startAt:start.toISOString(),endAt:end.toISOString()});toast.success(t('calendarSettings.syncResult',{local:result.local,caldav:result.caldav}),result.warnings?.length?{description:result.warnings.join('; ')}:undefined);}catch(error){toast.error(t('calendar.syncFailed'),{description:String(error)});}finally{setSyncing(false);}};
  if(loading)return <div className="flex justify-center p-12"><Loader2 className="animate-spin text-violet-600"/></div>;
  const input='w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100';
  return <div className="mt-6 space-y-6">
    <section className="rounded-2xl border border-violet-100 bg-white p-6 shadow-sm"><div className="flex items-start justify-between gap-4"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><CalendarDays className="h-5 w-5 text-violet-600"/>{t('calendarSettings.localTitle')}</h2><p className="mt-1 text-sm text-slate-500">{t('calendarSettings.localDescription')}</p></div><Switch checked={value.localEnabled} onCheckedChange={localEnabled=>setValue({...value,localEnabled})}/></div></section>
    <section className="rounded-2xl border border-violet-100 bg-white p-6 shadow-sm"><div className="flex items-start justify-between gap-4"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><Cloud className="h-5 w-5 text-sky-600"/>{t('calendarSettings.serverTitle')}</h2><p className="mt-1 text-sm text-slate-500">{t('calendarSettings.serverDescription')}</p></div><Switch checked={value.caldavEnabled} onCheckedChange={caldavEnabled=>setValue({...value,caldavEnabled,syncMode:caldavEnabled?'two_way':value.syncMode})}/></div>{value.caldavEnabled&&<div className="mt-5 grid grid-cols-2 gap-3"><input className={`${input} col-span-2`} placeholder={t('calendarSettings.url')} value={value.caldavUrl||''} onChange={event=>setValue({...value,caldavUrl:event.target.value})}/><input className={input} placeholder={t('calendarSettings.username')} value={value.caldavUsername||''} onChange={event=>setValue({...value,caldavUsername:event.target.value})}/><input className={input} type="password" placeholder={t('calendarSettings.password')} value={value.caldavPassword||''} onChange={event=>setValue({...value,caldavPassword:event.target.value})}/><input className={`${input} col-span-2`} placeholder={t('calendarSettings.path')} value={value.caldavCalendarPath||''} onChange={event=>setValue({...value,caldavCalendarPath:event.target.value})}/><button onClick={()=>void test()} disabled={testing} className="col-span-2 inline-flex items-center justify-center gap-2 rounded-xl border border-sky-200 py-2.5 text-sm font-medium text-sky-700 hover:bg-sky-50">{testing?<Loader2 className="h-4 w-4 animate-spin"/>:<CheckCircle2 className="h-4 w-4"/>}{t('calendarSettings.connect')}</button></div>}</section>
    <div className="flex items-center justify-between rounded-2xl border border-violet-100 bg-white p-4"><span className="text-xs text-slate-400">{value.lastSyncAt?t('calendarSettings.lastSync',{time:new Date(value.lastSyncAt).toLocaleString(dateLocale)}):t('calendarSettings.never')}</span><div className="flex gap-2"><button onClick={()=>void save()} disabled={saving} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm"><Save className="h-4 w-4"/>{t('calendar.save')}</button><button onClick={()=>void sync()} disabled={syncing} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white">{syncing?<Loader2 className="h-4 w-4 animate-spin"/>:<RefreshCw className="h-4 w-4"/>}{t('calendarSettings.syncNow')}</button></div></div>
  </div>;
}
