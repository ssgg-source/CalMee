'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CloudDownload, Loader2, RefreshCw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

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
  const zh = locale === 'zh-CN';
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'save' | 'load' | 'import' | null>(null);

  useEffect(() => {
    invoke<Settings>('api_get_calendar_settings').then(setSettings).catch(error => {
      reportTechnicalError('dedao.load-settings', error);
      toast.error(zh ? '得到笔记设置加载失败' : 'Could not load Dedao Brain settings', { description: toUserFacingError(error, locale).message });
    });
  }, [locale, zh]);

  const save = async () => {
    if (!settings) return false;
    setBusy('save');
    try {
      await invoke('api_save_calendar_settings', { settings: { ...settings, dedaoEnabled: true } });
      setSettings({ ...settings, dedaoEnabled: true });
      toast.success(zh ? '设置已保存' : 'Settings saved');
      return true;
    } catch (error) {
      reportTechnicalError('dedao.save-settings', error);
      toast.error(zh ? '保存失败' : 'Could not save settings', { description: toUserFacingError(error, locale).message });
      return false;
    } finally { setBusy(null); }
  };

  const load = async () => {
    if (!await save()) return;
    setBusy('load');
    try {
      const page = await invoke<Page>('api_list_dedao_notes', { cursor: null });
      setNotes(page.notes);
      toast.success(zh ? `已读取 ${page.notes.length} 条笔记` : `Loaded ${page.notes.length} notes`);
    } catch (error) {
      reportTechnicalError('dedao.list-notes', error);
      toast.error(zh ? '读取失败' : 'Could not load notes', { description: toUserFacingError(error, locale).message });
    } finally { setBusy(null); }
  };

  const importNotes = async () => {
    if (!selected.size) return;
    setBusy('import');
    try {
      const result = await invoke<ImportResult>('api_import_dedao_notes', { noteIds: [...selected], overwriteExisting: false });
      setNotes(items => items.map(item => selected.has(item.noteId) ? { ...item, imported: true } : item));
      setSelected(new Set());
      toast.success(zh ? `已导入 ${result.imported} 条，跳过 ${result.skipped} 条` : `Imported ${result.imported}; skipped ${result.skipped}`);
      if (result.failed) toast.warning(zh ? `${result.failed} 条未能导入` : `${result.failed} notes could not be imported`);
    } catch (error) {
      reportTechnicalError('dedao.import-notes', error);
      toast.error(zh ? '导入失败' : 'Import failed', { description: toUserFacingError(error, locale).message });
    } finally { setBusy(null); }
  };

  if (!settings) return <div className="flex justify-center p-12"><Loader2 className="animate-spin text-violet-600" /></div>;
  const input = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100';
  return <div className="mt-6 space-y-5">
    <section className="rounded-2xl border border-violet-100 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">{zh ? '连接得到笔记' : 'Connect Dedao Brain'}</h2>
      <p className="mt-1 text-sm text-slate-500">{zh ? '凭据只保存在本机 CalMee 专属数据目录，不会迁移许可证或 Pro 配置。' : 'Credentials stay in CalMee’s local app-data directory. License and former Pro configuration are never imported.'}</p>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <input className={input} placeholder="Client ID (cli_…)" value={settings.dedaoClientId ?? ''} onChange={event => setSettings({ ...settings, dedaoClientId: event.target.value })} />
        <input className={input} type="password" placeholder="API Key (gk_live_…)" value={settings.dedaoApiKey ?? ''} onChange={event => setSettings({ ...settings, dedaoApiKey: event.target.value })} />
        <label className="col-span-2 flex items-center justify-between rounded-xl border border-slate-200 p-3 text-sm"><span>{zh ? '只显示录音类笔记' : 'Show recording notes only'}</span><Switch checked={settings.dedaoRecordingOnly} onCheckedChange={dedaoRecordingOnly => setSettings({ ...settings, dedaoRecordingOnly })} /></label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={() => void save()} disabled={!!busy} className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm"><Save className="h-4 w-4" />{zh ? '保存' : 'Save'}</button>
        <button onClick={() => void load()} disabled={!!busy} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm text-white"><RefreshCw className={`h-4 w-4 ${busy === 'load' ? 'animate-spin' : ''}`} />{zh ? '验证并读取' : 'Verify and load'}</button>
      </div>
    </section>
    <section className="overflow-hidden rounded-2xl border border-violet-100 bg-white shadow-sm">
      <div className="border-b p-5 font-semibold">{zh ? `可导入笔记（${notes.length}）` : `Available notes (${notes.length})`}</div>
      {!notes.length ? <div className="p-12 text-center text-sm text-slate-400">{zh ? '验证连接后在这里选择要导入的笔记。' : 'Verify the connection, then choose notes to import.'}</div> : <div className="max-h-[440px] divide-y overflow-y-auto">{notes.filter(note => !settings.dedaoRecordingOnly || note.hasAudio).map(note => <button key={note.noteId} onClick={() => setSelected(current => { const next = new Set(current); next.has(note.noteId) ? next.delete(note.noteId) : next.add(note.noteId); return next; })} className={`w-full p-4 text-left ${selected.has(note.noteId) ? 'bg-violet-50' : 'hover:bg-slate-50'}`}>
        <div className="flex items-center gap-2"><span className={`h-4 w-4 rounded border ${selected.has(note.noteId) ? 'border-violet-600 bg-violet-600' : 'border-slate-300'}`} /><span className="font-medium">{note.title}</span>{note.imported && <span className="text-xs text-emerald-600">{zh ? '已导入' : 'Imported'}</span>}</div>
        <p className="mt-1 line-clamp-2 pl-6 text-xs text-slate-500">{note.contentPreview}</p>
      </button>)}</div>}
      <div className="flex justify-end border-t bg-slate-50 p-4"><button onClick={() => void importNotes()} disabled={!selected.size || !!busy} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm text-white disabled:opacity-40"><CloudDownload className="h-4 w-4" />{zh ? `导入所选（${selected.size}）` : `Import selected (${selected.size})`}</button></div>
    </section>
  </div>;
}
