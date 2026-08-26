'use client';

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { motion } from 'framer-motion';
import { RecordingControls } from '@/components/RecordingControls';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { StatusOverlays } from '@/app/_components/StatusOverlays';
import Analytics from '@/lib/analytics';
import { SettingsModals } from '@/app/_components/SettingsModal';
import { useModalState } from '@/hooks/useModalState';
import { useRecordingStateSync } from '@/hooks/useRecordingStateSync';
import { useRecordingStart } from '@/hooks/useRecordingStart';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useTranscriptRecovery } from '@/hooks/useTranscriptRecovery';
import { TranscriptRecovery } from '@/components/TranscriptRecovery';
import { indexedDBService } from '@/services/indexedDBService';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { openMeetingWorkspace } from '@/lib/meeting-window';
import { useLanguage } from '@/contexts/LanguageContext';
import { LiveMeetingNotes } from '@/components/LiveMeetingNotes';
import { hideRecordingOverlay, showRecordingOverlay } from '@/lib/recording-overlay';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CalendarDays, Check, Loader2, PictureInPicture2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

type RecordingCalendarEvent = {
  id: string;
  title: string;
  startAt: string;
  endAt?: string;
  calendarName?: string;
};

export default function RecordingPage() {
  const { t, locale } = useLanguage();
  // Local page state (not moved to contexts)
  const [isRecording, setIsRecordingState] = useState(false);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  const [notesSaved, setNotesSaved] = useState(true);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [nearbyEvents, setNearbyEvents] = useState<RecordingCalendarEvent[]>([]);
  const [linkedEvent, setLinkedEvent] = useState<RecordingCalendarEvent | null>(null);

  // Use contexts for state management
  const { meetingTitle, setMeetingTitle } = useTranscripts();
  const { transcriptModelConfig, selectedDevices } = useConfig();
  const recordingState = useRecordingState();
  const recordingActive = recordingState.isRecording || isRecording;

  // Extract status from global state
  const { status, isProcessing, isSaving } = recordingState;

  // Hooks
  const { hasMicrophone } = usePermissionCheck();
  const { setIsMeetingActive, refetchMeetings } = useSidebar();
  const { modals, messages, showModal, hideModal } = useModalState(transcriptModelConfig);
  const { isRecordingDisabled, setIsRecordingDisabled } = useRecordingStateSync(isRecording, setIsRecordingState, setIsMeetingActive);
  const { handleRecordingStart } = useRecordingStart(isRecording, setIsRecordingState, showModal);

  // Get handleRecordingStop function and setIsStopping (state comes from global context)
  const { handleRecordingStop, setIsStopping } = useRecordingStop(
    setIsRecordingState,
    setIsRecordingDisabled
  );

  // Recovery hook
  const {
    recoverableMeetings,
    isLoading: isLoadingRecovery,
    isRecovering,
    checkForRecoverableTranscripts,
    recoverMeeting,
    loadMeetingTranscripts,
    deleteRecoverableMeeting
  } = useTranscriptRecovery();

  const router = useRouter();

  useEffect(() => {
    // Track page view
    Analytics.trackPageView('recording');
  }, []);

  useEffect(() => {
    if (!calendarOpen) return;
    const now = Date.now();
    const start = new Date(now - 6 * 60 * 60 * 1000);
    const end = new Date(now + 12 * 60 * 60 * 1000);
    setCalendarLoading(true);
    void invoke<RecordingCalendarEvent[]>('api_get_calendar_events', {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
    }).then(events => {
      setNearbyEvents([...events]
        .sort((a, b) => Math.abs(new Date(a.startAt).getTime() - now) - Math.abs(new Date(b.startAt).getTime() - now))
        .slice(0, 5));
    }).catch(error => {
      reportTechnicalError('recording-calendar-events', error);
      toast.error(locale === 'zh-CN' ? '读取附近日程失败' : 'Could not load nearby events', {
        description: toUserFacingError(error, locale).message,
      });
      setNearbyEvents([]);
    }).finally(() => setCalendarLoading(false));
  }, [calendarOpen, locale]);

  const selectCalendarEvent = (event: RecordingCalendarEvent) => {
    setLinkedEvent(event);
    setMeetingTitle(event.title);
    sessionStorage.setItem('recording_calendar_event_id', event.id);
    setCalendarOpen(false);
  };

  useEffect(() => {
    if ([RecordingStatus.IDLE, RecordingStatus.COMPLETED, RecordingStatus.ERROR].includes(status)) {
      void hideRecordingOverlay().catch(() => undefined);
    }
  }, [status]);

  const enterFloatingMode = async () => {
    if (!recordingActive) return;
    try {
      await showRecordingOverlay();
      await getCurrentWindow().hide();
    } catch (error) {
      console.warn('Failed to enter floating recording mode:', error);
      toast.error(locale === 'zh-CN' ? '无法打开录音浮窗' : 'Could not open the recording overlay');
    }
  };

  // Startup recovery check
  useEffect(() => {
    const performStartupChecks = async () => {
      try {
        // Skip recovery check if currently recording or processing stop
        // This prevents the recovery dialog from showing when:
        if (recordingState.isRecording ||
          status === RecordingStatus.STOPPING ||
          status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
          status === RecordingStatus.SAVING) {
          console.log('Skipping recovery check - recording in progress or processing');
          return;
        }

        // 1. Clean up old meetings (7+ days)
        try {
          await indexedDBService.deleteOldMeetings(7);
        } catch (error) {
          console.warn('⚠️ Failed to clean up old meetings:', error);
        }

        // 2. Clean up saved meetings (24+ hours after save)
        try {
          await indexedDBService.deleteSavedMeetings(24);
        } catch (error) {
          console.warn('⚠️ Failed to clean up saved meetings:', error);
        }

        // 3. Always check for recoverable meetings on startup
        // Don't skip based on sessionStorage - we need to check every time
        await checkForRecoverableTranscripts();
      } catch (error) {
        console.error('Failed to perform startup checks:', error);
      }
    };

    performStartupChecks();
  }, [checkForRecoverableTranscripts, recordingState.isRecording, status]);

  // Watch for recoverable meetings changes and show dialog once per session
  useEffect(() => {
    if (recoverableMeetings.length === 0) {
      setShowRecoveryDialog(false);
      sessionStorage.removeItem('recovery_dialog_shown');
      return;
    }
    // Only show dialog if we have meetings and haven't shown it yet this session
    const shownThisSession = sessionStorage.getItem('recovery_dialog_shown');
    if (!shownThisSession) {
      setShowRecoveryDialog(true);
      sessionStorage.setItem('recovery_dialog_shown', 'true');
    }
  }, [recoverableMeetings]);

  // Handle recovery with toast notifications and navigation
  const handleRecovery = async (meetingId: string) => {
    try {
      const result = await recoverMeeting(meetingId);

      if (result.success) {
        toast.success(locale === 'zh-CN' ? '会议已恢复' : 'Meeting recovered', {
          description: result.audioRecoveryStatus?.status === 'success'
            ? (locale === 'zh-CN' ? '录音和文字已保存' : 'Audio and transcript were saved')
            : (locale === 'zh-CN' ? '可用内容已保存' : 'Available content was saved'),
          action: result.meetingId ? {
            label: locale === 'zh-CN' ? '查看会议' : 'View meeting',
            onClick: () => {
              void openMeetingWorkspace(result.meetingId!, url => router.push(url));
            }
          } : undefined,
          duration: 10000,
        });

        // Refresh sidebar to show the newly recovered meeting
        await refetchMeetings();

        sessionStorage.removeItem('recovery_dialog_shown');

        // Recovery restores and saves the interrupted recording, but remains
        // in the recording workspace. The user can explicitly open the saved
        // meeting from the toast when they are ready to review or transcribe.
      }
    } catch (error) {
      toast.error(locale === 'zh-CN' ? '恢复会议失败' : 'Failed to recover meeting', {
        description: locale === 'zh-CN'
          ? '未找到可恢复的文字或音频，请检查原录音文件。'
          : (error instanceof Error ? error.message : 'Unknown error occurred'),
      });
      throw error;
    }
  };

  // Handle dialog close - clear session flag if no meetings left
  const handleDialogClose = () => {
    setShowRecoveryDialog(false);
    // If user closes dialog and there are no more meetings, clear the flag
    // This allows the dialog to show again next session if new meetings appear
    if (recoverableMeetings.length === 0) {
      sessionStorage.removeItem('recovery_dialog_shown');
    }
  };

  // Computed values using global status
  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="calmee-page"
    >
      {/* All Modals supported*/}
      <SettingsModals
        modals={modals}
        messages={messages}
        onClose={hideModal}
      />

      {/* Recovery Dialog */}
      <TranscriptRecovery
        isOpen={showRecoveryDialog}
        onClose={handleDialogClose}
        recoverableMeetings={recoverableMeetings}
        onRecover={handleRecovery}
        onDelete={deleteRecoverableMeeting}
        onLoadPreview={loadMeetingTranscripts}
      />
      <header className="calmee-titlebar flex min-h-[76px] items-center justify-between gap-6 px-7 py-2.5">
        <div className="min-w-0 flex-1">
          <input
            value={meetingTitle === '+ New Call' ? '' : meetingTitle}
            onChange={(event) => {
              setMeetingTitle(event.target.value);
              if (linkedEvent) {
                setLinkedEvent(null);
                sessionStorage.removeItem('recording_calendar_event_id');
              }
            }}
            disabled={recordingState.isRecording}
            placeholder={t('recording.new')}
            aria-label={locale === 'zh-CN' ? '会议标题' : 'Meeting title'}
            className="w-full max-w-xl truncate border-0 bg-transparent p-0 text-[22px] font-semibold tracking-[-0.015em] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-100"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {notesSaved
              ? (locale === 'zh-CN' ? '已自动保存笔记' : 'Notes autosaved')
              : (locale === 'zh-CN' ? '正在保存笔记…' : 'Saving notes…')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-9 w-9 rounded-lg ${linkedEvent ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}
                title={linkedEvent
                  ? `${locale === 'zh-CN' ? '已关联' : 'Linked'}：${linkedEvent.title}`
                  : (locale === 'zh-CN' ? '关联附近的日程' : 'Link a nearby event')}
              >
                {linkedEvent ? <Check className="h-4 w-4" /> : <CalendarDays className="h-4 w-4" />}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 rounded-2xl p-2">
              {calendarLoading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />{locale === 'zh-CN' ? '正在读取日程…' : 'Loading events…'}</div>
              ) : nearbyEvents.length ? (
                <div className="space-y-1">
                  {nearbyEvents.map(event => (
                    <button key={event.id} type="button" onClick={() => selectCalendarEvent(event)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-violet-50">
                      <span className="w-11 shrink-0 text-xs font-medium tabular-nums text-violet-600">{new Date(event.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="min-w-0"><span className="block truncate text-sm font-medium text-slate-700">{event.title}</span><span className="block truncate text-[11px] text-slate-400">{event.calendarName || (locale === 'zh-CN' ? '本机日历' : 'Calendar')}</span></span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-slate-400">{locale === 'zh-CN' ? '附近没有日程' : 'No nearby events'}</div>
              )}
            </PopoverContent>
          </Popover>
          {status !== RecordingStatus.PROCESSING_TRANSCRIPTS &&
            status !== RecordingStatus.SAVING && (
              <RecordingControls
                isRecording={recordingActive}
                onRecordingStop={(callApi = true) => handleRecordingStop(callApi)}
                onRecordingStart={handleRecordingStart}
                onTranscriptReceived={() => { }}
                onStopInitiated={() => setIsStopping(true)}
                onTranscriptionError={(message) => {
                  showModal('errorAlert', message);
                }}
                isRecordingDisabled={isRecordingDisabled || (!hasMicrophone && !recordingState.isRecording)}
                isParentProcessing={isProcessingStop}
                selectedDevices={selectedDevices}
                meetingName={meetingTitle}
                onNotesOnlySaved={async () => {
                  await refetchMeetings();
                }}
              />
            )}
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-lg border-0 bg-transparent text-muted-foreground shadow-none hover:bg-muted hover:text-foreground"
            disabled={!recordingActive}
            onClick={() => void enterFloatingMode()}
            title={locale === 'zh-CN' ? '切换到悬浮录音' : 'Switch to floating recorder'}
          >
            <PictureInPicture2 className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <div className="relative flex-1 overflow-hidden bg-card">
        <div className="mx-auto flex h-full min-h-0 w-full max-w-[1440px]">
          <LiveMeetingNotes
            currentTime={recordingState.activeDuration || 0}
            onSaveStateChange={setNotesSaved}
          />
        </div>

        {/* Status Overlays - Processing and Saving */}
        <StatusOverlays
          isProcessing={status === RecordingStatus.PROCESSING_TRANSCRIPTS && !recordingState.isRecording}
          isSaving={status === RecordingStatus.SAVING}
          sidebarCollapsed={true}
        />
      </div>
    </motion.div>
  );
}
