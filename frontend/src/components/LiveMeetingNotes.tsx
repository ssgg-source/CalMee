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
  Cloud,
  CloudOff,
  Copy,
  Save,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  LIVE_MEETING_NOTES_EVENT,
  LIVE_MEETING_NOTES_CHANNEL,
  LIVE_MEETING_NOTES_KEY,
  readLiveMeetingNotes,
  writeLiveMeetingNotes,
  hasMeaningfulLiveMeetingNotes,
  type LiveMeetingNotesState,
} from "@/lib/live-meeting-notes";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
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
  onAutoSaveChange,
  onContentChange,
  onSave,
  saving = false,
}: {
  currentTime?: number;
  compact?: boolean;
  onSaveStateChange?: (saved: boolean) => void;
  onAutoSaveChange?: (enabled: boolean) => void;
  onContentChange?: (hasContent: boolean) => void;
  onSave?: (markdown: string) => Promise<void>;
  saving?: boolean;
}) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [notes, setNotes] = useState(() => (typeof window !== 'undefined' ? sessionStorage.getItem('calmee.live-notes-conflict') : null) ?? readLiveMeetingNotes().markdown);
  const [saved, setSaved] = useState(() => typeof window === 'undefined' || sessionStorage.getItem('calmee.live-notes-conflict') === null);
  const [autoSave, setAutoSave] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("calmee.live-meeting-notes.auto-save") !== "false";
  });
  const [editorMode, setEditorMode] = useState<"rich" | "markdown">("rich");
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef<UnifiedMarkdownEditorRef | null>(null);
  const localEditRef = useRef(false);
  const notesRef = useRef(notes);
  const composingRef = useRef(false);
  const baseRevisionRef = useRef(readLiveMeetingNotes());
  const [syncConflict, setSyncConflict] = useState(() => typeof window !== 'undefined' && sessionStorage.getItem('calmee.live-notes-conflict') !== null);
  const conflictRef = useRef(syncConflict);
  const writeDraft = (markdown: string) => {
    const result = writeLiveMeetingNotes(markdown, baseRevisionRef.current);
    if (result === false) { sessionStorage.setItem('calmee.live-notes-conflict', markdown); conflictRef.current = true; setSyncConflict(true); setSaved(false); return false; }
    baseRevisionRef.current = readLiveMeetingNotes();
    return true;
  };

  useEffect(() => {
    const sync = (value?: LiveMeetingNotesState) => {
      // Read the authoritative shared snapshot; queued channel payloads may be old.
      const latest = readLiveMeetingNotes();
      if (conflictRef.current) return;
      if (latest.sessionId === baseRevisionRef.current.sessionId && latest.revision === baseRevisionRef.current.revision) return;
      if (localEditRef.current) {
        if (latest.markdown === notesRef.current) { baseRevisionRef.current = latest; return; }
        sessionStorage.setItem('calmee.live-notes-conflict', notesRef.current);
        conflictRef.current = true; setSyncConflict(true); setSaved(false); return;
      }
      baseRevisionRef.current = latest;
      const markdown = latest.markdown;
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
    if (autoSave && localEditRef.current && !conflictRef.current) writeDraft(notesRef.current);
  }, [autoSave]);

  useEffect(() => {
    if (!autoSave || !localEditRef.current || syncConflict) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      if (!writeDraft(notes)) return;
      localEditRef.current = false;
      setSaved(true);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [autoSave, notes, syncConflict]);

  useEffect(() => {
    window.localStorage.setItem("calmee.live-meeting-notes.auto-save", String(autoSave));
    onAutoSaveChange?.(autoSave);
  }, [autoSave, onAutoSaveChange]);

  useEffect(() => {
    onSaveStateChange?.(saved);
  }, [onSaveStateChange, saved]);

  useEffect(() => {
    onContentChange?.(hasMeaningfulLiveMeetingNotes(notes));
  }, [notes, onContentChange]);

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
    if (conflictRef.current) sessionStorage.setItem('calmee.live-notes-conflict', value);
    setNotes(value);
  };

  const handleChange = (value: string) => updateNotes(value);

  const toggleAutoSave = () => {
    setAutoSave((current) => {
      const next = !current;
      if (next && localEditRef.current) {
        if (!writeDraft(notesRef.current)) return next;
        localEditRef.current = false;
        setSaved(true);
      }
      return next;
    });
  };

  const saveNow = async () => {
    if (!hasMeaningfulLiveMeetingNotes(notesRef.current) || saving) return;
    if (conflictRef.current) return;
    if (!writeDraft(notesRef.current)) return;
    localEditRef.current = false;
    setSaved(true);
    await onSave?.(notesRef.current);
  };

  const copyNotes = async () => {
    if (!hasMeaningfulLiveMeetingNotes(notesRef.current)) return;
    await navigator.clipboard.writeText(notesRef.current);
    toast.success(zh ? "会中笔记已复制" : "Meeting notes copied");
  };

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
      {syncConflict && <div role="status" className="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <p>{zh ? '其他窗口更新了笔记。本窗口草稿已保留，自动保存已暂停。请先复制需要保留的内容。' : 'Another window updated the notes. This draft is preserved and auto-save is paused. Copy any text you want to keep first.'}</p>
        <div className="mt-2 flex gap-3">
          <button type="button" onClick={() => void copyNotes()}>{zh ? '复制本窗口笔记' : 'Copy this draft'}</button>
          <button type="button" onClick={() => { const latest=readLiveMeetingNotes(); baseRevisionRef.current=latest; notesRef.current=latest.markdown; localEditRef.current=false; conflictRef.current=false; sessionStorage.removeItem('calmee.live-notes-conflict'); setSyncConflict(false); setNotes(latest.markdown); void editorRef.current?.setMarkdown(latest.markdown); setSaved(true); }}>{zh ? '放弃本窗口草稿，采用最新笔记' : 'Discard this draft and use latest notes'}</button>
        </div>
      </div>}
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
          <ButtonGroup>
            <Button
              variant="outline"
              size="icon"
              className={`h-9 w-9 ${autoSave ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "text-slate-500"}`}
              onClick={toggleAutoSave}
              title={autoSave ? (zh ? "自动保存已开启" : "Auto-save is on") : (zh ? "自动保存已关闭" : "Auto-save is off")}
              aria-pressed={autoSave}
            >
              {autoSave ? <Cloud className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => void saveNow()}
              disabled={!hasMeaningfulLiveMeetingNotes(notes) || saving}
              title={zh ? "保存为会中笔记" : "Save as meeting notes"}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => void copyNotes()}
              disabled={!hasMeaningfulLiveMeetingNotes(notes)}
              title={zh ? "复制" : "Copy"}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </ButtonGroup>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {!compact && (
          <div className="calmee-editor-mode-switch absolute right-4 top-3 z-10 shadow-sm" aria-label={zh ? "编辑模式" : "Editor mode"}>
            <button type="button" aria-label={zh ? "所见即所得" : "Visual editor"} aria-pressed={editorMode === "rich"} onClick={() => setEditorMode("rich")} className={`calmee-editor-mode-button ${editorMode === "rich" ? "is-active" : ""}`}><PanelTop className="h-3.5 w-3.5" /></button>
            <button type="button" aria-label="Markdown" aria-pressed={editorMode === "markdown"} onClick={() => setEditorMode("markdown")} className={`calmee-editor-mode-button ${editorMode === "markdown" ? "is-active" : ""}`}><Code2 className="h-3.5 w-3.5" /></button>
          </div>
        )}
      {editorMode === "rich" ? (
        <div className="h-full min-h-0">
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
          className={`calmee-markdown-source h-full min-h-0 w-full resize-none border-0 bg-transparent outline-none ${compact ? "px-2 py-2" : "px-12 py-8"}`}
        />
      )}
      </div>
      <ProductPromptDialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen} title={zh ? "添加链接" : "Add link"} description={zh ? "链接将应用到当前选中的文字。" : "The link will be applied to the selected text."} value={linkValue} onValueChange={setLinkValue} placeholder="https://" confirmLabel={zh ? "添加" : "Add"} cancelLabel={zh ? "取消" : "Cancel"} onConfirm={()=>{editorRef.current?.runCommand("link",linkValue.trim());setLinkDialogOpen(false);}} />
    </section>
  );
}
