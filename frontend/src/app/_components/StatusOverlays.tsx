interface StatusOverlaysProps {
  // Status flags
  isProcessing: boolean;      // Processing transcription after recording stops
  isSaving: boolean;          // Saving transcript to database

  // Layout
  sidebarCollapsed: boolean;  // For responsive margin calculation
}

// Internal reusable component for individual status overlays
interface StatusOverlayProps {
  show: boolean;
  message: string;
  sidebarCollapsed: boolean;
}

function StatusOverlay({ show, message, sidebarCollapsed }: StatusOverlayProps) {
  if (!show) return null;

  return (
    <div className="fixed bottom-4 left-0 right-0 z-10">
      <div
        className="flex justify-center pl-8 transition-[margin] duration-300"
        style={{
          marginLeft: sidebarCollapsed ? '4rem' : '16rem'
        }}
      >
        <div className="w-2/3 max-w-[750px] flex justify-center">
          <div className="flex items-center gap-2.5 rounded-xl border border-border/80 bg-card/95 px-4 py-2.5 text-card-foreground shadow-[0_14px_36px_hsl(var(--foreground)/0.13)] backdrop-blur-xl">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-[13px] font-medium">{message}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Main exported component - renders multiple status overlays
export function StatusOverlays({
  isProcessing,
  isSaving,
  sidebarCollapsed
}: StatusOverlaysProps) {
  const { locale }=useLanguage();const zh=locale==='zh-CN';
  return (
    <>
      {/* Processing status overlay - shown after recording stops while finalizing transcription */}
      <StatusOverlay
        show={isProcessing}
        message={zh?'正在完成录音处理…':'Finalizing the recording…'}
        sidebarCollapsed={sidebarCollapsed}
      />

      {/* Saving status overlay - shown while saving transcript to database */}
      <StatusOverlay
        show={isSaving}
        message={zh?'正在保存会议内容…':'Saving meeting content…'}
        sidebarCollapsed={sidebarCollapsed}
      />
    </>
  );
}
import { Loader2 } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
