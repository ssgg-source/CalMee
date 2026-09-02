'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';
import { TranscriptionModelCard } from './TranscriptionModelCard';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface FunAsrConfig {
  model: string;
  hub: 'ms' | 'hf';
  vad_enabled: boolean;
  punc_enabled: boolean;
  speaker_enabled: boolean;
  [key: string]: unknown;
}

interface FunAsrStatus { ready: boolean; loaded: boolean; model?: string | null; device?: string | null }
interface RuntimeStatus { available: boolean; source?: string | null; message: string }
interface ModelProfile { id: string; name: string; description: string; languages: string; capabilities: string[]; estimatedDownloadBytes: number }
interface ModelState { id: string; family: string; downloaded: boolean; ready: boolean; sizeBytes: number; loaded: boolean }
interface LegacyImportPreview { available: boolean; modelCount: number; sizeBytes: number; sourceLocations: string[]; targetLocation: string }
interface Props { onSelected: (model: string) => void; family?: 'funasr' | 'qwen3asr'; selectedModel?: string }

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

export function FunAsrSettings({ onSelected, family = 'funasr', selectedModel }: Props) {
  const { lt, locale } = useLanguage();
  const friendlyError = useCallback((scope: string, error: unknown) => {
    reportTechnicalError(scope, error);
    return toUserFacingError(error, locale).message;
  }, [locale]);
  const [config, setConfig] = useState<FunAsrConfig | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [status, setStatus] = useState<FunAsrStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [modelStates, setModelStates] = useState<Map<string, ModelState>>(new Map());
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'download' | 'load' | null>(null);
  const [requestedModel, setRequestedModel] = useState<string | null>(null);
  const [deleteModel, setDeleteModel] = useState<ModelProfile | null>(null);
  const [legacyImport, setLegacyImport] = useState<LegacyImportPreview | null>(null);
  const [showLegacyImport, setShowLegacyImport] = useState(false);
  const [importingLegacy, setImportingLegacy] = useState(false);
  const activeModel = selectedModel || (status?.loaded ? status.model || '' : '');

  const refreshState = useCallback(async () => {
    const [nextRuntime, states, nextStatus] = await Promise.all([
      invoke<RuntimeStatus>('funasr_get_runtime_status'),
      invoke<ModelState[]>('funasr_get_model_states', { family }),
      invoke<FunAsrStatus>('funasr_get_status').catch(() => ({ ready: false, loaded: false })),
    ]);
    setRuntime(nextRuntime);
    setModelStates(new Map(states.map(item => [item.id, item])));
    setStatus(nextStatus);
  }, [family]);

  useEffect(() => {
    // Older builds persisted optimistic browser-only readiness. It must never
    // override backend-verified files and runtime health.
    localStorage.removeItem(`calmee.${family}.readyModels`);
    Promise.all([
      invoke<FunAsrConfig>('funasr_get_config'),
      invoke<ModelProfile[]>(family === 'qwen3asr' ? 'qwen3_asr_get_model_profiles' : 'funasr_get_model_profiles'),
    ]).then(([saved, available]) => {
      setConfig(saved);
      setProfiles(available);
    }).catch(error => toast.error(lt('Failed to load models'), { description: friendlyError('funasr-load-models', error) }));
    void refreshState().catch(error => {
      setRuntime({ available: false, message: friendlyError('funasr-runtime-status', error) });
      setStatus({ ready: false, loaded: false });
    });
    invoke<LegacyImportPreview>('funasr_get_legacy_model_import_preview')
      .then(setLegacyImport)
      .catch(() => setLegacyImport(null));
  }, [family, friendlyError, lt, refreshState]);

  const activateModel = async (model: string) => {
    if (!config || busyModel) return;
    setRequestedModel(model);
    const nextConfig: FunAsrConfig = family === 'qwen3asr'
      ? { ...config, model, hub: 'hf', vad_enabled: false, punc_enabled: false, speaker_enabled: false }
      : { ...config, model, hub: 'ms' };
    setBusyModel(model);
    setBusyAction('load');
    try {
      const saved = await invoke<FunAsrConfig>('funasr_save_config', { config: nextConfig });
      await invoke('funasr_load_model');
      await invoke('api_save_transcript_config', { provider: family, model: saved.model, apiKey: null });
      setConfig(saved);
      onSelected(saved.model);
      setRequestedModel(null);
      await refreshState();
      toast.success(lt('Switched to {model}', { model: profiles.find(item => item.id === model)?.name || model }));
    } catch (error) {
      await refreshState().catch(() => undefined);
      toast.error(lt('Failed to prepare model'), { description: friendlyError('funasr-prepare-model', error) });
    } finally {
      setRequestedModel(null);
      setBusyModel(null);
      setBusyAction(null);
    }
  };

  const downloadModel = async (model: string) => {
    if (busyModel) return;
    setBusyModel(model);
    setBusyAction('download');
    try {
      await invoke('funasr_download_model', { family, model });
      await refreshState();
      toast.success(lt('Model downloaded'), {
        description: lt('Click the model card to load and use it.'),
      });
    } catch (error) {
      await refreshState().catch(() => undefined);
      toast.error(lt('Model download failed'), { description: friendlyError('funasr-download-model', error) });
    } finally {
      setBusyModel(null);
      setBusyAction(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteModel || busyModel) return;
    const target = deleteModel;
    setBusyModel(target.id);
    setBusyAction(null);
    try {
      const expectedSizeBytes = modelStates.get(target.id)?.sizeBytes || 0;
      const freed = await invoke<number>('funasr_delete_model', {
        family,
        model: target.id,
        confirmed: true,
        expectedSizeBytes,
      });
      if (activeModel === target.id) onSelected('');
      setDeleteModel(null);
      await refreshState();
      toast.success(lt('Model deleted'), {
        description: lt('Freed {size} of disk space.', { size: formatBytes(freed) }),
      });
    } catch (error) {
      toast.error(lt('Failed to delete model'), { description: friendlyError('funasr-delete-model', error) });
    } finally {
      setBusyModel(null);
      setBusyAction(null);
    }
  };

  const confirmLegacyImport = async () => {
    if (!legacyImport?.available || importingLegacy) return;
    setImportingLegacy(true);
    try {
      const copied = await invoke<number>('funasr_import_legacy_models', {
        confirmed: true,
        expectedSizeBytes: legacyImport.sizeBytes,
      });
      setShowLegacyImport(false);
      setLegacyImport(await invoke<LegacyImportPreview>('funasr_get_legacy_model_import_preview'));
      toast.success(lt('Existing models imported'), {
        description: lt('Copied {size}. The original cache was not changed.', { size: formatBytes(copied) }),
      });
    } catch (error) {
      toast.error(lt('Failed to import existing models'), { description: friendlyError('funasr-import-models', error) });
    } finally {
      setImportingLegacy(false);
    }
  };

  const recommendedId = useMemo(() => family === 'qwen3asr' ? 'Qwen/Qwen3-ASR-0.6B' : 'paraformer-zh', [family]);
  if (!config || profiles.length === 0) return <div className="space-y-3"><div className="h-24 animate-pulse rounded-lg bg-gray-100" /><div className="h-24 animate-pulse rounded-lg bg-gray-100" /></div>;

  return (
    <div className="space-y-3">
      {runtime === null && <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />{lt('Checking local transcription runtime…')}</div>}
      {legacyImport?.available && <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><div><div className="font-medium">{lt('Existing model cache detected')}</div><div className="mt-0.5 text-xs text-amber-700">{lt('{count} compatible models · {size}. Nothing will be moved or deleted.', { count: legacyImport.modelCount, size: formatBytes(legacyImport.sizeBytes) })}</div></div><button type="button" onClick={() => setShowLegacyImport(true)} className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-amber-100">{lt('Review import')}</button></div>}
      {profiles.map((profile, index) => {
        const modelState = modelStates.get(profile.id);
        const isReady = Boolean(runtime?.available && modelState?.ready);
        return <TranscriptionModelCard
          key={profile.id}
          name={profile.name}
          description={`${lt(profile.description)} · ${lt(profile.languages)}`}
          icon={index === 0 ? '⚡' : '📦'}
          isSelected={activeModel === profile.id || requestedModel === profile.id}
          isReady={isReady}
          isDownloaded={Boolean(modelState?.downloaded)}
          isRecommended={profile.id === recommendedId}
          isBusy={busyModel === profile.id}
          busyAction={busyModel === profile.id ? busyAction : null}
          sizeText={modelState?.downloaded ? formatBytes(modelState.sizeBytes) : lt('Approx. {size} download', { size: formatBytes(profile.estimatedDownloadBytes) })}
          onSelect={() => void activateModel(profile.id)}
          onDownload={() => void downloadModel(profile.id)}
          onDelete={modelState?.downloaded ? () => setDeleteModel(profile) : undefined}
        />;
      })}
      {activeModel && <div className="pt-2 text-center text-xs text-gray-500">{lt('Using {model} for transcription', { model: profiles.find(item => item.id === activeModel)?.name || activeModel })}</div>}

      <Dialog open={Boolean(deleteModel)} onOpenChange={open => { if (!open && !busyModel) setDeleteModel(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{lt('Delete local model?')}</DialogTitle>
            <DialogDescription>
              {lt('{model} will be removed from this computer. You can download it again later.', { model: deleteModel?.name || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" disabled={Boolean(busyModel)} onClick={() => setDeleteModel(null)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{lt('Cancel')}</button>
            <button type="button" disabled={Boolean(busyModel)} onClick={() => void confirmDelete()} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">{busyModel ? lt('Deleting…') : lt('Delete model')}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showLegacyImport} onOpenChange={open => { if (!importingLegacy) setShowLegacyImport(open); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{lt('Import existing local models?')}</DialogTitle>
            <DialogDescription>{lt('CalMee found compatible models downloaded by an earlier build. Import copies only recognized model directories into this app’s private data directory. The source remains read-only and is never deleted.')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            <div><span className="font-medium text-slate-800">{lt('Models and size:')}</span> {legacyImport?.modelCount || 0} · {formatBytes(legacyImport?.sizeBytes || 0)}</div>
            <div><span className="font-medium text-slate-800">{lt('Source:')}</span><div className="mt-1 break-all">{legacyImport?.sourceLocations.join('\n') || ''}</div></div>
            <div><span className="font-medium text-slate-800">{lt('Target:')}</span><div className="mt-1 break-all">{legacyImport?.targetLocation || ''}</div></div>
            <div className="text-amber-700">{lt('Imported files are not marked ready until CalMee successfully loads and verifies the selected model.')}</div>
          </div>
          <DialogFooter>
            <button type="button" disabled={importingLegacy} onClick={() => setShowLegacyImport(false)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{lt('Cancel')}</button>
            <button type="button" disabled={importingLegacy} onClick={() => void confirmLegacyImport()} className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">{importingLegacy ? lt('Importing…') : lt('Copy and import')}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
