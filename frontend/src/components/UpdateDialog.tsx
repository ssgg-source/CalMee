import React, { useEffect, useState } from 'react';
import { AlertCircle, Download, Loader2 } from 'lucide-react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { ProductButton } from './ui/ProductControls';
import type { UpdateInfo, UpdateProgress } from '@/services/updateService';
import { useLanguage } from '@/contexts/LanguageContext';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updateInfo: UpdateInfo | null;
}

export function UpdateDialog({ open, onOpenChange, updateInfo }: UpdateDialogProps) {
  const { locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);

  useEffect(() => {
    if (!open || !updateInfo?.available) {
      setIsDownloading(false);
      setProgress(null);
      setError(null);
      setUpdate(null);
      return;
    }

    setIsDownloading(false);
    setProgress(null);
    setError(null);
    void check()
      .then((updateResult) => {
        if (updateResult?.available) setUpdate(updateResult);
        else setError(zh ? '这个更新已不可用，请稍后重新检查。' : 'This update is no longer available. Check again later.');
      })
      .catch((nextError) => {
        reportTechnicalError('UpdateDialog.prepare', nextError);
        setError(toUserFacingError(nextError, locale).message);
      });
  }, [open, updateInfo, locale, zh]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isDownloading) return;
    onOpenChange(nextOpen);
  };

  const handleDownloadAndInstall = async () => {
    let updateToUse = update;
    if (!updateToUse) {
      try {
        const updateResult = await check();
        if (!updateResult?.available) {
          setError(zh ? '这个更新已不可用，请稍后重新检查。' : 'This update is no longer available. Check again later.');
          return;
        }
        updateToUse = updateResult;
        setUpdate(updateResult);
      } catch (nextError) {
        reportTechnicalError('UpdateDialog.check', nextError);
        setError(toUserFacingError(nextError, locale).message);
        return;
      }
    }

    setIsDownloading(true);
    setError(null);
    setProgress({ downloaded: 0, total: 0, percentage: 0 });
    try {
      let downloaded = 0;
      let contentLength = 0;
      await updateToUse.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength || 0;
          setProgress({ downloaded: 0, total: contentLength, percentage: 0 });
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength || 0;
          const percentage = contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0;
          setProgress({ downloaded, total: contentLength, percentage });
        } else if (event.event === 'Finished') {
          setProgress({ downloaded: contentLength, total: contentLength, percentage: 100 });
        }
      });

      toast.success(zh ? '更新已安装，CalMee 即将重新启动。' : 'Update installed. CalMee will restart now.');
      setIsDownloading(false);
      onOpenChange(false);
      await relaunch();
    } catch (nextError) {
      reportTechnicalError('UpdateDialog.install', nextError);
      const friendlyError = toUserFacingError(nextError, locale).message;
      setError(friendlyError);
      setIsDownloading(false);
      toast.error(zh ? '更新失败' : 'Update failed', { description: friendlyError });
    }
  };

  if (!updateInfo?.available) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[500px]"
        onEscapeKeyDown={(event) => isDownloading && event.preventDefault()}
        onInteractOutside={(event) => isDownloading && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isDownloading ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : error ? <AlertCircle className="h-5 w-5 text-destructive" /> : <Download className="h-5 w-5 text-primary" />}
            {isDownloading ? (zh ? '正在下载更新' : 'Downloading update') : error ? (zh ? '更新未完成' : 'Update not completed') : (zh ? '发现新版本' : 'Update available')}
          </DialogTitle>
          <DialogDescription>
            {isDownloading
              ? (zh ? '下载完成后 CalMee 会自动重新启动。' : 'CalMee will restart automatically after installation.')
              : error
                ? (zh ? '请关闭后稍后重新检查。' : 'Close this window and check again later.')
                : (zh ? `CalMee ${updateInfo.version} 已可安装。` : `CalMee ${updateInfo.version} is ready to install.`)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-3">
          {!isDownloading && !error && (
            <>
              <div className="overflow-hidden rounded-xl border border-border/70 bg-muted/25 text-[13px]">
                <VersionRow label={zh ? '当前版本' : 'Current version'} value={updateInfo.currentVersion} />
                <VersionRow label={zh ? '新版本' : 'New version'} value={updateInfo.version} accent />
                {updateInfo.date && <VersionRow label={zh ? '发布日期' : 'Release date'} value={formatDate(updateInfo.date, locale)} />}
              </div>
              {updateInfo.body && (
                <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border/70 bg-card p-4 text-[12px] leading-5 text-muted-foreground">
                  {updateInfo.body}
                </div>
              )}
            </>
          )}

          {isDownloading && progress && (
            <div className="space-y-2 rounded-xl border border-border/70 bg-muted/25 p-4">
              <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${Math.min(progress.percentage, 100)}%` }} />
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>{zh ? `已完成 ${Math.round(progress.percentage)}%` : `${Math.round(progress.percentage)}% complete`}</span>
                {progress.total > 0 && <span>{formatBytes(progress.downloaded)} / {formatBytes(progress.total)}</span>}
              </div>
            </div>
          )}

          {error && <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-[12px] text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          {!isDownloading && !error && (
            <>
              <ProductButton onClick={() => handleOpenChange(false)}>{zh ? '稍后' : 'Later'}</ProductButton>
              <ProductButton variant="primary" onClick={handleDownloadAndInstall}>
                <Download className="h-4 w-4" />
                {zh ? '下载并安装' : 'Download and install'}
              </ProductButton>
            </>
          )}
          {error && <ProductButton onClick={() => handleOpenChange(false)}>{zh ? '关闭' : 'Close'}</ProductButton>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionRow({ label, value, accent = false }: { label: string; value?: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 px-4 py-3 last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={accent ? 'font-semibold text-primary' : 'font-medium text-foreground'}>{value || '—'}</span>
    </div>
  );
}

function formatDate(dateString: string, locale: string) {
  try {
    return new Date(dateString).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
  } catch {
    return dateString;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round((bytes / 1024 ** index) * 100) / 100} ${units[index]}`;
}
