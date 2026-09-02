"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import { Pause, Play, RotateCcw, RotateCw, Volume1, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from 'sonner';
import { ProductSelect } from '@/components/ui/ProductControls';
import { useLanguage } from '@/contexts/LanguageContext';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';
import { readViewState, writeViewState } from '@/lib/view-state';

export interface AudioPlayerRef { seekTo: (seconds: number) => void; chooseFile: () => Promise<void>; }
type AudioFileInfo = { path: string; filename: string; duration_seconds: number };

interface AudioPlayerProps {
  meetingId: string;
  onPathChange?: (path: string | null) => void;
  onTimeChange?: (seconds: number) => void;
}

const time = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '00:00';
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
};

const reportMediaDiagnostic = (scope: string, audio: HTMLAudioElement | null, error?: unknown) => {
  const nativeError = error instanceof Error
    ? { name: error.name, message: error.message }
    : error == null ? null : { message: String(error) };
  const mediaError = audio?.error
    ? { code: audio.error.code, message: audio.error.message }
    : null;
  void invoke('log_media_diagnostic', {
    scope,
    detail: JSON.stringify({
      nativeError,
      mediaError,
      readyState: audio?.readyState ?? null,
      networkState: audio?.networkState ?? null,
      paused: audio?.paused ?? null,
      duration: audio?.duration ?? null,
      currentSrc: audio?.currentSrc ?? null,
    }),
  }).catch(() => undefined);
};

export const AudioPlayer = forwardRef<AudioPlayerRef, AudioPlayerProps>(function AudioPlayer({ meetingId, onPathChange, onTimeChange }, ref) {
  const { locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const audioRef = useRef<HTMLAudioElement>(null);
  const [path, setPath] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(() => readViewState<number>(`audio-rate:${meetingId}`) || 1);
  useEffect(() => { writeViewState(`audio-rate:${meetingId}`, rate); }, [meetingId, rate]);
  const [volume, setVolume] = useState(() => {
    if (typeof window === 'undefined') return 1;
    const raw = window.localStorage.getItem('calmee.player.volume');
    if (raw === null) return 1;
    const saved = Number(raw);
    return Number.isFinite(saved) ? Math.max(0, Math.min(1, saved)) : 1;
  });
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [repairing, setRepairing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPath(null); setSourceUrl(null); setCurrent(0); setDuration(0); setPlaying(false); setLoadFailed(false);
    invoke<string | null>('api_get_meeting_audio_path', { meetingId }).then(async value => {
      if (cancelled) return;
      setPath(value); onPathChange?.(value);
      if (!value) return;
      const url = await invoke<string>('get_audio_stream_url', { path: value });
      if (!cancelled) setSourceUrl(url);
    }).catch(error => {
      if (cancelled) return;
      reportTechnicalError('audio-source-load', error);
      setLoadFailed(true);
    });
    return () => { cancelled = true; };
  }, [meetingId, onPathChange]);

  const choose = async () => {
    try {
      const file = await invoke<AudioFileInfo | null>('select_and_validate_audio_command', { meetingId });
      if (!file) return;
      const url = await invoke<string>('get_audio_stream_url', { path: file.path });
      setPlaying(false); setLoading(true); setLoadFailed(false); setPath(file.path); setSourceUrl(url); onPathChange?.(file.path); setCurrent(0); setDuration(file.duration_seconds || 0);
    } catch (error) { reportTechnicalError('audio-file-load', error); toast.error(zh ? '音频载入失败' : 'Could not load audio', { description: toUserFacingError(error, locale).message }); }
  };

  const repairLegacyAudio = async () => {
    if (repairing) return;
    setRepairing(true);
    try {
      const repairedPath = await invoke<string>('api_repair_legacy_meeting_audio', { meetingId });
      const url = await invoke<string>('get_audio_stream_url', { path: repairedPath });
      setPlaying(false); setCurrent(0); setDuration(0); setLoadFailed(false); setLoading(true);
      setPath(repairedPath); setSourceUrl(url); onPathChange?.(repairedPath);
      toast.success(zh ? '已生成兼容的播放副本' : 'Compatible playback copy created', {
        description: zh ? '原始 MP4 已保留。' : 'The original MP4 was preserved.',
      });
    } catch (error) {
      reportTechnicalError('audio-repair', error);
      toast.error(zh ? '音频修复失败' : 'Could not repair audio', {
        description: toUserFacingError(error, locale).message,
      });
    } finally {
      setRepairing(false);
    }
  };

  useEffect(() => {
    if (!sourceUrl || !audioRef.current) return;
    setPlaying(false);
    setLoading(true);
    setCurrent(0);
    audioRef.current.load();
  }, [sourceUrl]);

  // Playback controls must never reload the media. Calling load() for a volume
  // or speed change resets currentTime and can leave WebKit unable to resume a
  // paused element until it becomes ready again.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  const changeVolume = (next: number) => {
    const value = Math.max(0, Math.min(1, next));
    setVolume(value);
    if (audioRef.current) audioRef.current.volume = value;
    window.localStorage.setItem('calmee.player.volume', String(value));
  };

  const togglePlayback = async () => {
    if (!path) { await choose(); return; }
    const audio = audioRef.current;
    if (!audio) return;
    try {
      // The media element is the source of truth. React state is updated by
      // media events and may lag one click behind during rapid pause/resume.
      if (!audio.paused && !audio.ended) {
        audio.pause();
        return;
      }
      if (audio.ended || (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.05)) {
        audio.currentTime = 0;
        setCurrent(0);
        onTimeChange?.(0);
      }
      if (audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await new Promise<void>((resolve, reject) => {
          const ready = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error(audio.error?.message || '音频尚未准备好')); };
          const cleanup = () => {
            audio.removeEventListener('canplay', ready);
            audio.removeEventListener('error', failed);
          };
          audio.addEventListener('canplay', ready, { once: true });
          audio.addEventListener('error', failed, { once: true });
          audio.load();
        });
      }
      await audio.play();
    } catch (error) {
      reportMediaDiagnostic('playback-promise', audio, error);
      reportTechnicalError('audio-play', error);
      toast.error(zh ? '音频无法播放' : 'Could not play audio', { description: toUserFacingError(error, locale).message });
    }
  };

  useImperativeHandle(ref, () => ({ seekTo: seconds => {
    const audio = audioRef.current; if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration || seconds));
    setCurrent(audio.currentTime);
    onTimeChange?.(audio.currentTime);
    void audio.play().catch(error => { reportTechnicalError('audio-seek-play', error); toast.error(zh ? '音频无法播放' : 'Could not play audio', { description: toUserFacingError(error, locale).message }); });
  }, chooseFile: choose }), [path, onTimeChange]);
  const jump = (delta: number) => {
    const audio = audioRef.current; if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + delta));
    setCurrent(audio.currentTime);
    onTimeChange?.(audio.currentTime);
  };

  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Math.max(0, Math.min(audio.duration || duration || seconds, seconds));
    audio.currentTime = next;
    // `timeupdate` is throttled heavily while paused and while the range thumb is
    // being dragged. Publish the requested position immediately so transcript
    // synchronization follows the thumb rather than a later media event.
    setCurrent(next);
    onTimeChange?.(next);
  };

  return <div className="flex w-full min-w-0 max-w-2xl items-center justify-center gap-2 px-2">
    {sourceUrl && <audio key={sourceUrl} ref={audioRef} src={sourceUrl} preload="metadata" playsInline onLoadStart={()=>setLoading(true)} onCanPlay={()=>{setLoading(false);setLoadFailed(false);}} onCanPlayThrough={()=>{setLoading(false);setLoadFailed(false);}} onPlaying={()=>{setLoading(false);setLoadFailed(false);setPlaying(true);}} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={event=>{setPlaying(false);setCurrent(event.currentTarget.duration||0);onTimeChange?.(event.currentTarget.duration||0);}} onLoadedMetadata={event=>{const restored=readViewState<number>(`audio-position:${meetingId}:${path}`);if(restored!==undefined&&Number.isFinite(event.currentTarget.duration)){event.currentTarget.currentTime=Math.min(restored,event.currentTarget.duration);setCurrent(event.currentTarget.currentTime);onTimeChange?.(event.currentTarget.currentTime);}setDuration(event.currentTarget.duration);event.currentTarget.playbackRate=rate;event.currentTarget.volume=volume;}} onSeeking={event=>{setCurrent(event.currentTarget.currentTime);onTimeChange?.(event.currentTarget.currentTime);}} onSeeked={event=>{setCurrent(event.currentTarget.currentTime);onTimeChange?.(event.currentTarget.currentTime);}} onError={event=>{setLoading(false);setPlaying(false);setLoadFailed(true);reportMediaDiagnostic('media-element-error',event.currentTarget);const detail=event.currentTarget.error?.message||(zh?'不支持此音频格式或文件无法访问':'Unsupported audio format or inaccessible file');toast.error(zh?'音频载入失败':'Could not load audio',{description:detail});}} onTimeUpdate={event=>{if(path)writeViewState(`audio-position:${meetingId}:${path}`,event.currentTarget.currentTime);setCurrent(event.currentTarget.currentTime);onTimeChange?.(event.currentTarget.currentTime);}} />}
    {loadFailed && <Button variant="ghost" size="sm" className="h-8 shrink-0 text-[11px] text-amber-700" disabled={repairing} onClick={()=>void repairLegacyAudio()}>{repairing?(zh?'修复中…':'Repairing…'):(zh?'修复旧录音':'Repair old audio')}</Button>}
    <Button variant="ghost" size="icon" className="relative h-8 w-8" disabled={!path} onClick={()=>jump(-15)} title="后退 15 秒"><RotateCcw className="!h-[18px] !w-[18px]" /><span className="pointer-events-none absolute inset-0 flex items-center justify-center pt-px text-[7px] font-bold">15</span></Button>
    <Button variant="outline" size="icon" className="h-9 w-9 rounded-full border-violet-200 text-violet-700" disabled={!path && loading} onClick={()=>void togglePlayback()} title={path ? (playing?'暂停':'播放') : '选择音频'}>{playing?<Pause className="h-4 w-4"/>:<Play className="ml-0.5 h-4 w-4"/>}</Button>
    <Button variant="ghost" size="icon" className="relative h-8 w-8" disabled={!path} onClick={()=>jump(15)} title="前进 15 秒"><RotateCw className="!h-[18px] !w-[18px]" /><span className="pointer-events-none absolute inset-0 flex items-center justify-center pt-px text-[7px] font-bold">15</span></Button>
    <span className="w-11 shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-500">{time(current)}</span>
    <input aria-label="播放进度" type="range" min={0} max={duration || 1} step={0.1} value={Math.min(current,duration||0)} disabled={!path} onChange={event=>seek(Number(event.target.value))} className="h-1 min-w-36 flex-1 accent-violet-600" />
    <span className="w-11 shrink-0 font-mono text-[11px] tabular-nums text-slate-500">{time(duration)}</span>
    <ProductSelect aria-label="播放速度" value={rate} onChange={event=>{const next=Number(event.target.value);setRate(next);if(audioRef.current)audioRef.current.playbackRate=next;}} className="h-7 w-[62px] cursor-pointer appearance-none border-0 bg-muted/55 px-2 text-[11px] shadow-none"><option value={0.75}>0.75×</option><option value={1}>1×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></ProductSelect>
    <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-slate-500" disabled={!path} title={`音量 ${Math.round(volume*100)}%`}>{volume===0?<VolumeX className="h-4 w-4"/>:volume<0.5?<Volume1 className="h-4 w-4"/>:<Volume2 className="h-4 w-4"/>}</Button></PopoverTrigger><PopoverContent align="end" sideOffset={8} className="w-48 p-3"><div className="flex items-center gap-3"><Volume1 className="h-4 w-4 shrink-0 text-slate-400"/><input aria-label="音量" type="range" min={0} max={1} step={0.01} value={volume} onChange={event=>changeVolume(Number(event.target.value))} className="h-1 min-w-0 flex-1 accent-violet-600"/><span className="w-8 text-right text-[10px] tabular-nums text-slate-500">{Math.round(volume*100)}</span></div></PopoverContent></Popover>
  </div>;
});
