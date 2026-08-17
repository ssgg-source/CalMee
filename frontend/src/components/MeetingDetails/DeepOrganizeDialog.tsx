"use client";

import { useEffect, useId, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfig } from '@/contexts/ConfigContext';
import { useLanguage } from '@/contexts/LanguageContext';
import type { ModelConfig } from '@/components/ModelSettingsModal';

const PROVIDERS: Array<{ value: ModelConfig['provider']; label: string }> = [
  { value: 'minimax', label: 'MiniMax' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'claude', label: 'Claude' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'groq', label: 'Groq' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'builtin-ai', label: 'Built-in AI' },
  { value: 'custom-openai', label: 'Custom OpenAI' },
];

const LANGUAGES = [
  { value: 'auto', label: 'Keep original language' },
  { value: 'zh', label: 'Simplified Chinese' },
  { value: 'zh-tw', label: 'Traditional Chinese' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
];

interface DeepOrganizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  transcriptCount: number;
  templateId?: string;
  beforeStart?: () => Promise<void>;
  onStarted: () => void;
  mode?: 'smart' | 'speech';
  contextKey?: string;
  speakerKeys?: string[];
  speakerNames?: string[];
}

export function DeepOrganizeDialog({
  open, onOpenChange, meetingId, transcriptCount, templateId, beforeStart, onStarted,
  mode = 'smart', contextKey = '', speakerKeys = [], speakerNames = [],
}: DeepOrganizeDialogProps) {
  const { modelConfig, modelOptions } = useConfig();
  const { lt } = useLanguage();
  const modelListId = useId();
  const [language, setLanguage] = useState('auto');
  const [provider, setProvider] = useState<ModelConfig['provider']>(modelConfig.provider);
  const [model, setModel] = useState(modelConfig.model);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLanguage('auto');
    setProvider(modelConfig.provider);
    setModel(modelConfig.provider === 'custom-openai'
      ? (modelConfig.customOpenAIModel || modelConfig.model)
      : modelConfig.model);
  }, [open, modelConfig]);

  const suggestions = useMemo(() => {
    const configured = provider === modelConfig.provider ? modelConfig.model : '';
    return Array.from(new Set([configured, ...(modelOptions[provider] || [])].filter(Boolean)));
  }, [modelConfig, modelOptions, provider]);

  const changeProvider = (next: ModelConfig['provider']) => {
    setProvider(next);
    const first = next === modelConfig.provider ? modelConfig.model : modelOptions[next]?.[0];
    setModel(first || '');
  };

  const start = async () => {
    if (!model.trim() || transcriptCount === 0 || starting) return;
    setStarting(true);
    try {
      await beforeStart?.();
      if (mode === 'speech') {
        await invoke('api_start_speech_summary', {
          meetingId, contextKey, speakerKeys,
          language: language === 'auto' ? null : language,
          provider, model: model.trim(), templateId: templateId || null,
          allowCloud: true,
        });
      } else {
        await invoke('api_start_ai_organize_meeting_record', {
          meetingId,
          language: language === 'auto' ? null : language,
          provider,
          model: model.trim(),
          templateId: templateId || null,
          allowCloudFullTranscript: true,
        });
      }
      onOpenChange(false);
      onStarted();
      toast.info(mode === 'speech' ? lt('Speech summary is running in the background') : lt('AI deep organization is running in the background'), {
        description: lt('You can switch pages while CalMee continues processing.'),
      });
    } catch (error) {
      toast.error(mode === 'speech' ? lt('Speech summary failed') : lt('AI deep organization failed'), { description: String(error) });
    } finally {
      setStarting(false);
    }
  };

  return <Dialog open={open} onOpenChange={starting ? undefined : onOpenChange}>
    <DialogContent className="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-violet-600" />{mode === 'speech' ? lt('Generate Speech Summary') : lt('Deep Organize Meeting Record')}</DialogTitle>
        <DialogDescription>{mode === 'speech' ? lt('Summarize all statements from the selected speakers in chronological order.') : lt('Merge consecutive speech with rules, then use AI to correct and structure the detailed meeting record.')}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-5 py-2">
        {mode === 'speech' && <div className="rounded-xl border border-violet-100 bg-violet-50/70 px-3 py-2 text-xs leading-5 text-violet-800">
          {lt('Selected speakers')}: {speakerNames.join(', ')}
        </div>}
        <div className="grid gap-2">
          <Label>{lt('Output language')}</Label>
          <Select value={language} onValueChange={setLanguage} disabled={starting}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{LANGUAGES.map(item => <SelectItem key={item.value} value={item.value}>{lt(item.label)}</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-xs text-slate-500">{lt('Keep original language is recommended unless you want the meeting record translated.')}</p>
        </div>

        <div className="grid grid-cols-[180px_1fr] gap-3">
          <div className="grid gap-2">
            <Label>{lt('AI provider')}</Label>
            <Select value={provider} onValueChange={value => changeProvider(value as ModelConfig['provider'])} disabled={starting}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{PROVIDERS.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={modelListId}>{lt('AI model')}</Label>
            <input
              id={modelListId}
              list={`${modelListId}-options`}
              value={model}
              onChange={event => setModel(event.target.value)}
              disabled={starting}
              placeholder={lt('Select or enter a model name')}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-violet-200"
            />
            <datalist id={`${modelListId}-options`}>{suggestions.map(name => <option key={name} value={name} />)}</datalist>
          </div>
        </div>

        <div className={`rounded-xl border p-3 text-xs leading-5 ${provider === 'builtin-ai' || provider === 'ollama' ? 'border-violet-100 bg-violet-50/70 text-violet-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          {provider === 'builtin-ai' || provider === 'ollama'
            ? lt('This task runs locally and the complete transcript stays on this Mac.')
            : mode === 'speech'
              ? lt('Starting this task sends only the selected speakers’ transcript to {provider}.').replace('{provider}', PROVIDERS.find(item => item.value === provider)?.label || provider)
              : lt('Starting this task sends the complete transcript once to {provider}. It is used only to generate this smart record.').replace('{provider}', PROVIDERS.find(item => item.value === provider)?.label || provider)}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={starting}>{lt('Cancel')}</Button>
        <Button onClick={() => void start()} disabled={starting || transcriptCount === 0 || !model.trim()} className="bg-violet-600 hover:bg-violet-700">
          {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
          {starting ? lt('Starting...') : mode === 'speech' ? lt('Generate Speech Summary') : lt('Start Deep Organization')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
