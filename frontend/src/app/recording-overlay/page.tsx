"use client";

import { useEffect, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { ChevronUp, Maximize2, Minus, NotebookPen, Pause, Play, Square } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useRecordingState } from "@/contexts/RecordingStateContext";
import { recordingService } from "@/services/recordingService";
import { LiveMeetingNotes } from "@/components/LiveMeetingNotes";
import { Button } from "@/components/ui/button";

const BAR_WIDTH = 242;
const BAR_HEIGHT = 52;
const NOTES_WIDTH = 460;
const NOTES_HEIGHT = 400;
const NOTES_MIN_WIDTH = 360;
const NOTES_MIN_HEIGHT = 280;
const BUTTON_SIZE = 34;
const NOTES_SIZE_KEY = "calmee-recording-overlay-notes-size";

const savedNotesSize = () => {
  try {
    const value = JSON.parse(window.localStorage.getItem(NOTES_SIZE_KEY) || "null") as { width?: number; height?: number } | null;
    return {
      width: Math.max(NOTES_MIN_WIDTH, Number(value?.width) || NOTES_WIDTH),
      height: Math.max(NOTES_MIN_HEIGHT, Number(value?.height) || NOTES_HEIGHT),
    };
  } catch {
    return { width: NOTES_WIDTH, height: NOTES_HEIGHT };
  }
};

const clock = (seconds?: number | null) => {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
};

export default function RecordingOverlayPage() {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const recording = useRecordingState();
  const [mode, setMode] = useState<"bar" | "button">("bar");
  const [notesOpen, setNotesOpen] = useState(false);
  const [pausePending, setPausePending] = useState(false);
  const [optimisticPaused, setOptimisticPaused] = useState<boolean | null>(null);
  const [displayDuration, setDisplayDuration] = useState(0);

  useEffect(() => {
    const base = Math.max(0, recording.recordingDuration || 0);
    setDisplayDuration(base);
    if (!recording.isRecording || recording.isPaused) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setDisplayDuration(base + (Date.now() - startedAt) / 1000);
    }, 200);
    return () => window.clearInterval(timer);
  }, [recording.isPaused, recording.isRecording, recording.recordingDuration]);

  useEffect(() => {
    const htmlBackground = document.documentElement.style.background;
    const bodyBackground = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      document.documentElement.style.background = htmlBackground;
      document.body.style.background = bodyBackground;
    };
  }, []);

  useEffect(() => {
    const overlay = getCurrentWindow();
    const updateSize = async () => {
      if (mode === "button") {
        await overlay.setMinSize(null);
        await overlay.setResizable(false);
        await overlay.setSize(new LogicalSize(BUTTON_SIZE, BUTTON_SIZE));
        return;
      }
      if (notesOpen) {
        const size = savedNotesSize();
        await overlay.setResizable(true);
        await overlay.setMinSize(new LogicalSize(NOTES_MIN_WIDTH, NOTES_MIN_HEIGHT));
        await overlay.setSize(new LogicalSize(size.width, size.height));
        return;
      }
      await overlay.setMinSize(null);
      await overlay.setResizable(false);
      await overlay.setSize(new LogicalSize(BAR_WIDTH, BAR_HEIGHT));
    };
    void updateSize();
  }, [mode, notesOpen]);

  useEffect(() => {
    if (mode !== "bar" || !notesOpen) return;
    let timer: number | undefined;
    const rememberSize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (window.innerWidth < NOTES_MIN_WIDTH || window.innerHeight < NOTES_MIN_HEIGHT) return;
        window.localStorage.setItem(NOTES_SIZE_KEY, JSON.stringify({
          width: Math.round(window.innerWidth),
          height: Math.round(window.innerHeight),
        }));
      }, 120);
    };
    window.addEventListener("resize", rememberSize);
    return () => {
      window.removeEventListener("resize", rememberSize);
      window.clearTimeout(timer);
    };
  }, [mode, notesOpen]);

  useEffect(() => {
    if (optimisticPaused === recording.isPaused) setOptimisticPaused(null);
  }, [optimisticPaused, recording.isPaused]);

  const pause = async () => {
    if (pausePending) return;
    const target = !recording.isPaused;
    setOptimisticPaused(target);
    setPausePending(true);
    try {
      if (recording.isPaused) await recordingService.resumeRecording();
      else await recordingService.pauseRecording();
    } catch (error) {
      setOptimisticPaused(null);
      console.error("Failed to change recording pause state", error);
    } finally {
      setPausePending(false);
    }
  };

  const displayPaused = optimisticPaused ?? recording.isPaused;
  const statusColor = displayPaused
    ? "bg-amber-400"
    : "bg-red-500";
  const statusTitle = displayPaused
    ? (zh ? "录音已暂停" : "Recording paused")
    : (zh ? "正在录音" : "Recording");

  const restoreMainWindow = async () => {
    const main = await WebviewWindow.getByLabel("main");
    await main?.show();
    await main?.setFocus();
    await getCurrentWindow().hide();
  };

  if (mode === "button") {
    return (
      <main className="h-screen bg-transparent">
        <div
          data-tauri-drag-region
          onMouseDown={() => void getCurrentWindow().startDragging()}
          className="relative flex h-full w-full cursor-grab items-center justify-center bg-transparent active:cursor-grabbing"
          title={zh ? "拖动外圈移动；点击中心展开" : "Drag the rim to move; click the center to expand"}
        >
          <button
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setMode("bar")}
            className="group flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-black/[0.08] bg-white/95 transition-transform hover:scale-105"
            title={zh ? "展开录音浮窗" : "Expand recorder"}
          >
            <span className={`h-2 w-2 rounded-full ${displayPaused ? "" : "animate-pulse"} ${statusColor}`} title={statusTitle} />
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="h-screen bg-transparent">
      <section className="relative flex h-full flex-col overflow-hidden rounded-[15px] border border-black/[0.08] bg-white/95 backdrop-blur-xl">
        <div
          data-tauri-drag-region
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button, input, textarea, [contenteditable='true']")) return;
            void getCurrentWindow().startDragging();
          }}
          className="flex h-[52px] shrink-0 cursor-grab items-center gap-1 px-2 active:cursor-grabbing"
          title={zh ? "拖动空白区域可移动浮窗" : "Drag any empty area to move"}
        >
          <div data-tauri-drag-region className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-1">
            <span className={`h-2 w-2 shrink-0 rounded-full ${displayPaused ? "" : "animate-pulse"} ${statusColor}`} title={statusTitle} />
            <span className="font-mono text-[11px] tabular-nums text-slate-600">
              {clock(displayDuration)}
            </span>
          </div>

          <Button disabled={pausePending} variant="ghost" size="icon" className="h-7 w-7 rounded-lg shadow-none" onClick={() => void pause()} title={displayPaused ? (zh ? "继续" : "Resume") : zh ? "暂停" : "Pause"}>
            {displayPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className={`h-7 w-7 rounded-lg shadow-none ${notesOpen ? "bg-violet-50 text-violet-700" : ""}`} onClick={() => setNotesOpen(value => !value)} title={zh ? "会中笔记" : "Meeting notes"}>
            {notesOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <NotebookPen className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg shadow-none" onClick={() => { setNotesOpen(false); setMode("button"); }} title={zh ? "缩成录音按钮" : "Collapse to recording button"}>
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg shadow-none" onClick={() => void restoreMainWindow()} title={zh ? "恢复完整界面" : "Restore full app"}>
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" className="h-7 w-7 rounded-full bg-red-500 shadow-none hover:bg-red-600" onClick={() => void emitTo("main", "recording-overlay-stop-request")} title={zh ? "停止并保存" : "Stop and save"}>
            <Square className="h-3 w-3 fill-current" />
          </Button>
        </div>

        {notesOpen && (
          <div className="min-h-0 flex-1 border-t border-black/[0.06] px-3 py-2">
            <LiveMeetingNotes currentTime={recording.activeDuration || 0} compact />
          </div>
        )}
        {notesOpen && (
          <button
            type="button"
            aria-label={zh ? "拖动调整笔记窗口大小" : "Drag to resize notes window"}
            title={zh ? "拖动调整宽度和高度" : "Drag to resize width and height"}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void getCurrentWindow().startResizeDragging("SouthEast");
            }}
            className="absolute bottom-0 right-0 z-30 h-5 w-5 cursor-se-resize bg-[linear-gradient(135deg,transparent_0%,transparent_52%,rgba(148,163,184,.55)_53%,rgba(148,163,184,.55)_59%,transparent_60%,transparent_69%,rgba(148,163,184,.55)_70%,rgba(148,163,184,.55)_76%,transparent_77%)] opacity-70 hover:opacity-100"
          />
        )}
      </section>
    </main>
  );
}
