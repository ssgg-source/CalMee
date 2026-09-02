'use client';

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import { Cloud, Loader2, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ModelManager } from '@/components/WhisperModelManager';
import { ParakeetModelManager } from '@/components/ParakeetModelManager';
import { FunAsrSettings } from '@/components/FunAsrSettings';
import { CustomModelProfileDialog } from '@/components/CustomModelProfileDialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { useCustomModelProfiles, type CustomModelProfile } from '@/hooks/useCustomModelProfiles';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

export type TranscriptProvider = 'none' | 'localWhisper' | 'parakeet' | 'funasr' | 'qwen3asr' | 'funasr-server' | 'deepgram' | 'groq' | 'openai' | 'qwen-cloud' | 'doubao' | 'tencent-asr' | 'baidu-asr' | 'iflytek-asr' | 'huawei-asr';
export interface TranscriptModelProps { provider: TranscriptProvider; model: string; apiKey?: string | null }
export interface TranscriptSettingsProps { transcriptModelConfig: TranscriptModelProps; setTranscriptModelConfig: (config: TranscriptModelProps) => void; onModelSelect?: () => void }

type LocalProvider = 'localWhisper' | 'parakeet' | 'funasr' | 'qwen3asr';
const localProviders:LocalProvider[]=['funasr','qwen3asr','localWhisper','parakeet'];

export function TranscriptSettings({ transcriptModelConfig, setTranscriptModelConfig, onModelSelect }: TranscriptSettingsProps) {
  const { lt, locale }=useLanguage();
  const zh=locale==='zh-CN';
  const { profiles,loading,refresh }=useCustomModelProfiles('transcription');
  const initialLocal=localProviders.includes(transcriptModelConfig.provider as LocalProvider)?transcriptModelConfig.provider as LocalProvider:'funasr';
  const [selection,setSelection]=useState<string>(initialLocal);
  const [dialogOpen,setDialogOpen]=useState(false);
  const [editing,setEditing]=useState<CustomModelProfile|null>(null);
  const [activating,setActivating]=useState(false);
  const selectedProfile=selection.startsWith('profile:')?profiles.find(profile=>`profile:${profile.id}`===selection):undefined;
  const localProvider=localProviders.includes(selection as LocalProvider)?selection as LocalProvider:null;

  useEffect(()=>{
    if(localProviders.includes(transcriptModelConfig.provider as LocalProvider)){
      setSelection(transcriptModelConfig.provider);
      return;
    }
    if(transcriptModelConfig.provider==='funasr-server'){
      const active=profiles.find(profile=>profile.model===transcriptModelConfig.model);
      if(active)setSelection(`profile:${active.id}`);
    }
  },[profiles,transcriptModelConfig.model,transcriptModelConfig.provider]);

  const selectLocal=(provider:LocalProvider,model:string)=>{
    setTranscriptModelConfig({provider,model,apiKey:null});
    onModelSelect?.();
  };

  const activateProfile=async(profile:CustomModelProfile)=>{
    setActivating(true);
    try{
      await invoke('api_activate_custom_model_profile',{id:profile.id});
      setTranscriptModelConfig({provider:'funasr-server',model:profile.model,apiKey:null});
      onModelSelect?.();
      toast.success(zh?'转写模型已选择':'Transcription model selected',{description:profile.displayName});
    }catch(error){reportTechnicalError('activate-transcription-profile',error);toast.error(zh?'无法选择该模型':'Could not select this model',{description:toUserFacingError(error,locale).message});}
    finally{setActivating(false);}
  };

  const handleSelection=(value:string)=>{
    if(value==='__add__'){setEditing(null);setDialogOpen(true);return;}
    setSelection(value);
    const profile=profiles.find(item=>`profile:${item.id}`===value);
    if(profile)void activateProfile(profile);
  };

  const localManager=useMemo(()=>{
    if(localProvider==='localWhisper')return <ModelManager selectedModel={transcriptModelConfig.provider==='localWhisper'?transcriptModelConfig.model:undefined} onModelSelect={model=>selectLocal('localWhisper',model)} autoSave/>;
    if(localProvider==='parakeet')return <ParakeetModelManager selectedModel={transcriptModelConfig.provider==='parakeet'?transcriptModelConfig.model:undefined} onModelSelect={model=>selectLocal('parakeet',model)} autoSave/>;
    if(localProvider==='funasr')return <FunAsrSettings family="funasr" selectedModel={transcriptModelConfig.provider==='funasr'?transcriptModelConfig.model:undefined} onSelected={model=>selectLocal('funasr',model)}/>;
    if(localProvider==='qwen3asr')return <FunAsrSettings family="qwen3asr" selectedModel={transcriptModelConfig.provider==='qwen3asr'?transcriptModelConfig.model:undefined} onSelected={model=>selectLocal('qwen3asr',model)}/>;
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[localProvider,transcriptModelConfig.provider,transcriptModelConfig.model]);

  return <div className="space-y-5 pb-6">
    <div>
      <h2 className="text-lg font-semibold text-foreground">{zh?'模型选择':'Model selection'}</h2>
      <p className="mb-4 mt-1 text-xs leading-5 text-muted-foreground">{zh?'管理本地模型和多个云端连接。会议转写时仍可针对每次任务重新选择。':'Manage local models and multiple cloud connections. You can still choose a model for each transcription task.'}</p>
      <Label className="mb-2 block text-sm font-medium">{zh?'模型':'Model'}</Label>
      <Select value={selection} onValueChange={handleSelection} disabled={loading||activating}><SelectTrigger className="max-w-xl"><SelectValue placeholder={loading?lt('Loading…'):lt('Select model')}/></SelectTrigger><SelectContent>
        <SelectGroup><SelectLabel>{zh?'本地模型':'Local models'}</SelectLabel><SelectItem value="funasr">FunASR</SelectItem><SelectItem value="qwen3asr">Qwen3-ASR</SelectItem><SelectItem value="localWhisper">Whisper</SelectItem><SelectItem value="parakeet">Parakeet</SelectItem></SelectGroup>
        {profiles.length>0&&<SelectGroup><SelectLabel>{zh?'已添加的云端模型':'Saved cloud models'}</SelectLabel>{profiles.map(profile=><SelectItem key={profile.id} value={`profile:${profile.id}`}>{profile.displayName} · {profile.model}</SelectItem>)}</SelectGroup>}
        <SelectGroup><SelectLabel>{zh?'模型管理':'Model management'}</SelectLabel><SelectItem value="__add__"><span className="flex items-center gap-2"><Plus className="h-4 w-4"/>{zh?'添加模型':'Add model'}</span></SelectItem></SelectGroup>
      </SelectContent></Select>
    </div>
    {localProvider&&<div>{localManager}</div>}
    {selectedProfile&&<div className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3"><Cloud className="h-5 w-5 text-primary"/><div className="min-w-0 flex-1"><div className="font-medium text-foreground">{selectedProfile.displayName}</div><div className="mt-0.5 truncate text-xs text-muted-foreground">{selectedProfile.model} · {selectedProfile.endpoint}</div></div>{activating?<Loader2 className="h-4 w-4 animate-spin text-muted-foreground"/>:<Button variant="outline" size="sm" onClick={()=>{setEditing(selectedProfile);setDialogOpen(true);}}><Pencil className="mr-2 h-4 w-4"/>{zh?'编辑':'Edit'}</Button>}</div>}
    <CustomModelProfileDialog open={dialogOpen} onOpenChange={setDialogOpen} kind="transcription" profile={editing} onSaved={profile=>{void refresh();setSelection(`profile:${profile.id}`);void activateProfile(profile);}} onDeleted={()=>{void refresh();setSelection('funasr');}}/>
  </div>;
}
