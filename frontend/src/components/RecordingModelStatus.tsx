"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cpu, Loader2, Radio } from "lucide-react";
import { useConfig } from "@/contexts/ConfigContext";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  RecordingStatus,
  useRecordingState,
} from "@/contexts/RecordingStateContext";
import { LIVE_CAPTIONS_STORAGE_KEY, liveCaptionsEnabled } from "@/lib/live-captions";

type ModelStatus = {
  provider: string;
  model: string;
  loaded: boolean;
};

export function RecordingModelStatus({ compact = false }: { compact?: boolean }) {
  const { selectedLanguage } = useConfig();
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const recording = useRecordingState();
  const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState<"off" | "checking" | "ready" | "error">("checking");
  useEffect(() => {
    setEnabled(liveCaptionsEnabled());
  }, []);
  useEffect(() => {
    let active = true;
    void invoke("set_live_caption_enabled", { enabled }).catch(() => undefined);
    if (!enabled) {
      setState("off");
      return () => { active = false; };
    }
    setState("checking");
    // Entering the recording page warms CalMee's fixed lightweight caption
    // model. The full transcription model is intentionally left untouched.
    const request = invoke<ModelStatus>("prepare_transcription_model");
    request
      .then(() => {
        if (!active) return;
        setState("ready");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [enabled, selectedLanguage]);

  const toggle = () => {
    if (recording.isRecording) return;
    const next = !enabled;
    setEnabled(next);
    window.localStorage.setItem(LIVE_CAPTIONS_STORAGE_KEY, String(next));
  };

  const active = recording.isRecording;
  const starting = recording.status === RecordingStatus.STARTING;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={recording.isRecording}
      className={`flex max-w-[360px] items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors ${
        active
          ? "border-red-100 bg-red-50 text-red-600"
          : !enabled
            ? "border-slate-200 bg-slate-50 text-slate-500"
          : state === "error"
            ? "border-amber-200 bg-amber-50 text-amber-700"
            : "border-violet-100 bg-violet-50 text-violet-700"
      } ${recording.isRecording ? "cursor-default" : "cursor-pointer hover:brightness-[0.98]"}`}
      title={active
        ? `${zh ? "本次即时字幕" : "Live captions for this recording"}: SenseVoice Small`
        : `${zh ? "即时字幕" : "Live captions"}: SenseVoice Small`}
    >
      {!enabled ? (
        <Radio className="h-3.5 w-3.5 opacity-45" />
      ) : active ? (
        <Radio className="h-3.5 w-3.5 animate-pulse" />
      ) : state === "checking" || starting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Cpu className="h-3.5 w-3.5" />
      )}
      <span className="truncate">
        {!enabled
          ? (zh ? "纯录音 · 即时字幕已关闭" : "Audio only · Live captions off")
          : active
          ? state === "checking"
              ? (zh ? "录音中 · 转写模型加载中" : "Recording · Loading transcription model")
              : state === "error"
                ? (zh ? "录音中 · 转写不可用" : "Recording · Transcription unavailable")
                : (zh ? "录音中 · 即时字幕" : "Recording · Live captions")
          : state === "checking"
            ? (zh ? "正在加载即时字幕" : "Loading live captions")
            : state === "error"
              ? (zh ? "即时字幕不可用 · 仍可录音" : "Live captions unavailable · Recording still works")
              : compact
                ? (zh ? "即时字幕" : "Live captions")
                : (zh ? "即时字幕已就绪" : "Live captions ready")}
      </span>
      <span aria-hidden="true" className={`ml-1 h-3.5 w-6 rounded-full p-0.5 transition-colors ${enabled ? "bg-violet-500" : "bg-slate-300"}`}>
        <span className={`block h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${enabled ? "translate-x-2.5" : "translate-x-0"}`} />
      </span>
    </button>
  );
}
