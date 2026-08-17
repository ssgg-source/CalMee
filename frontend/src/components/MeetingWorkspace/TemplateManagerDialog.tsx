"use client";

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, FileText, Plus, Save, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useLanguage, type AppLocale } from '@/contexts/LanguageContext';

export type DocumentTemplate={id:string;kind:string;name:string;description:string;prompt:string;builtin:boolean};
const builtinZh:Record<string,{name:string;description:string}>={
  'smart-detailed':{name:'详细智能记录',description:'按主题完整整理，包含概览、章节、金句、待办与发言回顾。'},
  'smart-clean':{name:'精炼智能记录',description:'聚焦结论、决策、原因、风险和待办的精炼版本。'},
  'summary-standard':{name:'标准会议纪要',description:'包含总结、议题、决策、风险与待办事项。'},
  'summary-executive':{name:'管理层简报',description:'面向管理者的精炼、决策导向简报。'},
  'summary-actions':{name:'行动事项',description:'50字以内会议摘要，以及简洁、可执行的待办事项。'},
  'speech-complete':{name:'完整讲话记录',description:'某位参会人的完整连贯发言记录。'},
  'speech-points':{name:'观点与要点',description:'所选参会人的观点、要求与承诺。'},
  'speech-formal':{name:'正式讲话稿',description:'将某位参会人的完整发言提炼为可直接宣读或正式发布的讲话稿。'},
};
export function localizedTemplate(template:DocumentTemplate,locale:AppLocale){return locale==='zh-CN'&&builtinZh[template.id]?{...template,...builtinZh[template.id]}:template;}

export function TemplateManagerDialog({open,onOpenChange,kind,selectedId,onSelect}:{open:boolean;onOpenChange:(open:boolean)=>void;kind:'smart_record'|'meeting_summary'|'speech_summary';selectedId?:string;onSelect:(template:DocumentTemplate)=>void}){
  const { locale }=useLanguage();
  const [templates,setTemplates]=useState<DocumentTemplate[]>([]);const [editing,setEditing]=useState<DocumentTemplate|null>(null);const [saving,setSaving]=useState(false);
  const load=async()=>setTemplates(await invoke('api_list_document_templates',{kind}));
  useEffect(()=>{if(open)void load();},[open,kind]);
  const edit=(template?:DocumentTemplate)=>setEditing(template?{...template}:{id:'',kind,name:'',description:'',prompt:'',builtin:false});
  const duplicate=(template:DocumentTemplate)=>setEditing({...template,id:'',name:`${template.name} Copy`,builtin:false});
  const save=async()=>{if(!editing)return;setSaving(true);try{const result=await invoke<DocumentTemplate>('api_save_document_template',{id:editing.id||null,kind,name:editing.name,description:editing.description,prompt:editing.prompt});await load();setEditing(null);onSelect(result);toast.success('模板已保存');}catch(error){toast.error('模板保存失败',{description:String(error)});}finally{setSaving(false);}};
  const remove=async(template:DocumentTemplate)=>{if(template.builtin)return;await invoke('api_delete_document_template',{templateId:template.id});await load();};
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-4xl"><DialogHeader><DialogTitle>模板</DialogTitle></DialogHeader>
    {editing?<div className="grid gap-4"><label className="text-xs text-slate-500">{locale==='zh-CN'?'模板名称':'Template name'}<input autoFocus value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})} className="mt-1 w-full rounded-xl border px-3 py-2 text-sm text-slate-800"/></label><label className="text-xs text-slate-500">{locale==='zh-CN'?'用途说明':'Description'}<input value={editing.description} onChange={e=>setEditing({...editing,description:e.target.value})} className="mt-1 w-full rounded-xl border px-3 py-2 text-sm text-slate-800"/></label><label className="text-xs text-slate-500">{locale==='zh-CN'?'提示词':'Prompt'}<textarea value={editing.prompt} onChange={e=>setEditing({...editing,prompt:e.target.value})} className="mt-1 min-h-[300px] w-full resize-y rounded-xl border px-3 py-3 font-mono text-sm leading-6 text-slate-800"/></label><div className="flex justify-end gap-2"><button onClick={()=>setEditing(null)} className="rounded-lg border px-4 py-2 text-sm">{locale==='zh-CN'?'取消':'Cancel'}</button><button disabled={saving||!editing.name.trim()||!editing.prompt.trim()} onClick={()=>void save()} className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm text-white disabled:opacity-40"><Save className="h-4 w-4"/>{locale==='zh-CN'?'保存':'Save'}</button></div></div>:<><div className="grid max-h-[480px] grid-cols-2 gap-3 overflow-y-auto pr-1">{templates.map(template=>{const display=localizedTemplate(template,locale);return <div key={template.id} className={`rounded-2xl border p-4 transition ${selectedId===template.id?'border-violet-300 bg-violet-50':'border-slate-100 hover:border-violet-200'}`}><button onClick={()=>{onSelect(template);onOpenChange(false);}} className="w-full text-left"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-violet-600"/><span className="font-medium text-slate-800">{display.name}</span>{template.builtin&&<span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">{locale==='zh-CN'?'内置':'Built-in'}</span>}</div><p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{display.description}</p></button><div className="mt-3 flex gap-1 border-t border-slate-100 pt-2"><button onClick={()=>duplicate(template)} className="rounded-md p-1.5 text-slate-400 hover:bg-white hover:text-violet-600" title={locale==='zh-CN'?'复制模板':'Duplicate template'}><Copy className="h-3.5 w-3.5"/></button>{!template.builtin&&<><button onClick={()=>edit(template)} className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-white">{locale==='zh-CN'?'编辑':'Edit'}</button><button onClick={()=>void remove(template)} className="ml-auto rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title={locale==='zh-CN'?'删除模板':'Delete template'}><Trash2 className="h-3.5 w-3.5"/></button></>}</div></div>})}</div><button onClick={()=>edit()} className="mt-3 inline-flex items-center gap-2 rounded-xl border border-dashed border-violet-200 px-4 py-2 text-sm text-violet-700 hover:bg-violet-50"><Plus className="h-4 w-4"/>{locale==='zh-CN'?'新建模板':'New template'}</button></>}
  </DialogContent></Dialog>;
}
