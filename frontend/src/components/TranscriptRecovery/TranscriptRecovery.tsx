/**
 * TranscriptRecovery Component
 *
 * Modal dialog for recovering interrupted meetings from IndexedDB.
 * Displays recoverable meetings, allows preview, and enables recovery or deletion.
 */

import React, { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import { AlertCircle, CheckCircle2, Clock, FileText, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ProductConfirmDialog } from '@/components/ui/ProductConfirmDialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { MeetingMetadata, StoredTranscript } from '@/services/indexedDBService';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';

interface TranscriptRecoveryProps {
  isOpen: boolean;
  onClose: () => void;
  recoverableMeetings: MeetingMetadata[];
  onRecover: (meetingId: string) => Promise<any>;
  onDelete: (meetingId: string) => Promise<void>;
  onLoadPreview: (meetingId: string) => Promise<StoredTranscript[]>;
}

export function TranscriptRecovery({
  isOpen,
  onClose,
  recoverableMeetings,
  onRecover,
  onDelete,
  onLoadPreview,
}: TranscriptRecoveryProps) {
  const { locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [previewTranscripts, setPreviewTranscripts] = useState<StoredTranscript[]>([]);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  // Reset selection when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedMeetingId(null);
      setPreviewTranscripts([]);
      setOperationError(null);
    }
  }, [isOpen]);

  // Auto-select first meeting if available
  useEffect(() => {
    if (isOpen && recoverableMeetings.length > 0 && !selectedMeetingId) {
      handleMeetingSelect(recoverableMeetings[0].meetingId);
    }
  }, [isOpen, recoverableMeetings]);

  const handleMeetingSelect = async (meetingId: string) => {
    setSelectedMeetingId(meetingId);
    setIsLoadingPreview(true);

    try {
      const transcripts = await onLoadPreview(meetingId);
      // Limit to first 10 for preview
      setPreviewTranscripts(transcripts.slice(0, 10));
    } catch (error) {
      console.error('Failed to load preview:', error);
      setPreviewTranscripts([]);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleRecover = async () => {
    if (!selectedMeetingId) return;

    setIsRecovering(true);
    setOperationError(null);
    try {
      const result = await onRecover(selectedMeetingId);
      console.log('Recovery successful:', result);
      onClose();
    } catch (error) {
      console.error('Recovery failed:', error);
      setOperationError(zh
        ? '未能恢复这条录音。请确认音频检查点仍然存在后重试。'
        : (error instanceof Error ? error.message : 'Recovery failed. Please try again.'));
    } finally {
      setIsRecovering(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedMeetingId) return;

    setIsDeleting(true);
    try {
      await onDelete(selectedMeetingId);
      setSelectedMeetingId(null);
      setPreviewTranscripts([]);
      setDeleteConfirmOpen(false);
    } catch (error) {
      console.error('Delete failed:', error);
      setOperationError(zh
        ? '删除失败，请重试。'
        : (error instanceof Error ? error.message : 'Delete failed. Please try again.'));
    } finally {
      setIsDeleting(false);
    }
  };

  const selectedMeeting = recoverableMeetings.find(m => m.meetingId === selectedMeetingId);

  return (
    <>
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !isRecovering && !isDeleting) onClose(); }}>
      <DialogContent className="flex h-[min(680px,78vh)] max-w-[860px] flex-col overflow-hidden rounded-[22px] border-black/[0.08] bg-[#fbfbfd] p-0 shadow-2xl">
        <DialogHeader className="border-b border-black/[0.06] bg-white px-6 pb-5 pt-6">
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><RotateCcw className="h-4 w-4" /></span>
            {zh ? '恢复中断的会议' : 'Recover Interrupted Meetings'}
          </DialogTitle>
          <DialogDescription className="pl-10 text-[13px] leading-5 text-slate-500">
            {zh ? `发现 ${recoverableMeetings.length} 条尚未保存的录音。选择一条查看并恢复。` : `Found ${recoverableMeetings.length} unsaved recording${recoverableMeetings.length === 1 ? '' : 's'}. Select one to preview and recover.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-4 px-6 py-5">
          {/* Meeting List */}
          <div className="w-1/3 flex flex-col">
            <h3 className="mb-2 text-xs font-medium text-slate-500">{zh ? '中断的录音' : 'Interrupted recordings'}</h3>
            <ScrollArea className="flex-1 rounded-2xl border border-black/[0.07] bg-white">
              <div className="p-2 space-y-2">
                {recoverableMeetings.map((meeting) => (
                  <button
                    key={meeting.meetingId}
                    onClick={() => handleMeetingSelect(meeting.meetingId)}
                    className={cn(
                      'w-full rounded-xl border p-3 text-left transition-colors',
                      selectedMeetingId === meeting.meetingId
                        ? 'border-violet-300 bg-violet-50/80'
                        : 'border-transparent hover:bg-slate-50'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{meeting.title}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                          <Clock className="w-3 h-3" />
                          {formatDistanceToNow(new Date(meeting.lastUpdated), { addSuffix: true, locale: zh ? zhCN : enUS })}
                        </p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                          <FileText className="w-3 h-3" />
                          {zh ? `${meeting.transcriptCount} 段文字` : `${meeting.transcriptCount} transcript${meeting.transcriptCount === 1 ? '' : 's'}`}
                        </p>
                      </div>
                      {meeting.folderPath ? (
                        <span title={zh ? '有可恢复音频' : 'Audio available'}>
                          <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                        </span>
                      ) : (
                        <span title={zh ? '没有音频检查点' : 'No audio checkpoint'}>
                          <AlertCircle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Preview Panel */}
          <div className="flex-1 flex flex-col">
            <h3 className="mb-2 text-xs font-medium text-slate-500">{zh ? '预览' : 'Preview'}</h3>
            <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-black/[0.07] bg-white">
              {selectedMeeting ? (
                <>
                  {/* Meeting Info */}
                  <div className="border-b border-black/[0.06] bg-slate-50/70 p-4">
                    <h4 className="font-semibold">{selectedMeeting.title}</h4>
                    <p className="text-sm text-muted-foreground mt-1">
                      {zh ? '开始于 ' : 'Started '}{new Date(selectedMeeting.startTime).toLocaleString(zh ? 'zh-CN' : 'en-US')}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-sm">
                      <span className="flex items-center gap-1">
                        <FileText className="w-4 h-4" />
                        {zh ? `${selectedMeeting.transcriptCount} 段文字` : `${selectedMeeting.transcriptCount} transcripts`}
                      </span>
                      {selectedMeeting.folderPath ? (
                        <span className="flex items-center gap-1 text-green-600">
                          <CheckCircle2 className="w-4 h-4" />
                          {zh ? '有可恢复音频' : 'Audio available'}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-yellow-600">
                          <AlertCircle className="w-4 h-4" />
                          {zh ? '没有音频检查点' : 'No audio checkpoint'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Transcript Preview */}
                  <ScrollArea className="flex-1 p-4">
                    {isLoadingPreview ? (
                      <div className="flex items-center justify-center h-full text-muted-foreground">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />{zh ? '正在载入预览…' : 'Loading preview…'}
                      </div>
                    ) : previewTranscripts.length > 0 ? (
                      <div className="space-y-3">
                        <Alert>
                          <AlertDescription>
                            {zh ? `显示前 ${previewTranscripts.length} 段，共 ${selectedMeeting.transcriptCount} 段` : `Showing the first ${previewTranscripts.length} of ${selectedMeeting.transcriptCount} transcript segments`}
                          </AlertDescription>
                        </Alert>
                        {previewTranscripts.map((transcript, index) => {
                          // Handle different timestamp formats
                          const getTimestamp = () => {
                            if (!transcript.timestamp) return '--:--';
                            try {
                              const date = new Date(transcript.timestamp);
                              if (isNaN(date.getTime())) {
                                // If timestamp is invalid, try audio_start_time
                                if (transcript.audio_start_time !== undefined) {
                                  const totalSecs = Math.floor(transcript.audio_start_time);
                                  const mins = Math.floor(totalSecs / 60);
                                  const secs = totalSecs % 60;
                                  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                                }
                                return '--:--';
                              }
                              return date.toLocaleTimeString();
                            } catch {
                              return '--:--';
                            }
                          };

                          return (
                            <div key={index} className="text-sm">
                              <span className="text-muted-foreground">[{getTimestamp()}]</span>{' '}
                              <span>{transcript.text}</span>
                            </div>
                          );
                        })}
                        {selectedMeeting.transcriptCount > 10 && (
                          <p className="text-sm text-muted-foreground italic">
                            {zh ? `…另有 ${selectedMeeting.transcriptCount - 10} 段` : `…and ${selectedMeeting.transcriptCount - 10} more segments`}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center justify-center h-full text-muted-foreground">
                        {selectedMeeting.folderPath
                          ? (zh ? '没有实时字幕，但可以恢复录音文件。' : 'No live transcript, but the audio can still be recovered.')
                          : (zh ? '没有可预览的文字' : 'No transcript to preview')}
                      </div>
                    )}
                  </ScrollArea>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  {zh ? '选择一条录音进行预览' : 'Select a recording to preview'}
                </div>
              )}
            </div>
          </div>
        </div>

        {operationError && <div className="mx-6 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700">{operationError}</div>}
        <DialogFooter className="border-t border-black/[0.06] bg-white px-6 py-4">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isRecovering || isDeleting}
          >
            {zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant="destructive"
            onClick={() => setDeleteConfirmOpen(true)}
            disabled={!selectedMeetingId || isRecovering || isDeleting}
          >
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {zh ? '正在删除…' : 'Deleting…'}
              </>
            ) : (
              <>
                <Trash2 className="w-4 h-4 mr-2" />
                {zh ? '删除' : 'Delete'}
              </>
            )}
          </Button>
          <Button
            onClick={handleRecover}
            disabled={!selectedMeetingId || isRecovering || isDeleting}
          >
            {isRecovering ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {zh ? '正在恢复…' : 'Recovering…'}
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4 mr-2" />
                {zh ? '恢复' : 'Recover'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <ProductConfirmDialog
      open={deleteConfirmOpen}
      onOpenChange={setDeleteConfirmOpen}
      title={zh ? '删除中断录音' : 'Delete interrupted recording'}
      description={zh
        ? '这条中断录音及其恢复检查点将被删除，此操作无法撤销。'
        : 'This interrupted recording and its recovery checkpoint will be deleted. This cannot be undone.'}
      confirmLabel={zh ? '确认删除' : 'Delete'}
      cancelLabel={zh ? '取消' : 'Cancel'}
      destructive
      loading={isDeleting}
      onConfirm={handleDelete}
    />
    </>
  );
}
