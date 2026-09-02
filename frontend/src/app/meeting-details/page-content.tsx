"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';
import type { Summary } from '@/types';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { MeetingDeleteDialog } from '@/components/MeetingDeleteDialog';
import { SelectionHotwordMenu } from '@/components/MeetingDetails/SelectionHotwordMenu';
import { MeetingWorkspaceShell } from '@/components/MeetingWorkspace/MeetingWorkspaceShell';
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useConfig } from '@/contexts/ConfigContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { addMeetingTab, closeMeetingWorkspaceOrNavigate } from '@/lib/meeting-window';

export default function PageContent({
  meeting,
  summaryData,
  shouldAutoGenerate = false,
  onAutoGenerateComplete,
  onMeetingUpdated,
  onRefetchTranscripts,
  segments,
}: {
  meeting: any;
  summaryData: Summary | null;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  segments?: any[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
}) {
  const { t, lt } = useLanguage();
  const router = useRouter();
  const { modelConfig } = useConfig();
  const { deleteMeetings } = useSidebar();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingMeeting, setDeletingMeeting] = useState(false);

  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const templates = useTemplates();
  const summaryGeneration = useSummaryGeneration({
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig,
    isModelConfigLoading: false,
    selectedTemplate: templates.selectedTemplate,
    onMeetingUpdated,
    updateMeetingTitle: meetingData.updateMeetingTitle,
    setAiSummary: meetingData.setAiSummary,
    onOpenModelSettings: () => toast.info(lt('Configure an AI model in Settings first')),
  });

  useEffect(() => {
    addMeetingTab({
      id: meeting.id,
      title: meeting.title || t('meeting.untitled'),
      source: meeting.source,
    });
  }, [meeting.id, meeting.source, meeting.title, t]);

  useEffect(() => { Analytics.trackPageView('meeting_details'); }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!shouldAutoGenerate || !meetingData.transcripts.length) return;
      await summaryGeneration.handleGenerateSummary('');
      if (!cancelled) onAutoGenerateComplete?.();
    };
    void run();
    return () => { cancelled = true; };
  }, [meeting.id, shouldAutoGenerate]);

  const handleDeleteMeeting = async () => {
    setDeletingMeeting(true);
    const result = await deleteMeetings([meeting.id]);
    setDeletingMeeting(false);
    if (result.failed.length) {
      toast.error(t('meeting.deleteFailed'));
      return;
    }
    setDeleteDialogOpen(false);
    toast.success(t('meeting.deleted'));
    await closeMeetingWorkspaceOrNavigate(url => router.push(url), meeting.id);
  };

  return <>
    <MeetingDeleteDialog
      open={deleteDialogOpen}
      meetingTitles={[meetingData.meetingTitle]}
      deleting={deletingMeeting}
      onOpenChange={setDeleteDialogOpen}
      onConfirm={handleDeleteMeeting}
    />
    <SelectionHotwordMenu>
      <MeetingWorkspaceShell
        key={meeting.id}
        meeting={meeting}
        title={meetingData.meetingTitle}
        onTitleChange={meetingData.handleTitleChange}
        onSaveTitle={meetingData.handleSaveMeetingTitle}
        transcripts={meetingData.transcripts}
        segments={segments}
        onRefetchTranscripts={onRefetchTranscripts}
        summary={meetingData.aiSummary}
        summaryStatus={summaryGeneration.summaryStatus}
        onGenerateSummary={summaryGeneration.handleGenerateSummary}
        onStopSummary={summaryGeneration.handleStopGeneration}
        onDelete={() => setDeleteDialogOpen(true)}
      />
    </SelectionHotwordMenu>
  </>;
}
