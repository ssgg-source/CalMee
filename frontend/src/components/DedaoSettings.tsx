"use client";

import { useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/data-invoke";
import { BookOpenText, Check, CloudDownload, Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/layout/ProductPage";
import { ProductButton, ProductEmptyState, ProductInput, ProductSelect } from "@/components/ui/ProductControls";
import { useLanguage } from "@/contexts/LanguageContext";
import { reportTechnicalError, toUserFacingError } from "@/lib/feedback";
import { filterDedaoNotes, mergeDedaoNotes, readDedaoPages, runDedaoImport, toggleDedaoSelection, type DedaoNote, type DedaoPage, type DedaoFilters, type DedaoImportResult } from "@/lib/dedao-notes";
import { useSidebar } from "@/components/Sidebar/SidebarProvider";

type Settings = {
  localEnabled: boolean; caldavEnabled: boolean; caldavUrl?: string; caldavUsername?: string;
  caldavPassword?: string; caldavCalendarPath?: string; syncMode: string; lastSyncAt?: string;
  dedaoEnabled: boolean; dedaoApiKey?: string; dedaoClientId?: string; dedaoRecordingOnly: boolean;
  dedaoContentMode: string; dedaoConflictMode: string; dedaoAuthorizedAt?: string; dedaoLastSyncAt?: string;
};

export function DedaoSettings() {
  const { locale } = useLanguage();
  const { refetchMeetings } = useSidebar();
  const zh = locale === "zh-CN";
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notes, setNotes] = useState<DedaoNote[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"save" | "load" | "all" | "import" | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [filters, setFilters] = useState<Omit<DedaoFilters, 'recordingOnly'>>({ query: '', from: '', to: '', status: 'all' });
  const locked = useRef(false);
  const stopped = useRef(false);
  const mounted = useRef(true);
  const seenCursors = useRef(new Set<string>());
  const selectAllRef = useRef<HTMLInputElement>(null);
  const visibleNotes = filterDedaoNotes(notes, { ...filters, recordingOnly: settings?.dedaoRecordingOnly ?? false });
  const visibleSelected = visibleNotes.filter(note => selected.has(note.noteId));
  const invalidDates = Boolean(filters.from && filters.to && filters.from > filters.to);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopped.current = true; }; }, []);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = visibleSelected.length > 0 && visibleSelected.length < visibleNotes.length;
  }, [visibleSelected.length, visibleNotes.length]);

  useEffect(() => {
    invoke<Settings>("api_get_calendar_settings").then(setSettings).catch((error) => {
      reportTechnicalError("dedao.load-settings", error);
      toast.error(zh ? "得到笔记设置加载失败" : "Could not load Dedao Brain settings", { description: toUserFacingError(error, locale).message });
    });
  }, [locale, zh]);

  const persistSettings = async () => {
    if (!settings) return false;
    try {
      await invoke("api_save_calendar_settings", { settings: { ...settings, dedaoEnabled: true } });
      const saved = await invoke<Settings>("api_get_calendar_settings");
      if (mounted.current) setSettings(saved);
      return true;
    } catch (error) {
      reportTechnicalError("dedao.save-settings", error);
      toast.error(zh ? "保存失败" : "Could not save settings", { description: toUserFacingError(error, locale).message });
      return false;
    }
  };
  const save = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy('save');
    try { if (await persistSettings()) toast.success(zh ? '设置已保存' : 'Settings saved'); }
    finally { locked.current = false; if (mounted.current) setBusy(null); }
  };
  const load = async (reset = false, all = false) => {
    if (locked.current || (!reset && cursor === null)) return;
    locked.current = true;
    stopped.current = false;
    setBusy(all ? 'all' : 'load');
    setLoadError(false);
    try {
      if (reset) {
        if (!await persistSettings() || !mounted.current) return;
        setNotes([]);
        setSelected(new Set());
        setCursor(null);
        setLoaded(false);
        seenCursors.current.clear();
      }
      await readDedaoPages({
        cursor: reset ? null : cursor, all, seen: seenCursors.current,
        stopped: () => stopped.current || !mounted.current,
        fetchPage: async next => {
          // Read serially so loading a long history does not flood the service.
          if (all && next !== null) await new Promise(resolve => setTimeout(resolve, 350));
          return invoke<DedaoPage>('api_list_dedao_notes', { cursor: next });
        },
        onPage: (page, next) => {
          setNotes(current => mergeDedaoNotes(current, page.notes));
          setCursor(next);
          setLoaded(true);
        },
      });
    } catch (error) {
      if (!mounted.current) return;
      setLoadError(true);
      reportTechnicalError("dedao.list-notes", error);
      toast.error(zh ? "读取失败" : "Could not load notes", { description: toUserFacingError(error, locale).message });
    } finally { locked.current = false; if (mounted.current) setBusy(null); }
  };
  const importNotes = async () => {
    if (!visibleSelected.length || locked.current) return;
    locked.current = true;
    setBusy("import");
    try {
      const result = await runDedaoImport(
        () => invoke<DedaoImportResult>("api_import_dedao_notes", { noteIds: visibleSelected.map(note => note.noteId), overwriteExisting: false }),
        refetchMeetings,
      );
      if (!mounted.current) return;
      const processed = new Set(result.processedNoteIds);
      setNotes((items) => items.map((item) => processed.has(item.noteId) ? { ...item, imported: true } : item));
      setSelected(current => new Set([...current].filter(id => !processed.has(id))));
      const message = zh
        ? `新增导入 ${result.imported} 条，已存在 ${result.skipped} 条，失败 ${result.failed} 条`
        : `Imported ${result.imported}; already present ${result.skipped}; failed ${result.failed}`;
      const description = result.imported || result.skipped
        ? (zh ? '可在首页「得到导入」查看，列表按笔记原始日期排列。' : 'View them under Dedao imports on the home page, sorted by the original note date.')
        : (zh ? '没有新增笔记，请重试。' : 'No notes were imported. Please retry.');
      if (result.failed) toast.warning(message, { description });
      else if (result.imported) toast.success(message, { description });
      else toast.info(message, { description });
    } catch (error) {
      reportTechnicalError("dedao.import-notes", error);
      toast.error(zh ? "导入失败" : "Import failed", { description: toUserFacingError(error, locale).message });
    } finally { locked.current = false; if (mounted.current) setBusy(null); }
  };

  if (!settings) return <div className="h-36 animate-pulse rounded-xl bg-muted" />;

  return (
    <div className="space-y-5">
      <SettingsSection title={zh ? "连接得到笔记" : "Connect Dedao Brain"} description={zh ? "凭据只保存在本机 CalMee 数据目录。" : "Credentials stay in CalMee’s local app-data directory."}>
        <div className="grid grid-cols-2 gap-3">
          <ProductInput aria-label="Client ID" disabled={!!busy} placeholder="Client ID (cli_…)" value={settings.dedaoClientId ?? ""} onChange={(event) => { setSettings({ ...settings, dedaoClientId: event.target.value }); setNotes([]); setSelected(new Set()); setLoaded(false); setCursor(null); }} />
          <ProductInput aria-label="API Key" disabled={!!busy} type="password" placeholder="API Key (gk_live_…)" value={settings.dedaoApiKey ?? ""} onChange={(event) => { setSettings({ ...settings, dedaoApiKey: event.target.value }); setNotes([]); setSelected(new Set()); setLoaded(false); setCursor(null); }} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <ProductButton size="sm" onClick={() => void save()} disabled={!!busy}><Save className="h-4 w-4" />{zh ? "保存" : "Save"}</ProductButton>
          <ProductButton size="sm" variant="primary" onClick={() => void load(true)} disabled={!!busy}><RefreshCw className={busy === "load" ? "h-4 w-4 animate-spin" : "h-4 w-4"} />{zh ? "验证并读取" : "Verify and load"}</ProductButton>
        </div>
      </SettingsSection>

      <SettingsSection title={zh ? `可导入笔记（${visibleNotes.length}）` : `Available notes (${visibleNotes.length})`}>
        <fieldset disabled={!!busy} className="mb-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs text-muted-foreground">{zh ? '搜索标题或摘要' : 'Search title or preview'}<ProductInput value={filters.query} onChange={event => setFilters({ ...filters, query: event.target.value })} placeholder={zh ? '输入关键词' : 'Keywords'} /></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground">{zh ? '导入状态' : 'Import status'}<ProductSelect value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value as DedaoFilters['status'] })}><option value="all">{zh ? '全部状态' : 'All statuses'}</option><option value="pending">{zh ? '未导入' : 'Not imported'}</option><option value="imported">{zh ? '已导入' : 'Imported'}</option></ProductSelect></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground">{zh ? '开始日期' : 'Start date'}<ProductInput type="date" value={filters.from} max={filters.to || undefined} onChange={event => setFilters({ ...filters, from: event.target.value })} /></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground">{zh ? '结束日期（含当天）' : 'End date (inclusive)'}<ProductInput type="date" value={filters.to} min={filters.from || undefined} onChange={event => setFilters({ ...filters, to: event.target.value })} /></label>
          </div>
          {invalidDates && <p role="alert" className="text-xs text-destructive">{zh ? '开始日期不能晚于结束日期。' : 'Start date must not be later than end date.'}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs"><Switch checked={settings.dedaoRecordingOnly} disabled={!!busy} onCheckedChange={dedaoRecordingOnly => setSettings({ ...settings, dedaoRecordingOnly })} />{zh ? '只显示录音类笔记' : 'Recording notes only'}</label>
            <ProductButton size="sm" variant="ghost" onClick={() => { setFilters({ query: '', from: '', to: '', status: 'all' }); setSettings({ ...settings, dedaoRecordingOnly: false }); }}>{zh ? '清除筛选' : 'Clear filters'}</ProductButton>
          </div>
        </fieldset>
        <p className="mb-3 text-xs leading-5 text-muted-foreground" aria-live="polite">{zh ? `已加载 ${notes.length} 条${loaded && cursor === null ? '，已到末页' : ''}。筛选仅作用于已加载笔记；查找更早记录请加载更多或全部。` : `${notes.length} notes loaded${loaded && cursor === null ? ', last page reached' : ''}. Filters apply to loaded notes. Load more or all to find older notes.`}</p>
        {loadError && <p role="alert" className="mb-3 text-xs text-destructive">{zh ? '本次读取未完成，已加载列表保留。请重试加载，或重新验证并读取。' : 'Loading did not finish. Loaded notes are retained. Retry loading or verify and load again.'}</p>}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-y border-border/60 py-2">
          <label className="flex items-center gap-2 text-xs"><input ref={selectAllRef} type="checkbox" className="h-4 w-4 accent-primary" checked={visibleNotes.length > 0 && visibleSelected.length === visibleNotes.length} disabled={!visibleNotes.length || !!busy} onChange={() => setSelected(current => toggleDedaoSelection(current, visibleNotes))} />{zh ? '全选当前筛选结果' : 'Select filtered notes'}</label>
          <ProductButton size="sm" variant="ghost" disabled={!selected.size || !!busy} onClick={() => setSelected(new Set())}>{zh ? '取消全部选择' : 'Clear selection'}</ProductButton>
        </div>
        {!visibleNotes.length ? (
          <ProductEmptyState className="min-h-[180px]" icon={<BookOpenText className="h-5 w-5" />} title={loaded ? (zh ? '没有符合筛选条件的笔记' : 'No matching notes') : (zh ? '还没有可导入的笔记' : 'No notes available')} description={loaded ? (zh ? '可以调整筛选条件，或继续加载历史笔记。' : 'Adjust filters or continue loading older notes.') : (zh ? '验证连接后，可以在这里选择要导入的笔记。' : 'Verify the connection, then choose notes to import.')} />
        ) : (
          <div className="-mx-5 max-h-[440px] divide-y divide-border/60 overflow-y-auto">
            {visibleNotes.map((note) => {
              const checked = selected.has(note.noteId);
              return <button type="button" role="checkbox" aria-checked={checked} disabled={!!busy} key={note.noteId} onClick={() => setSelected((current) => { const next = new Set(current); next.has(note.noteId) ? next.delete(note.noteId) : next.add(note.noteId); return next; })} className={checked ? "w-full bg-accent/60 p-4 text-left transition" : "w-full p-4 text-left transition hover:bg-muted/35"}><div className="flex items-center gap-2"><span className={checked ? "grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border border-primary bg-primary text-primary-foreground" : "h-4 w-4 shrink-0 rounded-[5px] border border-input bg-card"}>{checked && <Check className="h-3 w-3" />}</span><span className="font-medium">{note.title}</span>{note.imported && <span className="text-[10px] text-emerald-600">{zh ? "已导入" : "Imported"}</span>}</div><p className="mt-1 pl-6 text-[10px] text-muted-foreground">{note.createdAt && Number.isFinite(Date.parse(note.createdAt)) ? new Date(note.createdAt).toLocaleDateString(locale) : (zh ? '日期未知' : 'Unknown date')}</p><p className="mt-1 line-clamp-2 pl-6 text-[11px] leading-5 text-muted-foreground">{note.contentPreview}</p></button>;
            })}
          </div>
        )}
        {(cursor !== null || busy === 'all') && <div className="mt-3 flex flex-wrap justify-center gap-2">{busy === 'all' ? <ProductButton size="sm" onClick={() => { stopped.current = true; }}>{zh ? '停止加载' : 'Stop loading'}</ProductButton> : <><ProductButton size="sm" disabled={!!busy} onClick={() => void load(false)}>{busy === 'load' && <Loader2 className="h-4 w-4 animate-spin" />}{zh ? '加载更多' : 'Load more'}</ProductButton><ProductButton size="sm" disabled={!!busy} onClick={() => void load(false, true)}>{zh ? '加载全部' : 'Load all'}</ProductButton></>}</div>}
        <div className="-mx-5 -mb-5 mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-muted/25 p-4"><span className="text-xs text-muted-foreground">{zh ? `当前选中 ${visibleSelected.length} 条` : `${visibleSelected.length} selected in view`}{selected.size > visibleSelected.length && (zh ? `，另有 ${selected.size - visibleSelected.length} 条被筛选隐藏，不会导入` : `; ${selected.size - visibleSelected.length} hidden selections will not be imported`)}</span><ProductButton variant="primary" onClick={() => void importNotes()} disabled={!visibleSelected.length || !!busy || invalidDates}>{busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}{zh ? `导入所选（${visibleSelected.length}）` : `Import selected (${visibleSelected.length})`}</ProductButton></div>
      </SettingsSection>
    </div>
  );
}
