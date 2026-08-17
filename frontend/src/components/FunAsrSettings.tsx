'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { TranscriptionModelCard } from './TranscriptionModelCard';

interface FunAsrConfig {
  model: string;
  hub: 'ms' | 'hf';
  vad_enabled: boolean;
  punc_enabled: boolean;
  speaker_enabled: boolean;
  [key: string]: unknown;
}

interface FunAsrStatus { ready: boolean; loaded: boolean; model?: string | null; device?: string | null }
interface ModelProfile { id: string; name: string; description: string; languages: string; capabilities: string[] }
interface Props { onSelected: (model: string) => void; family?: 'funasr' | 'qwen3asr'; selectedModel?: string }

const readyStorageKey = (family: string) => `calmee.${family}.readyModels`;

export function FunAsrSettings({ onSelected, family = 'funasr', selectedModel }: Props) {
  const { lt } = useLanguage();
  const [config, setConfig] = useState<FunAsrConfig | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [status, setStatus] = useState<FunAsrStatus | null>(null);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [readyModels, setReadyModels] = useState<Set<string>>(new Set());
  const activeModel = selectedModel || (status?.loaded ? status.model || '' : '');

  const refreshStatus = useCallback(async () => {
    try { setStatus(await invoke<FunAsrStatus>('funasr_get_status')); }
    catch { setStatus({ ready: false, loaded: false }); }
  }, []);

  useEffect(() => {
    try { setReadyModels(new Set(JSON.parse(localStorage.getItem(readyStorageKey(family)) || '[]'))); }
    catch { setReadyModels(new Set()); }
    Promise.all([
      invoke<FunAsrConfig>('funasr_get_config'),
      invoke<ModelProfile[]>(family === 'qwen3asr' ? 'qwen3_asr_get_model_profiles' : 'funasr_get_model_profiles'),
    ]).then(([saved, available]) => { setConfig(saved); setProfiles(available); }).catch(error => toast.error(lt('Failed to load models'), { description: String(error) }));
    void refreshStatus();
  }, [family, lt, refreshStatus]);

  useEffect(() => {
    if (!status?.loaded || !status.model) return;
    setReadyModels(current => {
      const next = new Set(current).add(status.model!);
      localStorage.setItem(readyStorageKey(family), JSON.stringify([...next]));
      return next;
    });
  }, [family, status?.loaded, status?.model]);

  const prepareModel = async (model: string) => {
    if (!config || busyModel) return;
    const nextConfig: FunAsrConfig = family === 'qwen3asr'
      ? { ...config, model, hub: 'hf', vad_enabled: false, punc_enabled: false, speaker_enabled: false }
      : { ...config, model };
    setBusyModel(model);
    try {
      const saved = await invoke<FunAsrConfig>('funasr_save_config', { config: nextConfig });
      await invoke('funasr_load_model');
      await invoke('api_save_transcript_config', { provider: family, model: saved.model, apiKey: null });
      setConfig(saved);
      setStatus({ ready: true, loaded: true, model: saved.model });
      setReadyModels(current => {
        const next = new Set(current).add(saved.model);
        localStorage.setItem(readyStorageKey(family), JSON.stringify([...next]));
        return next;
      });
      onSelected(saved.model);
      toast.success(lt('Switched to {model}', { model: profiles.find(item => item.id === model)?.name || model }));
    } catch (error) {
      toast.error(lt('Failed to prepare model'), { description: String(error) });
    } finally { setBusyModel(null); }
  };

  const recommendedId = useMemo(() => family === 'qwen3asr' ? 'Qwen/Qwen3-ASR-0.6B' : 'paraformer-zh', [family]);
  if (!config || profiles.length === 0) return <div className="space-y-3"><div className="h-24 animate-pulse rounded-lg bg-gray-100" /><div className="h-24 animate-pulse rounded-lg bg-gray-100" /></div>;

  return (
    <div className="space-y-3">
      {profiles.map((profile, index) => {
        const isReady = readyModels.has(profile.id) || (status?.loaded && status.model === profile.id);
        return <TranscriptionModelCard
          key={profile.id}
          name={profile.name}
          description={`${lt(profile.description)} · ${lt(profile.languages)}`}
          icon={index === 0 ? '⚡' : '📦'}
          isSelected={activeModel === profile.id}
          isReady={Boolean(isReady)}
          isRecommended={profile.id === recommendedId}
          isBusy={busyModel === profile.id}
          onSelect={() => void prepareModel(profile.id)}
          onDownload={() => void prepareModel(profile.id)}
        />;
      })}
      {activeModel && <div className="pt-2 text-center text-xs text-gray-500">{lt('Using {model} for transcription', { model: profiles.find(item => item.id === activeModel)?.name || activeModel })}</div>}
    </div>
  );
}
