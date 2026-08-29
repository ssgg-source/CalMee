import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Cloud, Database, Loader2, Save, TestTube2 } from 'lucide-react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './ui/select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { ModelManager } from './WhisperModelManager';
import { ParakeetModelManager } from './ParakeetModelManager';
import { FunAsrSettings } from './FunAsrSettings';
import { useLanguage } from '@/contexts/LanguageContext';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

export type TranscriptProvider = 'none' | 'localWhisper' | 'parakeet' | 'funasr' | 'qwen3asr' | 'funasr-server' | 'deepgram' | 'groq' | 'openai' | 'qwen-cloud' | 'doubao' | 'tencent-asr' | 'baidu-asr' | 'iflytek-asr' | 'huawei-asr';
export interface TranscriptModelProps { provider: TranscriptProvider; model: string; apiKey?: string | null }
export interface TranscriptSettingsProps { transcriptModelConfig: TranscriptModelProps; setTranscriptModelConfig: (config: TranscriptModelProps) => void; onModelSelect?: () => void }

type CredentialField = { key: string; label: string; placeholder: string; secret?: boolean; required?: boolean };
const LOCAL_PROVIDERS: TranscriptProvider[] = ['none', 'localWhisper', 'parakeet', 'funasr', 'qwen3asr'];
const MODEL_OPTIONS: Record<TranscriptProvider, string[]> = {
  none: [], localWhisper: [], parakeet: [], funasr: [], qwen3asr: [], 'funasr-server': ['default'],
  openai: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize'],
  'qwen-cloud': ['qwen3-asr-flash', 'qwen3-asr-flash-filetrans'],
  doubao: ['volc.bigasr.auc_turbo', 'volc.bigasr.auc'],
  'tencent-asr': ['recording-file', 'realtime-diarization'],
  'baidu-asr': ['pro-asr', 'standard-short-asr'],
  'iflytek-asr': ['asr-llm-file', 'speed-transcription'],
  'huawei-asr': ['recording-file', 'realtime-asr'],
  groq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  deepgram: ['nova-3', 'nova-2'],
};
const MODEL_LABELS: Record<string, string> = {
  'volc.bigasr.auc_turbo': 'Large-model fast recording transcription',
  'volc.bigasr.auc': 'Large-model standard recording transcription',
  'recording-file': 'Recording file transcription',
  'realtime-diarization': 'Real-time transcription with speaker diarization',
  'pro-asr': 'High-speed speech recognition',
  'standard-short-asr': 'Standard short speech recognition',
  'asr-llm-file': 'Large-model recording transcription',
  'speed-transcription': 'High-speed recording transcription',
  'realtime-asr': 'Real-time speech recognition',
};
const CREDENTIAL_FIELDS: Record<Exclude<TranscriptProvider, 'none' | 'localWhisper' | 'parakeet' | 'funasr' | 'qwen3asr'>, CredentialField[]> = {
  'funasr-server': [{ key: 'endpoint', label: 'Server URL', placeholder: 'https://asr.example.com/v1/audio/transcriptions', required: true }, { key: 'apiKey', label: 'Access token (optional)', placeholder: 'Bearer token', secret: true, required: false }],
  openai: [{ key: 'apiKey', label: 'API Key', placeholder: 'sk-…', secret: true }],
  'qwen-cloud': [{ key: 'apiKey', label: 'API Key', placeholder: 'sk-…', secret: true }],
  doubao: [{ key: 'apiKey', label: 'API Key', placeholder: 'X-Api-Key', secret: true }, { key: 'resourceId', label: 'Resource ID', placeholder: 'volc.bigasr.auc_turbo' }],
  'tencent-asr': [{ key: 'appId', label: 'AppID', placeholder: 'AppID' }, { key: 'secretId', label: 'SecretID', placeholder: 'SecretID', secret: true }, { key: 'secretKey', label: 'SecretKey', placeholder: 'SecretKey', secret: true }],
  'baidu-asr': [{ key: 'appId', label: 'AppID', placeholder: 'AppID' }, { key: 'apiKey', label: 'API Key', placeholder: 'API Key', secret: true }, { key: 'secretKey', label: 'Secret Key', placeholder: 'Secret Key', secret: true }],
  'iflytek-asr': [{ key: 'appId', label: 'APPID', placeholder: 'APPID' }, { key: 'apiKey', label: 'APIKey', placeholder: 'APIKey', secret: true }, { key: 'apiSecret', label: 'APISecret', placeholder: 'APISecret', secret: true }],
  'huawei-asr': [{ key: 'accessKeyId', label: 'Access Key ID', placeholder: 'AK', secret: true }, { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: 'SK', secret: true }, { key: 'projectId', label: 'Project ID', placeholder: 'Project ID' }, { key: 'region', label: 'Region', placeholder: 'cn-north-4' }],
  groq: [{ key: 'apiKey', label: 'API Key', placeholder: 'gsk_…', secret: true }],
  deepgram: [{ key: 'apiKey', label: 'API Key', placeholder: 'Deepgram API Key', secret: true }],
};
const TESTABLE = new Set<TranscriptProvider>(['funasr-server', 'openai', 'qwen-cloud', 'groq', 'deepgram']);

export function TranscriptSettings({ transcriptModelConfig, setTranscriptModelConfig, onModelSelect }: TranscriptSettingsProps) {
  const { lt, locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const [uiProvider, setUiProvider] = useState<TranscriptProvider>(transcriptModelConfig.provider);
  const [cloudModel, setCloudModel] = useState(transcriptModelConfig.model);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [savingCloud, setSavingCloud] = useState(false);
  const isLocal = LOCAL_PROVIDERS.includes(uiProvider);
  const fields = isLocal ? [] : CREDENTIAL_FIELDS[uiProvider as keyof typeof CREDENTIAL_FIELDS];
  const cloudReady = !isLocal && Boolean(cloudModel) && fields.every(field => field.required === false || credentials[field.key]?.trim());

  useEffect(() => setUiProvider(transcriptModelConfig.provider), [transcriptModelConfig.provider]);

  const loadCloudProfile = async (provider: TranscriptProvider) => {
    const defaults: Record<string, string> = provider === 'doubao' ? { resourceId: 'volc.bigasr.auc_turbo' } : {};
    setLoadingCredentials(true);
    try {
      const saved = await invoke<{ model?: string; apiKey?: string; credentials?: Record<string, string> }>('api_get_transcript_provider_credentials', { provider });
      setCloudModel(saved.model || MODEL_OPTIONS[provider][0] || '');
      setCredentials({ ...defaults, ...(saved.credentials || {}), ...(saved.apiKey ? { apiKey: saved.apiKey } : {}) });
    } catch {
      setCloudModel(MODEL_OPTIONS[provider][0] || '');
      setCredentials(defaults);
    } finally { setLoadingCredentials(false); }
  };

  const selectLocal = (provider: TranscriptProvider, model: string) => {
    setTranscriptModelConfig({ provider, model, apiKey: null });
    onModelSelect?.();
  };

  const selectRecordingOnly = async () => {
    const config: TranscriptModelProps = { provider: 'none', model: '', apiKey: null };
    try {
      await invoke('api_save_transcript_config', {
        provider: config.provider,
        model: config.model,
        apiKey: null,
      });
      setTranscriptModelConfig(config);
      toast.success(zh ? '已切换为仅录音' : 'Recording-only mode enabled', {
        description: zh ? '录音会立即开始，结束后可在会议页面选择模型转写。' : 'Recording starts immediately. You can transcribe it from the meeting page later.',
      });
      onModelSelect?.();
    } catch (error) {
      reportTechnicalError('save-recording-only-mode', error);
      toast.error(zh ? '无法保存仅录音设置' : 'Could not save recording-only mode', { description: toUserFacingError(error, locale).message });
    }
  };

  const testCloudConnection = async () => {
    const apiKey = credentials.apiKey?.trim() || '';
    if (!TESTABLE.has(uiProvider) || (uiProvider !== 'funasr-server' && !apiKey)) return;
    setTestingConnection(true);
    try {
      await invoke('api_test_transcript_connection', { provider: uiProvider, apiKey, endpoint: credentials.endpoint?.trim() || null });
      toast.success(lt('Connection successful'), { description: uiProvider === 'funasr-server' ? (zh ? '服务器可访问；连接测试没有上传录音。接口格式会在首次转写时完整验证。' : 'The server is reachable; no recording was uploaded. The full API response format is validated on the first transcription.') : lt('Credentials are valid. No recording audio was uploaded.') });
    } catch (error) {
      reportTechnicalError('test-transcription-connection', error);
      toast.error(lt('Connection failed'), { description: toUserFacingError(error, locale).message });
    }
    finally { setTestingConnection(false); }
  };

  const saveCloud = async () => {
    if (!cloudReady) return;
    setSavingCloud(true);
    try {
      const primaryKey = credentials.apiKey || credentials.accessKeyId || credentials.secretId || '';
      await invoke('api_save_transcript_provider_credentials', { provider: uiProvider, model: cloudModel, apiKey: primaryKey || null, credentials });
      toast.success(lt('Cloud transcription credentials saved'), { description: lt('Your active local transcription model was not changed.') });
    } catch (error) {
      reportTechnicalError('save-transcription-provider', error);
      toast.error(lt('Failed to save transcription model configuration'), { description: toUserFacingError(error, locale).message });
    }
    finally { setSavingCloud(false); }
  };

  const localManager = useMemo(() => {
    if (uiProvider === 'localWhisper') return <ModelManager selectedModel={transcriptModelConfig.provider === 'localWhisper' ? transcriptModelConfig.model : undefined} onModelSelect={model => selectLocal('localWhisper', model)} autoSave />;
    if (uiProvider === 'parakeet') return <ParakeetModelManager selectedModel={transcriptModelConfig.provider === 'parakeet' ? transcriptModelConfig.model : undefined} onModelSelect={model => selectLocal('parakeet', model)} autoSave />;
    if (uiProvider === 'funasr') return <FunAsrSettings family="funasr" selectedModel={transcriptModelConfig.provider === 'funasr' ? transcriptModelConfig.model : undefined} onSelected={model => selectLocal('funasr', model)} />;
    if (uiProvider === 'qwen3asr') return <FunAsrSettings family="qwen3asr" selectedModel={transcriptModelConfig.provider === 'qwen3asr' ? transcriptModelConfig.model : undefined} onSelected={model => selectLocal('qwen3asr', model)} />;
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiProvider, transcriptModelConfig.provider, transcriptModelConfig.model]);

  return <div className="space-y-5 pb-6">
    <div>
      <Label className="mb-1 flex items-center gap-2 text-sm font-medium text-gray-700"><Database className="h-4 w-4 text-violet-500" />{isLocal?(zh?'本地 ASR 模型':'Local ASR models'):(zh?'云端 ASR 服务':'Cloud ASR service')}</Label>
      <div className="flex gap-2">
        <Select value={uiProvider} onValueChange={value => { const provider = value as TranscriptProvider; setUiProvider(provider); if (provider === 'none') void selectRecordingOnly(); else if (!LOCAL_PROVIDERS.includes(provider)) void loadCloudProfile(provider); }}>
          <SelectTrigger className="focus:border-blue-500 focus:ring-1 focus:ring-blue-500"><SelectValue placeholder={lt('Select provider')} /></SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectGroup><SelectLabel>{lt('Local models')}</SelectLabel>
              <SelectItem value="none">🎙️ {zh ? '仅录音与会中笔记' : 'Recording and live notes only'}</SelectItem>
              <SelectItem value="parakeet">⚡ {zh ? 'Parakeet（快速本地转写）' : 'Parakeet (fast local transcription)'}</SelectItem>
              <SelectItem value="localWhisper">🏠 {lt('Local Whisper (High Accuracy)')}</SelectItem>
              <SelectItem value="funasr">🎙️ {lt('FunASR (Chinese meetings / Advanced)')}</SelectItem>
              <SelectItem value="qwen3asr">🏠 {lt('Qwen3-ASR (Local)')}</SelectItem>
            </SelectGroup>
            <SelectGroup><SelectLabel>{lt('Chinese cloud ASR')}</SelectLabel>
              <SelectItem value="funasr-server">🌐 {zh ? 'FunASR 服务器（OpenAI 兼容）' : 'FunASR server (OpenAI-compatible)'}</SelectItem>
              <SelectItem value="qwen-cloud">☁️ {lt('Alibaba Cloud Model Studio (Qwen ASR)')}</SelectItem>
              <SelectItem value="doubao">☁️ {lt('Volcano Engine (Doubao Speech)')}</SelectItem>
              <SelectItem value="tencent-asr">☁️ {lt('Tencent Cloud Speech Recognition')}</SelectItem>
              <SelectItem value="baidu-asr">☁️ {lt('Baidu AI Cloud Speech Recognition')}</SelectItem>
              <SelectItem value="iflytek-asr">☁️ {lt('iFLYTEK Open Platform')}</SelectItem>
              <SelectItem value="huawei-asr">☁️ {lt('Huawei Cloud SIS')}</SelectItem>
            </SelectGroup>
            <SelectGroup><SelectLabel>{lt('International cloud ASR')}</SelectLabel>
              <SelectItem value="openai">☁️ OpenAI</SelectItem><SelectItem value="groq">☁️ Groq</SelectItem><SelectItem value="deepgram">☁️ Deepgram</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {!isLocal && (uiProvider === 'funasr-server' ? <Input value={cloudModel} onChange={event => setCloudModel(event.target.value)} placeholder={zh ? '服务器模型名，例如 FunAudioLLM-8B' : 'Server model name, e.g. FunAudioLLM-8B'} /> : <Select value={cloudModel} onValueChange={setCloudModel}><SelectTrigger className="focus:border-blue-500 focus:ring-1 focus:ring-blue-500"><SelectValue placeholder={lt('Select model')} /></SelectTrigger><SelectContent>{MODEL_OPTIONS[uiProvider].map(model => <SelectItem key={model} value={model}>{lt(MODEL_LABELS[model] || model)}</SelectItem>)}</SelectContent></Select>)}
      </div>
    </div>

    {uiProvider === 'none' ? <div className="rounded-xl border border-violet-100 bg-violet-50/70 px-4 py-3 text-sm leading-6 text-slate-600">
      {zh ? '仅保存录音和会中笔记，不加载语音识别模型，也不生成实时字幕。录音结束后可在会议页面选择任意已配置模型进行完整转写。' : 'Saves audio and live notes without loading a speech-recognition model or producing live captions. After recording, choose any configured model on the meeting page to transcribe the full recording.'}
    </div> : isLocal ? <div>{localManager}</div> : <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex gap-3 text-xs leading-5 text-gray-600"><Cloud className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" /><p>{uiProvider === 'funasr-server' ? (zh ? '连接使用 OpenAI 兼容的 /v1/audio/transcriptions 接口。转写时完整录音会发送到你配置的服务器；公网服务建议使用 HTTPS。' : 'Uses an OpenAI-compatible /v1/audio/transcriptions endpoint. The full recording is sent to your configured server; use HTTPS for internet-facing services.') : lt('Configure the cloud service here. CalMee will ask again before sending recording audio to this provider.')}</p></div>
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">{zh?'当前页面用于保存和验证云端凭证。只有完成音频上传、任务轮询和结果转换连接器的服务，才会出现在转写任务中。':'This page stores and validates cloud credentials. A provider appears in transcription tasks only after its upload, polling, and result adapter is implemented.'}</div>
      {loadingCredentials ? <div className="flex items-center gap-2 py-4 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />{lt('Loading…')}</div> : <div className="grid gap-3 md:grid-cols-2">{fields.map(field => <div key={field.key} className="space-y-1.5"><Label>{field.label}</Label><Input type={field.secret ? 'password' : 'text'} value={credentials[field.key] || ''} onChange={event => setCredentials(current => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} /></div>)}</div>}
      <div className="flex flex-wrap gap-2">
        {TESTABLE.has(uiProvider) && <Button variant="outline" onClick={() => void testCloudConnection()} disabled={(uiProvider === 'funasr-server' ? !credentials.endpoint?.trim() : !credentials.apiKey?.trim()) || testingConnection || savingCloud}>{testingConnection ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TestTube2 className="mr-2 h-4 w-4" />}{lt('Test Connection')}</Button>}
        <Button onClick={() => void saveCloud()} disabled={!cloudReady || savingCloud || testingConnection}>{savingCloud ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{lt('Save configuration')}</Button>
      </div>
    </div>}
  </div>;
}
