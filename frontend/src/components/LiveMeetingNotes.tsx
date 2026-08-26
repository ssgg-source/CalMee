"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Bold,
  BookmarkPlus,
  Clock3,
  Code2,
  Highlighter,
  Heading2,
  Heading3,
  Heading4,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  NotebookPen,
  PanelTop,
  Pilcrow,
  Quote,
  Redo2,
  Undo2,
  Underline,
  Strikethrough,
  ChevronDown,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  LIVE_MEETING_NOTES_EVENT,
  LIVE_MEETING_NOTES_CHANNEL,
  LIVE_MEETING_NOTES_KEY,
  readLiveMeetingNotes,
  writeLiveMeetingNotes,
  type LiveMeetingNotesState,
} from "@/lib/live-meeting-notes";
import { Button } from "@/components/ui/button";
import type { UnifiedMarkdownEditorRef } from "@/components/MeetingWorkspace/UnifiedMarkdownEditor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProductPromptDialog } from "@/components/ui/ProductPromptDialog";

const UnifiedMarkdownEditor = lazy(async () => ({
  default: (await import("@/components/MeetingWorkspace/UnifiedMarkdownEditor")).UnifiedMarkdownEditor,
}));

const clock = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
};

export function LiveMeetingNotes({
  currentTime = 0,
  compact = false,
  onSaveStateChange,
}: {
  currentTime?: number;
  compact?: boolean;
  onSaveStateChange?: (saved: boolean) => void;
}) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [notes, setNotes] = useState(() => readLiveMeetingNotes().markdown);
  const [saved, setSaved] = useState(true);
  const [editorMode, setEditorMode] = useState<"rich" | "markdown">("rich");
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef<UnifiedMarkdownEditorRef | null>(null);
  const localEditRef = useRef(false);
  const notesRef = useRef(notes);
  const composingRef = useRef(false);

  useEffect(() => {
    const sync = (value?: LiveMeetingNotesState) => {
      if (localEditRef.current) return;
      const markdown = value?.markdown ?? readLiveMeetingNotes().markdown;
      notesRef.current = markdown;
      setNotes(markdown);
      void editorRef.current?.setMarkdown(markdown);
      setSaved(true);
    };
    const custom = (event: Event) =>
      sync((event as CustomEvent<LiveMeetingNotesState>).detail);
    const storage = (event: StorageEvent) => {
      if (event.key === LIVE_MEETING_NOTES_KEY) sync();
    };
    window.addEventListener(LIVE_MEETING_NOTES_EVENT, custom);
    window.addEventListener("storage", storage);
    const channel = typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(LIVE_MEETING_NOTES_CHANNEL)
      : null;
    if (channel) channel.onmessage = event => sync(event.data as LiveMeetingNotesState);
    return () => {
      window.removeEventListener(LIVE_MEETING_NOTES_EVENT, custom);
      window.removeEventListener("storage", storage);
      channel?.close();
    };
  }, []);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => () => {
    if (localEditRef.current) writeLiveMeetingNotes(notesRef.current);
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

  useEffect(() => {
    onSaveStateChange?.(saved);
  }, [onSaveStateChange, saved]);

  const insertIntoTextarea = (marker: string) => {
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

  const appendMarker = (marker: string) => {
    if (editorMode === "rich") {
      localEditRef.current = true;
      void editorRef.current?.appendMarkdown(marker);
      return;
    }
    insertIntoTextarea(marker);
  };

  const insertTimestamp = () => appendMarker(`- [${clock(currentTime)}] `);

  const insertHighlight = () =>
    appendMarker(`> 🔖 **${zh ? "重点" : "Highlight"} [${clock(currentTime)}]** `);

  const runEditorCommand = (command: Parameters<UnifiedMarkdownEditorRef["runCommand"]>[0]) => {
    if (editorMode !== "rich") return;
    if (command === "link") {
      setLinkValue("");
      setLinkDialogOpen(true);
      return;
    }
    editorRef.current?.runCommand(command);
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
          : "flex min-h-0 flex-1 flex-col overflow-hidden bg-card"
      }
    >
      {compact ? (
        <div className="flex items-center gap-2 pb-2">
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
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-lg border-amber-200 text-amber-600 hover:bg-amber-50 hover:text-amber-700"
            onClick={insertHighlight}
            title={zh ? "标记当前重点" : "Mark highlight"}
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="calmee-editor-toolbar">
          <button type="button" onClick={() => runEditorCommand("undo")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "撤销" : "Undo"}><Undo2 /></button>
          <button type="button" onClick={() => runEditorCommand("redo")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "重做" : "Redo"}><Redo2 /></button>
          <span className="calmee-editor-toolbar-divider" aria-hidden="true" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={editorMode !== "rich"}>
              <button type="button" className="calmee-editor-style-trigger" aria-label={zh ? "段落样式" : "Paragraph style"}>
                <Pilcrow className="h-3.5 w-3.5" />
                <span>{zh ? "正文" : "Text"}</span>
                <ChevronDown className="h-3 w-3 text-slate-400" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44 rounded-xl p-1.5">
              <DropdownMenuItem onClick={() => runEditorCommand("paragraph")} className="rounded-lg"><Pilcrow />{zh ? "正文" : "Text"}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => runEditorCommand("heading")} className="rounded-lg text-base font-semibold">H1 <span>{zh ? "一级标题" : "Heading 1"}</span></DropdownMenuItem>
              <DropdownMenuItem onClick={() => runEditorCommand("heading2")} className="rounded-lg"><Heading2 />{zh ? "二级标题" : "Heading 2"}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => runEditorCommand("heading3")} className="rounded-lg"><Heading3 />{zh ? "三级标题" : "Heading 3"}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => runEditorCommand("heading4")} className="rounded-lg"><Heading4 />{zh ? "四级标题" : "Heading 4"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button type="button" onClick={() => runEditorCommand("bold")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "粗体" : "Bold"}><Bold /></button>
          <button type="button" onClick={() => runEditorCommand("italic")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "斜体" : "Italic"}><Italic /></button>
          <button type="button" onClick={() => runEditorCommand("underline")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "下划线" : "Underline"}><Underline /></button>
          <button type="button" onClick={() => runEditorCommand("strike")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "删除线" : "Strikethrough"}><Strikethrough /></button>
          <button type="button" onClick={() => runEditorCommand("highlight")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "文字高亮" : "Highlight"}><Highlighter /></button>
          <span className="calmee-editor-toolbar-divider" aria-hidden="true" />
          <button type="button" onClick={() => runEditorCommand("bulletList")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "项目列表" : "Bullet list"}><List /></button>
          <button type="button" onClick={() => runEditorCommand("numberedList")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "编号列表" : "Numbered list"}><ListOrdered /></button>
          <button type="button" onClick={() => runEditorCommand("checkList")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "待办列表" : "Checklist"}><ListChecks /></button>
          <button type="button" onClick={() => runEditorCommand("quote")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "引用" : "Quote"}><Quote /></button>
          <button type="button" onClick={() => runEditorCommand("link")} disabled={editorMode !== "rich"} className="calmee-editor-toolbar-button" aria-label={zh ? "链接" : "Link"}><Link /></button>
          <span className="calmee-editor-toolbar-divider" aria-hidden="true" />
          <Button
            variant="ghost"
            size="icon"
            className="calmee-editor-toolbar-button h-8 w-8"
            onClick={insertTimestamp}
            title={zh ? "插入当前时间" : "Insert current time"}
          >
            <Clock3 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="calmee-editor-toolbar-button h-8 w-8 text-amber-600 hover:bg-amber-50 hover:text-amber-700"
            onClick={insertHighlight}
            title={zh ? "标记当前重点" : "Mark highlight"}
          >
            <BookmarkPlus className="h-4 w-4" />
          </Button>
          <span className="min-w-2 flex-1" />
          <div className="calmee-editor-mode-switch" aria-label={zh ? "编辑模式" : "Editor mode"}>
            <button
              type="button"
              aria-label={zh ? "所见即所得" : "Visual editor"}
              aria-pressed={editorMode === "rich"}
              onClick={() => setEditorMode("rich")}
              className={`calmee-editor-mode-button ${editorMode === "rich" ? "is-active" : ""}`}
            >
              <PanelTop className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="Markdown"
              aria-pressed={editorMode === "markdown"}
              onClick={() => setEditorMode("markdown")}
              className={`calmee-editor-mode-button ${editorMode === "markdown" ? "is-active" : ""}`}
            >
              <Code2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      {editorMode === "rich" ? (
        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="h-full animate-pulse bg-slate-50" />}>
            <UnifiedMarkdownEditor
              ref={editorRef}
              documentKey="active-live-meeting-notes"
              value={notes}
              placeholder={zh ? "记录讨论要点、决定和待办…" : "Capture discussion points, decisions, and actions…"}
              onChange={handleChange}
              compact={compact}
            />
          </Suspense>
        </div>
      ) : (
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
              ? "记录讨论要点、决定和待办；Enter 新建时间点，Shift+Enter 换行…"
              : "Capture discussion points, decisions, and actions; Enter adds a timestamp, Shift+Enter adds a line…"
          }
          className={`calmee-markdown-source min-h-0 flex-1 resize-none border-0 bg-transparent outline-none ${compact ? "px-2 py-2" : "px-12 py-8"}`}
        />
      )}
      <ProductPromptDialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen} title={zh ? "添加链接" : "Add link"} description={zh ? "链接将应用到当前选中的文字。" : "The link will be applied to the selected text."} value={linkValue} onValueChange={setLinkValue} placeholder="https://" confirmLabel={zh ? "添加" : "Add"} cancelLabel={zh ? "取消" : "Cancel"} onConfirm={()=>{editorRef.current?.runCommand("link",linkValue.trim());setLinkDialogOpen(false);}} />
    </section>
  );
}
