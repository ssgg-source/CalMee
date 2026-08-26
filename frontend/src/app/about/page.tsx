'use client';

import { About } from '@/components/About';
import { useLanguage } from '@/contexts/LanguageContext';
import { ProductPage, ProductPageContent, ProductPageHeader } from '@/components/layout/ProductPage';

export default function AboutPage() {
  const { t } = useLanguage();
  return (
    <ProductPage>
      <ProductPageHeader title={t('about.title')} description={t('about.eyebrow')} />
      <ProductPageContent className="max-w-4xl">
        <About />
      </ProductPageContent>
    </ProductPage>
  );
}
