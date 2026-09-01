"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function LegacyKnowledgePage() {
  const router = useRouter();
  const { locale } = useLanguage();

  useEffect(() => {
    router.replace("/settings?tab=people");
  }, [router]);

  return (
    <div className="grid h-full place-items-center text-[12px] text-muted-foreground">
      <span className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {locale === "zh-CN" ? "正在打开人员设置…" : "Opening People settings…"}
      </span>
    </div>
  );
}
