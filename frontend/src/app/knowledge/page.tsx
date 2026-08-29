"use client";

import dynamic from "next/dynamic";
import { useLanguage } from "@/contexts/LanguageContext";
import { ProductPage, ProductPageContent, ProductPageHeader } from "@/components/layout/ProductPage";

const KnowledgeSettings = dynamic(() => import("@/components/KnowledgeSettings").then(module => module.KnowledgeSettings), {
  ssr: false,
  loading: () => (
    <div className="space-y-3">
      <div className="h-9 w-56 animate-pulse rounded-lg bg-muted" />
      <div className="h-[430px] animate-pulse rounded-xl bg-muted/55" />
    </div>
  ),
});

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
