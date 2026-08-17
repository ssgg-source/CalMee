import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  FileAudio,
  Clock,
  HardDrive,
  Minimize2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { toast } from 'sonner';
import { useImportAudio, ImportResult } from '@/hooks/useImportAudio';
import { useRouter } from 'next/navigation';
import { openMeetingWorkspace } from '@/lib/meeting-window';
import { useSidebar } from '../Sidebar/SidebarProvider';
import { useLanguage } from '@/contexts/LanguageContext';


interface ImportAudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedFile?: string | null;
  preselectedRecordedAt?: string | null;
  onComplete?: () => void;
}

const BACKGROUND_IMPORT_TOAST_ID = 'background-audio-import';

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function ImportAudioDialog({
  open,
  onOpenChange,
  preselectedFile,
  preselectedRecordedAt,
  onComplete,
}: ImportAudioDialogProps) {
  const router = useRouter();
  const { refetchMeetings } = useSidebar();
  const { t, locale } = useLanguage();
  const zh = locale === 'zh-CN';

  const importProgressMessage = useCallback((stage?: string) => {
    switch (stage) {
      case 'copying':
        return zh ? '正在复制原始录音…' : 'Copying the original recording…';
      case 'saving':
        return zh ? '正在创建会议…' : 'Creating the meeting…';
      case 'complete':
        return zh ? '录音导入完成' : 'Recording imported';
      default:
        return zh ? '正在准备录音…' : 'Preparing the recording…';
    }
  }, [zh]);

  const [title, setTitle] = useState('');
  const [titleModifiedByUser, setTitleModifiedByUser] = useState(false);
  const [transcribeAfterImport, setTranscribeAfterImport] = useState(false);
  const [refineAfterImport, setRefineAfterImport] = useState(false);
  const [smartRecordAfterImport, setSmartRecordAfterImport] = useState(false);

  // Always start as false — represents "dialog has not yet been opened".
  // Do NOT initialize from the `open` prop: if the component mounts with open=true
  // (e.g. drag-drop path), we still need the initialization effect to run.
  const prevOpenRef = useRef(false);
  const lastValidatedDropPathRef = useRef<string | null>(null);

  const handleImportComplete = useCallback((result: ImportResult) => {
    toast.dismiss(BACKGROUND_IMPORT_TOAST_ID);
    void refetchMeetings();
    onComplete?.();

    if (transcribeAfterImport) {
      window.sessionStorage.setItem(`calmee.import-workflow.${result.meeting_id}`, JSON.stringify({
        transcribe: true,
        refine: refineAfterImport,
        smartRecord: smartRecordAfterImport,
      }));
    }
    const recordedAt = result.recorded_at ? new Date(result.recorded_at) : null;
    const recordedText = recordedAt && !Number.isNaN(recordedAt.getTime())
      ? recordedAt.toLocaleString(zh ? 'zh-CN' : 'en-US')
      : (zh ? '录音时间待确认' : 'Recording time to be confirmed');
    const nextText = transcribeAfterImport
      ? (zh ? '进入会议后确认转写设置' : 'Confirm transcription settings in the meeting')
      : (zh ? '已保存原始录音' : 'Original recording saved');
    const completionDescription = `${recordedText} · ${formatDuration(result.duration_seconds)} · ${nextText}`;

    if (!open) {
      toast.success(zh ? '录音导入完成' : 'Recording imported', {
        description: completionDescription,
        duration: 10000,
        action: {
          label: t('import.openMeeting'),
          onClick: () => void openMeetingWorkspace(result.meeting_id, url => router.push(url), { title: result.title || title || undefined }),
        },
      });
      return;
    }

    toast.success(zh ? '录音导入完成' : 'Recording imported', { description: completionDescription });
    onOpenChange(false);
    void openMeetingWorkspace(result.meeting_id, url => router.push(url), { title: result.title || title || undefined });
  }, [open, router, refetchMeetings, onComplete, onOpenChange, title, t, zh, transcribeAfterImport, refineAfterImport, smartRecordAfterImport]);

  const handleImportError = useCallback((error: string) => {
    toast.dismiss(BACKGROUND_IMPORT_TOAST_ID);
    toast.error(zh ? '录音导入失败' : 'Recording import failed', { description: error });
  }, [zh]);

  const {
    status,
    fileInfo,
    progress,
    error,
    isProcessing,
    selectFile,
    validateFile,
    startImport,
    cancelImport,
    reset,
  } = useImportAudio({
    onComplete: handleImportComplete,
    onError: handleImportError,
  });

  // Reset state only when dialog transitions from closed to open
  // This prevents re-initialization when config changes while dialog is already open (Bug #4 & #5)
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    // Only initialize when transitioning from closed (false) to open (true)
    if (open && !wasOpen && !isProcessing) {
      reset();
      setTitle('');
      setTitleModifiedByUser(false);
      setTranscribeAfterImport(false);
      setRefineAfterImport(false);
      setSmartRecordAfterImport(false);
    }
  }, [open, isProcessing, preselectedFile, reset]);

  // A file can be dropped while this dialog is already open. In that case
  // `open` does not transition and the initialization effect above will not
  // run, so react explicitly to every newly dropped path.
  useEffect(() => {
    if (!open) {
      lastValidatedDropPathRef.current = null;
      return;
    }
    if (!preselectedFile || preselectedFile === lastValidatedDropPathRef.current) return;
    lastValidatedDropPathRef.current = preselectedFile;
    void validateFile(preselectedFile).then((info) => {
      if (!info) return;
      setTitle(info.filename);
      setTitleModifiedByUser(false);
    });
  }, [open, preselectedFile, validateFile]);

  // When the dialog is sent to the background, keep one live progress toast.
  // The import hook stays mounted at layout level, so closing the dialog never
  // interrupts the native ASR job or its event listeners.
  useEffect(() => {
    if (!open && isProcessing) {
      const percentage = Math.round(progress?.progress_percentage ?? 0);
      toast.loading(t('import.backgroundTitle'), {
        id: BACKGROUND_IMPORT_TOAST_ID,
        description: `${importProgressMessage(progress?.stage)} — ${percentage}%`,
        duration: Infinity,
        action: { label: t('import.viewProgress'), onClick: () => onOpenChange(true) },
      });
    } else if (open) {
      toast.dismiss(BACKGROUND_IMPORT_TOAST_ID);
    }
  }, [open, isProcessing, progress, onOpenChange, t, importProgressMessage]);

  // Update title when fileInfo changes
  useEffect(() => {
    if (fileInfo && !title && !titleModifiedByUser) {
      setTitle(fileInfo.filename);
    }
  }, [fileInfo, title, titleModifiedByUser]);

  const handleSelectFile = async () => {
    const info = await selectFile();
    if (info) {
      setTitle(info.filename);
    }
  };

  const handleStartImport = async () => {
    if (!fileInfo) return;

    await startImport(
      fileInfo.path,
      title || fileInfo.filename,
      false,
      preselectedRecordedAt || fileInfo.recorded_at || null,
    );
  };

  const handleCancel = async () => {
    if (isProcessing) {
      await cancelImport();
      toast.info(zh ? '已取消导入' : 'Import cancelled');
    }
    onOpenChange(false);
  };

  const handleRunInBackground = () => {
    onOpenChange(false);
  };

  // Closing a processing dialog sends it to the background. Cancellation is
  // intentionally a separate explicit action.
  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen);
  };

  const handleInteractOutside = (event: Event) => {
    if (isProcessing) {
      event.preventDefault();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="w-[calc(100vw-2rem)] min-w-0 overflow-hidden sm:max-w-[500px]"
        onInteractOutside={handleInteractOutside}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isProcessing ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                {zh ? '正在导入录音…' : 'Importing recording…'}
              </>
            ) : error ? (
              <>
                <AlertCircle className="h-5 w-5 text-red-600" />
                {zh ? '导入失败' : 'Import failed'}
              </>
            ) : status === 'complete' ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                {zh ? '导入完成' : 'Import complete'}
              </>
            ) : (
              <>
                <Upload className="h-5 w-5 text-blue-600" />
                {zh ? '导入录音文件' : 'Import audio file'}
              </>
            )}
          </DialogTitle>
          <DialogDescription className="break-words pr-6 [overflow-wrap:anywhere]">
            {isProcessing
              ? importProgressMessage(progress?.stage)
              : error
              ? (zh ? '导入录音时发生错误' : 'An error occurred while importing')
              : (zh ? '选择录音和导入后的处理步骤。' : 'Choose a recording and the next steps.')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4 py-4">
          {/* File selection / info */}
          {!isProcessing && !error && (
            <>
              {fileInfo ? (
                <div className="min-w-0 space-y-3 overflow-hidden rounded-lg bg-gray-50 p-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <FileAudio className="h-8 w-8 text-blue-600 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="block max-w-full truncate font-medium text-gray-900" title={fileInfo.filename}>{fileInfo.filename}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          {formatDuration(fileInfo.duration_seconds)}
                        </span>
                        <span className="flex items-center gap-1">
                          <HardDrive className="h-3.5 w-3.5" />
                          {formatFileSize(fileInfo.size_bytes)}
                        </span>
                        <span className="text-blue-600 font-medium">{fileInfo.format}</span>
                        {(preselectedRecordedAt || fileInfo.recorded_at) && (
                          <span className="basis-full text-xs text-slate-400">
                            {zh ? '录音时间：' : 'Recorded: '}
                            {new Date(preselectedRecordedAt || fileInfo.recorded_at!).toLocaleString(zh ? 'zh-CN' : 'en-US')}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Editable title */}
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-700">{zh ? '会议名称' : 'Meeting title'}</label>
                    <Input
                      value={title}
                      className="min-w-0"
                      onChange={(e) => {
                        setTitle(e.target.value);
                        setTitleModifiedByUser(true);
                      }}
                      placeholder={zh ? '输入会议名称' : 'Enter meeting title'}
                    />
                  </div>

                  <Button variant="outline" size="sm" onClick={handleSelectFile} className="w-full">
                    {zh ? '选择其他文件' : 'Choose another file'}
                  </Button>
                </div>
              ) : (
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                  <FileAudio className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <Button onClick={handleSelectFile} disabled={status === 'validating'}>
                    {status === 'validating' ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {zh ? '正在检查…' : 'Validating…'}
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        {zh ? '选择录音文件' : 'Select audio file'}
                      </>
                    )}
                  </Button>
                  <p className="text-sm text-gray-500 mt-2">MP4, WAV, MP3, FLAC, OGG, MKV, WebM, WMA</p>
                </div>
              )}

              {fileInfo && (
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <label className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                    <span>{zh ? '转文字稿' : 'Transcribe audio'}</span>
                    <Switch checked={transcribeAfterImport} onCheckedChange={(checked) => {
                      setTranscribeAfterImport(checked);
                      if (!checked) { setRefineAfterImport(false); setSmartRecordAfterImport(false); }
                    }} />
                  </label>
                  <label className={`flex items-center justify-between gap-4 border-t border-slate-100 px-4 py-3 text-sm ${transcribeAfterImport ? '' : 'text-slate-400'}`}>
                    <span>{zh ? 'AI 优化文字稿' : 'Optimize transcript with AI'}</span>
                    <Switch checked={refineAfterImport} disabled={!transcribeAfterImport} onCheckedChange={setRefineAfterImport} />
                  </label>
                  <label className={`flex items-center justify-between gap-4 border-t border-slate-100 px-4 py-3 text-sm ${transcribeAfterImport ? '' : 'text-slate-400'}`}>
                    <span>{zh ? '生成智能记录' : 'Generate smart record'}</span>
                    <Switch checked={smartRecordAfterImport} disabled={!transcribeAfterImport} onCheckedChange={setSmartRecordAfterImport} />
                  </label>
                </div>
              )}
            </>
          )}

          {/* Progress display */}
          {isProcessing && progress && (
            <div className="space-y-2">
              <div className="relative">
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className="bg-blue-600 h-3 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(progress.progress_percentage, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-gray-600 mt-1">
                  <span>{importProgressMessage(progress.stage)}</span>
                  <span>{Math.round(progress.progress_percentage)}%</span>
                </div>
              </div>
              <p className="break-words text-center text-sm text-muted-foreground [overflow-wrap:anywhere]">{importProgressMessage(progress.stage)}</p>
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="break-words text-sm text-red-800 [overflow-wrap:anywhere]">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {!isProcessing && !error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button
                onClick={handleStartImport}
                className="bg-blue-600 hover:bg-blue-700"
                disabled={!fileInfo}
              >
                <Upload className="h-4 w-4 mr-2" />
                {transcribeAfterImport ? (zh ? '导入并继续' : 'Import and continue') : (zh ? '导入并打开' : 'Import and open')}
              </Button>
            </>
          )}
          {isProcessing && (
            <>
              <Button variant="outline" onClick={handleRunInBackground}>
                <Minimize2 className="h-4 w-4 mr-2" />
                {t('import.runBackground')}
              </Button>
              <Button variant="outline" onClick={handleCancel} className="text-red-600 hover:text-red-700">
                <X className="h-4 w-4 mr-2" />
                {t('import.cancelTask')}
              </Button>
            </>
          )}
          {error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {zh ? '关闭' : 'Close'}
              </Button>
              <Button onClick={reset} variant="outline">
                {zh ? '重试' : 'Try again'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
