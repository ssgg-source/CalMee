"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfig } from "@/contexts/ConfigContext";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ModelConfig } from "@/components/ModelSettingsModal";
import { reportTechnicalError, toUserFacingError } from "@/lib/feedback";

const PROVIDERS: Array<{value:ModelConfig["provider"];label:string}> = [
  {value:"minimax",label:"MiniMax"},{value:"deepseek",label:"DeepSeek"},{value:"kimi",label:"Kimi"},
  {value:"qwen",label:"Qwen"},{value:"doubao",label:"Doubao"},{value:"zhipu",label:"Zhipu AI"},
  {value:"openai",label:"OpenAI"},{value:"claude",label:"Claude"},{value:"openrouter",label:"OpenRouter"},
  {value:"groq",label:"Groq"},{value:"gemini",label:"Gemini"},{value:"ollama",label:"Ollama"},
  {value:"builtin-ai",label:"Local AI"},{value:"custom-openai",label:"Custom OpenAI"},
];

export function PersonProfileGenerationDialog({open,onOpenChange,personId,personName,statementCount,onStarted}:{open:boolean;onOpenChange:(open:boolean)=>void;personId:string;personName:string;statementCount:number;onStarted:()=>void}){
  const {locale}=useLanguage(); const zh=locale==="zh-CN";
  const {modelConfig,modelOptions}=useConfig();
  const modelListId=useId();
  const [provider,setProvider]=useState<ModelConfig["provider"]>(modelConfig.provider);
  const [model,setModel]=useState(modelConfig.model);
  const [cloudConfirmed,setCloudConfirmed]=useState(false);
  const [starting,setStarting]=useState(false);
  useEffect(()=>{if(!open)return;setProvider(modelConfig.provider);setModel(modelConfig.provider==="custom-openai"?(modelConfig.customOpenAIModel||modelConfig.model):modelConfig.model);setCloudConfirmed(false);},[open,modelConfig]);
  const suggestions=useMemo(()=>Array.from(new Set([provider===modelConfig.provider?modelConfig.model:"",...(modelOptions[provider]||[])].filter(Boolean))),[modelConfig,modelOptions,provider]);
  const local=provider==="builtin-ai"||provider==="ollama";
  const providerLabel=PROVIDERS.find(item=>item.value===provider)?.label||provider;
  const changeProvider=(next:ModelConfig["provider"])=>{setProvider(next);setModel((next===modelConfig.provider?modelConfig.model:modelOptions[next]?.[0])||"");setCloudConfirmed(false);};
  const start=async()=>{if(!model.trim()||starting||!statementCount||(!local&&!cloudConfirmed))return;setStarting(true);try{
    await invoke("api_generate_person_profile",{personId,provider,model:model.trim(),allowCloud:!local&&cloudConfirmed});
    onOpenChange(false);onStarted();
    toast.info(zh?"人物画像正在后台生成":"Profile generation is running in the background",{description:zh?"你可以切换页面，CalMee 会继续处理。":"You can switch pages while CalMee continues processing."});
  }catch(error){reportTechnicalError("person-profile-start",error);toast.error(zh?"画像生成失败":"Profile generation failed",{description:toUserFacingError(error,locale).message});}finally{setStarting(false);}};
  return <Dialog open={open} onOpenChange={starting?undefined:onOpenChange}><DialogContent className="sm:max-w-[520px]"><DialogHeader><DialogTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-violet-600"/>{zh?"生成长期发言画像":"Generate speaking profile"}</DialogTitle><DialogDescription>{zh?`分析 ${personName} 的已确认发言，并为每项结论保留可核验证据。`:`Analyze ${personName}'s confirmed statements and retain verifiable evidence.`}</DialogDescription></DialogHeader><div className="grid gap-5 py-2"><div className="grid grid-cols-[180px_1fr] gap-3"><div className="grid gap-2"><Label>{zh?"AI 服务":"AI provider"}</Label><Select value={provider} onValueChange={value=>changeProvider(value as ModelConfig["provider"])} disabled={starting}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{PROVIDERS.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-2"><Label htmlFor={modelListId}>{zh?"AI 模型":"AI model"}</Label><input id={modelListId} list={`${modelListId}-options`} value={model} onChange={event=>setModel(event.target.value)} disabled={starting} placeholder={zh?"选择或输入模型名称":"Select or enter a model name"} className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-violet-200"/><datalist id={`${modelListId}-options`}>{suggestions.map(name=><option key={name} value={name}/>)}</datalist></div></div><div className={`rounded-xl border p-3 text-xs leading-5 ${local?"border-violet-100 bg-violet-50/70 text-violet-800":"border-amber-200 bg-amber-50 text-amber-800"}`}>{local?(zh?`约 ${statementCount} 段已绑定发言只在这台 Mac 上处理。单场会议只能形成初步观察。`:`About ${statementCount} linked statements stay on this Mac. Single-meeting results remain preliminary.`):<label className="flex cursor-pointer items-start gap-2"><input type="checkbox" checked={cloudConfirmed} onChange={event=>setCloudConfirmed(event.target.checked)} className="mt-1 h-4 w-4 accent-violet-600"/><span>{zh?`我允许 CalMee 将 ${personName} 的已确认发言发送给 ${providerLabel}，仅用于生成本次人物画像。`:`I allow CalMee to send ${personName}'s confirmed statements to ${providerLabel} only to generate this profile.`}</span></label>}</div></div><DialogFooter><Button variant="outline" onClick={()=>onOpenChange(false)} disabled={starting}>{zh?"取消":"Cancel"}</Button><Button onClick={()=>void start()} disabled={starting||!model.trim()||!statementCount||(!local&&!cloudConfirmed)} className="bg-violet-600 hover:bg-violet-700">{starting?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<Sparkles className="mr-2 h-4 w-4"/>}{starting?(zh?"正在启动…":"Starting…"):(zh?"生成画像":"Generate profile")}</Button></DialogFooter></DialogContent></Dialog>;
}
