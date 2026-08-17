'use client';

import { FileAudio, FolderOpen, UploadCloud } from 'lucide-react';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { useLanguage } from '@/contexts/LanguageContext';

export default function UploadPage() {
  const { openImportDialog } = useImportDialog();
  const { t } = useLanguage();
  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-[#f8f7fb] px-8 pb-12 pt-8">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col">
        <header className="mb-8"><p className="mb-2 text-sm font-medium text-violet-600">{t('upload.eyebrow')}</p><h1 className="text-3xl font-semibold tracking-tight text-slate-900">{t('upload.title')}</h1><p className="mt-2 text-slate-500">{t('upload.description')}</p></header>
        <button onClick={() => openImportDialog()} className="group flex flex-1 min-h-[420px] flex-col items-center justify-center rounded-[32px] border-2 border-dashed border-violet-200 bg-white p-12 text-center shadow-sm transition hover:border-violet-400 hover:bg-violet-50/40">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-violet-100 text-violet-700 transition group-hover:scale-105"><UploadCloud className="h-9 w-9" /></div>
          <h2 className="text-xl font-semibold text-slate-900">{t('upload.choose')}</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{t('upload.help')}</p>
          <div className="mt-8 flex gap-3 text-xs text-slate-500"><span className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1.5"><FileAudio className="h-3.5 w-3.5" />{t('upload.media')}</span><span className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1.5"><FolderOpen className="h-3.5 w-3.5" />{t('upload.local')}</span></div>
        </button>
      </div>
    </div>
  );
}
