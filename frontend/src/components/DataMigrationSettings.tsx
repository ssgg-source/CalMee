"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle2, Database, FileSearch, FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/layout/ProductPage";
import { ProductButton } from "@/components/ui/ProductControls";
import { useLanguage } from "@/contexts/LanguageContext";
import { reportTechnicalError, toUserFacingError } from "@/lib/feedback";

type Preview = {
  sourcePath: string;
  targetPath: string;
  categories: Array<{ key: string; rows: number }>;
  audioReferences: number;
  missingAudioReferences: number;
  excludedRows: number;
  excludedItems: string[];
};
type Report = { insertedRows: number; skippedExistingRows: number; preservedAudioReferences: number; missingAudioReferences: number };
const labels: Record<string, [string, string]> = {
  meetings: ["会议基础信息", "Meetings"],
  rawTranscripts: ["原始文字稿", "Raw transcripts"],
  transcriptVersions: ["原始 / 聚类版本", "Original / clustered versions"],
  aiRefinements: ["AI 优化文字稿", "AI-refined transcripts"],
  meetingNotes: ["会议笔记", "Meeting notes"],
  publicDocuments: ["智能记录 / 纪要 / 讲话文档", "Smart records / summaries / speech documents"],
  recordBlocks: ["公共智能记录段落", "Public smart-record blocks"],
  tags: ["会议标签", "Meeting tags"],
};

export function DataMigrationSettings() {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [sourcePath, setSourcePath] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [includeAudioReferences, setIncludeAudioReferences] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    invoke<string | null>("api_get_default_legacy_calmee_source").then((path) => path && setSourcePath(path)).catch(() => undefined);
  }, []);

  const selectSource = async () => {
    const path = await invoke<string | null>("api_select_legacy_calmee_source");
    if (path) {
      setSourcePath(path);
      setPreview(null);
      setReport(null);
      setConfirmed(false);
    }
  };
  const loadPreview = async () => {
    if (!sourcePath) return;
    setLoading(true);
    setReport(null);
    setConfirmed(false);
    try {
      setPreview(await invoke<Preview>("api_preview_legacy_calmee_import", { sourcePath }));
    } catch (error) {
      setPreview(null);
      reportTechnicalError("data-migration-preview", error);
      toast.error(zh ? "无法预览旧数据" : "Could not preview old data", { description: toUserFacingError(error, locale).message });
    } finally {
      setLoading(false);
    }
  };
  const runImport = async () => {
    if (!preview || !confirmed) return;
    setImporting(true);
    try {
      setReport(await invoke<Report>("api_import_legacy_calmee_data", { options: { sourcePath: preview.sourcePath, includeAudioReferences } }));
      toast.success(zh ? "公共数据导入完成" : "Public data import completed");
    } catch (error) {
      reportTechnicalError("data-migration-import", error);
      toast.error(zh ? "导入失败，所有变更已回滚" : "Import failed; all changes were rolled back", { description: toUserFacingError(error, locale).message });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <SettingsSection>
        <div className="flex items-start gap-3">
          <span className="rounded-lg bg-primary/10 p-2 text-primary"><Database className="h-4 w-4" /></span>
          <div><h2 className="text-[15px] font-semibold">{zh ? "从旧 CalMee 数据导入" : "Import from old CalMee data"}</h2><p className="mt-1 text-[12px] leading-5 text-muted-foreground">{zh ? "旧数据库始终只读。CalMee 会先显示可导入数量，并只把白名单中的公共会议数据写入当前数据库。" : "The old database stays read-only. CalMee previews counts and writes only allowlisted public meeting data."}</p></div>
        </div>
        <div className="mt-5 rounded-lg border border-border/70 bg-muted/35 p-4">
          <p className="text-[11px] font-medium text-foreground">{zh ? "来源数据库（只读）" : "Source database (read-only)"}</p>
          <p className="mt-2 break-all font-mono text-[11px] leading-5 text-muted-foreground">{sourcePath || (zh ? "尚未选择" : "Not selected")}</p>
          <div className="mt-3 flex gap-2">
            <ProductButton size="sm" onClick={() => void selectSource()}><FolderOpen className="h-4 w-4" />{zh ? "选择文件" : "Choose file"}</ProductButton>
            <ProductButton size="sm" variant="primary" onClick={() => void loadPreview()} disabled={!sourcePath || loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />}{zh ? "只读预览" : "Preview read-only"}</ProductButton>
          </div>
        </div>
      </SettingsSection>

      {preview && (
        <SettingsSection title={zh ? "导入预览" : "Import preview"}>
          <div className="grid gap-px overflow-hidden rounded-lg border border-border/70 bg-border/70 sm:grid-cols-2 lg:grid-cols-4">
            {preview.categories.map((item) => <div key={item.key} className="bg-card p-3"><p className="text-xl font-semibold tabular-nums">{item.rows}</p><p className="mt-1 text-[11px] leading-4 text-muted-foreground">{labels[item.key]?.[zh ? 0 : 1] ?? item.key}</p></div>)}
          </div>
          <div className="mt-4 rounded-lg border border-amber-200/80 bg-amber-50/85 p-4 text-[11px] leading-5 text-amber-900">
            <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />{zh ? "明确排除" : "Always excluded"}</div>
            <p className="mt-1">{preview.excludedItems.join(" · ")}</p>
            <p>{zh ? `源库中检测到 ${preview.excludedRows} 条排除范围记录；它们不会写入新库。` : `${preview.excludedRows} excluded rows were detected; they will not be copied.`}</p>
          </div>
          <div className="mt-4 space-y-2 rounded-lg bg-muted/35 p-4 text-[11px] leading-5 text-muted-foreground">
            <p><strong className="text-foreground">{zh ? "来源：" : "Source: "}</strong><span className="break-all font-mono">{preview.sourcePath}</span></p>
            <p><strong className="text-foreground">{zh ? "目标：" : "Target: "}</strong><span className="break-all font-mono">{preview.targetPath}</span></p>
            <p>{zh ? `音频引用 ${preview.audioReferences} 条，其中 ${preview.missingAudioReferences} 条路径已不存在。不会自动复制音频。` : `${preview.audioReferences} audio references; ${preview.missingAudioReferences} paths are missing. Audio is never copied automatically.`}</p>
          </div>
          <CheckRow checked={includeAudioReferences} onChange={setIncludeAudioReferences} accent={false}>{zh ? "保留仍然存在的音频文件夹引用（只保存路径，不复制文件；缺失路径会跳过）" : "Keep audio folder references that still exist (paths only; missing paths are skipped)"}</CheckRow>
          <CheckRow checked={confirmed} onChange={setConfirmed} accent>{zh ? "我已核对来源、目标和排除项，并确认开始事务化导入。重复记录保留目标库现有版本。" : "I reviewed the source, target, and exclusions. Import transactionally and keep existing target records on duplicates."}</CheckRow>
          <ProductButton className="mt-4" variant="primary" onClick={() => void runImport()} disabled={!confirmed || importing}>{importing && <Loader2 className="h-4 w-4 animate-spin" />}{zh ? "开始安全导入" : "Start safe import"}</ProductButton>
        </SettingsSection>
      )}

      {report && <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-[12px] leading-5 text-emerald-900"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" /><p>{zh ? `已写入 ${report.insertedRows} 条；跳过 ${report.skippedExistingRows} 条重复记录；保留 ${report.preservedAudioReferences} 条音频引用；跳过 ${report.missingAudioReferences} 条缺失引用。` : `Inserted ${report.insertedRows}; skipped ${report.skippedExistingRows} duplicates; preserved ${report.preservedAudioReferences} audio references; skipped ${report.missingAudioReferences} missing references.`}</p></div>}
    </div>
  );
}

function CheckRow({ checked, onChange, accent, children }: { checked: boolean; onChange: (checked: boolean) => void; accent: boolean; children: React.ReactNode }) {
  return <label className={accent ? "mt-3 flex items-start gap-3 rounded-lg border border-primary/25 bg-accent/55 p-4 text-[12px] leading-5 text-accent-foreground" : "mt-4 flex items-start gap-3 rounded-lg border border-border/70 p-4 text-[12px] leading-5 text-foreground"}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 accent-primary" /><span>{children}</span></label>;
}
