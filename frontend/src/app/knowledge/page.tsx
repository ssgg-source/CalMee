"use client";

import { KnowledgeSettings } from "@/components/KnowledgeSettings";
import { useLanguage } from "@/contexts/LanguageContext";
import { ProductPage, ProductPageContent, ProductPageHeader } from "@/components/layout/ProductPage";

export default function KnowledgePage() {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  return (
    <ProductPage>
      <ProductPageHeader
        title={zh ? "数据" : "Data"}
        description={zh ? "管理人员、声纹和转写词库" : "Manage people, voiceprints, and transcription vocabulary"}
      />
      <ProductPageContent className="px-7 pb-12 pt-5">
        <div className="mx-auto max-w-[1180px]">
          <KnowledgeSettings />
        </div>
      </ProductPageContent>
    </ProductPage>
  );
}
