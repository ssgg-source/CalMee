'use client';

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import { CheckCircle2, Loader2, RefreshCw, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';
import type { CustomModelKind, CustomModelProfile, CustomModelProtocol } from '@/hooks/useCustomModelProfiles';

type Draft = { protocol:CustomModelProtocol; displayName:string; endpoint:string; apiKey:string; model:string };
const emptyDraft = (kind:CustomModelKind):Draft => ({ protocol:'openai', displayName:'', endpoint:kind === 'ai' ? 'https://api.openai.com/v1' : '', apiKey:'', model:'' });

export function CustomModelProfileDialog({ open, onOpenChange, kind, profile, onSaved, onDeleted }:{
  open:boolean;
  onOpenChange:(value:boolean)=>void;
  kind:CustomModelKind;
  profile?:CustomModelProfile | null;
  onSaved:(profile:CustomModelProfile)=>void;
  onDeleted?:(id:string)=>void;
}) {
  const { locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const [draft,setDraft] = useState<Draft>(()=>emptyDraft(kind));
  const [models,setModels] = useState<string[]>([]);
  const [busy,setBusy] = useState<'save'|'test'|'models'|'delete'|null>(null);
  const hasRequiredKey = draft.protocol !== 'anthropic' || Boolean(draft.apiKey.trim() || profile?.hasApiKey);
  const canSubmit = Boolean(draft.displayName.trim() && draft.endpoint.trim() && draft.model.trim() && hasRequiredKey);

  useEffect(()=>{
    if(!open)return;
    setModels([]);
    setDraft(profile ? { protocol:profile.protocol,displayName:profile.displayName,endpoint:profile.endpoint,apiKey:'',model:profile.model } : emptyDraft(kind));
  },[open,profile,kind]);

  const helper = useMemo(()=> kind === 'transcription'
    ? (zh ? '填写 OpenAI 兼容的音频转写地址，例如 https://server.example.com/v1/audio/transcriptions。' : 'Enter an OpenAI-compatible audio transcription endpoint, such as https://server.example.com/v1/audio/transcriptions.')
    : draft.protocol === 'anthropic'
      ? (zh ? 'Anthropic 当前使用官方 api.anthropic.com 接口。' : 'Anthropic currently uses the official api.anthropic.com endpoint.')
      : (zh ? '填写 OpenAI 兼容服务的基础地址，例如 https://api.openai.com/v1。' : 'Enter an OpenAI-compatible base URL, such as https://api.openai.com/v1.'), [kind,draft.protocol,zh]);

  const discover = async()=>{
    setBusy('models');
    try{
      const result=await invoke<string[]>('api_discover_custom_profile_models',{id:profile?.id||null,protocol:draft.protocol,endpoint:draft.endpoint,apiKey:draft.apiKey||null});
      setModels(result);
      if(!draft.model&&result[0])setDraft(current=>({...current,model:result[0]}));
      toast.success(zh?'模型列表已更新':'Model list updated');
    }catch(error){reportTechnicalError('custom-model-discover',error);toast.error(zh?'无法读取模型列表':'Could not load models',{description:toUserFacingError(error,locale).message});}
    finally{setBusy(null);}
  };

  const test = async()=>{
    if(!canSubmit)return;
    setBusy('test');
    try{
      await invoke('api_test_custom_model_profile',{id:profile?.id||null,kind,protocol:draft.protocol,endpoint:draft.endpoint,apiKey:draft.apiKey||null,model:draft.model});
      toast.success(zh?'连接成功':'Connection successful',{description:zh?'服务已返回有效响应。':'The service returned a valid response.'});
    }catch(error){reportTechnicalError('custom-model-test',error);toast.error(zh?'连接失败':'Connection failed',{description:toUserFacingError(error,locale).message});}
    finally{setBusy(null);}
  };

  const save = async()=>{
    if(!canSubmit)return;
    setBusy('save');
    try{
      const saved=await invoke<CustomModelProfile>('api_save_custom_model_profile',{id:profile?.id||null,kind,protocol:draft.protocol,displayName:draft.displayName,endpoint:draft.endpoint,apiKey:draft.apiKey||null,model:draft.model});
      onSaved(saved);onOpenChange(false);toast.success(zh?'模型已保存':'Model saved');
    }catch(error){reportTechnicalError('custom-model-save',error);toast.error(zh?'模型保存失败':'Could not save model',{description:toUserFacingError(error,locale).message});}
    finally{setBusy(null);}
  };

  const remove = async()=>{
    if(!profile)return;
    setBusy('delete');
    try{await invoke('api_delete_custom_model_profile',{id:profile.id,kind});onDeleted?.(profile.id);onOpenChange(false);toast.success(zh?'模型已删除':'Model deleted');}
    catch(error){reportTechnicalError('custom-model-delete',error);toast.error(zh?'模型删除失败':'Could not delete model',{description:toUserFacingError(error,locale).message});}
    finally{setBusy(null);}
  };

  return <Dialog open={open} onOpenChange={busy?undefined:onOpenChange}><DialogContent className="sm:max-w-[560px]">
    <DialogHeader><DialogTitle>{profile?(zh?'编辑模型':'Edit model'):(zh?'添加模型':'Add model')}</DialogTitle></DialogHeader>
    <div className="grid gap-4 py-2">
      {kind==='ai'&&<div className="grid gap-2"><Label>{zh?'接口格式':'API format'}</Label><Select value={draft.protocol} onValueChange={value=>setDraft(current=>({...current,protocol:value as CustomModelProtocol,endpoint:value==='anthropic'?'https://api.anthropic.com':current.endpoint==='https://api.anthropic.com'?'https://api.openai.com/v1':current.endpoint}))}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="openai">OpenAI compatible</SelectItem><SelectItem value="anthropic">Anthropic</SelectItem></SelectContent></Select></div>}
      <div className="grid gap-2"><Label>{zh?'名称':'Name'}</Label><Input value={draft.displayName} onChange={event=>setDraft(current=>({...current,displayName:event.target.value}))} placeholder={kind==='transcription'?(zh?'团队转写服务器':'Team transcription server'):(zh?'公司大模型':'Company AI model')}/></div>
      <div className="grid gap-2"><Label>{zh?'服务地址':'Service URL'}</Label><Input value={draft.endpoint} onChange={event=>setDraft(current=>({...current,endpoint:event.target.value}))} disabled={draft.protocol==='anthropic'} placeholder="https://..."/><p className="text-xs leading-5 text-muted-foreground">{helper}</p></div>
      <div className="grid gap-2"><Label>API Key</Label><Input type="password" value={draft.apiKey} onChange={event=>setDraft(current=>({...current,apiKey:event.target.value}))} placeholder={profile?.hasApiKey?(zh?'已保存，留空表示不更改':'Saved. Leave empty to keep it'):'sk-...'}/></div>
      <div className="grid gap-2"><div className="flex items-center justify-between gap-3"><Label>{zh?'模型':'Model'}</Label><Button type="button" variant="ghost" size="sm" onClick={()=>void discover()} disabled={!draft.endpoint.trim()||busy!==null}>{busy==='models'?<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin"/>:<RefreshCw className="mr-1.5 h-3.5 w-3.5"/>}{zh?'读取模型':'Load models'}</Button></div>{models.length>0?<Select value={draft.model} onValueChange={model=>setDraft(current=>({...current,model}))}><SelectTrigger><SelectValue placeholder={zh?'选择模型':'Select model'}/></SelectTrigger><SelectContent className="max-h-64">{models.map(model=><SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent></Select>:<Input value={draft.model} onChange={event=>setDraft(current=>({...current,model:event.target.value}))} placeholder={zh?'输入模型名称，也可以先读取模型列表':'Enter a model name, or load the model list first'}/>}</div>
    </div>
    <DialogFooter className="flex-row items-center sm:justify-between"><div>{profile&&<Button type="button" variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={()=>void remove()} disabled={busy!==null}>{busy==='delete'?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<Trash2 className="mr-2 h-4 w-4"/>}{zh?'删除':'Delete'}</Button>}</div><div className="flex gap-2"><Button type="button" variant="outline" onClick={()=>void test()} disabled={!canSubmit||busy!==null}>{busy==='test'?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<CheckCircle2 className="mr-2 h-4 w-4"/>}{zh?'测试':'Test'}</Button><Button type="button" onClick={()=>void save()} disabled={!canSubmit||busy!==null}>{busy==='save'?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<Save className="mr-2 h-4 w-4"/>}{zh?'保存':'Save'}</Button></div></DialogFooter>
  </DialogContent></Dialog>;
}
