"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CalendarDays,
  Cloud,
  CloudOff,
  Copy,
  Check,
  FileAudio,
  FileText,
  Languages,
  Link2,
  ListTree,
  NotebookPen,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  UserRound,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";
import type { Summary, Transcript, TranscriptSegmentData } from "@/types";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AudioPlayer, AudioPlayerRef } from "./AudioPlayer";
import { RawTranscriptView, RawTranscriptViewRef } from "./RawTranscriptView";
import type { UnifiedMarkdownEditorRef } from "./UnifiedMarkdownEditor";
import { ProgressIconButton } from "./ProgressIconButton";
import { TagManager } from "./TagManager";
import { CalendarLinkDialog } from "./CalendarLinkDialog";
import {
  TemplateManagerDialog,
  DocumentTemplate,
  localizedTemplate,
} from "./TemplateManagerDialog";
import { RetranscribeDialog } from "@/components/MeetingDetails/RetranscribeDialog";
import { DeepOrganizeDialog } from "@/components/MeetingDetails/DeepOrganizeDialog";
import { TranscriptRefinementDialog } from "@/components/MeetingDetails/TranscriptRefinementDialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { reportTechnicalError, toUserFacingError, transcriptionProgressLabel } from "@/lib/feedback";

// BlockNote is the heaviest dependency in the meeting workspace. The raw
// transcript is the default tab, so loading the editor up front makes every
// first meeting open pay that cost even when the editor is never used.
const UnifiedMarkdownEditor = lazy(() =>
  import("./UnifiedMarkdownEditor").then((module) => ({
    default: module.UnifiedMarkdownEditor,
  })),
);

function EditorLoadingState({ zh }: { zh: boolean }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      {zh ? "正在加载编辑器…" : "Loading editor…"}
    </div>
  );
}

type Tab = "raw" | "smart" | "summary" | "notes" | "speech";
type DocumentKind = "smart_record" | "meeting_summary" | "speech_summary";
type MeetingDocument = {
  markdown: string;
  language: string;
  templateId?: string;
};
type EditorSnapshot = {
  tab: Exclude<Tab, "raw">;
  kind?: DocumentKind;
  contextKey?: string;
  markdown: string;
  language?: string;
  templateId?: string;
};
type GenerationPreference = {
  meetingId: string;
  kind: string;
  language: string;
  templateId?: string;
  provider?: string;
  model?: string;
  parametersJson: string;
};
type Speaker = {
  key: string;
  name: string;
  localSpeaker?: string;
  personId?: string;
  segmentCount: number;
};
type OrganizerJob = {
  status: string;
  progress?: { percentage: number; message: string };
  preview?: {
    markdown?: string;
    record: {
      blocks: Array<{
        personName?: string;
        localSpeaker?: string;
        startMs: number;
        text: string;
      }>;
    };
  };
  error?: string;
};
type SpeechSummaryJob = {
  status: string;
  progress?: { percentage: number; message: string };
  markdown?: string;
  error?: string;
};

const tabKind: Partial<Record<Tab, DocumentKind>> = {
  smart: "smart_record",
  summary: "meeting_summary",
  speech: "speech_summary",
};
const tabs: Array<{ id: Tab; en: string; zh: string; icon: any }> = [
  { id: "raw", en: "Raw Transcript", zh: "原始文稿", icon: FileText },
  { id: "smart", en: "Smart Record", zh: "智能记录", icon: ListTree },
  { id: "summary", en: "Meeting Summary", zh: "会议纪要", icon: WandSparkles },
  { id: "notes", en: "Meeting Notes", zh: "会中笔记", icon: NotebookPen },
];
const formatClock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};

function DocumentTabProgress({
  value,
  tone = "default",
}: {
  value: number;
  tone?: "default" | "ai";
}) {
  const indeterminate = value < 0;
  const progress = Math.max(1, Math.min(100, value));
  const circumference = 37.7;
  return (
    <span
      className={`relative flex h-4 w-4 shrink-0 items-center justify-center ${tone === "ai" ? "text-violet-600" : "text-slate-500"}`}
      aria-hidden="true"
    >
      <svg className={`absolute h-4 w-4 -rotate-90 ${indeterminate ? "animate-spin" : ""}`} viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".14" strokeWidth="1.8" />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeDasharray={indeterminate ? "10 27.7" : circumference}
          strokeDashoffset={indeterminate ? 0 : circumference * (1 - progress / 100)}
        />
      </svg>
      {!indeterminate && <span className="text-[5px] font-bold leading-none tabular-nums">{Math.round(progress)}</span>}
    </span>
  );
}

function summaryMarkdown(summary: Summary | null) {
  const data: any = summary;
  if (!data) return "";
  if (typeof data.markdown === "string") return data.markdown;
  if (Array.isArray(data.summary_json)) return "";
  return Object.values(data)
    .filter((value: any) => value && typeof value === "object" && value.title)
    .map(
      (section: any) =>
        `## ${section.title}\n\n${(section.blocks || [])
          .map((block: any) => block.content || block.text || "")
          .filter(Boolean)
          .join("\n\n")}`,
    )
    .join("\n\n");
}
function organizerMarkdown(job: OrganizerJob) {
  return (
    job.preview?.markdown || job.preview?.record.blocks
      .map(
        (block) =>
          `${block.personName || block.localSpeaker ? `### ${block.personName || block.localSpeaker} · ${formatClock(block.startMs)}\n\n` : ""}${block.text}`,
      )
      .join("\n\n") || ""
  );
}

export function MeetingWorkspaceShell({
  meeting,
  title,
  onTitleChange,
  onSaveTitle,
  transcripts,
  segments,
  onRefetchTranscripts,
  summary,
  summaryStatus,
  onGenerateSummary,
  onStopSummary,
  onDelete,
}: {
  meeting: any;
  title: string;
  onTitleChange: (value: string) => void;
  onSaveTitle: () => Promise<boolean>;
  transcripts: Transcript[];
  segments?: TranscriptSegmentData[];
  onRefetchTranscripts?: () => Promise<void>;
  summary: Summary | null;
  summaryStatus: string;
  onGenerateSummary: (prompt?: string) => Promise<void>;
  onStopSummary: () => Promise<void>;
  onDelete: () => void;
}) {
  const { locale, t } = useLanguage();
  const zh = locale === "zh-CN";
  const languages = [
    ["auto", zh ? "跟随原文" : "Follow source"],
    ["zh", zh ? "简体中文" : "Simplified Chinese"],
    ["zh-tw", zh ? "繁体中文" : "Traditional Chinese"],
    ["en", "English"],
    ["ja", "日本語"],
    ["ko", "한국어"],
  ];
  const [active, setActive] = useState<Tab>("raw");
  const [editingTitle, setEditingTitle] = useState(false);
  const titleBefore = useRef(title);
  const [meetingTime, setMeetingTime] = useState(
    meeting.meeting_start_time || meeting.created_at,
  );
  const [timeOpen, setTimeOpen] = useState(false);
  const [timeDraft, setTimeDraft] = useState("");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [linkedEvent, setLinkedEvent] = useState<any>(null);
  const [docs, setDocs] = useState<
    Partial<Record<DocumentKind, MeetingDocument>>
  >({});
  const [docText, setDocText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorAutoSave, setEditorAutoSave] = useState(() => {
    if (typeof window === "undefined") return true;
    const current = window.localStorage.getItem("calmee.meeting-editor.auto-save");
    if (current != null) return current !== "false";
    return window.localStorage.getItem("calmee.meeting-notes.auto-save") !== "false";
  });
  const editorAutoSaveRef = useRef(editorAutoSave);
  const latestEditorSnapshotRef = useRef<EditorSnapshot | null>(null);
  const editorDirtyRef = useRef(false);
  const rawDirtyRef = useRef(false);
  const editorSaveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  // This token only remounts the editor after a document is loaded/replaced.
  // It is not a persisted document version.
  const [editorReloadToken, setEditorReloadToken] = useState(0);
  const documentLoadToken = useRef(0);
  const [language, setLanguage] = useState<Record<DocumentKind, string>>({
    smart_record: "auto",
    meeting_summary: "auto",
    speech_summary: "auto",
  });
  const [templates, setTemplates] = useState<
    Partial<Record<DocumentKind, DocumentTemplate>>
  >({});
  const [templateOpen, setTemplateOpen] = useState(false);
  const [preferences, setPreferences] = useState<
    Partial<Record<DocumentKind, GenerationPreference>>
  >({});
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [selectedSpeakers, setSelectedSpeakers] = useState<Speaker[]>([]);
  const [retranscribeOpen, setRetranscribeOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [organizeProgress, setOrganizeProgress] = useState<number | null>(null);
  const [organizeMessage, setOrganizeMessage] = useState("");
  const [speechOpen, setSpeechOpen] = useState(false);
  const [speechProgress, setSpeechProgress] = useState<number | null>(null);
  const [speechMessage, setSpeechMessage] = useState("");
  const [speechJobContext, setSpeechJobContext] = useState("");
  const [refinementOpen, setRefinementOpen] = useState(false);
  const [importWorkflow, setImportWorkflow] = useState<{ refine: boolean; smartRecord: boolean } | null>(null);
  const [refinementProgress, setRefinementProgress] = useState<number | null>(
    null,
  );
  const [refinementMessage, setRefinementMessage] = useState("");
  const [transcriptionProgress, setTranscriptionProgress] = useState<
    number | null
  >(null);
  const [transcriptionMessage, setTranscriptionMessage] = useState("");
  const [reclusterProgress, setReclusterProgress] = useState<number | null>(
    null,
  );
  const [reclusterMessage, setReclusterMessage] = useState("");
  const [audioPath, setAudioPath] = useState<string | null>(
    meeting.folder_path || null,
  );
  const rawRef = useRef<RawTranscriptViewRef>(null);
  const editorRef = useRef<UnifiedMarkdownEditorRef>(null);
  const audioRef = useRef<AudioPlayerRef>(null);
  const [audioTime, setAudioTime] = useState(0);
  const kind = tabKind[active];
  const contextKey =
    active === "speech"
      ? selectedSpeakers
          .map((item) => item.key)
          .sort()
          .join("|")
      : "";

  useEffect(() => {
    editorAutoSaveRef.current = editorAutoSave;
    window.localStorage.setItem(
      "calmee.meeting-editor.auto-save",
      String(editorAutoSave),
    );
  }, [editorAutoSave]);

  useEffect(() => {
    const key = `calmee.import-workflow.${meeting.id}`;
    try {
      const workflow = JSON.parse(window.sessionStorage.getItem(key) || "null");
      window.sessionStorage.removeItem(key);
      if (workflow?.transcribe) {
        setImportWorkflow({ refine: Boolean(workflow.refine), smartRecord: Boolean(workflow.smartRecord) });
        setActive("raw");
        window.setTimeout(() => setRetranscribeOpen(true), 250);
      }
    } catch {
      window.sessionStorage.removeItem(key);
    }
  }, [meeting.id]);

  useEffect(() => {
    invoke("api_get_linked_calendar_event", { meetingId: meeting.id })
      .then(setLinkedEvent)
      .catch(() => undefined);
    invoke<Speaker[]>("api_get_meeting_speaker_options", {
      meetingId: meeting.id,
    })
      .then((items) => {
        setSpeakers(items);
        const storageKey = `calmee.speech-speakers.${meeting.id}`;
        const legacy = window.localStorage.getItem(
          `calmee.speech-speaker.${meeting.id}`,
        );
        let savedKeys: string[] = [];
        try {
          const saved = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
          if (Array.isArray(saved)) savedKeys = saved.filter((key): key is string => typeof key === "string");
        } catch {
          savedKeys = [];
        }
        if (!savedKeys.length && legacy) savedKeys = [legacy];
        setSelectedSpeakers((current) => {
          const desired = current.length ? current.map((item) => item.key) : savedKeys;
          return items.filter((item) => desired.includes(item.key));
        });
      })
      .catch(() => undefined);
  }, [meeting.id]);
  useEffect(() => {
    if (!kind) return;
    const token = ++documentLoadToken.current;
    let live = true;
    Promise.all([
      invoke<MeetingDocument | null>("api_get_meeting_document", {
        meetingId: meeting.id,
        kind,
        contextKey: contextKey || null,
      }),
      invoke<DocumentTemplate[]>("api_list_document_templates", { kind }),
      invoke<GenerationPreference | null>("api_get_generation_preference", {
        meetingId: meeting.id,
        kind,
      }),
    ]).then(async ([document, available, preference]) => {
      if (!live || token !== documentLoadToken.current) return;
      let markdown = document?.markdown || "";
      if (!markdown && kind === "smart_record") {
        const record: any = await invoke("api_get_or_build_meeting_record", {
          meetingId: meeting.id,
        });
        if (!live || token !== documentLoadToken.current) return;
        /* Only an explicitly imported/edited organized document belongs here. The rule-built raw record and transcript refinement are separate sources. */ markdown =
          record.documentMarkdown || "";
      }
      if (!markdown && kind === "meeting_summary")
        markdown = summaryMarkdown(summary);
      const effectiveLanguage =
        document?.language || preference?.language || "auto";
      const selected =
        available.find(
          (item) =>
            item.id === (preference?.templateId || document?.templateId),
        ) || available[0];
      setDocs((current) => ({
        ...current,
        [kind]: {
          markdown,
          language: effectiveLanguage,
          templateId: selected?.id,
        },
      }));
      if (preference)
        setPreferences((current) => ({ ...current, [kind]: preference }));
      latestEditorSnapshotRef.current = {
        tab: active as Exclude<Tab, "raw">,
        kind,
        contextKey: contextKey || undefined,
        markdown,
        language: effectiveLanguage,
        templateId: selected?.id,
      };
      editorDirtyRef.current = false;
      setDocText(markdown);
      setEditorReloadToken((value) => value + 1);
      setLanguage((current) => ({ ...current, [kind]: effectiveLanguage }));
      if (selected)
        setTemplates((current) => ({ ...current, [kind]: selected }));
      setDirty(false);
    });
    return () => {
      live = false;
    };
  }, [meeting.id, kind, contextKey]);
  useEffect(() => {
    if (active !== "notes") return;
    const token = ++documentLoadToken.current;
    let live = true;
    invoke<{ notesMarkdown?: string } | null>("api_get_meeting_notes", {
      meetingId: meeting.id,
    }).then((notes) => {
      if (!live || token !== documentLoadToken.current) return;
      const markdown = notes?.notesMarkdown || "";
      latestEditorSnapshotRef.current = { tab: "notes", markdown };
      editorDirtyRef.current = false;
      setDocText(markdown);
      setEditorReloadToken((value) => value + 1);
      setDirty(false);
    }).catch((error) => {
      if (live) {
        reportTechnicalError("meeting-notes-load", error);
        toast.error(zh ? "读取会中笔记失败" : "Could not load meeting notes", {
          description: toUserFacingError(error, locale).message,
        });
      }
    });
    return () => { live = false; };
  }, [active, locale, meeting.id, zh]);
  useEffect(() => {
    if (active === "summary") {
      const value = summaryMarkdown(summary);
      if (value && value !== docText) {
        latestEditorSnapshotRef.current = {
          tab: "summary",
          kind: "meeting_summary",
          markdown: value,
          language: language.meeting_summary,
          templateId: templates.meeting_summary?.id,
        };
        editorDirtyRef.current = true;
        setDocText(value);
        setEditorReloadToken((token) => token + 1);
        setDirty(true);
      }
    }
  }, [summary]);
  useEffect(() => {
    if (organizeProgress == null) return;
    let timer: number;
    const poll = async () => {
      const job = await invoke<OrganizerJob>(
        "api_get_ai_organize_meeting_record_status",
        { meetingId: meeting.id },
      );
      if (job.status === "processing") {
        setOrganizeProgress(job.progress?.percentage || 5);
        setOrganizeMessage(job.progress?.message || "");
        timer = window.setTimeout(() => void poll(), 1200);
      } else if (job.status === "completed") {
        const value = organizerMarkdown(job);
        setDocText(value);
        setDocs((current) => ({
          ...current,
          smart_record: {
            markdown: value,
            language: language.smart_record,
            templateId: templates.smart_record?.id,
          },
        }));
        setEditorReloadToken((token) => token + 1);
        latestEditorSnapshotRef.current = {
          tab: "smart",
          kind: "smart_record",
          markdown: value,
          language: language.smart_record,
          templateId: templates.smart_record?.id,
        };
        editorDirtyRef.current = false;
        setDirty(false);
        setOrganizeProgress(null);
        setOrganizeMessage("");
        setActive("smart");
        await invoke("api_clear_ai_organize_meeting_record", {
          meetingId: meeting.id,
        });
      } else if (job.status === "error") {
        setOrganizeProgress(null);
        reportTechnicalError("meeting-organize-job", job.error);
        toast.error(zh ? "AI 整理失败" : "AI organization failed", { description: toUserFacingError(job.error, locale).message });
      } else if (job.status === "cancelled") {
        setOrganizeProgress(null);
        setOrganizeMessage("");
        toast.info(zh ? "已取消 AI 生成" : "AI generation cancelled");
      }
    };
    void poll();
    return () => window.clearTimeout(timer);
  }, [organizeProgress, meeting.id, zh, language.smart_record, templates.smart_record]);
  useEffect(() => {
    if (speechProgress == null || !speechJobContext) return;
    let timer: number;
    let live = true;
    const poll = async () => {
      const job = await invoke<SpeechSummaryJob>("api_get_speech_summary_status", {
        meetingId: meeting.id,
        contextKey: speechJobContext,
      });
      if (!live) return;
      if (job.status === "processing") {
        setSpeechProgress(job.progress?.percentage || 5);
        setSpeechMessage(job.progress?.message || "");
        timer = window.setTimeout(() => void poll(), 1200);
      } else if (job.status === "completed" && job.markdown) {
        setSpeechProgress(null);
        setSpeechMessage("");
        if (contextKey === speechJobContext) {
          setDocText(job.markdown);
          setDocs((current) => ({
            ...current,
            speech_summary: {
              markdown: job.markdown!,
              language: language.speech_summary,
              templateId: templates.speech_summary?.id,
            },
          }));
          setEditorReloadToken((token) => token + 1);
          latestEditorSnapshotRef.current = {
            tab: "speech",
            kind: "speech_summary",
            contextKey: speechJobContext,
            markdown: job.markdown,
            language: language.speech_summary,
            templateId: templates.speech_summary?.id,
          };
          editorDirtyRef.current = false;
          setDirty(false);
        }
        await invoke("api_clear_speech_summary", {
          meetingId: meeting.id,
          contextKey: speechJobContext,
        });
        toast.success(zh ? "讲话总结已生成" : "Speech summary generated");
      } else if (job.status === "error") {
        setSpeechProgress(null);
        setSpeechMessage("");
        reportTechnicalError("speech-summary-job", job.error);
        toast.error(zh ? "讲话总结生成失败" : "Speech summary failed", { description: toUserFacingError(job.error, locale).message });
      } else if (job.status === "cancelled") {
        setSpeechProgress(null);
        setSpeechMessage("");
        toast.info(zh ? "已取消讲话总结" : "Speech summary cancelled");
      }
    };
    void poll();
    return () => { live = false; if (timer) window.clearTimeout(timer); };
  }, [speechProgress, speechJobContext, meeting.id, contextKey, language.speech_summary, templates.speech_summary, zh]);
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listen<any>("retranscription-progress", (event) => {
        if (event.payload.meeting_id === meeting.id) {
          setTranscriptionProgress(event.payload.determinate === false ? -1 : (event.payload.progress_percentage || 1));
          setTranscriptionMessage(transcriptionProgressLabel(event.payload.stage, locale));
        }
      }),
      listen<any>("retranscription-complete", async (event) => {
        if (event.payload.meeting_id !== meeting.id) return;
        setTranscriptionProgress(null);
        setTranscriptionMessage("");
        await onRefetchTranscripts?.();
        toast.success(
          zh
            ? `转写完成，共 ${event.payload.segments_count} 段`
            : `Transcription completed with ${event.payload.segments_count} segments`,
        );
        if (importWorkflow?.refine) {
          setImportWorkflow((current) => current ? { ...current, refine: false } : null);
          window.setTimeout(() => setRefinementOpen(true), 300);
        } else if (importWorkflow?.smartRecord) {
          setImportWorkflow(null);
          setActive("smart");
          window.setTimeout(() => setOrganizeOpen(true), 300);
        }
      }),
      listen<any>("retranscription-error", (event) => {
        if (event.payload.meeting_id !== meeting.id) return;
        setTranscriptionProgress(null);
        setTranscriptionMessage("");
        const cancelled = String(event.payload.error || "")
          .toLowerCase()
          .includes("cancel");
        if (cancelled)
          toast.info(zh ? "已取消语音转写" : "Transcription cancelled");
        else
          toast.error(zh ? "转写失败" : "Transcription failed", {
            description: event.payload.error,
          });
        setImportWorkflow(null);
      }),
      listen<any>("speaker-recluster-progress", (event) => {
        if (event.payload.meeting_id !== meeting.id) return;
        setReclusterMessage(event.payload.message || "");
        if (
          event.payload.cancelled ||
          event.payload.progress_percentage >= 100
        ) {
          if (event.payload.cancelled) {
            setReclusterProgress(null);
            toast.info(zh ? "已取消说话人聚类" : "Reclustering cancelled");
          } else {
            setReclusterProgress(100);
            window.setTimeout(() => setReclusterProgress(null), 700);
          }
        } else {
          setReclusterProgress(event.payload.progress_percentage || 1);
        }
      }),
      listen<any>("speaker-recluster-complete", (event) => {
        if (event.payload.meeting_id !== meeting.id) return;
        setReclusterProgress(null);
        setReclusterMessage("");
        void onRefetchTranscripts?.();
      }),
    ]).then((items) => {
      if (disposed) items.forEach((unlisten) => unlisten());
      else unlisteners.push(...items);
    });
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [meeting.id, onRefetchTranscripts, zh, locale, importWorkflow]);
  useEffect(() => {
    let live = true;
    invoke<any>("get_retranscription_status_command", { meetingId: meeting.id })
      .then((job) => {
        if (live && job.status === "processing") {
          setTranscriptionProgress(job.progress?.determinate === false ? -1 : (job.progress?.progress_percentage || 1));
          setTranscriptionMessage(transcriptionProgressLabel(job.progress?.stage, locale));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [meeting.id, locale]);
  useEffect(() => {
    let live = true;
    invoke<any>("api_get_transcript_refinement_status", {
      meetingId: meeting.id,
    })
      .then((job) => {
        if (live && job.status === "processing") {
          setRefinementProgress(job.progress?.percentage || 1);
          setRefinementMessage(job.progress?.message || "");
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [meeting.id]);
  useEffect(() => {
    let live = true;
    invoke<OrganizerJob>("api_get_ai_organize_meeting_record_status", {
      meetingId: meeting.id,
    })
      .then((job) => {
        if (live && job.status === "processing") {
          setOrganizeProgress(job.progress?.percentage || 1);
          setOrganizeMessage(job.progress?.message || "");
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [meeting.id]);
  useEffect(() => {
    if (refinementProgress == null) return;
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        const job = await invoke<any>("api_get_transcript_refinement_status", {
          meetingId: meeting.id,
        });
        if (!active) return;
        if (job.status === "processing") {
          setRefinementProgress(job.progress?.percentage || 1);
          setRefinementMessage(job.progress?.message || "");
          timer = window.setTimeout(() => void poll(), 1200);
        } else if (job.status === "completed") {
          setRefinementProgress(null);
          setRefinementMessage("");
          await rawRef.current?.reloadAi();
          toast.success(
            zh ? "AI 文字稿优化完成" : "AI transcript optimization completed",
          );
          if (importWorkflow?.smartRecord) {
            setImportWorkflow(null);
            setActive("smart");
            window.setTimeout(() => setOrganizeOpen(true), 300);
          }
        } else if (job.status === "error") {
          setRefinementProgress(null);
          toast.error(
            zh ? "AI 文字稿优化失败" : "AI transcript optimization failed",
            { description: toUserFacingError(job.error, locale).message },
          );
        } else if (job.status === "cancelled") {
          setRefinementProgress(null);
          setRefinementMessage("");
          toast.info(
            zh
              ? "已取消 AI 文字稿优化"
              : "AI transcript optimization cancelled",
          );
        }
      } catch {
        timer = window.setTimeout(() => void poll(), 1800);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [refinementProgress, meeting.id, zh, importWorkflow]);
  const persistEditorSnapshot = useCallback((snapshot: EditorSnapshot) => {
    const operation = editorSaveQueueRef.current.then(async () => {
      setSaving(true);
      try {
        if (snapshot.tab === "notes") {
          await invoke("api_save_meeting_notes", {
            meetingId: meeting.id,
            notesMarkdown: snapshot.markdown,
            notesJson: JSON.stringify({ source: "meeting-workspace" }),
          });
        } else if (snapshot.kind) {
          await invoke("api_save_meeting_document", {
            meetingId: meeting.id,
            kind: snapshot.kind,
            contextKey: snapshot.contextKey || null,
            markdown: snapshot.markdown,
            language: snapshot.language || "auto",
            templateId: snapshot.templateId || null,
          });
          if (snapshot.kind === "meeting_summary") {
            await invoke("api_save_meeting_summary", {
              meetingId: meeting.id,
              summary: { markdown: snapshot.markdown },
            });
          }
          setDocs((current) => ({
            ...current,
            [snapshot.kind!]: {
              markdown: snapshot.markdown,
              language: snapshot.language || "auto",
              templateId: snapshot.templateId,
            },
          }));
        }
        const latest = latestEditorSnapshotRef.current;
        if (
          latest?.tab === snapshot.tab &&
          latest.markdown === snapshot.markdown &&
          latest.contextKey === snapshot.contextKey
        ) {
          editorDirtyRef.current = false;
          setDirty(false);
        }
        return true;
      } catch (error) {
        reportTechnicalError("meeting-notes-save", error);
        return false;
      } finally {
        setSaving(false);
      }
    });
    editorSaveQueueRef.current = operation;
    return operation;
  }, [meeting.id]);

  const captureEditorSnapshot = async (): Promise<EditorSnapshot | null> => {
    if (active === "raw") return null;
    const markdown = (await editorRef.current?.getMarkdown()) ?? docText;
    const snapshot: EditorSnapshot = {
      tab: active,
      kind,
      contextKey: contextKey || undefined,
      markdown,
      language: kind ? language[kind] : undefined,
      templateId: kind ? templates[kind]?.id : undefined,
    };
    latestEditorSnapshotRef.current = snapshot;
    return snapshot;
  };

  const saveCurrent = async (notify = true) => {
    setSaving(true);
    try {
      if (active === "raw") {
        await rawRef.current?.save();
        return true;
      }
      const snapshot = await captureEditorSnapshot();
      if (!snapshot) return true;
      const saved = await persistEditorSnapshot(snapshot);
      if (!saved) throw new Error("Meeting document could not be saved");
      setDocText(snapshot.markdown);
      if (notify) {
        toast.success(
          active === "notes"
            ? zh ? "会中笔记已保存" : "Meeting notes saved"
            : zh ? "已保存" : "Saved",
        );
      }
      return true;
    } catch (error) {
      if (notify) {
        reportTechnicalError("meeting-document-save", error);
        toast.error(zh ? "保存失败" : "Save failed", {
          description: toUserFacingError(error, locale).message,
        });
      }
      return false;
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    if (active === "raw" || !editorAutoSave || !dirty) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        const snapshot = await captureEditorSnapshot();
        if (!snapshot) return;
        const saved = await persistEditorSnapshot(snapshot);
        if (!saved) {
          toast.error(zh ? "自动保存失败" : "Could not auto-save", {
            description: zh ? "内容仍保留在当前页面，请重试。" : "Your changes remain on this page. Please try again.",
          });
        }
      })();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [active, dirty, docText, editorAutoSave, persistEditorSnapshot, zh]);

  // Route or meeting-tab navigation can unmount this workspace without using
  // its internal tab buttons. Queue one last snapshot so a just-typed note is
  // not lost during that transition.
  useEffect(() => () => {
    const snapshot = latestEditorSnapshotRef.current;
    if (editorAutoSaveRef.current && editorDirtyRef.current && snapshot) {
      void persistEditorSnapshot(snapshot);
    }
    if (editorAutoSaveRef.current && rawDirtyRef.current) {
      void rawRef.current?.save(false);
    }
  }, [persistEditorSnapshot]);

  const changeWorkspaceTab = async (next: Tab) => {
    if (next === active) return;
    if (active === "raw" && editorAutoSave && rawDirtyRef.current) {
      try {
        await rawRef.current?.save(false);
        rawDirtyRef.current = false;
        setDirty(false);
      } catch (error) {
        reportTechnicalError("transcript-auto-save", error);
        toast.error(zh ? "请先保存当前文字稿" : "Save the transcript before leaving", {
          description: zh ? "自动保存失败，已留在当前页面。" : "Auto-save failed, so this page remains open.",
        });
        return;
      }
    }
    if (active !== "raw" && editorAutoSave && editorDirtyRef.current) {
      const snapshot = await captureEditorSnapshot();
      const saved = snapshot ? await persistEditorSnapshot(snapshot) : true;
      if (!saved) {
        toast.error(zh ? "请先保存当前内容" : "Save the current document before leaving", {
          description: zh ? "自动保存失败，已留在当前页面。" : "Auto-save failed, so this page remains open.",
        });
        return;
      }
    }
    setActive(next);
  };
  useEffect(() => {
    const handleBatchCorrection = (event: Event) => {
      const detail = (event as CustomEvent<{
        from: string;
        to: string;
        complete: (count: number) => void;
        fail: (error: unknown) => void;
      }>).detail;
      void (async () => {
        try {
          const rawScrollTop = active === "raw"
            ? rawRef.current?.getScrollTop()
            : undefined;
          if (active === "raw") {
            await rawRef.current?.save();
          } else {
            const saved = await saveCurrent(false);
            if (!saved) {
              throw new Error(
                zh
                  ? "当前文档尚未保存，批量纠错已取消"
                  : "The current document could not be saved; batch correction was cancelled",
              );
            }
          }

          const count = await invoke<number>(
            "api_batch_correct_meeting_documents",
            {
              meetingId: meeting.id,
              from: detail.from,
              to: detail.to,
            },
          );

          const editorReplacement = active !== "raw"
            ? await editorRef.current?.replaceAll(detail.from, detail.to)
            : undefined;

          setDocs((current) =>
            Object.fromEntries(
              Object.entries(current).map(([documentKind, document]) => [
                documentKind,
                document
                  ? {
                      ...document,
                      markdown: document.markdown
                        .split(detail.from)
                        .join(detail.to),
                    }
                  : document,
              ]),
            ),
          );
          if (active !== "raw") {
            setDocText((current) =>
              editorReplacement?.markdown
              ?? current.split(detail.from).join(detail.to),
            );
          }
          editorDirtyRef.current = false;
          setDirty(false);
          await Promise.all([
            rawRef.current?.reloadAi(),
            onRefetchTranscripts?.(),
          ]);
          if (active === "raw")
            rawRef.current?.restoreScrollTop(rawScrollTop);
          detail.complete(count);
        } catch (error) {
          detail.fail(error);
        }
      })();
    };
    window.addEventListener("calmee-batch-correct-selection", handleBatchCorrection);
    return () => window.removeEventListener("calmee-batch-correct-selection", handleBatchCorrection);
  }, [active, meeting.id, onRefetchTranscripts, saveCurrent, zh]);
  const saveMeeting = async () => {
    if (saving) return;
    const documentSaved = await saveCurrent(false);
    const titleSaved = await onSaveTitle();
    if (documentSaved && titleSaved) toast.success(t("meeting.saved"));
    else toast.error(t("meeting.saveFailed"));
  };
  const copy = async () => {
    if (active === "raw") {
      await rawRef.current?.copy();
      return;
    }
    await navigator.clipboard.writeText(
      (await editorRef.current?.getMarkdown()) || docText,
    );
    toast.success("已复制");
  };
  const saveTime = async () => {
    if (!timeDraft) return;
    const startAt = new Date(timeDraft).toISOString();
    await invoke("api_update_meeting_schedule", {
      meetingId: meeting.id,
      startAt,
      endAt: meeting.meeting_end_time || null,
      calendarEventId: meeting.calendar_event_id || null,
    });
    setMeetingTime(startAt);
    setTimeOpen(false);
    toast.success("会议时间已更新");
  };
  const persistPreference = (
    target: DocumentKind,
    patch: Partial<GenerationPreference>,
  ) => {
    const current = preferences[target];
    const preference: GenerationPreference = {
      meetingId: meeting.id,
      kind: target,
      language: patch.language ?? current?.language ?? language[target],
      templateId:
        patch.templateId ?? current?.templateId ?? templates[target]?.id,
      provider: current?.provider,
      model: current?.model,
      parametersJson: current?.parametersJson || "{}",
    };
    setPreferences((value) => ({ ...value, [target]: preference }));
    void invoke("api_save_generation_preference", { preference }).catch(
      () => undefined,
    );
  };
  const chooseTemplate = (template: DocumentTemplate) => {
    if (!kind) return;
    setTemplates((current) => ({ ...current, [kind]: template }));
    persistPreference(kind, { templateId: template.id });
    const current = latestEditorSnapshotRef.current;
    if (current) latestEditorSnapshotRef.current = { ...current, templateId: template.id };
    editorDirtyRef.current = true;
    setDirty(true);
  };
  const summaryRunning = ["processing", "summarizing", "regenerating"].includes(
    summaryStatus,
  );
  const cancelTranscription = async () => {
    await invoke("cancel_retranscription_command");
    setTranscriptionMessage(zh ? "正在取消转写…" : "Cancelling transcription…");
  };
  const cancelRefinement = async () => {
    await invoke("api_cancel_transcript_refinement", { meetingId: meeting.id });
    setRefinementMessage(
      zh ? "正在取消 AI 优化…" : "Cancelling AI optimization…",
    );
  };
  const cancelOrganize = async () => {
    await invoke("api_cancel_ai_organize_meeting_record", {
      meetingId: meeting.id,
    });
    setOrganizeMessage(zh ? "正在取消 AI 生成…" : "Cancelling AI generation…");
  };
  const cancelSpeechSummary = async () => {
    if (!speechJobContext) return;
    await invoke("api_cancel_speech_summary", { meetingId: meeting.id, contextKey: speechJobContext });
    setSpeechMessage(zh ? "正在取消讲话总结…" : "Cancelling speech summary…");
  };
  const cancelRecluster = async () => {
    await invoke("cancel_speaker_recluster_command", { meetingId: meeting.id });
    setReclusterMessage(zh ? "正在取消聚类…" : "Cancelling reclustering…");
  };
  const generate = () => {
    if (active === "summary") {
      if (!summaryRunning) {
        const selectedTemplate = templates.meeting_summary;
        const outputTemplatePrompt = selectedTemplate?.prompt.trim()
          ? `CALMEE_SELECTED_OUTPUT_TEMPLATE_V1\nTemplate-ID: ${selectedTemplate.id}\n${selectedTemplate.prompt.trim()}`
          : "";
        void onGenerateSummary(outputTemplatePrompt);
      }
    } else if (active === "smart") {
      setOrganizeOpen(true);
    } else if (active === "speech") {
      if (!selectedSpeakers.length) {
        toast.info(zh ? "请先选择至少一位讲话人" : "Choose at least one speaker first");
        return;
      }
      setSpeechOpen(true);
    } else setOrganizeOpen(true);
  };

  return (
    <div className="calmee-meeting-workspace calmee-page">
      <header className="calmee-titlebar shrink-0 px-7 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {editingTitle ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                onFocus={() => {
                  titleBefore.current = title;
                }}
                onBlur={() => {
                  setEditingTitle(false);
                  void onSaveTitle();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    onTitleChange(titleBefore.current);
                    setEditingTitle(false);
                  }
                }}
                className="w-full max-w-3xl border-0 bg-transparent p-0 text-[20px] font-semibold leading-7 text-foreground outline-none"
              />
            ) : (
              <button
                onClick={() => setEditingTitle(true)}
                className="max-w-3xl truncate text-left text-[20px] font-semibold leading-7 text-foreground hover:text-primary"
                title="点击修改会议名称"
              >
                {title}
              </button>
            )}
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
              <Popover
                open={timeOpen}
                onOpenChange={(open) => {
                  setTimeOpen(open);
                  if (open) {
                    const date = new Date(meetingTime);
                    setTimeDraft(
                      new Date(
                        date.getTime() - date.getTimezoneOffset() * 60000,
                      )
                        .toISOString()
                        .slice(0, 16),
                    );
                  }
                }}
              >
                <PopoverTrigger asChild>
                  <button className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-violet-700">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {new Date(meetingTime).toLocaleString()}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-3">
                  <input
                    type="datetime-local"
                    value={timeDraft}
                    onChange={(e) => setTimeDraft(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                  <button
                    onClick={() => void saveTime()}
                    className="mt-2 w-full rounded-lg bg-violet-600 py-2 text-sm text-white"
                  >
                    保存时间
                  </button>
                </PopoverContent>
              </Popover>
              <span className="h-4 w-px bg-slate-200" />
              <TagManager meetingId={meeting.id} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              className={`h-9 w-9 ${linkedEvent ? "border-emerald-200 text-emerald-700" : ""}`}
              onClick={() => setCalendarOpen(true)}
              title={linkedEvent ? `已关联：${linkedEvent.title}` : "关联日程"}
            >
              <Link2 className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 text-slate-600"
              disabled={saving}
              onClick={() => void saveMeeting()}
              title={zh ? "保存整场会议" : "Save meeting"}
            >
              <Save className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 border-red-100 text-red-500 hover:bg-red-50"
              onClick={onDelete}
              title="删除会议"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col bg-card">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
          <div className="grid min-h-[68px] shrink-0 grid-cols-[180px_minmax(320px,1fr)_180px] items-center gap-4 px-5">
            <div className="justify-self-start">
              <ButtonGroup>
                {active === "raw" ? (
                  <>
                    <ProgressIconButton
                      className="rounded-r-none"
                      icon={<FileAudio className="h-4 w-4" />}
                      title={zh ? "选择音频" : "Choose audio"}
                      onClick={() => void audioRef.current?.chooseFile()}
                    />
                    <ProgressIconButton
                      className="rounded-none border-l-0"
                      icon={<RefreshCw className="h-4 w-4" />}
                      title={
                        zh
                          ? "选择 ASR 模型并转写"
                          : "Choose an ASR model and transcribe"
                      }
                      progress={transcriptionProgress}
                      progressText={
                        transcriptionMessage ||
                        (zh ? "正在转写" : "Transcribing")
                      }
                      onClick={() => setRetranscribeOpen(true)}
                      onCancel={() => void cancelTranscription()}
                      disabled={!audioPath}
                    />
                    <ProgressIconButton
                      className="rounded-l-none border-l-0"
                      icon={<Sparkles className="h-4 w-4" />}
                      title={
                        zh ? "AI 优化原始文稿" : "Optimize transcript with AI"
                      }
                      tone="ai"
                      progress={refinementProgress}
                      progressText={
                        refinementMessage ||
                        (zh ? "正在优化文字稿" : "Optimizing transcript")
                      }
                      onClick={() => setRefinementOpen(true)}
                      onCancel={() => void cancelRefinement()}
                      disabled={transcripts.length === 0}
                    />
                  </>
                ) : active === "notes" ? null : (
                  <>
                    <Popover>
                      <PopoverTrigger asChild>
                        <span>
                          <ProgressIconButton
                            className="rounded-r-none"
                            icon={
                              active === "speech" ? (
                                <span className="relative">
                                  <UserRound className="h-4 w-4" />
                                  {selectedSpeakers.length > 0 && (
                                    <span className="absolute -right-2 -top-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-violet-600 px-0.5 text-[8px] font-semibold leading-none text-white ring-2 ring-white">
                                      {selectedSpeakers.length}
                                    </span>
                                  )}
                                </span>
                              ) : (
                                <Languages className="h-4 w-4" />
                              )
                            }
                            title={
                              active === "speech"
                                ? zh
                                  ? `已选择 ${selectedSpeakers.length} 位讲话人`
                                  : `${selectedSpeakers.length} speakers selected`
                                : `输出语言：${kind ? languages.find((item) => item[0] === language[kind])?.[1] : ""}`
                            }
                            onClick={() => undefined}
                          />
                        </span>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        className={`${active === "speech" ? "max-h-[min(18rem,var(--radix-popover-content-available-height))] overflow-y-auto" : ""} w-52 p-1`}
                      >
                        {active === "speech"
                          ? speakers.map((item) => (
                              <button
                                key={item.key}
                                onClick={() => {
                                  setSelectedSpeakers((current) => {
                                    const selected = current.some((value) => value.key === item.key);
                                    const next = selected
                                      ? current.filter((value) => value.key !== item.key)
                                      : [...current, item];
                                    window.localStorage.setItem(
                                      `calmee.speech-speakers.${meeting.id}`,
                                      JSON.stringify(next.map((value) => value.key)),
                                    );
                                    return next;
                                  });
                                }}
                                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs leading-4 hover:bg-violet-50"
                              >
                                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-slate-300 bg-white">
                                  {selectedSpeakers.some((value) => value.key === item.key) && (
                                    <Check className="h-3 w-3 text-violet-600" />
                                  )}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-left">{item.name}</span>
                                <span className="shrink-0 text-[10px] text-slate-400">
                                  {item.segmentCount} 段
                                </span>
                              </button>
                            ))
                          : kind &&
                            languages.map((item) => (
                              <button
                                key={item[0]}
                                onClick={() => {
                                  setLanguage((current) => ({
                                    ...current,
                                    [kind]: item[0],
                                  }));
                                  persistPreference(kind, {
                                    language: item[0],
                                  });
                                }}
                                className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-violet-50"
                              >
                                {item[1]}
                              </button>
                            ))}
                      </PopoverContent>
                    </Popover>
                    <ProgressIconButton
                      className="rounded-none border-l-0"
                      icon={<FileText className="h-4 w-4" />}
                      title={`${zh ? "模板" : "Template"}：${kind && templates[kind] ? localizedTemplate(templates[kind]!, locale).name : zh ? "请选择" : "Choose"}`}
                      onClick={() => setTemplateOpen(true)}
                    />
                    <ProgressIconButton
                      className="rounded-l-none border-l-0"
                      icon={
                        summaryRunning && active === "summary" ? (
                          <span className="h-3 w-3 rounded-sm bg-current" />
                        ) : (
                          <Sparkles className="h-4 w-4" />
                        )
                      }
                      title={
                        summaryRunning && active === "summary"
                          ? zh
                            ? "停止生成"
                            : "Stop generation"
                          : zh
                            ? "AI 生成"
                            : "Generate with AI"
                      }
                      tone="ai"
                      progress={
                        active === "summary" && summaryRunning
                          ? 55
                          : active === "smart"
                            ? organizeProgress
                            : active === "speech"
                              ? speechProgress
                              : null
                      }
                      progressText={
                        active === "summary" && summaryRunning
                          ? zh
                            ? "正在生成会议纪要"
                            : "Generating meeting summary"
                          : active === "speech"
                            ? speechMessage || (zh ? "正在生成讲话总结" : "Generating speech summary")
                            : organizeMessage ||
                              (zh
                                ? "正在生成智能记录"
                                : "Generating smart record")
                      }
                      onClick={generate}
                      onCancel={
                        active === "summary"
                          ? () => void onStopSummary()
                          : active === "smart"
                            ? () => void cancelOrganize()
                            : active === "speech"
                              ? () => void cancelSpeechSummary()
                              : undefined
                      }
                    />
                  </>
                )}
              </ButtonGroup>
            </div>
            <AudioPlayer
              ref={audioRef}
              meetingId={meeting.id}
              onPathChange={setAudioPath}
              onTimeChange={setAudioTime}
            />
            <div className="flex items-center justify-self-end gap-2">
              <ButtonGroup>
                <Button
                    variant="outline"
                    size="icon"
                    className={`h-9 w-9 ${editorAutoSave ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "text-slate-500"}`}
                    title={
                      editorAutoSave
                        ? saving
                          ? zh ? "正在自动保存" : "Auto-saving"
                          : dirty
                            ? zh ? "等待自动保存" : "Waiting to auto-save"
                            : zh ? "自动保存已开启" : "Auto-save is on"
                        : zh ? "自动保存已关闭" : "Auto-save is off"
                    }
                    aria-pressed={editorAutoSave}
                    onClick={() => setEditorAutoSave((value) => !value)}
                  >
                    {editorAutoSave ? <Cloud className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />}
                  </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className={`h-9 w-9 ${dirty ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}`}
                  disabled={saving}
                  onClick={() => void saveCurrent()}
                  title="保存"
                >
                  <Save className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  onClick={() => void copy()}
                  title="复制"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </ButtonGroup>
            </div>
          </div>
          <div className="shrink-0 border-b border-border/70 px-5">
            <div className="grid grid-cols-4">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const backgroundProgress =
                  active === tab.id
                    ? null
                    : tab.id === "raw"
                      ? refinementProgress ?? transcriptionProgress ?? reclusterProgress
                      : tab.id === "smart"
                        ? organizeProgress
                        : tab.id === "summary" && summaryRunning
                          ? 55
                          : tab.id === "speech"
                            ? speechProgress
                            : null;
                const progressTitle =
                  tab.id === "raw"
                    ? refinementProgress != null
                      ? refinementMessage || (zh ? "正在优化文字稿" : "Optimizing transcript")
                      : transcriptionProgress != null
                        ? transcriptionMessage || (zh ? "正在转写" : "Transcribing")
                        : reclusterMessage || (zh ? "正在调整说话人" : "Adjusting speakers")
                    : tab.id === "smart"
                      ? organizeMessage || (zh ? "正在生成智能记录" : "Generating smart record")
                      : tab.id === "speech"
                        ? speechMessage || (zh ? "正在生成讲话总结" : "Generating speech summary")
                      : zh
                        ? "正在生成会议纪要"
                        : "Generating meeting summary";
                return (
                  <button
                    key={tab.id}
                    onClick={() => void changeWorkspaceTab(tab.id)}
                    title={backgroundProgress != null ? progressTitle : undefined}
                    className={`flex items-center justify-center gap-2 border-b-2 px-3 py-2.5 text-[13px] leading-5 transition ${active === tab.id ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                  >
                    {backgroundProgress != null ? (
                      <DocumentTabProgress
                        value={backgroundProgress}
                        tone={refinementProgress != null || tab.id !== "raw" ? "ai" : "default"}
                      />
                    ) : (
                      <Icon className="h-4 w-4" />
                    )}
                    {zh ? tab.zh : tab.en}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {active === "raw" ? (
              <RawTranscriptView
                ref={rawRef}
                meetingId={meeting.id}
                transcripts={transcripts}
                segments={segments}
                onRefetch={onRefetchTranscripts}
                onSeek={(seconds) => audioRef.current?.seekTo(seconds)}
                currentTime={audioTime}
                autoSave={editorAutoSave}
                onDirtyChange={(value) => {
                  rawDirtyRef.current = value;
                  setDirty(value);
                }}
              />
            ) : active === "notes" ? (
              <Suspense fallback={<EditorLoadingState zh={zh} />}>
                <UnifiedMarkdownEditor
                  key={`meeting-notes:${editorReloadToken}`}
                  ref={editorRef}
                  documentKey={`${meeting.id}:meeting-notes:${editorReloadToken}`}
                  value={docText}
                  placeholder={zh ? "整理会中记录、重点、决定和待办…" : "Organize meeting notes, highlights, decisions, and actions…"}
                  onChange={(markdown) => {
                    latestEditorSnapshotRef.current = { tab: "notes", markdown };
                    setDocText(markdown);
                  }}
                  onDirtyChange={(value) => {
                    editorDirtyRef.current = value;
                    setDirty(value);
                  }}
                />
              </Suspense>
            ) : kind ? (
              <Suspense fallback={<EditorLoadingState zh={zh} />}>
                <UnifiedMarkdownEditor
                  key={`${kind}:${contextKey}:${editorReloadToken}`}
                  ref={editorRef}
                  documentKey={`${meeting.id}:${kind}:${contextKey}:${editorReloadToken}`}
                  value={docText}
                  placeholder={
                    active === "smart"
                      ? "在这里生成或编辑详细的智能记录…"
                      : active === "summary"
                        ? "在这里生成或编辑会议纪要…"
                        : "选择讲话人后生成讲话总结…"
                  }
                  onChange={(markdown) => {
                    latestEditorSnapshotRef.current = {
                      tab: active as Exclude<Tab, "raw">,
                      kind,
                      contextKey: contextKey || undefined,
                      markdown,
                      language: language[kind],
                      templateId: templates[kind]?.id,
                    };
                    setDocText(markdown);
                  }}
                  onDirtyChange={(value) => {
                    editorDirtyRef.current = value;
                    setDirty(value);
                  }}
                />
              </Suspense>
            ) : null}
          </div>
        </div>
      </main>
      <CalendarLinkDialog
        open={calendarOpen}
        onOpenChange={setCalendarOpen}
        meetingId={meeting.id}
        meetingTime={meetingTime}
        currentEventId={linkedEvent?.id || meeting.calendar_event_id}
        onLinked={(event) => {
          setLinkedEvent(event);
          meeting.calendar_event_id = event?.id || null;
        }}
      />
      {kind && (
        <TemplateManagerDialog
          open={templateOpen}
          onOpenChange={setTemplateOpen}
          kind={kind}
          selectedId={templates[kind]?.id}
          onSelect={chooseTemplate}
        />
      )}
      <RetranscribeDialog
        open={retranscribeOpen}
        onOpenChange={setRetranscribeOpen}
        meetingId={meeting.id}
        meetingFolderPath={audioPath}
        onStarted={() => setTranscriptionProgress(1)}
      />
      <TranscriptRefinementDialog
        open={refinementOpen}
        onOpenChange={setRefinementOpen}
        meetingId={meeting.id}
        transcriptCount={transcripts.length}
        beforeStart={async () => {
          await rawRef.current?.save();
        }}
        onStarted={() => setRefinementProgress(1)}
      />
      <DeepOrganizeDialog
        open={organizeOpen}
        onOpenChange={setOrganizeOpen}
        meetingId={meeting.id}
        transcriptCount={transcripts.length}
        templateId={templates.smart_record?.id}
        beforeStart={async () => {
          await rawRef.current?.save();
        }}
        onStarted={() => {
          setOrganizeProgress(1);
          setActive("smart");
        }}
      />
      <DeepOrganizeDialog
        open={speechOpen}
        onOpenChange={setSpeechOpen}
        meetingId={meeting.id}
        transcriptCount={selectedSpeakers.reduce((total, item) => total + item.segmentCount, 0)}
        templateId={templates.speech_summary?.id}
        mode="speech"
        contextKey={contextKey}
        speakerKeys={selectedSpeakers.map((item) => item.key)}
        speakerNames={selectedSpeakers.map((item) => item.name)}
        beforeStart={async () => {
          await rawRef.current?.save();
        }}
        onStarted={() => {
          setSpeechJobContext(contextKey);
          setSpeechProgress(1);
          setActive("speech");
        }}
      />
    </div>
  );
}
