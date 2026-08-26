'use client';

import { FileAudio, FolderOpen, UploadCloud } from 'lucide-react';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { ProductPage, ProductPageContent, ProductPageHeader } from '@/components/layout/ProductPage';

export default function UploadPage() {
  const { openImportDialog } = useImportDialog();
  const { t } = useLanguage();
  return (
    <ProductPage>
      <ProductPageHeader title={t('upload.title')} description={t('upload.description')} />
      <ProductPageContent className="flex px-7 pb-12 pt-6">
        <div className="mx-auto flex w-full max-w-[1040px] flex-1">
        <button onClick={() => openImportDialog()} className="group flex min-h-[420px] flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-primary/35 bg-card p-12 text-center shadow-surface transition duration-200 hover:border-primary/60 hover:bg-primary/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-[0.995]">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary transition duration-200 group-hover:-translate-y-0.5"><UploadCloud className="h-6 w-6" /></div>
          <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-foreground">{t('upload.choose')}</h2><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t('upload.help')}</p>
          <div className="mt-7 flex items-center gap-4 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><FileAudio className="h-3.5 w-3.5" />{t('upload.media')}</span><span className="h-3 w-px bg-border"/><span className="flex items-center gap-1.5"><FolderOpen className="h-3.5 w-3.5" />{t('upload.local')}</span></div>
        </button>
        </div>
      </ProductPageContent>
    </ProductPage>
  );
}
