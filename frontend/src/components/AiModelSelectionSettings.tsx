'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import { Cloud, Loader2, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { BuiltInModelManager } from '@/components/BuiltInModelManager';
import { CustomModelProfileDialog } from '@/components/CustomModelProfileDialog';
import type { ModelConfig } from '@/components/ModelSettingsModal';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { useCustomModelProfiles, type CustomModelProfile } from '@/hooks/useCustomModelProfiles';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

type LocalFamily='qwen'|'gemma';

export function AiModelSelectionSettings({modelConfig,setModelConfig,onSave}:{modelConfig:ModelConfig;setModelConfig:(config:ModelConfig)=>void;onSave:(config:ModelConfig)=>Promise<void>}){
  const {lt,locale}=useLanguage();
  const zh=locale==='zh-CN';
  const {profiles,loading,refresh}=useCustomModelProfiles('ai');
  const [selection,setSelection]=useState<string>(modelConfig.provider==='builtin-ai'?(modelConfig.model.toLowerCase().includes('gemma')?'local:gemma':'local:qwen'):'');
  const [dialogOpen,setDialogOpen]=useState(false);
  const [editing,setEditing]=useState<CustomModelProfile|null>(null);
  const [activating,setActivating]=useState(false);
  const family:LocalFamily|null=selection==='local:qwen'?'qwen':selection==='local:gemma'?'gemma':null;
  const selectedProfile=selection.startsWith('profile:')?profiles.find(profile=>`profile:${profile.id}`===selection):undefined;

  useEffect(()=>{
    if(modelConfig.provider==='builtin-ai'){
      setSelection(modelConfig.model.toLowerCase().includes('gemma')?'local:gemma':'local:qwen');
      return;
    }
    const protocol=modelConfig.provider==='claude'?'anthropic':'openai';
    const match=profiles.find(profile=>profile.protocol===protocol&&profile.model===modelConfig.model);
    setSelection(match?`profile:${match.id}`:'');
  },[modelConfig.provider,modelConfig.model,profiles]);

  const selectLocal=async(model:string)=>{
    const next={...modelConfig,provider:'builtin-ai' as const,model};
    setModelConfig(next);
    await onSave(next);
  };

  const activateProfile=async(profile:CustomModelProfile)=>{
    setActivating(true);
    try{
      const active=await invoke<{provider:ModelConfig['provider'];model:string}>('api_activate_custom_model_profile',{id:profile.id});
      const next={...modelConfig,provider:active.provider,model:active.model,apiKey:null};
      setModelConfig(next);
      const {emit}=await import('@tauri-apps/api/event');
      await emit('model-config-updated',next);
      toast.success(zh?'AI 模型已选择':'AI model selected',{description:profile.displayName});
    }catch(error){reportTechnicalError('activate-ai-profile',error);toast.error(zh?'无法选择该模型':'Could not select this model',{description:toUserFacingError(error,locale).message});}
    finally{setActivating(false);}
  };

  const choose=(value:string)=>{
    if(value==='__add__'){setEditing(null);setDialogOpen(true);return;}
    setSelection(value);
    const profile=profiles.find(item=>`profile:${item.id}`===value);
    if(profile)void activateProfile(profile);
  };

  return <div className="space-y-5">
    <div><Label className="mb-2 block text-sm font-medium">{zh?'模型':'Model'}</Label><Select value={selection} onValueChange={choose} disabled={loading||activating}><SelectTrigger className="max-w-xl"><SelectValue placeholder={loading?lt('Loading…'):lt('Select model')}/></SelectTrigger><SelectContent>
      <SelectGroup><SelectLabel>{zh?'本地模型':'Local models'}</SelectLabel><SelectItem value="local:qwen">Qwen</SelectItem><SelectItem value="local:gemma">Gemma</SelectItem></SelectGroup>
      {profiles.length>0&&<SelectGroup><SelectLabel>{zh?'已添加的云端模型':'Saved cloud models'}</SelectLabel>{profiles.map(profile=><SelectItem key={profile.id} value={`profile:${profile.id}`}>{profile.displayName} · {profile.model}</SelectItem>)}</SelectGroup>}
      <SelectGroup><SelectLabel>{zh?'模型管理':'Model management'}</SelectLabel><SelectItem value="__add__"><span className="flex items-center gap-2"><Plus className="h-4 w-4"/>{zh?'添加模型':'Add model'}</span></SelectItem></SelectGroup>
    </SelectContent></Select></div>
    {family&&<BuiltInModelManager family={family} selectedModel={modelConfig.provider==='builtin-ai'?modelConfig.model:''} onModelSelect={model=>void selectLocal(model)}/>}
    {selectedProfile&&<div className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3"><Cloud className="h-5 w-5 text-primary"/><div className="min-w-0 flex-1"><div className="font-medium text-foreground">{selectedProfile.displayName}</div><div className="mt-0.5 truncate text-xs text-muted-foreground">{selectedProfile.protocol==='anthropic'?'Anthropic':'OpenAI compatible'} · {selectedProfile.model} · {selectedProfile.endpoint}</div></div>{activating?<Loader2 className="h-4 w-4 animate-spin text-muted-foreground"/>:<Button variant="outline" size="sm" onClick={()=>{setEditing(selectedProfile);setDialogOpen(true);}}><Pencil className="mr-2 h-4 w-4"/>{zh?'编辑':'Edit'}</Button>}</div>}
    <CustomModelProfileDialog open={dialogOpen} onOpenChange={setDialogOpen} kind="ai" profile={editing} onSaved={profile=>{void refresh();setSelection(`profile:${profile.id}`);void activateProfile(profile);}} onDeleted={()=>{void refresh();setSelection('local:qwen');}}/>
  </div>;
}
