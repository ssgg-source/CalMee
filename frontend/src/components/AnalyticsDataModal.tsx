'use client';

import { Info, ShieldCheck } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ProductButton } from '@/components/ui/ProductControls';

interface AnalyticsDataModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirmDisable: () => void;
}

export default function AnalyticsDataModal({ isOpen, onClose, onConfirmDisable }: AnalyticsDataModalProps) {
  const { locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const categories = zh ? [
    ['模型偏好', '转写模型、总结模型及模型服务商。'],
    ['匿名会议指标', '录音与暂停时长、文字段数和处理的音频块数量。'],
    ['设备类型', '仅区分蓝牙、有线或未知，不收集具体设备名称。'],
    ['功能使用情况', '应用启动、会话时长、功能使用和错误出现次数。'],
    ['平台信息', '操作系统、应用版本和处理器架构。'],
  ] : [
    ['Model preferences', 'Transcription and summary models, plus the selected provider.'],
    ['Anonymous meeting metrics', 'Recording and pause duration, transcript segment count, and audio chunks processed.'],
    ['Device types', 'Bluetooth, wired, or unknown only. Specific device names are never collected.'],
    ['Feature usage', 'App sessions, feature usage, session duration, and error occurrences.'],
    ['Platform information', 'Operating system, app version, and processor architecture.'],
  ];
  const excluded = zh
    ? ['会议名称或标题', '文件名、文件路径和会议文件夹', '录音、文字稿或会议内容', '具体设备名称', '个人信息或可识别数据']
    : ['Meeting names or titles', 'File names, paths, or meeting folders', 'Recordings, transcripts, or meeting content', 'Specific device names', 'Personal or identifiable information'];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-6 pb-4 pt-5">
          <span className="mb-1 grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/10 text-emerald-700"><ShieldCheck className="h-4 w-4" /></span>
          <DialogTitle>{zh ? '使用情况分析会收集什么' : 'What usage analytics collects'}</DialogTitle>
          <DialogDescription>{zh ? '分析功能默认关闭；启用后只发送匿名的产品与性能数据。' : 'Analytics is off by default. When enabled, it sends anonymous product and performance data only.'}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="flex gap-3 rounded-lg bg-emerald-500/8 px-3.5 py-3 text-[13px] leading-5 text-emerald-900">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
            <p>{zh ? 'CalMee 不收集会议内容、姓名、文件路径或个人信息。以下数据只用于判断兼容性、性能和功能使用情况。' : 'CalMee does not collect meeting content, names, file paths, or personal information. The data below is used only to understand compatibility, performance, and feature usage.'}</p>
          </div>

          <section>
            <h3 className="text-xs font-semibold text-foreground">{zh ? '启用后收集' : 'Collected when enabled'}</h3>
            <div className="mt-2 divide-y divide-border/60 rounded-xl bg-muted/35 px-4">
              {categories.map(([title, description], index) => (
                <div key={title} className="grid grid-cols-[24px_1fr] gap-2.5 py-3">
                  <span className="font-mono text-[11px] text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                  <div><div className="text-[13px] font-medium text-foreground">{title}</div><div className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{description}</div></div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-foreground">{zh ? '明确不收集' : 'Never collected'}</h3>
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {excluded.map((item) => <li key={item} className="rounded-lg bg-destructive/6 px-3 py-2 text-[12px] text-foreground">{item}</li>)}
            </ul>
          </section>

          <details className="rounded-lg border border-border/70 px-3.5 py-3 text-xs">
            <summary className="cursor-pointer font-medium text-foreground">{zh ? '查看匿名事件示例' : 'View an anonymous event example'}</summary>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-muted/55 p-3 font-mono text-[10px] leading-4 text-muted-foreground">{`{
  "event": "meeting_ended",
  "app_version": "${process.env.NEXT_PUBLIC_APP_VERSION ?? 'development'}",
  "transcription_provider": "parakeet",
  "summary_provider": "ollama",
  "total_duration_seconds": "125.5",
  "microphone_device_type": "Wired",
  "chunks_processed": "150",
  "had_fatal_error": "false"
}`}</pre>
          </details>
        </div>

        <DialogFooter className="mx-6 mb-5 sm:justify-between">
          <ProductButton onClick={onClose}>{zh ? '保持启用' : 'Keep enabled'}</ProductButton>
          <ProductButton variant="danger" onClick={onConfirmDisable}>{zh ? '关闭使用情况分析' : 'Disable analytics'}</ProductButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
