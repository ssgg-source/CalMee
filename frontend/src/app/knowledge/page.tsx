"use client";

import { Database } from "lucide-react";
import { KnowledgeSettings } from "@/components/KnowledgeSettings";
import { useLanguage } from "@/contexts/LanguageContext";

export default function KnowledgePage() {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  return (
    <div className="h-screen overflow-y-auto bg-[#f5f5f7] px-6 pb-12 pt-5 text-slate-900">
      <div className="mx-auto max-w-[1120px]">
        <header className="mb-4 flex items-center">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-slate-600 shadow-sm ring-1 ring-black/[0.07]">
              <Database className="h-4 w-4" />
            </span>
            <div>
              <h1 className="text-[20px] font-semibold tracking-[-0.02em]">
                {zh ? "数据" : "Data"}
              </h1>
            </div>
          </div>
        </header>
        <KnowledgeSettings />
      </div>
    </div>
  );
}
