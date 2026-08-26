"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BookOpenText, Check, CloudDownload, Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/layout/ProductPage";
import { ProductButton, ProductEmptyState, ProductInput } from "@/components/ui/ProductControls";
import { useLanguage } from "@/contexts/LanguageContext";
import { reportTechnicalError, toUserFacingError } from "@/lib/feedback";

type Settings = {
  localEnabled: boolean; caldavEnabled: boolean; caldavUrl?: string; caldavUsername?: string;
  caldavPassword?: string; caldavCalendarPath?: string; syncMode: string; lastSyncAt?: string;
  dedaoEnabled: boolean; dedaoApiKey?: string; dedaoClientId?: string; dedaoRecordingOnly: boolean;
  dedaoContentMode: string; dedaoConflictMode: string; dedaoAuthorizedAt?: string; dedaoLastSyncAt?: string;
};
type Note = { noteId: string; title: string; contentPreview: string; createdAt?: string; imported: boolean; hasAudio: boolean };
type Page = { notes: Note[]; cursor?: string; hasMore: boolean };
type ImportResult = { imported: number; skipped: number; failed: number };

export function DedaoSettings() {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"save" | "load" | "import" | null>(null);

  useEffect(() => {
    invoke<Settings>("api_get_calendar_settings").then(setSettings).catch((error) => {
      reportTechnicalError("dedao.load-settings", error);
      toast.error(zh ? "得到笔记设置加载失败" : "Could not load Dedao Brain settings", { description: toUserFacingError(error, locale).message });
    });
  }, [locale, zh]);

  const save = async () => {
    if (!settings) return false;
    setBusy("save");
    try {
      await invoke("api_save_calendar_settings", { settings: { ...settings, dedaoEnabled: true } });
      setSettings({ ...settings, dedaoEnabled: true });
      toast.success(zh ? "设置已保存" : "Settings saved");
      return true;
    } catch (error) {
      reportTechnicalError("dedao.save-settings", error);
      toast.error(zh ? "保存失败" : "Could not save settings", { description: toUserFacingError(error, locale).message });
      return false;
    } finally { setBusy(null); }
  };
  const load = async () => {
    if (!await save()) return;
    setBusy("load");
    try {
      const page = await invoke<Page>("api_list_dedao_notes", { cursor: null });
      setNotes(page.notes);
      toast.success(zh ? `已读取 ${page.notes.length} 条笔记` : `Loaded ${page.notes.length} notes`);
    } catch (error) {
      reportTechnicalError("dedao.list-notes", error);
      toast.error(zh ? "读取失败" : "Could not load notes", { description: toUserFacingError(error, locale).message });
    } finally { setBusy(null); }
  };
  const importNotes = async () => {
    if (!selected.size) return;
    setBusy("import");
    try {
      const result = await invoke<ImportResult>("api_import_dedao_notes", { noteIds: [...selected], overwriteExisting: false });
      setNotes((items) => items.map((item) => selected.has(item.noteId) ? { ...item, imported: true } : item));
      setSelected(new Set());
      toast.success(zh ? `已导入 ${result.imported} 条，跳过 ${result.skipped} 条` : `Imported ${result.imported}; skipped ${result.skipped}`);
      if (result.failed) toast.warning(zh ? `${result.failed} 条未能导入` : `${result.failed} notes could not be imported`);
    } catch (error) {
      reportTechnicalError("dedao.import-notes", error);
      toast.error(zh ? "导入失败" : "Import failed", { description: toUserFacingError(error, locale).message });
    } finally { setBusy(null); }
  };

  if (!settings) return <div className="h-36 animate-pulse rounded-xl bg-muted" />;
  const visibleNotes = notes.filter((note) => !settings.dedaoRecordingOnly || note.hasAudio);

  return (
    <div className="space-y-5">
      <SettingsSection title={zh ? "连接得到笔记" : "Connect Dedao Brain"} description={zh ? "凭据只保存在本机 CalMee 数据目录。" : "Credentials stay in CalMee’s local app-data directory."}>
        <div className="grid grid-cols-2 gap-3">
          <ProductInput placeholder="Client ID (cli_…)" value={settings.dedaoClientId ?? ""} onChange={(event) => setSettings({ ...settings, dedaoClientId: event.target.value })} />
          <ProductInput type="password" placeholder="API Key (gk_live_…)" value={settings.dedaoApiKey ?? ""} onChange={(event) => setSettings({ ...settings, dedaoApiKey: event.target.value })} />
          <label className="col-span-2 flex items-center justify-between rounded-lg border border-border/70 bg-muted/25 p-3 text-[12px]"><span>{zh ? "只显示录音类笔记" : "Show recording notes only"}</span><Switch checked={settings.dedaoRecordingOnly} onCheckedChange={(dedaoRecordingOnly) => setSettings({ ...settings, dedaoRecordingOnly })} /></label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <ProductButton size="sm" onClick={() => void save()} disabled={!!busy}><Save className="h-4 w-4" />{zh ? "保存" : "Save"}</ProductButton>
          <ProductButton size="sm" variant="primary" onClick={() => void load()} disabled={!!busy}><RefreshCw className={busy === "load" ? "h-4 w-4 animate-spin" : "h-4 w-4"} />{zh ? "验证并读取" : "Verify and load"}</ProductButton>
        </div>
      </SettingsSection>

      <SettingsSection title={zh ? `可导入笔记（${visibleNotes.length}）` : `Available notes (${visibleNotes.length})`}>
        {!visibleNotes.length ? (
          <ProductEmptyState className="min-h-[250px]" icon={<BookOpenText className="h-5 w-5" />} title={zh ? "还没有可导入的笔记" : "No notes available"} description={zh ? "验证连接后，可以在这里选择要导入的笔记。" : "Verify the connection, then choose notes to import."} />
        ) : (
          <div className="-mx-5 -mt-5 max-h-[440px] divide-y divide-border/60 overflow-y-auto">
            {visibleNotes.map((note) => {
              const checked = selected.has(note.noteId);
              return <button key={note.noteId} onClick={() => setSelected((current) => { const next = new Set(current); next.has(note.noteId) ? next.delete(note.noteId) : next.add(note.noteId); return next; })} className={checked ? "w-full bg-accent/60 p-4 text-left transition" : "w-full p-4 text-left transition hover:bg-muted/35"}><div className="flex items-center gap-2"><span className={checked ? "grid h-4 w-4 place-items-center rounded-[5px] border border-primary bg-primary text-primary-foreground" : "h-4 w-4 rounded-[5px] border border-input bg-card"}>{checked && <Check className="h-3 w-3" />}</span><span className="font-medium">{note.title}</span>{note.imported && <span className="text-[10px] text-emerald-600">{zh ? "已导入" : "Imported"}</span>}</div><p className="mt-1 line-clamp-2 pl-6 text-[11px] leading-5 text-muted-foreground">{note.contentPreview}</p></button>;
            })}
          </div>
        )}
        <div className="-mx-5 -mb-5 mt-4 flex justify-end border-t border-border/70 bg-muted/25 p-4"><ProductButton variant="primary" onClick={() => void importNotes()} disabled={!selected.size || !!busy}>{busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}{zh ? `导入所选（${selected.size}）` : `Import selected (${selected.size})`}</ProductButton></div>
      </SettingsSection>
    </div>
  );
}
