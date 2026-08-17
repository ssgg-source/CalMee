'use client';

import { About } from '@/components/About';
import { useLanguage } from '@/contexts/LanguageContext';

export default function AboutPage() {
  const { t } = useLanguage();
  return <div className="h-screen overflow-y-auto bg-[#f8f7fb] px-8 pb-12 pt-8"><div className="mx-auto max-w-4xl"><p className="mb-2 text-sm font-medium text-violet-600">{t('about.eyebrow')}</p><h1 className="mb-6 text-3xl font-semibold tracking-tight text-slate-900">{t('about.title')}</h1><div className="overflow-hidden rounded-3xl border border-violet-100 bg-white shadow-sm"><About /></div></div></div>;
}
