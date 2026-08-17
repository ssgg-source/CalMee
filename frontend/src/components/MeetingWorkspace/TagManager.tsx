"use client";

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from 'sonner';

export type MeetingTag = { id: string; name: string; color: string; meetingCount: number };
const colors = ['#8B5CF6','#2563EB','#0891B2','#059669','#D97706','#EA580C','#E11D48','#64748B'];

export function TagManager({ meetingId }: { meetingId: string }) {
  const [all, setAll] = useState<MeetingTag[]>([]);
  const [assigned, setAssigned] = useState<MeetingTag[]>([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState(colors[0]);
  const [editing, setEditing] = useState<MeetingTag | null>(null);
  const [editName, setEditName] = useState('');
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    const [tags, current] = await Promise.all([
      invoke<MeetingTag[]>('api_list_meeting_tags', { meetingId: null }),
      invoke<MeetingTag[]>('api_list_meeting_tags', { meetingId }),
    ]);
    setAll(tags); setAssigned(current);
  }, [meetingId]);
  useEffect(()=>{void load();},[load]);
  const toggle = async (tag: MeetingTag) => {
    const active = assigned.some(item=>item.id===tag.id);
    await invoke('api_set_meeting_tag',{meetingId,tagId:tag.id,assigned:!active});
    await load();
  };
  const create = async () => {
    if(!name.trim())return;
    try { const tag=await invoke<MeetingTag>('api_create_meeting_tag',{name,color});setName('');await invoke('api_set_meeting_tag',{meetingId,tagId:tag.id,assigned:true});await load(); }
    catch(error){toast.error('标签创建失败',{description:String(error)});}
  };
  const update = async () => {
    if (!editing || !editName.trim()) return;
    try { await invoke('api_update_meeting_tag',{tagId:editing.id,name:editName.trim(),color:editing.color});setEditing(null);await load(); }
    catch(error){toast.error('标签更新失败',{description:String(error)});}
  };
  const remove = async (tag: MeetingTag) => {
    try { await invoke('api_delete_meeting_tag',{tagId:tag.id});if(editing?.id===tag.id)setEditing(null);await load(); }
    catch(error){toast.error('标签删除失败',{description:String(error)});}
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-1.5">
    {assigned.map(tag=><span key={tag.id} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{backgroundColor:`${tag.color}18`,color:tag.color}}><span className="h-1.5 w-1.5 rounded-full" style={{backgroundColor:tag.color}}/>{tag.name}<button onClick={()=>void toggle(tag)} className="rounded-full opacity-50 hover:opacity-100" title="移除标签"><X className="h-2.5 w-2.5"/></button></span>)}
    <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><button className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-slate-200 px-2 text-[11px] text-slate-400 hover:border-violet-300 hover:text-violet-600" title="添加标签"><Plus className="h-3 w-3"/>标签</button></PopoverTrigger><PopoverContent align="start" className="w-80 p-2">
      <div className="max-h-56 space-y-1 overflow-y-auto">{all.map(tag=>{const active=assigned.some(item=>item.id===tag.id);return <div key={tag.id} className="flex items-center rounded-lg hover:bg-violet-50"><button onClick={()=>void toggle(tag)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{backgroundColor:tag.color}}/><span className="min-w-0 flex-1 truncate">{tag.name}</span><span className="text-[10px] text-slate-400">{tag.meetingCount}</span>{active&&<Check className="h-4 w-4 text-violet-600"/>}</button><button onClick={()=>{setEditing(tag);setEditName(tag.name);}} className="p-2 text-slate-300 hover:text-violet-600" title="编辑标签"><Pencil className="h-3.5 w-3.5"/></button><button onClick={()=>void remove(tag)} className="p-2 text-slate-300 hover:text-red-600" title="删除标签"><Trash2 className="h-3.5 w-3.5"/></button></div>})}</div>
      {editing?<div className="mt-2 space-y-2 border-t pt-2"><div className="flex gap-1"><input autoFocus value={editName} onChange={e=>setEditName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void update();}} className="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-sm"/><button onClick={()=>void update()} className="rounded-md bg-violet-600 px-3 text-xs text-white">保存</button><button onClick={()=>setEditing(null)} className="rounded-md border px-2 text-xs">取消</button></div><div className="flex gap-1.5">{colors.map(value=><button key={value} onClick={()=>setEditing({...editing,color:value})} className={`h-5 w-5 rounded-full ${editing.color===value?'ring-2 ring-offset-2 ring-violet-300':''}`} style={{backgroundColor:value}} aria-label={value}/>)}</div></div>:<div className="mt-2 space-y-2 border-t pt-2"><div className="flex gap-1"><div className="flex flex-1 items-center gap-2 rounded-md border px-2"><Tag className="h-3.5 w-3.5 text-slate-400"/><input value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void create();}} placeholder="新标签" className="min-w-0 flex-1 border-0 py-1.5 text-sm outline-none"/></div><button onClick={()=>void create()} disabled={!name.trim()} className="rounded-md bg-violet-600 px-3 text-xs text-white disabled:opacity-40">添加</button></div><div className="flex gap-1.5">{colors.map(value=><button key={value} onClick={()=>setColor(value)} className={`h-5 w-5 rounded-full ${color===value?'ring-2 ring-offset-2 ring-violet-300':''}`} style={{backgroundColor:value}} aria-label={value}/>)}</div></div>}
    </PopoverContent></Popover>
  </div>;
}
