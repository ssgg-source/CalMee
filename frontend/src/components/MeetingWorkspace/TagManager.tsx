"use client";

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import { Check, Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { ProductButton, ProductInput } from '@/components/ui/ProductControls';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

export type MeetingTag = { id: string; name: string; color: string; meetingCount: number };
const colors = ['#8B5CF6','#2563EB','#0891B2','#059669','#D97706','#EA580C','#E11D48','#64748B'];

export function TagManager({ meetingId }: { meetingId: string }) {
  const { locale }=useLanguage();const zh=locale==='zh-CN';
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
    catch(error){reportTechnicalError('tag-create',error);toast.error(zh?'标签创建失败':'Could not create tag',{description:toUserFacingError(error,locale).message});}
  };
  const update = async () => {
    if (!editing || !editName.trim()) return;
    try { await invoke('api_update_meeting_tag',{tagId:editing.id,name:editName.trim(),color:editing.color});setEditing(null);await load(); }
    catch(error){reportTechnicalError('tag-update',error);toast.error(zh?'标签更新失败':'Could not update tag',{description:toUserFacingError(error,locale).message});}
  };
  const remove = async (tag: MeetingTag) => {
    try { await invoke('api_delete_meeting_tag',{tagId:tag.id});if(editing?.id===tag.id)setEditing(null);await load(); }
    catch(error){reportTechnicalError('tag-delete',error);toast.error(zh?'标签删除失败':'Could not delete tag',{description:toUserFacingError(error,locale).message});}
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-1.5">
    {assigned.map(tag=><span key={tag.id} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium" style={{backgroundColor:`${tag.color}18`,color:tag.color}}><span className="h-1.5 w-1.5 rounded-full" style={{backgroundColor:tag.color}}/>{tag.name}<button onClick={()=>void toggle(tag)} className="rounded opacity-50 transition hover:opacity-100" title={zh?'移除标签':'Remove tag'}><X className="h-2.5 w-2.5"/></button></span>)}
    <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><button className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-border px-2 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:text-primary" title={zh?'添加标签':'Add tag'}><Plus className="h-3 w-3"/>{zh?'标签':'Tag'}</button></PopoverTrigger><PopoverContent align="start" className="w-80 p-2">
      <div className="max-h-56 space-y-1 overflow-y-auto">{all.map(tag=>{const active=assigned.some(item=>item.id===tag.id);return <div key={tag.id} className="flex items-center rounded-lg hover:bg-accent/60"><button onClick={()=>void toggle(tag)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-[13px]"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{backgroundColor:tag.color}}/><span className="min-w-0 flex-1 truncate">{tag.name}</span><span className="text-[10px] text-muted-foreground">{tag.meetingCount}</span>{active&&<Check className="h-4 w-4 text-primary"/>}</button><ProductButton size="icon" variant="ghost" onClick={()=>{setEditing(tag);setEditName(tag.name);}} title={zh?'编辑标签':'Edit tag'}><Pencil className="h-3.5 w-3.5"/></ProductButton><ProductButton size="icon" variant="ghost" onClick={()=>void remove(tag)} className="text-destructive hover:text-destructive" title={zh?'删除标签':'Delete tag'}><Trash2 className="h-3.5 w-3.5"/></ProductButton></div>})}</div>
      {editing?<div className="mt-2 space-y-2 border-t border-border/70 pt-2"><div className="flex gap-1"><ProductInput autoFocus value={editName} onChange={e=>setEditName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void update();}} className="min-w-0 flex-1"/><ProductButton size="sm" variant="primary" onClick={()=>void update()}>{zh?'保存':'Save'}</ProductButton><ProductButton size="sm" onClick={()=>setEditing(null)}>{zh?'取消':'Cancel'}</ProductButton></div><div className="flex gap-1.5">{colors.map(value=><button key={value} onClick={()=>setEditing({...editing,color:value})} className={`h-5 w-5 rounded-full ${editing.color===value?'ring-2 ring-primary/30 ring-offset-2':''}`} style={{backgroundColor:value}} aria-label={value}/>)}</div></div>:<div className="mt-2 space-y-2 border-t border-border/70 pt-2"><div className="flex gap-1"><div className="relative min-w-0 flex-1"><Tag className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground"/><ProductInput value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void create();}} placeholder={zh?'新标签':'New tag'} className="w-full pl-8"/></div><ProductButton size="sm" variant="primary" onClick={()=>void create()} disabled={!name.trim()}>{zh?'添加':'Add'}</ProductButton></div><div className="flex gap-1.5">{colors.map(value=><button key={value} onClick={()=>setColor(value)} className={`h-5 w-5 rounded-full ${color===value?'ring-2 ring-primary/30 ring-offset-2':''}`} style={{backgroundColor:value}} aria-label={value}/>)}</div></div>}
    </PopoverContent></Popover>
  </div>;
}
