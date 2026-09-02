'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { invoke } from '@/lib/data-invoke';
import { RecordingControls } from '@/components/RecordingControls';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { StatusOverlays } from '@/app/_components/StatusOverlays';
import Analytics from '@/lib/analytics';
import { useModalState } from '@/hooks/useModalState';
import { useRecordingStateSync } from '@/hooks/useRecordingStateSync';
import { useRecordingStart } from '@/hooks/useRecordingStart';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useTranscriptRecovery } from '@/hooks/useTranscriptRecovery';
import { indexedDBService } from '@/services/indexedDBService';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { openMeetingWorkspace } from '@/lib/meeting-window';
import { useLanguage } from '@/contexts/LanguageContext';
import { hideRecordingOverlay, showRecordingOverlay } from '@/lib/recording-overlay';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CalendarDays, Check, Loader2, PictureInPicture2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CalendarLinkDialog, type LinkedCalendarEvent } from '@/components/MeetingWorkspace/CalendarLinkDialog';
import { attachRecordingCalendar, readRecordingCalendarSelection, selectRecordingCalendar } from '@/lib/recording-calendar';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';
import { clearLiveMeetingNotes, hasMeaningfulLiveMeetingNotes, readLiveMeetingNotes, writeLiveMeetingNotes, LIVE_MEETING_NOTES_EVENT } from '@/lib/live-meeting-notes';

const SettingsModals = dynamic(() => import('@/app/_components/SettingsModal').then(module => module.SettingsModals), { ssr: false });
const TranscriptRecovery = dynamic(() => import('@/components/TranscriptRecovery').then(module => module.TranscriptRecovery), { ssr: false });
const LiveMeetingNotes = dynamic(() => import('@/components/LiveMeetingNotes').then(module => module.LiveMeetingNotes), {
  ssr: false,
  loading: () => <div className="mx-7 my-6 h-[calc(100%-3rem)] flex-1 animate-pulse rounded-2xl bg-muted/55" />,
});

export default function RecordingPage() {
  const { t, locale } = useLanguage();
  // Local page state (not moved to contexts)
  const [isRecording, setIsRecordingState] = useState(false);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  const [notesSaved, setNotesSaved] = useState(true);
  const [notesAutoSave, setNotesAutoSave] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('calmee.live-meeting-notes.auto-save') !== 'false';
  });
  const [savingNotesOnly, setSavingNotesOnly] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [linkedEvent, setLinkedEvent] = useState<LinkedCalendarEvent | null>(()=>readRecordingCalendarSelection());
  useEffect(()=>{const sync=()=>setLinkedEvent(readRecordingCalendarSelection());window.addEventListener(LIVE_MEETING_NOTES_EVENT,sync);return()=>window.removeEventListener(LIVE_MEETING_NOTES_EVENT,sync);},[]);

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

  const selectCalendarEvent = (event: LinkedCalendarEvent | null) => {
    setLinkedEvent(event);
    selectRecordingCalendar(event);
    if (event && (!meetingTitle.trim() || meetingTitle === '+ New Call')) setMeetingTitle(event.title);
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

  const saveNotesOnly = async (markdown?: string) => {
    if (savingNotesOnly) return;
    if (markdown != null) writeLiveMeetingNotes(markdown);
    const draft = markdown == null
      ? readLiveMeetingNotes()
      : { ...readLiveMeetingNotes(), markdown };
    if (!hasMeaningfulLiveMeetingNotes(draft.markdown)) {
      toast.info(locale === 'zh-CN' ? '写下内容后再保存' : 'Add some notes before saving');
      return;
    }
    if (recordingActive) {
      writeLiveMeetingNotes(draft.markdown);
      toast.success(locale === 'zh-CN' ? '笔记已保存，将随录音归入会中笔记' : 'Notes saved and will be attached to this recording');
      return;
    }
    setSavingNotesOnly(true);
    try {
      const title = meetingTitle.trim() && meetingTitle !== '+ New Call'
        ? meetingTitle.trim()
        : t('meeting.untitled');
      const response = await invoke<{ meetingId: string }>('api_create_notes_only_meeting', {
        title,
        notesMarkdown: draft.markdown,
        notesJson: JSON.stringify({ source: 'live-recording', ...draft }),
      });
      const calendarSelection=readRecordingCalendarSelection();
      clearLiveMeetingNotes(draft);
      try { await attachRecordingCalendar(response.meetingId,calendarSelection); } catch { toast.warning(locale==='zh-CN'?'笔记已保存，但日程尚未关联；可在会议中重试':'Notes saved, but calendar linking failed. Retry from the meeting.'); }
      setLinkedEvent(null);
      await refetchMeetings();
      toast.success(locale === 'zh-CN' ? '会中笔记已保存' : 'Meeting notes saved', {
        action: {
          label: locale === 'zh-CN' ? '打开会议' : 'Open meeting',
          onClick: () => void openMeetingWorkspace(response.meetingId, url => router.push(url), { title }),
        },
      });
    } catch (error) {
      reportTechnicalError('recording-save-notes-only', error);
      toast.error(locale === 'zh-CN' ? '会中笔记保存失败' : 'Could not save meeting notes', {
        description: toUserFacingError(error, locale).message,
      });
    } finally {
      setSavingNotesOnly(false);
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
  const hasOpenSettingsModal = Object.values(modals).some(Boolean);

  return (
    <div className="calmee-page">
      {/* All Modals supported*/}
      {hasOpenSettingsModal && <SettingsModals
        modals={modals}
        messages={messages}
        onClose={hideModal}
      />}

      {/* Recovery Dialog */}
      {showRecoveryDialog && <TranscriptRecovery
        isOpen={showRecoveryDialog}
        onClose={handleDialogClose}
        recoverableMeetings={recoverableMeetings}
        onRecover={handleRecovery}
        onDelete={deleteRecoverableMeeting}
        onLoadPreview={loadMeetingTranscripts}
      />}
      <header className="calmee-titlebar flex min-h-[76px] items-center justify-between gap-6 px-7 py-2.5">
        <div className="min-w-0 flex-1">
          <input
            value={meetingTitle === '+ New Call' ? '' : meetingTitle}
            onChange={(event) => {
              setMeetingTitle(event.target.value);
            }}
            disabled={recordingState.isRecording}
            placeholder={t('recording.new')}
            aria-label={locale === 'zh-CN' ? '会议标题' : 'Meeting title'}
            className="w-full max-w-xl truncate border-0 bg-transparent p-0 text-[22px] font-semibold tracking-[-0.015em] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-100"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {!notesAutoSave
              ? (locale === 'zh-CN' ? '自动保存已关闭' : 'Auto-save is off')
              : notesSaved
              ? (locale === 'zh-CN' ? '草稿已保存' : 'Draft saved')
              : (locale === 'zh-CN' ? '正在保存草稿…' : 'Saving draft…')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={()=>setCalendarOpen(true)} className={`h-9 w-9 rounded-lg ${linkedEvent?'bg-primary/10 text-primary':'text-muted-foreground'}`} title={linkedEvent ? `${locale==='zh-CN'?'已选择日程':'Selected event'}：${linkedEvent.title}` : (locale==='zh-CN'?'关联日程':'Link calendar event')}>
            {linkedEvent?<Check className="h-4 w-4"/>:<CalendarDays className="h-4 w-4"/>}
          </Button>
          <CalendarLinkDialog open={calendarOpen} onOpenChange={setCalendarOpen} meetingTitle={meetingTitle} currentEventId={linkedEvent?.id} onLinked={selectCalendarEvent}/>

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
            onAutoSaveChange={setNotesAutoSave}
            onSave={saveNotesOnly}
            saving={savingNotesOnly}
          />
        </div>

        {/* Status Overlays - Processing and Saving */}
        <StatusOverlays
          isProcessing={status === RecordingStatus.PROCESSING_TRANSCRIPTS && !recordingState.isRecording}
          isSaving={status === RecordingStatus.SAVING}
          sidebarCollapsed={true}
        />
      </div>
    </div>
  );
}
