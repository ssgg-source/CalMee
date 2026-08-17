'use client';

import { useState, useEffect } from 'react';
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
import { TranscriptPanel } from '@/app/_components/TranscriptPanel';
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
import { RecordingModelStatus } from '@/components/RecordingModelStatus';
import { hideRecordingOverlay, showRecordingOverlay } from '@/lib/recording-overlay';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Globe2, PictureInPicture2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function RecordingPage() {
  const { t, locale } = useLanguage();
  // Local page state (not moved to contexts)
  const [isRecording, setIsRecordingState] = useState(false);
  const [barHeights, setBarHeights] = useState(['58%', '76%', '58%']);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);

  // Use contexts for state management
  const { meetingTitle } = useTranscripts();
  const { transcriptModelConfig, selectedDevices, selectedLanguage, setSelectedLanguage } = useConfig();
  const recordingState = useRecordingState();

  // Extract status from global state
  const { status, isStopping, isProcessing, isSaving } = recordingState;

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
    if ([RecordingStatus.IDLE, RecordingStatus.COMPLETED, RecordingStatus.ERROR].includes(status)) {
      void hideRecordingOverlay().catch(() => undefined);
    }
  }, [status]);

  const enterFloatingMode = async () => {
    if (!recordingState.isRecording) return;
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
    // Only show dialog if we have meetings and haven't shown it yet this session
    if (recoverableMeetings.length > 0) {
      const shownThisSession = sessionStorage.getItem('recovery_dialog_shown');
      if (!shownThisSession) {
        setShowRecoveryDialog(true);
        sessionStorage.setItem('recovery_dialog_shown', 'true');
      }
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

        // Open the recovered meeting immediately so the action has visible
        // feedback; the previous two-second delay looked like a dead button.
        if (result.meetingId) {
          await openMeetingWorkspace(result.meetingId, url => router.push(url));
        }
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

  useEffect(() => {
    if (recordingState.isRecording) {
      const interval = setInterval(() => {
        setBarHeights(prev => {
          const newHeights = [...prev];
          newHeights[0] = Math.random() * 20 + 10 + 'px';
          newHeights[1] = Math.random() * 20 + 10 + 'px';
          newHeights[2] = Math.random() * 20 + 10 + 'px';
          return newHeights;
        });
      }, 300);

      return () => clearInterval(interval);
    }
  }, [recordingState.isRecording]);

  // Computed values using global status
  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="flex flex-col h-screen bg-[#f8f7fb]"
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
      <header className="flex items-center justify-between border-b border-violet-100 bg-white px-8 py-5">
        <div>
          <p className="text-sm font-medium text-violet-600">{t('recording.eyebrow')}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
            {recordingState.isRecording ? meetingTitle : t('recording.new')}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Globe2 className="h-3.5 w-3.5 text-slate-400" />
            <Select value={selectedLanguage} onValueChange={setSelectedLanguage} disabled={recordingState.isRecording}>
              <SelectTrigger className="h-8 w-[118px] rounded-full border-slate-200 bg-white px-3 text-[11px] shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{locale === 'zh-CN' ? '自动识别' : 'Auto detect'}</SelectItem>
                <SelectItem value="zh">{locale === 'zh-CN' ? '中文' : 'Chinese'}</SelectItem>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="yue">{locale === 'zh-CN' ? '粤语' : 'Cantonese'}</SelectItem>
                <SelectItem value="ja">日本語</SelectItem>
                <SelectItem value="ko">한국어</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <RecordingModelStatus />
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 rounded-xl"
            disabled={!recordingState.isRecording}
            onClick={() => void enterFloatingMode()}
            title={locale === 'zh-CN' ? '切换到悬浮录音' : 'Switch to floating recorder'}
          >
            <PictureInPicture2 className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <div className="relative flex-1 overflow-hidden p-4 pb-24">
        <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.65fr)_minmax(280px,0.75fr)] gap-4">
          <div className="min-h-0 overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-sm">
            <TranscriptPanel
              isProcessingStop={isProcessingStop}
              isStopping={isStopping}
              showModal={showModal}
            />
          </div>
          <LiveMeetingNotes currentTime={recordingState.activeDuration || 0} />
        </div>

        {/* Recording controls - only show when permissions are granted or already recording and not showing status messages */}
        {(hasMicrophone || isRecording) &&
          status !== RecordingStatus.PROCESSING_TRANSCRIPTS &&
          status !== RecordingStatus.SAVING && (
            <div className="fixed bottom-12 left-20 right-0 z-10">
              <div
                className="flex justify-center px-8"
              >
                <div className="w-2/3 max-w-[750px] flex justify-center">
                  <div className="bg-white rounded-full shadow-lg flex items-center">
                    <RecordingControls
                      isRecording={recordingState.isRecording}
                      onRecordingStop={(callApi = true) => handleRecordingStop(callApi)}
                      onRecordingStart={handleRecordingStart}
                      onTranscriptReceived={() => { }} // Not actually used by RecordingControls
                      onStopInitiated={() => setIsStopping(true)}
                      barHeights={barHeights}
                      onTranscriptionError={(message) => {
                        showModal('errorAlert', message);
                      }}
                      isRecordingDisabled={isRecordingDisabled}
                      isParentProcessing={isProcessingStop}
                      selectedDevices={selectedDevices}
                      meetingName={meetingTitle}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

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
