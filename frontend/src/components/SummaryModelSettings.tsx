'use client';

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ModelConfig, ModelSettingsModal } from '@/components/ModelSettingsModal';
import { useLanguage } from '@/contexts/LanguageContext';
import { RotateCcw, Save, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

type HarnessSetting = { content: string; isCustomized: boolean };

interface SummaryModelSettingsProps {
  refetchTrigger?: number; // Change this to trigger refetch
}

export function SummaryModelSettings({ refetchTrigger }: SummaryModelSettingsProps) {
  const { lt, locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const showError = useCallback((title: string, error: unknown) => {
    reportTechnicalError('summary-model-settings', error);
    toast.error(title, { description: toUserFacingError(error, locale).message });
  }, [locale]);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'ollama',
    model: 'llama3.2:latest',
    whisperModel: 'large-v3',
    apiKey: null,
    ollamaEndpoint: null
  });
  const [harness, setHarness] = useState('');
  const [savedHarness, setSavedHarness] = useState('');
  const [harnessCustomized, setHarnessCustomized] = useState(false);
  const [harnessLoading, setHarnessLoading] = useState(true);
  const [harnessSaving, setHarnessSaving] = useState(false);

  const loadHarness = useCallback(async () => {
    setHarnessLoading(true);
    try {
      const value = await invoke<HarnessSetting>('api_get_smart_record_harness');
      setHarness(value.content);
      setSavedHarness(value.content);
      setHarnessCustomized(value.isCustomized);
    } catch (error) {
      showError(zh ? '读取智能记录设置失败' : 'Failed to load smart-record settings', error);
    } finally {
      setHarnessLoading(false);
    }
  }, [showError, zh]);

  useEffect(() => { void loadHarness(); }, [loadHarness]);

  const saveHarness = async () => {
    if (harnessSaving || harness === savedHarness) return;
    setHarnessSaving(true);
    try {
      await invoke('api_save_smart_record_harness', { content: harness });
      setSavedHarness(harness.trim());
      setHarness(harness.trim());
      setHarnessCustomized(true);
      toast.success(zh ? '智能记录 Harness 已保存' : 'Smart-record Harness saved');
    } catch (error) {
      showError(zh ? '智能记录设置保存失败' : 'Failed to save smart-record settings', error);
    } finally {
      setHarnessSaving(false);
    }
  };

  const resetHarness = async () => {
    setHarnessSaving(true);
    try {
      const value = await invoke<HarnessSetting>('api_reset_smart_record_harness');
      setHarness(value.content);
      setSavedHarness(value.content);
      setHarnessCustomized(false);
      toast.success(zh ? '已恢复 CalMee 默认 Harness' : 'Restored the CalMee default Harness');
    } catch (error) {
      showError(zh ? '恢复默认值失败' : 'Failed to restore defaults', error);
    } finally {
      setHarnessSaving(false);
    }
  };

  // Reusable fetch function
  const fetchModelConfig = useCallback(async () => {
    try {
      const data = await invoke('api_get_model_config') as any;
      if (data && data.provider !== null) {
        // Fetch API key if not included and provider requires it
        if (data.provider !== 'ollama' && data.provider !== 'builtin-ai' && !data.apiKey) {
          try {
            const apiKeyData = await invoke('api_get_api_key', {
              provider: data.provider
            }) as string;
            data.apiKey = apiKeyData;
          } catch (err) {
            console.error('Failed to fetch API key:', err);
          }
        }
        // Fetch Custom OpenAI config if that's the active provider
        if (data.provider === 'custom-openai') {
          try {
            const customConfig = (await invoke('api_get_custom_openai_config')) as any;
            if (customConfig) {
              data.customOpenAIDisplayName = customConfig.displayName || null;
              data.customOpenAIEndpoint = customConfig.endpoint || null;
              data.customOpenAIModel = customConfig.model || null;
              data.customOpenAIApiKey = customConfig.apiKey || null;
              data.maxTokens = customConfig.maxTokens || null;
              data.temperature = customConfig.temperature || null;
              data.topP = customConfig.topP || null;
              // For custom-openai, model field should match customOpenAIModel
              data.model = customConfig.model || data.model;
            }
          } catch (err) {
            console.error('Failed to fetch custom OpenAI config:', err);
          }
        }
        setModelConfig(data);
      }
    } catch (error) {
      console.error('Failed to fetch model config:', error);
      toast.error(lt('Failed to load model settings'));
    }
  }, [lt]);

  // Fetch on mount
  useEffect(() => {
    fetchModelConfig();
  }, [fetchModelConfig]);

  // Refetch when trigger changes (optional external control)
  useEffect(() => {
    if (refetchTrigger !== undefined && refetchTrigger > 0) {
      fetchModelConfig();
    }
  }, [refetchTrigger, fetchModelConfig]);

  // Listen for model config updates from other components
  useEffect(() => {
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<ModelConfig>('model-config-updated', (event) => {
        console.log('SummaryModelSettings received model-config-updated event:', event.payload);
        setModelConfig(event.payload);
      });

      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    setupListener().then(fn => cleanup = fn);

    return () => {
      cleanup?.();
    };
  }, []);

  // Save handler
  const handleSaveModelConfig = async (config: ModelConfig) => {
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey,
        ollamaEndpoint: config.ollamaEndpoint,
      });

      setModelConfig(config);

      // Emit event to sync other components
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);

      toast.success(lt('Model settings saved successfully'));
    } catch (error) {
      console.error('Error saving model config:', error);
      toast.error(lt('Failed to save model settings'));
    }
  };

  return (
    <div className="space-y-7 pb-6">
      <section>
        <h3 className="mb-1 text-lg font-semibold">{lt('Summary Model Configuration')}</h3>
        <p className="mb-5 text-sm text-gray-600">
          {lt('Configure the AI model used for generating meeting summaries.')}
        </p>

        <ModelSettingsModal
          modelConfig={modelConfig}
          setModelConfig={setModelConfig}
          onSave={handleSaveModelConfig}
          skipInitialFetch={true}
          compact={true}
        />
      </section>

      <section className="rounded-2xl border border-violet-100 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <SlidersHorizontal className="h-4 w-4 text-violet-600" />
              {zh ? '智能记录 Harness' : 'Smart-record Harness'}
            </h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {zh ? '控制智能记录的理解流程、知识使用、信息取舍和事实约束。章节结构与输出格式在会议页面的模板中管理。' : 'Controls reasoning workflow, knowledge use, information selection, and factual safeguards. Section structure and output format are managed by meeting templates.'}
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${harnessCustomized ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-500'}`}>
            {harnessCustomized ? (zh ? '已自定义' : 'Customized') : (zh ? 'CalMee 默认' : 'CalMee default')}
          </span>
        </div>
        <textarea
          value={harness}
          onChange={event => setHarness(event.target.value)}
          disabled={harnessLoading || harnessSaving}
          spellCheck={false}
          className="min-h-[420px] w-full resize-y rounded-xl border border-slate-200 bg-slate-50/60 p-4 font-mono text-xs leading-5 text-slate-700 outline-none transition focus:border-violet-400 focus:bg-white focus:ring-2 focus:ring-violet-100 disabled:opacity-60"
          placeholder={zh ? '正在读取 Harness…' : 'Loading Harness…'}
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] tabular-nums text-slate-400">
            {harness.length.toLocaleString()} {zh ? '字符' : 'characters'}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void resetHarness()} disabled={harnessLoading || harnessSaving || !harnessCustomized}>
              <RotateCcw className="mr-2 h-4 w-4" />{zh ? '恢复默认' : 'Restore default'}
            </Button>
            <Button onClick={() => void saveHarness()} disabled={harnessLoading || harnessSaving || harness.trim() === savedHarness.trim()} className="bg-violet-600 hover:bg-violet-700">
              <Save className="mr-2 h-4 w-4" />{harnessSaving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存 Harness' : 'Save Harness')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
