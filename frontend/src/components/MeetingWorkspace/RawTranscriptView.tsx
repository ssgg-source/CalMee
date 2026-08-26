"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AudioLines,
  Check,
  ListFilter,
  Loader2,
  Minus,
  Pencil,
  Plus,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";
import type { Transcript, TranscriptSegmentData } from "@/types";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { ProductSelect } from "@/components/ui/ProductControls";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useLanguage } from "@/contexts/LanguageContext";
import { ProgressIconButton } from "./ProgressIconButton";
import { reportTechnicalError, toUserFacingError } from "@/lib/feedback";

type Person = { id: string; name: string };
type SpeakerOverride = { transcriptId: string; personId: string; personName: string };
type SpeakerMeta = {
  blockId: string;
  localSpeaker?: string;
  personId?: string;
  name: string;
  colorIndex: number;
};
type RefinedSegment = {
  id: string;
  originalText: string;
  optimizedText: string;
  proposedText: string;
  safeToApply: boolean;
  warnings: string[];
};
type RefinementResult = {
  changedCount: number;
  reviewCount: number;
  segments: RefinedSegment[];
};
type SpeakerReclusterStatus = {
  available: boolean;
  estimated_count: number;
  current_count: number;
};
type TranscriptVersionSnapshot = {
  meetingId: string;
  versionKind: "original" | "clustered";
  speakerCount: number;
  segments: Transcript[];
};
export interface RawTranscriptViewRef {
  save: () => Promise<void>;
  copy: () => Promise<void>;
  reloadAi: () => Promise<void>;
  replaceAll: (from: string, to: string) => Promise<number>;
  getScrollTop: () => number | undefined;
  restoreScrollTop: (scrollTop?: number) => void;
}

const colors = [
  { fg: "#7C3AED", soft: "#F3E8FF", ring: "#C4B5FD" },
  { fg: "#0284C7", soft: "#E0F2FE", ring: "#7DD3FC" },
  { fg: "#059669", soft: "#D1FAE5", ring: "#6EE7B7" },
  { fg: "#EA580C", soft: "#FFEDD5", ring: "#FDBA74" },
  { fg: "#DB2777", soft: "#FCE7F3", ring: "#F9A8D4" },
  { fg: "#4F46E5", soft: "#E0E7FF", ring: "#A5B4FC" },
];
const UNASSIGNED_SPEAKER_KEY = "unassigned-speaker";
const clock = (seconds?: number) => {
  const v = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(v / 60)
    .toString()
    .padStart(2, "0")}:${(v % 60).toString().padStart(2, "0")}`;
};
const splitSpeakerPrefix = (text: string) => {
  const match = text.trim().match(/^\[Speaker\s+([^\]]+)\]\s*/i);
  return match
    ? {
        speaker: `Speaker ${match[1].trim()}`,
        text: text.trim().slice(match[0].length).trimStart(),
      }
    : { speaker: undefined, text };
};
const initials = (name: string) =>
  Array.from(name.trim()).slice(-2).join("") || "发言";
const joinParagraph = (parts: string[]) => {
  let result = "";
  for (const source of parts) {
    const part = source
      .trim()
      .replace(/[，,]+([。！？!?])/g, "$1")
      .replace(/([。！？!?])\1+/g, "$1");
    if (!part) continue;
    if (!result) {
      result = part;
      continue;
    }
    const last = Array.from(result).at(-1) || "";
    const first = Array.from(part)[0] || "";
    const separated =
      /[。！？!?；;：:，,、…]$/.test(last) ||
      /^[。！？!?；;：:，,、…]/.test(first);
    const english = /[A-Za-z0-9]$/.test(last) && /^[A-Za-z0-9]/.test(first);
    result += separated ? "" : english ? " " : "，";
    result += part;
  }
  if (/[，,：:、]$/.test(result)) result = `${result.slice(0, -1)}。`;
  else if (result && !/[。！？!?；;…]$/.test(result)) result += "。";
  return result;
};
const partitionParagraph = (value: string, weights: number[]) => {
  if (weights.length <= 1) return [value.trim()];
  const chars = Array.from(value.trim());
  if (!chars.length) return weights.map(() => "");
  const total = weights.reduce((sum, item) => sum + Math.max(1, item), 0);
  const cuts: number[] = [];
  let consumed = 0;
  let previous = 0;
  for (let index = 0; index < weights.length - 1; index++) {
    consumed += Math.max(1, weights[index]);
    const target = Math.round((chars.length * consumed) / total);
    let best = -1;
    let distance = Number.POSITIVE_INFINITY;
    const lower = Math.max(previous + 1, target - 48);
    const upper = Math.min(
      chars.length - (weights.length - index - 1),
      target + 48,
    );
    for (let cursor = lower; cursor <= upper; cursor++) {
      if (
        /[。！？!?；;，,]/.test(chars[cursor - 1] || "") &&
        Math.abs(cursor - target) < distance
      ) {
        best = cursor;
        distance = Math.abs(cursor - target);
      }
    }
    const cut =
      best > previous ? best : Math.max(previous + 1, Math.min(upper, target));
    cuts.push(cut);
    previous = cut;
  }
  const result: string[] = [];
  let start = 0;
  for (const cut of [...cuts, chars.length]) {
    result.push(chars.slice(start, cut).join("").trim());
    start = cut;
  }
  return result;
};

export const RawTranscriptView = forwardRef<
  RawTranscriptViewRef,
  {
    meetingId: string;
    transcripts: Transcript[];
    segments?: TranscriptSegmentData[];
    onRefetch?: () => Promise<void>;
    onSeek?: (seconds: number) => void;
    currentTime?: number;
  }
>(function RawTranscriptView(
  { meetingId, transcripts, segments, onRefetch, onSeek, currentTime = 0 },
  ref,
) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const liveRows = useMemo(
    () =>
      segments ||
      transcripts.map((item) => ({
        id: item.id,
        timestamp: item.audio_start_time ?? 0,
        endTime: item.audio_end_time,
        text: item.text,
        confidence: item.confidence,
      })),
    [segments, transcripts],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [optimizedDrafts, setOptimizedDrafts] = useState<
    Record<string, string>
  >({});
  const [version, setVersion] = useState<
    "original" | "clustered" | "optimized"
  >("clustered");
  const [refinement, setRefinement] = useState<RefinementResult | null>(null);
  const [originalVersion, setOriginalVersion] =
    useState<TranscriptVersionSnapshot | null>(null);
  const originalRows = useMemo(
    () =>
      originalVersion?.segments.map((item) => ({
        id: item.id,
        timestamp: item.audio_start_time ?? 0,
        endTime: item.audio_end_time,
        text: item.text,
        confidence: item.confidence,
      })) || [],
    [originalVersion],
  );
  const rows =
    version === "original" && originalRows.length ? originalRows : liveRows;
  const optimizedById = useMemo(
    () => new Map(refinement?.segments.map((item) => [item.id, item]) || []),
    [refinement],
  );
  const aiAvailable = useMemo(
    () =>
      Boolean(
        refinement?.segments.some((item) =>
          liveRows.some((row) => row.id === item.id),
        ),
      ),
    [refinement, liveRows],
  );
  const shown = (id: string, original: string) =>
    splitSpeakerPrefix(
      version === "optimized"
        ? (optimizedById.get(id)?.proposedText ??
            optimizedById.get(id)?.optimizedText ??
            original)
        : original,
    ).text;
  const visibleChangeCount = useMemo(
    () =>
      refinement?.segments.filter(
        (item) =>
          (item.proposedText || item.optimizedText) !== item.originalText,
      ).length || 0,
    [refinement],
  );
  const [speakerMap, setSpeakerMap] = useState<Record<string, SpeakerMeta>>({});
  const [speakerFilter, setSpeakerFilter] = useState("all");
  const [syncPlayback, setSyncPlayback] = useState(false);
  const [reclusterStatus, setReclusterStatus] =
    useState<SpeakerReclusterStatus | null>(null);
  const [speakerCountDraft, setSpeakerCountDraft] = useState(1);
  const [reclustering, setReclustering] = useState(false);
  const [reclusterProgress, setReclusterProgress] = useState<number | null>(
    null,
  );
  const [reclusterMessage, setReclusterMessage] = useState("");
  const [speakerCountOpen, setSpeakerCountOpen] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [bindingPersonId, setBindingPersonId] = useState("");
  const [speakerOverrides, setSpeakerOverrides] = useState<Record<string, SpeakerOverride>>({});
  const [newName, setNewName] = useState("");
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const restoreScrollPosition = (scrollTop?: number) => {
    if (scrollTop === undefined) return;
    const restore = () => {
      if (scrollContainerRef.current)
        scrollContainerRef.current.scrollTop = scrollTop;
    };
    window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
  };
  const rememberCurrentScroll = () => scrollContainerRef.current?.scrollTop;
  const speakerKey = (meta?: SpeakerMeta) =>
    meta?.personId || meta?.localSpeaker || UNASSIGNED_SPEAKER_KEY;
  const effectiveSpeakerKey = (rowId: string) =>
    speakerOverrides[rowId]?.personId || speakerKey(speakerMap[rowId]);
  const effectiveSpeakerName = (rowId: string) =>
    speakerOverrides[rowId]?.personName || speakerMap[rowId]?.name || (zh ? "发言人" : "Speaker");
  const speakerOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const row of rows) {
      options.set(effectiveSpeakerKey(row.id), effectiveSpeakerName(row.id));
    }
    return Array.from(options.entries());
  }, [rows, speakerMap, speakerOverrides, zh]);
  const allGroups = useMemo(() => {
    const result: Array<{ id: string; rows: typeof rows }> = [];
    for (const row of rows) {
      const current = result.at(-1);
      const previous = current?.rows.at(-1);
      const rowOverride = speakerOverrides[row.id];
      const previousOverride = previous ? speakerOverrides[previous.id] : undefined;
      const sameSpeaker =
        !!previous &&
        (previousOverride?.personId || effectiveSpeakerKey(previous.id)) ===
          (rowOverride?.personId || effectiveSpeakerKey(row.id));
      const closeEnough =
        !!previous &&
        (row.timestamp || 0) - (previous.endTime ?? previous.timestamp ?? 0) <=
          3.2;
      if (current && sameSpeaker && closeEnough) current.rows.push(row);
      else result.push({ id: row.id, rows: [row] as typeof rows });
    }
    return result;
  }, [rows, speakerMap, speakerOverrides]);
  const groups = useMemo(
    () =>
      speakerFilter === "all"
        ? allGroups
        : allGroups.filter(
            (group) =>
              effectiveSpeakerKey(group.rows[0].id) === speakerFilter,
          ),
    [allGroups, speakerFilter, speakerMap, speakerOverrides],
  );
  const paragraphText = (group: { id: string; rows: typeof rows }) =>
    (version === "optimized"
      ? optimizedDrafts[group.id]
      : version === "clustered"
        ? drafts[group.id]
        : undefined) ??
    joinParagraph(group.rows.map((row) => shown(row.id, row.text)));
  const count = useMemo(
    () =>
      groups.reduce(
        (total, group) =>
          total + Array.from(paragraphText(group).replace(/\s/g, "")).length,
        0,
      ),
    [drafts, optimizedDrafts, groups, version, optimizedById],
  );
  useEffect(() => {
    if (
      speakerFilter !== "all" &&
      !speakerOptions.some(([key]) => key === speakerFilter)
    )
      setSpeakerFilter("all");
  }, [speakerFilter, speakerOptions]);
  const loadReclusterStatus = async () => {
    try {
      const status = await invoke<SpeakerReclusterStatus>(
        "get_speaker_recluster_status_command",
        { meetingId },
      );
      setReclusterStatus(status);
      setSpeakerCountDraft(
        Math.max(
          1,
          status.current_count ||
            status.estimated_count ||
            speakerOptions.length,
        ),
      );
    } catch {
      setReclusterStatus(null);
      setSpeakerCountDraft(Math.max(1, speakerOptions.length));
    }
  };
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([listen<any>("speaker-recluster-progress", (event) => {
      if (event.payload.meeting_id !== meetingId) return;
      setReclusterMessage(event.payload.message || "");
      if (event.payload.cancelled || event.payload.progress_percentage >= 100) {
        setReclustering(false);
        if (event.payload.cancelled) setReclusterProgress(null);
        else {
          setReclusterProgress(100);
          window.setTimeout(() => setReclusterProgress(null), 700);
        }
      } else {
        setReclusterProgress(event.payload.progress_percentage || 1);
        setReclustering(true);
      }
    }), listen<any>("speaker-recluster-complete", (event) => {
      if (event.payload.meeting_id !== meetingId) return;
      void loadReclusterStatus();
      void onRefetch?.();
    })]).then((values) => {
      if (disposed) values.forEach(value => value());
      else unlisteners.push(...values);
    });
    return () => {
      disposed = true;
      unlisteners.forEach(value => value());
    };
  }, [meetingId, onRefetch]);
  const activeRowId = useMemo(() => {
    if (!rows.length) return undefined;
    let active = rows[0];
    for (const row of rows) {
      if ((row.timestamp || 0) > currentTime) break;
      active = row;
    }
    return active.id;
  }, [rows, currentTime]);
  useEffect(() => {
    if (!syncPlayback || !activeRowId) return;
    rowRefs.current[activeRowId]?.scrollIntoView({
      block: "center",
      behavior: "auto",
    });
  }, [syncPlayback, activeRowId]);
  const reloadAi = async () => {
    const value = await invoke<RefinementResult | null>(
      "api_get_saved_transcript_refinement",
      { meetingId },
    );
    setRefinement(value);
    if (value) setVersion("optimized");
  };
  const reloadSpeakerOverrides = async () => {
    const items = await invoke<SpeakerOverride[]>("api_list_transcript_speaker_overrides", { meetingId });
    setSpeakerOverrides(Object.fromEntries(items.map(item => [item.transcriptId, item])));
  };
  useEffect(() => {
    setDrafts({});
    setOptimizedDrafts({});
    setVersion("clustered");
    Promise.all([
      invoke<Person[]>("api_list_people"),
      invoke<RefinementResult | null>("api_get_saved_transcript_refinement", {
        meetingId,
      }).catch(() => null),
      invoke<TranscriptVersionSnapshot | null>(
        "get_transcript_version_command",
        { meetingId, versionKind: "original" },
      ).catch(() => null),
      invoke<SpeakerOverride[]>("api_list_transcript_speaker_overrides", { meetingId }).catch(() => []),
    ]).then(([list, ai, baseline, overrides]) => {
      setPeople(
        list.filter(
          (person, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.name.trim().toLocaleLowerCase() ===
                person.name.trim().toLocaleLowerCase(),
            ) === index,
        ),
      );
      setRefinement(ai);
      if (ai) setVersion("optimized");
      setOriginalVersion(baseline);
      setSpeakerOverrides(Object.fromEntries(overrides.map(item => [item.transcriptId, item])));
    });
  }, [meetingId]);
  useEffect(() => {
    const map: Record<string, SpeakerMeta> = {};
    const speakerColors = new Map<string, number>();
    for (const row of liveRows) {
      const parsed = splitSpeakerPrefix(row.text);
      const override = speakerOverrides[row.id];
      // A transcript row is a VAD/ASR segment, not a speaker identity. Live
      // recordings may not have diarization labels yet, so all unlabeled rows
      // must share one temporary identity instead of appearing as one speaker
      // per sentence.
      const key =
        override?.personId || parsed.speaker || UNASSIGNED_SPEAKER_KEY;
      if (!speakerColors.has(key))
        speakerColors.set(key, speakerColors.size % colors.length);
      map[row.id] = {
        blockId: row.id,
        localSpeaker: parsed.speaker,
        personId: override?.personId,
        name:
          override?.personName ||
          parsed.speaker ||
          (zh ? "发言人" : "Speaker"),
        colorIndex: speakerColors.get(key)!,
      };
    }
    setSpeakerMap(map);
  }, [liveRows, speakerOverrides, zh]);
  const save = async () => {
    if (version === "original") {
      toast.info(
        zh ? "原文基线为只读版本" : "The original baseline is read-only",
      );
      return;
    }
    const changes = Object.entries(
      version === "optimized" ? optimizedDrafts : drafts,
    );
    if (!changes.length) return;
    const tasks: Promise<unknown>[] = [];
    for (const [groupId, text] of changes) {
      const group = allGroups.find((item) => item.id === groupId);
      if (!group) continue;
      const weights = group.rows.map((row) =>
        Math.max(1, Array.from(shown(row.id, row.text)).length),
      );
      const parts = partitionParagraph(text, weights);
      group.rows.forEach((row, index) => {
        const next = parts[index] || "";
        if (version === "optimized")
          tasks.push(
            invoke("api_update_transcript_refinement_text", {
              meetingId,
              transcriptId: row.id,
              text: next,
            }),
          );
        else {
          const prefix = splitSpeakerPrefix(row.text).speaker;
          tasks.push(
            invoke("api_update_transcript_text", {
              transcriptId: row.id,
              text: prefix ? `[${prefix}] ${next.trimStart()}` : next,
            }),
          );
        }
      });
    }
    await Promise.all(tasks);
    if (version === "optimized") {
      setOptimizedDrafts({});
      await reloadAi();
      toast.success("AI 优化文稿已保存");
      return;
    }
    setDrafts({});
    await onRefetch?.();
    toast.success(zh ? "聚类文稿已保存" : "Clustered transcript saved");
  };
  const copy = async () => {
    await navigator.clipboard.writeText(
      groups
        .map(
          (group) =>
            `[${clock(group.rows[0].timestamp)}] ${effectiveSpeakerName(group.rows[0].id)}\n${paragraphText(group)}`,
        )
        .join("\n\n"),
    );
    toast.success("文字稿已复制");
  };
  const replaceAll = async (from: string, to: string) => {
    if (!from || from === to) return 0;
    const scrollTop = rememberCurrentScroll();
    const targetVersion = version === "optimized" ? "optimized" : "clustered";
    const tasks: Promise<unknown>[] = [];
    const refinementUpdates: Array<{ transcriptId: string; text: string }> = [];
    let count = 0;
    for (const row of liveRows) {
      const source = targetVersion === "optimized"
        ? (optimizedById.get(row.id)?.proposedText ?? optimizedById.get(row.id)?.optimizedText ?? splitSpeakerPrefix(row.text).text)
        : splitSpeakerPrefix(row.text).text;
      const hits = source.split(from).length - 1;
      if (!hits) continue;
      count += hits;
      const next = source.split(from).join(to);
      if (targetVersion === "optimized")
        refinementUpdates.push({ transcriptId: row.id, text: next });
      else {
        const speaker = splitSpeakerPrefix(row.text).speaker;
        tasks.push(invoke("api_update_transcript_text", { transcriptId: row.id, text: speaker ? `[${speaker}] ${next}` : next }));
      }
    }
    if (!count) return 0;
    if (refinementUpdates.length) {
      tasks.push(invoke("api_batch_update_transcript_refinement_text", {
        meetingId,
        updates: refinementUpdates,
      }));
    }
    await Promise.all(tasks);
    setDrafts({});
    setOptimizedDrafts({});
    if (targetVersion === "optimized") await reloadAi();
    else {
      setVersion("clustered");
      await onRefetch?.();
    }
    restoreScrollPosition(scrollTop);
    return count;
  };
  useImperativeHandle(ref, () => ({
    save,
    copy,
    reloadAi,
    replaceAll,
    getScrollTop: rememberCurrentScroll,
    restoreScrollTop: restoreScrollPosition,
  }), [
    drafts,
    optimizedDrafts,
    rows,
    liveRows,
    speakerMap,
    version,
    refinement,
  ]);
  const assign = async (id: string, person: Person) => {
    const meta = speakerMap[id];
    if (!meta) return;
    if (meta.localSpeaker)
      await invoke("api_assign_meeting_speaker", {
        meetingId,
        localSpeaker: meta.localSpeaker,
        personId: person.id,
        rememberVoice: true,
      });
    else
      await invoke("api_assign_meeting_record_block_person", {
        blockId: meta.blockId,
        personId: person.id,
      });
    setSpeakerMap((current) =>
      Object.fromEntries(
        Object.entries(current).map(([key, value]) => [
          key,
          (value.localSpeaker && value.localSpeaker === meta.localSpeaker) ||
          value.blockId === meta.blockId
            ? { ...value, personId: person.id, name: person.name }
            : value,
        ]),
      ),
    );
    setEditing(null);
  };
  const create = async (id: string) => {
    if (!newName.trim()) return;
    const person = await invoke<Person>("api_create_person", {
      name: newName.trim(),
    });
    setPeople((current) =>
      current.some((item) => item.id === person.id)
        ? current
        : [...current, person],
    );
    setNewName("");
    await assign(id, person);
  };
  const resolveBindingPerson = async () => {
    if (bindingPersonId) return people.find(person => person.id === bindingPersonId) || null;
    if (!newName.trim()) return null;
    const person = await invoke<Person>("api_create_person", { name: newName.trim() });
    setPeople(current => current.some(item => item.id === person.id) ? current : [...current, person]);
    setBindingPersonId(person.id);
    setNewName("");
    return person;
  };
  const bindDisplayedSpeech = async (transcriptIds: string[]) => {
    try {
      const scrollTop = rememberCurrentScroll();
      const person = await resolveBindingPerson();
      if (!person) return;
      await invoke("api_set_transcript_speaker_overrides", { meetingId, transcriptIds, personId: person.id });
      await reloadSpeakerOverrides();
      setEditing(null);
      restoreScrollPosition(scrollTop);
      toast.success(zh ? "已单条绑定当前讲话" : "Current speech bound");
    } catch (error) {
      reportTechnicalError("speaker-bind-one", error);
      toast.error(zh ? "单条绑定失败" : "Single binding failed", { description: toUserFacingError(error, locale).message });
    }
  };
  const bindSpeakerBatch = async (rowId: string) => {
    try {
      const scrollTop = rememberCurrentScroll();
      const person = await resolveBindingPerson();
      if (!person) return;
      await assign(rowId, person);
      restoreScrollPosition(scrollTop);
      toast.success(zh ? "已批量绑定该说话人的全部讲话" : "All speeches from this speaker were bound");
    } catch (error) {
      reportTechnicalError("speaker-bind-all", error);
      toast.error(zh ? "批量绑定失败" : "Batch binding failed", { description: toUserFacingError(error, locale).message });
    }
  };
  const recluster = async () => {
    if (reclustering || !reclusterStatus?.available) return;
    let completed = false;
    setSpeakerCountOpen(false);
    setReclustering(true);
    setReclusterProgress(8);
    setReclusterMessage(
      zh ? "正在准备说话人聚类…" : "Preparing speaker reclustering…",
    );
    try {
      const status = await invoke<SpeakerReclusterStatus>(
        "recluster_meeting_speakers_command",
        { meetingId, speakerCount: speakerCountDraft },
      );
      setReclusterStatus(status);
      setSpeakerCountDraft(
        Math.max(1, status.current_count || speakerCountDraft),
      );
      completed = true;
      setReclusterProgress(100);
      setReclusterMessage(
        zh ? "说话人聚类完成" : "Speaker reclustering complete",
      );
      window.setTimeout(() => setReclusterProgress(null), 700);
      setVersion("clustered");
      const baseline = await invoke<TranscriptVersionSnapshot | null>(
        "get_transcript_version_command",
        { meetingId, versionKind: "original" },
      ).catch(() => null);
      setOriginalVersion(baseline);
      await onRefetch?.();
      toast.success(
        zh
          ? `已按 ${status.current_count} 位说话人重新聚类`
          : `Reclustered into ${status.current_count} speakers`,
      );
    } catch (reason) {
      if (!String(reason).toLowerCase().includes("cancel"))
        reportTechnicalError("speaker-recluster", reason);
        toast.error(zh ? "重新聚类失败" : "Speaker reclustering failed", {
          description: toUserFacingError(reason, locale).message,
        });
    } finally {
      setReclustering(false);
      if (!completed) setReclusterProgress(null);
    }
  };
  const cancelRecluster = async () => {
    await invoke("cancel_speaker_recluster_command", { meetingId });
    setReclusterMessage(zh ? "正在取消聚类…" : "Cancelling reclustering…");
    toast.info(zh ? "正在取消说话人聚类" : "Cancelling speaker reclustering");
  };
  const visibleSpeakerCount = Math.max(
    1,
    reclusterStatus?.current_count || speakerOptions.length,
  );
  return (
    <div className="relative h-full bg-white">
      <div ref={scrollContainerRef} className="h-full overflow-y-auto px-8 pb-5">
        <div className="mx-auto max-w-[920px]">
          <div className="sticky top-0 z-10 mb-1 flex min-h-10 items-center justify-between gap-3 bg-white/95 py-1 backdrop-blur">
            <div className="min-w-0 text-[11px] text-slate-400">
              {refinement && version === "optimized"
                ? zh
                  ? `${visibleChangeCount} 处优化`
                  : `${visibleChangeCount} improvements`
                : ""}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant={syncPlayback ? "secondary" : "outline"}
                size="icon"
                className={`h-8 w-8 ${syncPlayback ? "bg-violet-100 text-violet-700 hover:bg-violet-100" : ""}`}
                onClick={() => setSyncPlayback((value) => !value)}
                title={
                  syncPlayback
                    ? zh
                      ? "关闭音文同步"
                      : "Disable audio-text sync"
                    : zh
                      ? "开启音文同步"
                      : "Enable audio-text sync"
                }
              >
                <AudioLines className="h-4 w-4" />
              </Button>
              <Popover
                open={speakerCountOpen}
                onOpenChange={(open) => {
                  setSpeakerCountOpen(open);
                  if (open) void loadReclusterStatus();
                }}
              >
                <PopoverTrigger asChild>
                  <span>
                    <ProgressIconButton
                      className="h-8 w-11"
                      icon={
                        <span className="flex items-center gap-1">
                          <UsersRound className="h-3.5 w-3.5" />
                          <span className="text-[10px] tabular-nums">
                            {visibleSpeakerCount}
                          </span>
                        </span>
                      }
                      title={
                        zh
                          ? reclusterStatus?.available
                            ? `当前识别 ${visibleSpeakerCount} 人，点击调整`
                            : `当前显示 ${visibleSpeakerCount} 人；完成会议模式转写后可调整`
                          : reclusterStatus?.available
                            ? `${visibleSpeakerCount} speakers; click to adjust`
                            : `${visibleSpeakerCount} speakers; transcribe in meeting mode to adjust`
                      }
                      progress={reclusterProgress}
                      progressText={
                        reclusterMessage ||
                        (zh ? "重新聚类说话人" : "Reclustering speakers")
                      }
                      onClick={() => setSpeakerCountOpen(true)}
                      onCancel={() => void cancelRecluster()}
                    />
                  </span>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-60 p-3">
                  <div className="text-xs font-medium text-slate-700">
                    {zh ? "说话人数" : "Speaker count"}
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-slate-400">
                    {reclusterStatus?.available
                      ? zh
                        ? `系统自动估计为 ${reclusterStatus.estimated_count} 人。调整后只重新聚类，不重复转写。`
                        : `The system estimated ${reclusterStatus.estimated_count}. Adjusting only reclusters speakers and does not rerun ASR.`
                      : zh
                        ? "完成一次会议模式转写后，即可在这里调整人数。"
                        : "Complete a meeting-mode transcription before adjusting the count."}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() =>
                        setSpeakerCountDraft((value) => Math.max(1, value - 1))
                      }
                      disabled={speakerCountDraft <= 1 || reclustering}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <div className="flex h-8 min-w-12 flex-1 items-center justify-center rounded-lg border border-slate-200 text-sm font-semibold tabular-nums text-slate-700">
                      {speakerCountDraft}
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() =>
                        setSpeakerCountDraft((value) => Math.min(20, value + 1))
                      }
                      disabled={speakerCountDraft >= 20 || reclustering}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Button
                    className="mt-3 h-8 w-full bg-violet-600 text-xs hover:bg-violet-700"
                    onClick={() => void recluster()}
                    disabled={
                      reclustering ||
                      !reclusterStatus?.available ||
                      speakerCountDraft === reclusterStatus.current_count
                    }
                  >
                    {reclustering && (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    )}
                    {zh ? "重新聚类" : "Recluster"}
                  </Button>
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`h-8 gap-1.5 px-2.5 text-xs ${speakerFilter !== "all" ? "border-violet-200 bg-violet-50 text-violet-700" : ""}`}
                    title={zh ? "筛选说话人" : "Filter speakers"}
                  >
                    <ListFilter className="h-3.5 w-3.5" />
                    <span className="max-w-24 truncate">
                      {speakerFilter === "all"
                        ? zh
                          ? "说话人"
                          : "Speakers"
                        : speakerOptions.find(
                            (item) => item[0] === speakerFilter,
                          )?.[1] || (zh ? "说话人" : "Speaker")}
                    </span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="max-h-[min(18rem,var(--radix-popover-content-available-height))] w-52 overflow-y-auto p-1"
                >
                  <button
                    onClick={() => setSpeakerFilter("all")}
                    className="flex h-7 w-full items-center justify-between rounded-md px-2 text-left text-xs leading-4 hover:bg-violet-50"
                  >
                    <span className="min-w-0 truncate">
                      {zh ? "全部说话人" : "All speakers"}
                    </span>
                    {speakerFilter === "all" && (
                      <Check className="h-3.5 w-3.5 text-violet-600" />
                    )}
                  </button>
                  {speakerOptions.map(([key, name]) => (
                    <button
                      key={key}
                      onClick={() => setSpeakerFilter(key)}
                      className="flex h-7 w-full items-center justify-between rounded-md px-2 text-left text-xs leading-4 hover:bg-violet-50"
                    >
                      <span className="min-w-0 flex-1 truncate pr-2">{name}</span>
                      {speakerFilter === key && (
                        <Check className="h-3.5 w-3.5 text-violet-600" />
                      )}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
              <ButtonGroup>
                <Button
                  variant="outline"
                  size="sm"
                  className={`h-8 rounded-r-none px-3 text-xs ${version === "original" ? "border-violet-200 bg-violet-50 text-violet-700" : ""}`}
                  onClick={() => setVersion("original")}
                  disabled={!originalVersion}
                >
                  {zh ? "原文" : "Original"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={`h-8 rounded-none border-l-0 px-3 text-xs ${version === "clustered" ? "border-violet-200 bg-violet-50 text-violet-700" : ""}`}
                  onClick={() => setVersion("clustered")}
                >
                  {zh ? "聚类" : "Clustered"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={`h-8 rounded-l-none border-l-0 px-3 text-xs ${version === "optimized" ? "border-violet-200 bg-violet-50 text-violet-700" : ""}`}
                  onClick={() => setVersion("optimized")}
                  disabled={!aiAvailable}
                  title={
                    !aiAvailable
                      ? zh
                        ? "请基于当前聚类版本生成 AI 优化"
                        : "Generate AI optimization from the clustered version"
                      : undefined
                  }
                >
                  {zh ? "AI 优化" : "AI Optimized"}
                </Button>
              </ButtonGroup>
            </div>
          </div>
          {groups.map((group) => {
            const row = group.rows[0];
            const meta = speakerMap[row.id];
            const displayName = effectiveSpeakerName(row.id);
            const palette = colors[meta?.colorIndex || 0];
            const active = group.rows.some((item) => item.id === activeRowId);
            const base = joinParagraph(
              group.rows.map((item) => shown(item.id, item.text)),
            );
            return (
              <section
                key={group.id}
                ref={(element) => {
                  for (const item of group.rows)
                    rowRefs.current[item.id] = element;
                }}
                className={`relative mb-4 scroll-mt-14 px-3 pt-1 transition-colors ${active ? "bg-violet-50/60" : ""}`}
              >
                {active && (
                  <span className="absolute inset-y-0 left-0 w-0.5 rounded-full bg-violet-400" />
                )}
                <div className="mb-1 flex items-center gap-2 text-[12px]">
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-full border text-[9px] font-semibold"
                    style={{
                      color: palette.fg,
                      backgroundColor: palette.soft,
                      borderColor: palette.ring,
                    }}
                  >
                    {initials(displayName)}
                  </span>
                  <span className="font-semibold" style={{ color: palette.fg }}>
                    {displayName}
                  </span>
                  {version !== "original" && (
                    <button
                      onClick={() => {
                        setEditing(editing === group.id ? null : group.id);
                        setBindingPersonId(speakerOverrides[row.id]?.personId || meta?.personId || "");
                        setNewName("");
                      }}
                      className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-violet-600"
                      title="编辑发言人"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => onSeek?.(row.timestamp || 0)}
                    className="font-medium tabular-nums text-slate-400 hover:text-violet-600"
                  >
                    {clock(row.timestamp)}
                  </button>
                </div>
                {editing === group.id && (
                  <div className="mb-3 ml-9 w-fit max-w-[calc(100%-2.25rem)] overflow-x-auto rounded-lg border border-violet-100 bg-violet-50/50 p-1.5">
                    <div className="flex flex-nowrap items-center gap-1.5">
                      <ProductSelect value={bindingPersonId} onChange={event => setBindingPersonId(event.target.value)} className="h-8 w-36 shrink-0">
                        <option value="">{zh ? "选择已有参会人" : "Choose participant"}</option>
                        {people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
                      </ProductSelect>
                      <input
                        value={newName}
                        onChange={event => { setNewName(event.target.value); if (event.target.value) setBindingPersonId(""); }}
                        placeholder={zh ? "新建参会人" : "New participant"}
                        className="h-8 w-28 shrink-0 rounded-md border px-2 text-xs"
                      />
                      <button onClick={() => void bindDisplayedSpeech(group.rows.map(item => item.id))} disabled={!bindingPersonId && !newName.trim()} className="h-8 shrink-0 whitespace-nowrap rounded-md border border-violet-200 bg-white px-3 text-xs font-medium text-violet-700 disabled:opacity-40">{zh ? "单条绑定" : "Single"}</button>
                      <button onClick={() => void bindSpeakerBatch(row.id)} disabled={!bindingPersonId && !newName.trim()} className="h-8 shrink-0 whitespace-nowrap rounded-md bg-violet-600 px-3 text-xs font-medium text-white disabled:opacity-40">{zh ? "批量绑定" : "Batch"}</button>
                    </div>
                  </div>
                )}
                <textarea
                  value={
                    (version === "optimized"
                      ? optimizedDrafts[group.id]
                      : version === "clustered"
                        ? drafts[group.id]
                        : undefined) ?? base
                  }
                  readOnly={version === "original"}
                  onChange={(event) => {
                    if (version === "original") return;
                    const value = event.target.value;
                    const setter =
                      version === "optimized" ? setOptimizedDrafts : setDrafts;
                    setter((current) => {
                      const next = { ...current };
                      if (value === base) delete next[group.id];
                      else next[group.id] = value;
                      return next;
                    });
                  }}
                  className={`min-h-[52px] w-full resize-none [field-sizing:content] border-0 bg-transparent py-0 pl-8 pr-2 text-[15px] leading-[1.8] text-slate-700 outline-none ${version === "original" ? "cursor-default" : ""}`}
                />
              </section>
            );
          })}
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-7 right-5 z-20 rounded-lg border border-slate-100 bg-white/95 px-2.5 py-1 text-[11px] tabular-nums text-slate-500 shadow-sm backdrop-blur-sm">
        字数：{count.toLocaleString()}
      </div>
    </div>
  );
});
