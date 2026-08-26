import React from 'react';
import { Upload } from 'lucide-react';
import { getAudioFormatsDisplayList } from '@/constants/audioFormats';
import { useLanguage } from '@/contexts/LanguageContext';

interface ImportDropOverlayProps {
  visible: boolean;
}

export function ImportDropOverlay({ visible }: ImportDropOverlayProps) {
  const { locale } = useLanguage();
  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 backdrop-blur-sm
                 flex items-center justify-center pointer-events-none
                 transition-opacity duration-200"
    >
      <div className="min-w-[360px] rounded-2xl border border-primary/25 bg-card/95 p-10 text-center shadow-2xl ring-1 ring-white/40 transition-transform">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
          <Upload className="h-7 w-7" />
        </div>
        <p className="text-[16px] font-semibold text-foreground">
          {locale === 'zh-CN' ? '松开即可导入录音' : 'Drop to import recording'}
        </p>
        <p className="mt-2 text-[12px] text-muted-foreground">{getAudioFormatsDisplayList()}</p>
      </div>
    </div>
  );
}
