'use client';

import { Languages } from 'lucide-react';
import { useLanguage, type AppLocale } from '@/contexts/LanguageContext';
import { SettingsSection } from '@/components/layout/ProductPage';
import { ProductSelect } from '@/components/ui/ProductControls';

export function InterfaceLanguageSettings() {
  const { locale, setLocale, t } = useLanguage();

  return (
    <SettingsSection>
      <div className="flex items-center justify-between gap-6">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary"><Languages className="h-4 w-4" /></div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-foreground">{t('language.settingTitle')}</h3>
            <p className="mt-1 max-w-xl text-[12px] leading-5 text-muted-foreground">{t('language.settingDescription')}</p>
          </div>
        </div>
        <ProductSelect
          aria-label={t('language.settingTitle')}
          value={locale}
          onChange={event => setLocale(event.target.value as AppLocale)}
          className="min-w-44"
        >
          <option value="en">{t('language.english')}</option>
          <option value="zh-CN">{t('language.chinese')}</option>
        </ProductSelect>
      </div>
    </SettingsSection>
  );
}
