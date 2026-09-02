"use client";

import { useEffect, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import { Copy, FileText, Plus, Save, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useLanguage, type AppLocale } from '@/contexts/LanguageContext';
import { ProductButton, ProductInput } from '@/components/ui/ProductControls';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

export type DocumentTemplate={id:string;kind:string;name:string;description:string;prompt:string;builtin:boolean};
const builtinZh:Record<string,{name:string;description:string}>={
  'smart-detailed':{name:'详细智能记录',description:'按主题完整整理，包含概览、章节、金句、待办与发言回顾。'},
  'smart-clean':{name:'精炼智能记录',description:'聚焦结论、决策、原因、风险和待办的精炼版本。'},
  'summary-standard':{name:'标准会议纪要',description:'包含总结、议题、决策、风险与待办事项。'},
  'summary-executive':{name:'管理层简报',description:'面向管理者的精炼、决策导向简报。'},
  'summary-actions':{name:'行动事项',description:'50字以内会议摘要，以及简洁、可执行的待办事项。'},
  'summary-speech':{name:'讲话总结',description:'按参会人整理主要观点、论证、要求、承诺与待办。'},
  'speech-complete':{name:'完整讲话记录',description:'某位参会人的完整连贯发言记录。'},
  'speech-points':{name:'观点与要点',description:'所选参会人的观点、要求与承诺。'},
  'speech-formal':{name:'正式讲话稿',description:'将某位参会人的完整发言提炼为可直接宣读或正式发布的讲话稿。'},
};
export function localizedTemplate(template:DocumentTemplate,locale:AppLocale){return locale==='zh-CN'&&builtinZh[template.id]?{...template,...builtinZh[template.id]}:template;}

export function TemplateManagerDialog({open,onOpenChange,kind,selectedId,onSelect}:{open:boolean;onOpenChange:(open:boolean)=>void;kind:'smart_record'|'meeting_summary'|'speech_summary';selectedId?:string;onSelect:(template:DocumentTemplate)=>void}){
  const { locale }=useLanguage();
  const zh=locale==='zh-CN';
  const [templates,setTemplates]=useState<DocumentTemplate[]>([]);const [editing,setEditing]=useState<DocumentTemplate|null>(null);const [saving,setSaving]=useState(false);
  const load=async()=>setTemplates(await invoke('api_list_document_templates',{kind}));
  useEffect(()=>{if(open)void load();},[open,kind]);
  const edit=(template?:DocumentTemplate)=>setEditing(template?{...template}:{id:'',kind,name:'',description:'',prompt:'',builtin:false});
  const duplicate=(template:DocumentTemplate)=>setEditing({...template,id:'',name:`${template.name} ${zh?'副本':'Copy'}`,builtin:false});
  const save=async()=>{if(!editing)return;setSaving(true);try{const result=await invoke<DocumentTemplate>('api_save_document_template',{id:editing.id||null,kind,name:editing.name,description:editing.description,prompt:editing.prompt});await load();setEditing(null);onSelect(result);toast.success(zh?'模板已保存':'Template saved');}catch(error){reportTechnicalError('template-save',error);toast.error(zh?'模板保存失败':'Could not save template',{description:toUserFacingError(error,locale).message});}finally{setSaving(false);}};
  const remove=async(template:DocumentTemplate)=>{if(template.builtin)return;try{await invoke('api_delete_document_template',{templateId:template.id});await load();}catch(error){reportTechnicalError('template-delete',error);toast.error(zh?'模板删除失败':'Could not delete template',{description:toUserFacingError(error,locale).message});}};
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-4xl"><DialogHeader><DialogTitle>{zh?'模板':'Templates'}</DialogTitle><DialogDescription>{zh?'选择内置模板，或创建适合团队的提示词模板。':'Choose a built-in template or create one for your team.'}</DialogDescription></DialogHeader>
    {editing?<div className="grid gap-4"><label className="text-xs text-muted-foreground">{zh?'模板名称':'Template name'}<ProductInput autoFocus value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})} className="mt-1 w-full"/></label><label className="text-xs text-muted-foreground">{zh?'用途说明':'Description'}<ProductInput value={editing.description} onChange={e=>setEditing({...editing,description:e.target.value})} className="mt-1 w-full"/></label><label className="text-xs text-muted-foreground">{zh?'提示词':'Prompt'}<textarea value={editing.prompt} onChange={e=>setEditing({...editing,prompt:e.target.value})} className="mt-1 min-h-[300px] w-full resize-y rounded-lg border border-input bg-card px-3 py-3 font-mono text-[13px] leading-6 outline-none focus:border-primary/70 focus:ring-2 focus:ring-primary/15"/></label><div className="flex justify-end gap-2"><ProductButton onClick={()=>setEditing(null)}>{zh?'取消':'Cancel'}</ProductButton><ProductButton variant="primary" disabled={saving||!editing.name.trim()||!editing.prompt.trim()} onClick={()=>void save()}><Save className="h-4 w-4"/>{zh?'保存':'Save'}</ProductButton></div></div>:<><div className="grid max-h-[480px] grid-cols-2 gap-3 overflow-y-auto pr-1">{templates.map(template=>{const display=localizedTemplate(template,locale);return <div key={template.id} className={`rounded-xl border p-4 transition ${selectedId===template.id?'border-primary/40 bg-primary/10':'border-border/70 hover:bg-accent/40'}`}><button onClick={()=>{onSelect(template);onOpenChange(false);}} className="w-full text-left"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-primary"/><span className="font-medium text-foreground">{display.name}</span>{template.builtin&&<span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{zh?'内置':'Built-in'}</span>}</div><p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{display.description}</p></button><div className="mt-3 flex gap-1 border-t border-border/60 pt-2"><ProductButton size="icon" variant="ghost" onClick={()=>duplicate(template)} title={zh?'复制模板':'Duplicate template'}><Copy className="h-3.5 w-3.5"/></ProductButton>{!template.builtin&&<><ProductButton size="sm" variant="ghost" onClick={()=>edit(template)}>{zh?'编辑':'Edit'}</ProductButton><ProductButton size="icon" variant="ghost" onClick={()=>void remove(template)} className="ml-auto text-destructive hover:text-destructive" title={zh?'删除模板':'Delete template'}><Trash2 className="h-3.5 w-3.5"/></ProductButton></>}</div></div>})}</div><ProductButton onClick={()=>edit()} className="mt-3 border-dashed text-primary"><Plus className="h-4 w-4"/>{zh?'新建模板':'New template'}</ProductButton></>}
  </DialogContent></Dialog>;
}
