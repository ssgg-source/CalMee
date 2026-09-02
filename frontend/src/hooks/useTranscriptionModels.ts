import { useState, useCallback, useRef } from 'react';
import { invoke } from '@/lib/data-invoke';

export interface RawModelInfo {
  name: string;
  size_mb: number;
  status: 'Available' | 'Missing' | { Downloading: { progress: number } } | { Error: string };
}

export interface ModelOption {
  provider: 'whisper' | 'parakeet' | 'funasr' | 'qwen3asr' | 'funasr-server';
  name: string;
  displayName: string;
  size_mb: number;
  capabilities: TranscriptionCapability[];
  languages: string;
  profileId?: string;
  remoteModel?: string;
}

export type TranscriptionCapability =
  | 'timestamps'
  | 'multilingual'
  | 'hotwords'
  | 'punctuation'
  | 'itn'
  | 'vad'
  | 'speaker-diarization'
  | 'voiceprint-matching';

interface TranscriptModelConfig {
  provider?: string;
  model?: string;
}

/**
 * Custom hook for fetching and managing transcription models (Whisper and Parakeet).
 *
 * This hook centralizes the model fetching logic that was previously duplicated
 * in ImportAudioDialog and RetranscribeDialog components.
 *
 * @param transcriptModelConfig - User's saved model configuration from context
 * @returns Object containing available models, selected model key, loading state, and fetch function
 */
export function useTranscriptionModels(transcriptModelConfig: TranscriptModelConfig | undefined) {
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState<string>('');
  const [loadingModels, setLoadingModels] = useState(false);
  // Track whether the user has manually changed the model selection
  const userSelectedRef = useRef(false);

  // Wrap setSelectedModelKey to track user-initiated changes
  const setSelectedModelKeyWithTracking = useCallback((key: string) => {
    userSelectedRef.current = true;
    setSelectedModelKey(key);
  }, []);

  const fetchModels = useCallback(async () => {
    setLoadingModels(true);
    const allModels: ModelOption[] = [];

    // Fetch Whisper models
    try {
      const whisperModels = await invoke<RawModelInfo[]>('whisper_get_available_models');
      const availableWhisper = whisperModels
        .filter((m) => m.status === 'Available')
        .map((m) => ({
          provider: 'whisper' as const,
          name: m.name,
          displayName: `🏠 Whisper: ${m.name}`,
          size_mb: m.size_mb,
          capabilities: ['timestamps', 'multilingual', 'vad'] as TranscriptionCapability[],
          languages: 'Multilingual',
        }));
      allModels.push(...availableWhisper);
    } catch (err) {
      console.error('Failed to fetch Whisper models:', err);
    }

    // Fetch Parakeet models
    try {
      const parakeetModels = await invoke<RawModelInfo[]>('parakeet_get_available_models');
      const availableParakeet = parakeetModels
        .filter((m) => m.status === 'Available')
        .map((m) => ({
          provider: 'parakeet' as const,
          name: m.name,
          displayName: `⚡ Parakeet: ${m.name}`,
          size_mb: m.size_mb,
          capabilities: ['timestamps', 'vad'] as TranscriptionCapability[],
          languages: 'English',
        }));
      allModels.push(...availableParakeet);
    } catch (err) {
      console.error('Failed to fetch Parakeet models:', err);
    }

    try {
      const [funasrModels,funasrStates] = await Promise.all([
        invoke<Array<{ id: string; name: string; languages?:string; capabilities?:string[] }>>('funasr_get_model_profiles'),
        invoke<Array<{ id:string;ready:boolean;sizeBytes:number }>>('funasr_get_model_states',{family:'funasr'}),
      ]);
      const states=new Map(funasrStates.map(state=>[state.id,state]));
      const readySet=new Set(funasrStates.filter(state=>state.ready).map(state=>state.id));
      allModels.push(...funasrModels.filter(model=>readySet.has(model.id)).map(model => ({
        provider: 'funasr' as const,
        name: model.id,
        displayName: `🎙️ FunASR: ${model.name}`,
        size_mb: (states.get(model.id)?.sizeBytes || 0) / (1024 * 1024),
        capabilities: Array.from(new Set([...(model.capabilities || []), 'speaker-diarization', 'voiceprint-matching'])) as TranscriptionCapability[],
        languages: model.languages || 'Chinese / multilingual',
      })));
    } catch (err) {
      console.error('Failed to fetch FunASR models:', err);
    }

    try {
      const [qwenModels,qwenStates] = await Promise.all([
        invoke<Array<{ id: string; name: string; languages?:string; capabilities?:string[] }>>('qwen3_asr_get_model_profiles'),
        invoke<Array<{ id:string;ready:boolean;sizeBytes:number }>>('funasr_get_model_states',{family:'qwen3asr'}),
      ]);
      const states=new Map(qwenStates.map(state=>[state.id,state]));
      const readySet=new Set(qwenStates.filter(state=>state.ready).map(state=>state.id));
      allModels.push(...qwenModels.filter(model=>readySet.has(model.id)).map(model => ({
        provider: 'qwen3asr' as const,
        name: model.id,
        displayName: `🏠 Qwen3-ASR: ${model.name}`,
        size_mb: (states.get(model.id)?.sizeBytes || 0) / (1024 * 1024),
        capabilities: ['timestamps', 'multilingual'] as TranscriptionCapability[],
        languages: model.languages || '52 languages and dialects',
      })));
    } catch (err) {
      console.error('Failed to fetch Qwen3-ASR models:', err);
    }

    try {
      const profiles = await invoke<Array<{id:string;displayName:string;model:string;endpoint:string}>>('api_list_custom_model_profiles', { kind: 'transcription' });
      allModels.push(...profiles.map(profile => ({
          provider: 'funasr-server' as const,
          name: profile.id,
          displayName: `${profile.displayName}: ${profile.model}`,
          size_mb: 0,
          capabilities: ['timestamps', 'multilingual', 'punctuation', 'itn'] as TranscriptionCapability[],
          languages: 'Server-defined',
          profileId: profile.id,
          remoteModel: profile.model,
        })));
    } catch (err) {
      console.error('Failed to fetch FunASR server configuration:', err);
    }

    setAvailableModels(allModels);

    // Set default model based on user's saved configuration
    const configuredProvider = transcriptModelConfig?.provider || '';
    const configuredModel = transcriptModelConfig?.model || '';

    // Try to match the configured model
    // Note: 'localWhisper' in config maps to 'whisper' provider in model list
    const configuredMatch = allModels.find(
      (m) =>
        (configuredProvider === 'localWhisper' && m.provider === 'whisper' && m.name === configuredModel) ||
        (configuredProvider === 'parakeet' && m.provider === 'parakeet' && m.name === configuredModel) ||
        (configuredProvider === 'funasr' && m.provider === 'funasr' && m.name === configuredModel) ||
        (configuredProvider === 'qwen3asr' && m.provider === 'qwen3asr' && m.name === configuredModel) ||
        (configuredProvider === 'funasr-server' && m.provider === 'funasr-server' && m.remoteModel === configuredModel)
    );

    // Only set default model if user hasn't manually selected one
    if (!userSelectedRef.current) {
      if (configuredMatch) {
        // Use the configured model if available
        setSelectedModelKey(`${configuredMatch.provider}:${configuredMatch.name}`);
      } else if (allModels.length > 0) {
        // Fall back to first available model
        setSelectedModelKey(`${allModels[0].provider}:${allModels[0].name}`);
      }
    }

    setLoadingModels(false);
  }, [transcriptModelConfig]);

  // Reset user selection tracking (call when dialog opens fresh)
  const resetSelection = useCallback(() => {
    userSelectedRef.current = false;
  }, []);

  return {
    availableModels,
    selectedModelKey,
    setSelectedModelKey: setSelectedModelKeyWithTracking,
    loadingModels,
    fetchModels,
    resetSelection,
  };
}
