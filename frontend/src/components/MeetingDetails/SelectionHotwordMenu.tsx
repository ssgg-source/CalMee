"use client";

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookPlus, Loader2, ReplaceAll } from 'lucide-react';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

type MenuState = { x: number; y: number; text: string } | null;

function selectedText(target: EventTarget | null) {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    return target.value.slice(start, end).trim();
  }
  return window.getSelection()?.toString().trim() || '';
}

export function SelectionHotwordMenu({ children }: { children: React.ReactNode }) {
  const { lt, locale } = useLanguage();
  const [menu, setMenu] = useState<MenuState>(null);
  const [saving, setSaving] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [replacement, setReplacement] = useState('');

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', key);
    };
  }, [menu]);

  const add = async () => {
    if (!menu || saving) return;
    setSaving(true);
    try {
      await invoke('api_upsert_hotword', { term: menu.text, replacementFrom: null, category: 'Meeting selection' });
      toast.success(lt('Added to hotwords'), { description: menu.text });
      setMenu(null);
    } catch (error) {
      toast.error(lt('Failed to add hotword'), { description: String(error) });
    } finally {
      setSaving(false);
    }
  };

  const correctAll = async () => {
    if (!menu || saving || !replacement.trim() || replacement.trim() === menu.text) return;
    setSaving(true);
    const corrected = replacement.trim();
    let replacedCount = 0;
    try {
      replacedCount = await new Promise<number>((resolve, reject) => {
        window.dispatchEvent(new CustomEvent('calmee-batch-correct-selection', {
          detail: { from: menu.text, to: corrected, complete: resolve, fail: reject },
        }));
      });
      if (!replacedCount) throw new Error(locale === 'zh-CN' ? '当前会议的文稿中没有找到该词' : 'The term was not found in this meeting');
      await invoke('api_upsert_hotword', { term: corrected, replacementFrom: menu.text, category: 'Meeting batch correction' });
      toast.success(locale === 'zh-CN' ? `已在本次会议中替换 ${replacedCount} 处，并加入热词库` : `Replaced ${replacedCount} occurrences across this meeting and added the correction to hotwords`, { description: `${menu.text} → ${corrected}` });
      setMenu(null);
      setCorrecting(false);
      setReplacement('');
    } catch (error) {
      toast.error(
        replacedCount
          ? locale === 'zh-CN' ? '文字已替换，但热词保存失败' : 'Text was replaced, but the hotword could not be saved'
          : locale === 'zh-CN' ? '批量纠错失败' : 'Batch correction failed',
        { description: String(error) },
      );
    } finally {
      setSaving(false);
    }
  };

  return <div
    className="contents"
    onContextMenuCapture={event => {
      const text = selectedText(event.target);
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      setCorrecting(false);
      setReplacement('');
      setMenu({ x: Math.min(event.clientX, window.innerWidth - 245), y: Math.min(event.clientY, window.innerHeight - 190), text });
    }}
  >
    {children}
    {menu && <div
      className="fixed z-[100] w-max min-w-0 max-w-60 rounded-lg border border-slate-200 bg-white p-1 shadow-xl"
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={event => event.stopPropagation()}
    >
      <button onMouseDown={event => event.preventDefault()} onClick={() => void add()} disabled={saving} className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-sm text-slate-700 hover:bg-violet-50 disabled:opacity-50">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookPlus className="h-4 w-4 text-violet-600" />}
        <span>{locale === 'zh-CN' ? '添加热词' : 'Add hotword'}</span>
      </button>
      <button onMouseDown={event => event.preventDefault()} onClick={() => { setCorrecting(true); setReplacement(''); }} disabled={saving} className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-sm text-slate-700 hover:bg-violet-50 disabled:opacity-50">
        <ReplaceAll className="h-4 w-4 text-violet-600" />
        <span>{locale === 'zh-CN' ? '批量纠错' : 'Batch correction'}</span>
      </button>
      {correcting && <div className="mt-1 w-56 border-t border-slate-100 p-2">
        <div className="mb-1.5 truncate text-xs text-slate-400">{menu.text} →</div>
        <input autoFocus value={replacement} onChange={event => setReplacement(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void correctAll(); }} placeholder={locale === 'zh-CN' ? '输入正确词语' : 'Enter the correct term'} className="h-9 w-full rounded-md border border-slate-200 px-2.5 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
        <button onClick={() => void correctAll()} disabled={saving || !replacement.trim()} className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{locale === 'zh-CN' ? '全部替换' : 'Replace all'}
        </button>
      </div>}
    </div>}
  </div>;
}
