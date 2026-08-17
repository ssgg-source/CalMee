"use client";

import { useEffect, useRef, useState } from "react";
import { Clock3, NotebookPen } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  LIVE_MEETING_NOTES_EVENT,
  LIVE_MEETING_NOTES_KEY,
  readLiveMeetingNotes,
  writeLiveMeetingNotes,
  type LiveMeetingNotesState,
} from "@/lib/live-meeting-notes";
import { Button } from "@/components/ui/button";

const clock = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
};

export function LiveMeetingNotes({
  currentTime = 0,
  compact = false,
}: {
  currentTime?: number;
  compact?: boolean;
}) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [notes, setNotes] = useState(() => readLiveMeetingNotes().markdown);
  const [saved, setSaved] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const localEditRef = useRef(false);
  const composingRef = useRef(false);

  useEffect(() => {
    const sync = (value?: LiveMeetingNotesState) => {
      if (localEditRef.current) return;
      setNotes(value?.markdown ?? readLiveMeetingNotes().markdown);
      setSaved(true);
    };
    const custom = (event: Event) =>
      sync((event as CustomEvent<LiveMeetingNotesState>).detail);
    const storage = (event: StorageEvent) => {
      if (event.key === LIVE_MEETING_NOTES_KEY) sync();
    };
    window.addEventListener(LIVE_MEETING_NOTES_EVENT, custom);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(LIVE_MEETING_NOTES_EVENT, custom);
      window.removeEventListener("storage", storage);
    };
  }, []);

  useEffect(() => {
    if (!localEditRef.current) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      writeLiveMeetingNotes(notes);
      localEditRef.current = false;
      setSaved(true);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [notes]);

  const insertTimestamp = () => {
    const marker = `- [${clock(currentTime)}] `;
    const element = textareaRef.current;
    const start = element?.selectionStart ?? notes.length;
    const end = element?.selectionEnd ?? start;
    const prefix = start > 0 && notes[start - 1] !== "\n" ? "\n" : "";
    const value = `${notes.slice(0, start)}${prefix}${marker}${notes.slice(end)}`;
    localEditRef.current = true;
    setNotes(value);
    window.requestAnimationFrame(() => {
      const position = start + prefix.length + marker.length;
      element?.focus();
      element?.setSelectionRange(position, position);
    });
  };

  const updateNotes = (value: string) => {
    localEditRef.current = true;
    setNotes(value);
  };

  const handleChange = (value: string) => updateNotes(value);

  const ensureInitialTimestamp = () => {
    if (notes.trim()) return;
    const marker = `- [${clock(currentTime)}] `;
    updateNotes(marker);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(marker.length, marker.length);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    const element = event.currentTarget;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const marker = `\n- [${clock(currentTime)}] `;
    const value = `${notes.slice(0, start)}${marker}${notes.slice(end)}`;
    updateNotes(value);
    window.requestAnimationFrame(() => {
      const position = start + marker.length;
      element.setSelectionRange(position, position);
    });
  };

  return (
    <section
      className={
        compact
          ? "flex min-h-0 flex-1 flex-col"
          : "flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-sm"
      }
    >
      <div className={`flex items-center gap-2 ${compact ? "pb-2" : "border-b border-black/[0.06] px-4 py-3"}`}>
        <NotebookPen className="h-4 w-4 text-violet-500" />
        <span className="text-[13px] font-semibold text-slate-700">
          {zh ? "会中笔记" : "Meeting notes"}
        </span>
        <span className="ml-auto text-[10px] text-slate-400">
          {saved ? (zh ? "已自动保存" : "Autosaved") : zh ? "保存中…" : "Saving…"}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 rounded-lg"
          onClick={insertTimestamp}
          title={zh ? "插入当前时间" : "Insert current time"}
        >
          <Clock3 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <textarea
        ref={textareaRef}
        value={notes}
        onChange={(event) => handleChange(event.target.value)}
        onFocus={ensureInitialTimestamp}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={handleKeyDown}
        placeholder={
          zh
            ? "直接输入即可自动记录时间；Enter 新建时间点，Shift+Enter 换行…"
            : "Start typing to timestamp automatically; Enter adds a timed note, Shift+Enter adds a line…"
        }
        className={`min-h-0 flex-1 resize-none border-0 bg-transparent text-[13px] leading-6 text-slate-700 outline-none placeholder:text-slate-300 ${compact ? "px-1 py-1" : "px-4 py-3"}`}
      />
      {!compact && (
        <p className="border-t border-black/[0.05] px-4 py-2 text-[10px] leading-4 text-slate-400">
          {zh
            ? "人工笔记会与最终文字稿一起用于生成智能记录，但不会改写原始文稿。"
            : "These notes guide the Smart Record without changing the raw transcript."}
        </p>
      )}
    </section>
  );
}
