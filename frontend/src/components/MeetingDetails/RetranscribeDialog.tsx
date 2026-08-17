'use client';

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Cpu, FileAudio, Globe2, Loader2, MessageSquareText, RefreshCw, SlidersHorizontal, UserRound, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { LANGUAGES } from '@/constants/languages';
import { useConfig } from '@/contexts/ConfigContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { ModelOption, useTranscriptionModels } from '@/hooks/useTranscriptionModels';

interface RetranscribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  meetingFolderPath: string | null;
  onStarted?: () => void;
  onComplete?: () => void;
}

type Hotword = { term: string; enabled: boolean };
type WorkflowMode = 'meeting' | 'single';
type RetranscriptionPreferences = { modelKey?:string;language?:string;mode?:WorkflowMode|'global'|'custom';globalVoiceprintMatching?:boolean;useHotwords?:boolean;punctuation?:boolean;itn?:boolean;vadEnabled?:boolean;vadMaxSegmentMs?:string;mergeVad?:boolean;mergeLengthS?:string;speakerMode?:'default'|'vad_segment'|'punc_segment' };
const PREFERENCES_KEY='calmee.retranscription.preferences.v1';
type FunAsrConfig = {
  model: string;
  hub: 'ms' | 'hf';
  language: string;
  speaker_enabled: boolean;
  punc_enabled: boolean;
  use_itn: boolean;
  sentence_timestamp: boolean;
  vad_enabled: boolean;
  vad_max_segment_ms: number;
  merge_vad: boolean;
  merge_length_s: number;
  speaker_mode: 'default' | 'vad_segment' | 'punc_segment';
  preset_speaker_count?: number | null;
  hotwords: string;
  [key: string]: unknown;
};

const filename = (path: string | null) => path?.split(/[\\/]/).pop() || '';

export function RetranscribeDialog({ open, onOpenChange, meetingId, meetingFolderPath, onStarted, onComplete }: RetranscribeDialogProps) {
  const { locale, lt } = useLanguage();
  const zh = locale === 'zh-CN';
  const { selectedLanguage, transcriptModelConfig } = useConfig();
  const [language, setLanguage] = useState(selectedLanguage || 'auto');
  const [mode, setMode] = useState<WorkflowMode>('meeting');
  const [globalVoiceprintMatching, setGlobalVoiceprintMatching] = useState(true);
  const [useHotwords, setUseHotwords] = useState(true);
  const [punctuation, setPunctuation] = useState(true);
  const [itn, setItn] = useState(true);
  const [vadEnabled, setVadEnabled] = useState(true);
  const [vadMaxSegmentMs, setVadMaxSegmentMs] = useState('60000');
  const [mergeVad, setMergeVad] = useState(true);
  const [mergeLengthS, setMergeLengthS] = useState('15');
  const [speakerMode, setSpeakerMode] = useState<'default' | 'vad_segment' | 'punc_segment'>('punc_segment');
  const [hotwords, setHotwords] = useState<Hotword[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [preferencesReady,setPreferencesReady]=useState(false);
  const { availableModels, selectedModelKey, setSelectedModelKey, loadingModels, fetchModels, resetSelection } = useTranscriptionModels(transcriptModelConfig);

  const selectedModel = useMemo<ModelOption | undefined>(() => {
    const split = selectedModelKey.indexOf(':');
    if (split < 0) return undefined;
    const provider = selectedModelKey.slice(0, split);
    const name = selectedModelKey.slice(split + 1);
    return availableModels.find(item => item.provider === provider && item.name === name);
  }, [availableModels, selectedModelKey]);
  const compatibleModels=availableModels;
  const selectedProvider=(selectedModel&&compatibleModels.includes(selectedModel)?selectedModel:compatibleModels[0])?.provider;
  const providerOptions=useMemo(()=>Array.from(new Set(compatibleModels.map(item=>item.provider))),[compatibleModels]);
  const providerModels=useMemo(()=>compatibleModels.filter(item=>item.provider===selectedProvider),[compatibleModels,selectedProvider]);
  const providerLabel=(value:ModelOption['provider'])=>value==='whisper'?'Whisper':value==='parakeet'?'Parakeet':value==='funasr'?'FunASR':'Qwen3-ASR';
  const funAsrFamily = selectedModel?.provider === 'funasr' || selectedModel?.provider === 'qwen3asr';
  const supportsHotwords = Boolean(selectedModel?.capabilities.includes('hotwords'));
  const supportsPunctuation = Boolean(selectedModel?.capabilities.includes('punctuation'));
  const supportsVad = Boolean(selectedModel?.capabilities.includes('vad'));
  const speakerEnabled = mode !== 'single';
  const fixedAutoLanguage = selectedModel?.provider === 'parakeet';

  useEffect(() => {
    if (!open) return;
    setPreferencesReady(false);
    resetSelection();
    let saved:RetranscriptionPreferences={};try{saved=JSON.parse(window.localStorage.getItem(PREFERENCES_KEY)||'{}');}catch{saved={};}
    if(saved.modelKey)setSelectedModelKey(saved.modelKey);
    setLanguage(saved.language||selectedLanguage||'auto');
    setMode(saved.mode==='single'?'single':'meeting');
    setGlobalVoiceprintMatching(saved.globalVoiceprintMatching??true);
    setUseHotwords(saved.useHotwords??true);
    setPunctuation(saved.punctuation??true);
    setItn(saved.itn??true);
    setVadEnabled(saved.vadEnabled??true);
    setVadMaxSegmentMs(saved.vadMaxSegmentMs||'60000');
    setMergeVad(saved.mergeVad??true);
    setMergeLengthS(saved.mergeLengthS||'15');
    setSpeakerMode(saved.speakerMode||'punc_segment');
    setError('');
    void fetchModels();
    invoke<Hotword[]>('api_list_hotwords').then(setHotwords).catch(() => setHotwords([]));
    setPreferencesReady(true);
  }, [open, selectedLanguage, resetSelection, fetchModels, setSelectedModelKey]);

  useEffect(()=>{if(!open||!preferencesReady)return;const preferences:RetranscriptionPreferences={modelKey:selectedModelKey,language,mode,globalVoiceprintMatching,useHotwords,punctuation,itn,vadEnabled,vadMaxSegmentMs,mergeVad,mergeLengthS,speakerMode};window.localStorage.setItem(PREFERENCES_KEY,JSON.stringify(preferences));},[open,preferencesReady,selectedModelKey,language,mode,globalVoiceprintMatching,useHotwords,punctuation,itn,vadEnabled,vadMaxSegmentMs,mergeVad,mergeLengthS,speakerMode]);

  useEffect(()=>{if(!open||loadingModels||availableModels.length===0)return;const exists=availableModels.some(item=>`${item.provider}:${item.name}`===selectedModelKey);if(!exists)setSelectedModelKey(`${availableModels[0].provider}:${availableModels[0].name}`);},[open,loadingModels,availableModels,selectedModelKey,setSelectedModelKey]);

  useEffect(() => {
    if (fixedAutoLanguage && language !== 'auto') setLanguage('auto');
  }, [fixedAutoLanguage, language]);

  useEffect(()=>{
    if(!open||loadingModels||compatibleModels.length===0)return;
    if(!selectedModel||!compatibleModels.includes(selectedModel))setSelectedModelKey(`${compatibleModels[0].provider}:${compatibleModels[0].name}`);
  },[open,loadingModels,compatibleModels,selectedModel,setSelectedModelKey]);

  useEffect(() => {
    if (!onComplete) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<any>('retranscription-complete', event => {
      if (event.payload.meeting_id === meetingId) onComplete();
    }).then(value => { if (disposed) value(); else unlisten = value; });
    return () => { disposed = true; unlisten?.(); };
  }, [meetingId, onComplete]);

  const start = async () => {
    if (!meetingFolderPath || !selectedModel || starting) return;
    setStarting(true);
    setError('');
    try {
      const languageValue = fixedAutoLanguage || language === 'auto' ? null : language;
      if (funAsrFamily) {
        const config = await invoke<FunAsrConfig>('funasr_get_config');
        const terms = hotwords.filter(item => item.enabled).map(item => item.term.trim()).filter(Boolean);
        await invoke('funasr_save_config', {
          config: {
            ...config,
            model: selectedModel.name,
            hub: selectedModel.provider === 'qwen3asr' ? 'hf' : 'ms',
            language: languageValue || 'auto',
            speaker_enabled: speakerEnabled,
            punc_enabled: supportsPunctuation && punctuation,
            use_itn: itn,
            sentence_timestamp: true,
            // Qwen3-ASR does not own a diarizer. In Meeting mode CalMee adds
            // FSMN-VAD + CAM++ through the shared FunASR sidecar.
            vad_enabled: speakerEnabled || (supportsVad && vadEnabled),
            vad_max_segment_ms: Number(vadMaxSegmentMs),
            merge_vad: mergeVad,
            merge_length_s: Number(mergeLengthS),
            speaker_mode: selectedModel.provider === 'qwen3asr' && speakerEnabled ? 'vad_segment' : speakerMode,
            preset_speaker_count: null,
            hotwords: useHotwords && supportsHotwords ? terms.join(' ') : '',
          },
        });
      } else if (speakerEnabled) {
        const config = await invoke<FunAsrConfig>('funasr_get_config');
        await invoke('funasr_save_config', {
          config: {
            ...config,
            preset_speaker_count: null,
          },
        });
      }
      await invoke('start_retranscription_command', {
        meetingId,
        meetingFolderPath,
        language: languageValue,
        model: selectedModel.name,
        provider: selectedModel.provider,
        workflowMode: mode,
        globalVoiceprintMatching: mode === 'meeting' && globalVoiceprintMatching,
      });
      const preferences:RetranscriptionPreferences={modelKey:selectedModelKey,language,mode,globalVoiceprintMatching,useHotwords,punctuation,itn,vadEnabled,vadMaxSegmentMs,mergeVad,mergeLengthS,speakerMode};
      window.localStorage.setItem(PREFERENCES_KEY,JSON.stringify(preferences));
      onStarted?.();
      onOpenChange(false);
      toast.info(zh ? '转写已在后台开始' : 'Transcription started in the background');
    } catch (reason) {
      const message = String(reason);
      setError(message);
      toast.error(zh ? '无法开始转写' : 'Could not start transcription', { description: message });
    } finally {
      setStarting(false);
    }
  };

  return <Dialog open={open} onOpenChange={starting ? undefined : onOpenChange}>
    <DialogContent className="overflow-hidden p-0 sm:max-w-[600px]">
      <DialogHeader className="border-b border-slate-100 px-6 pb-5 pt-6">
        <DialogTitle className="flex items-center gap-2 text-lg"><RefreshCw className="h-5 w-5 text-violet-600" />{zh ? '语音转写设置' : 'Speech transcription'}</DialogTitle>
        <DialogDescription>{zh ? '选择识别模型和本次任务参数；成功开始后将记住这些选项。' : 'Choose the ASR model and task settings. Successful choices are remembered.'}</DialogDescription>
      </DialogHeader>

      <div className="max-h-[68vh] space-y-5 overflow-y-auto px-6 py-5">
        <div className="flex items-center gap-3 rounded-xl border border-violet-100 bg-violet-50/60 px-4 py-3">
          <FileAudio className="h-5 w-5 shrink-0 text-violet-600" />
          <div className="min-w-0"><div className="truncate text-sm font-medium text-slate-700">{filename(meetingFolderPath)}</div><div className="mt-0.5 text-xs text-slate-400">{zh ? '已载入播放器并绑定到当前会议' : 'Loaded in the player and attached to this meeting'}</div></div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4"><Label className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-slate-400" />{zh ? '转写工作流' : 'Transcription workflow'}</Label><label className={`flex items-center gap-2 text-xs ${mode==='meeting'?'text-slate-600':'text-slate-300'}`}><span>{zh?'全局声纹匹配':'Global voiceprint matching'}</span><Switch checked={globalVoiceprintMatching} onCheckedChange={setGlobalVoiceprintMatching} disabled={mode!=='meeting'}/></label></div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={()=>setMode('meeting')} className={`rounded-xl border px-3 py-3 text-left transition ${mode==='meeting'?'border-violet-400 bg-violet-50 text-violet-700':'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
              <span className="flex items-center gap-2 text-sm font-medium"><UsersRound className="h-4 w-4" />{zh?'会议模式':'Meeting'}</span><span className="mt-1.5 block text-[11px] leading-4 text-slate-400">{zh?'会内区分说话人并生成 Speaker 编号':'Separate speakers within this meeting'}</span>
            </button>
            <button type="button" onClick={()=>setMode('single')} className={`rounded-xl border px-3 py-3 text-left transition ${mode==='single'?'border-violet-400 bg-violet-50 text-violet-700':'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
              <span className="flex items-center gap-2 text-sm font-medium"><UserRound className="h-4 w-4" />{zh?'单人模式':'Single'}</span><span className="mt-1.5 block text-[11px] leading-4 text-slate-400">{zh?'不运行说话人分离，保留完整转写能力':'No speaker separation'}</span>
            </button>
          </div>
          {mode==='meeting'&&<p className="text-xs text-slate-400">{globalVoiceprintMatching?(zh?'统一使用 FunASR CAM++ 匹配知识库中的历史参会人。':'Uses the shared FunASR CAM++ space to match saved participants.'):(zh?'只生成本次会议的 Speaker 编号，不读取或写入全局声纹库。':'Creates local Speaker IDs without reading or writing the global voiceprint library.')}</p>}
        </div>

        <div className="grid grid-cols-[170px_1fr] gap-4">
          <div className="grid gap-2"><Label className="flex items-center gap-2"><Cpu className="h-4 w-4 text-slate-400" />{zh?'模型服务':'ASR provider'}</Label><Select value={selectedProvider} onValueChange={value=>{const first=compatibleModels.find(item=>item.provider===value);if(first)setSelectedModelKey(`${first.provider}:${first.name}`);}} disabled={loadingModels}><SelectTrigger><SelectValue placeholder={loadingModels?lt('Loading models...'):lt('Select model')}/></SelectTrigger><SelectContent>{providerOptions.map(value=><SelectItem key={value} value={value}>{providerLabel(value)}</SelectItem>)}</SelectContent></Select></div>
          <div className="grid gap-2"><Label>{zh?'ASR 模型':'ASR model'}</Label><Select value={selectedModelKey} onValueChange={setSelectedModelKey} disabled={loadingModels}><SelectTrigger><SelectValue placeholder={loadingModels?lt('Loading models...'):lt('Select model')}/></SelectTrigger><SelectContent>{providerModels.map(model=><SelectItem key={`${model.provider}:${model.name}`} value={`${model.provider}:${model.name}`}>{model.displayName}{model.size_mb>0?` · ${Math.round(model.size_mb)} MB`:''}</SelectItem>)}</SelectContent></Select></div>
          <div className="col-span-2 space-y-2">
          {selectedModel&&<div className="flex flex-wrap gap-1.5">{selectedModel.capabilities.map(capability=><span key={capability} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{capability==='speaker-diarization'?(zh?'说话人分离':'Diarization'):capability==='voiceprint-matching'?(zh?'声纹匹配':'Voiceprints'):capability==='hotwords'?(zh?'热词':'Hotwords'):capability==='punctuation'?(zh?'智能标点':'Punctuation'):capability==='timestamps'?(zh?'时间戳':'Timestamps'):capability==='multilingual'?(zh?'多语言':'Multilingual'):capability.toUpperCase()}</span>)}</div>}
          <p className="text-xs text-slate-400">{zh ? '只显示已经下载并准备好的模型。会议模式会在识别后运行独立的说话人分离管线。' : 'Only downloaded and prepared models are shown. Meeting mode runs an independent diarization pipeline after ASR.'}</p>
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto] items-end gap-4">
          <div className="grid gap-2">
            <Label className="flex items-center gap-2"><Globe2 className="h-4 w-4 text-slate-400" />{zh ? '识别语言' : 'Language'}</Label>
            <Select value={language} onValueChange={setLanguage} disabled={fixedAutoLanguage}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-60">{LANGUAGES.map(item => <SelectItem key={item.code} value={item.code}>{item.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <label className="flex min-h-10 items-center gap-3 rounded-lg border border-slate-200 px-3"><MessageSquareText className="h-4 w-4 text-violet-500"/><span className="whitespace-nowrap text-sm text-slate-700">{zh?'知识库热词':'Hotwords'}</span><Switch checked={useHotwords} onCheckedChange={setUseHotwords} disabled={!supportsHotwords}/></label>
        </div>

        <details className="group rounded-xl border border-slate-200 px-4 py-3"><summary className="cursor-pointer list-none text-sm font-medium text-slate-600">{zh ? '高级参数' : 'Advanced settings'}</summary><div className="mt-4 grid gap-4 border-t border-slate-100 pt-4">
          {supportsPunctuation&&<label className="flex items-center justify-between gap-4"><span><span className="block text-sm text-slate-700">{zh ? '智能标点' : 'Smart punctuation'}</span><span className="block text-xs text-slate-400">{zh ? '自动恢复句号、逗号和问号' : 'Restore sentence punctuation automatically'}</span></span><Switch checked={punctuation} onCheckedChange={setPunctuation} /></label>}
          <label className="flex items-center justify-between gap-4"><span><span className="block text-sm text-slate-700">{zh ? '数字与日期格式化（ITN）' : 'Number and date formatting (ITN)'}</span><span className="block text-xs text-slate-400">{zh ? '把口语数字转换成更易读的书面形式' : 'Convert spoken numbers into readable written forms'}</span></span><Switch checked={itn} onCheckedChange={setItn} /></label>
          {supportsVad&&<label className="flex items-center justify-between gap-4"><span><span className="block text-sm text-slate-700">{zh ? '语音活动检测（VAD）' : 'Voice activity detection (VAD)'}</span><span className="block text-xs text-slate-400">{zh ? '跳过静音并按自然停顿切分长音频' : 'Skip silence and split long audio at natural pauses'}</span></span><Switch checked={vadEnabled} onCheckedChange={setVadEnabled} /></label>}
          {supportsVad&&vadEnabled&&<div className="grid grid-cols-2 gap-4"><div className="grid gap-2"><Label className="text-xs text-slate-500">{zh?'单个连续语音上限':'Continuous-speech limit'}</Label><Select value={vadMaxSegmentMs} onValueChange={setVadMaxSegmentMs}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="30000">30 {zh?'秒':'sec'}</SelectItem><SelectItem value="60000">60 {zh?'秒（推荐）':'sec (recommended)'}</SelectItem><SelectItem value="120000">120 {zh?'秒':'sec'}</SelectItem></SelectContent></Select><span className="text-[11px] leading-4 text-slate-400">{zh?'自然停顿仍会形成长短不同的片段；这里只限制极端长段。':'Natural pauses still create variable-length segments; this only caps unusually long speech.'}</span></div><div className="grid gap-2"><Label className="text-xs text-slate-500">{zh?'VAD 批次合并上限':'VAD merge window'}</Label><Select value={mergeLengthS} onValueChange={setMergeLengthS} disabled={!mergeVad}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="8">8 {zh?'秒':'sec'}</SelectItem><SelectItem value="15">15 {zh?'秒（推荐）':'sec (recommended)'}</SelectItem><SelectItem value="30">30 {zh?'秒':'sec'}</SelectItem></SelectContent></Select><span className="text-[11px] leading-4 text-slate-400">{zh?'把过短的相邻语音合并成一次识别批次，不决定最终段落长度。':'Combines tiny adjacent regions for ASR; it does not determine final paragraph length.'}</span></div></div>}
          {supportsVad&&vadEnabled&&<label className="flex items-center justify-between gap-4"><span><span className="block text-sm text-slate-700">{zh?'合并相邻语音段':'Merge adjacent speech'}</span><span className="block text-xs text-slate-400">{zh?'减少过碎的句段，同时保留时间戳':'Reduce fragmentation while preserving timestamps'}</span></span><Switch checked={mergeVad} onCheckedChange={setMergeVad}/></label>}
          {speakerEnabled&&<div className="grid gap-2"><Label className="text-xs text-slate-500">{zh?'说话人分段依据':'Speaker segmentation basis'}</Label><Select value={speakerMode} onValueChange={value=>setSpeakerMode(value as typeof speakerMode)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="punc_segment">{zh?'按语义和标点（推荐）':'Semantic + punctuation (recommended)'}</SelectItem><SelectItem value="vad_segment">{zh?'按语音停顿':'Voice pauses'}</SelectItem><SelectItem value="default">{zh?'模型默认':'Model default'}</SelectItem></SelectContent></Select><span className="text-[11px] leading-4 text-slate-400">{zh?'CAM++ 会先自动估计人数；转写后可在原始文稿顶部调整并快速重新聚类。':'CAM++ estimates the count first. Adjust it above the transcript to recluster without rerunning ASR.'}</span></div>}
          {mode==='meeting'&&<div className="rounded-lg bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-700">{globalVoiceprintMatching?(zh?'CAM++ 会生成 Speaker 编号，并将高质量声纹用于历史参会人匹配。':'CAM++ creates Speaker IDs and uses qualified embeddings for saved-participant matching.'):(zh?'CAM++ 只用于本次会议的说话人分离，不保存声纹。':'CAM++ is used only for meeting-local diarization; embeddings are not saved.')}</div>}
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-400">{zh?'设备、CPU 线程、批处理大小、模型来源与版本由 CalMee 根据机型和模型自动管理；句级时间戳和事实保留固定开启。':'Device, CPU threads, batch size, model source, and revision are managed automatically. Sentence timestamps and fact preservation stay enabled.'}</div>
        </div></details>

        {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      </div>

      <DialogFooter className="border-t border-slate-100 px-6 py-4">
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={starting}>{lt('Cancel')}</Button>
        <Button onClick={() => void start()} disabled={starting || loadingModels || !selectedModel || !meetingFolderPath} className="bg-violet-600 hover:bg-violet-700">{starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}{zh ? '开始转写' : 'Start transcription'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
