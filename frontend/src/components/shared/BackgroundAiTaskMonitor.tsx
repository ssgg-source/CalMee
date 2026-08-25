'use client';

import { useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { usePathname, useRouter } from 'next/navigation';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { openMeetingWorkspace } from '@/lib/meeting-window';
import { useLanguage } from '@/contexts/LanguageContext';
import { boundedPercentage, progressDescription, reportTechnicalError, toUserFacingError } from '@/lib/feedback';

type AiProgress = { stage?: string; percentage?: number; message?: string };
type ProgressEvent = { meetingId: string; progress: AiProgress };
type OrganizerProgress = AiProgress & { meetingId: string };
type ErrorEvent = { meetingId: string; error: string };
type ProfileProgressEvent = AiProgress & { personId: string; personName: string };
type ProfileEvent = { personId: string; personName: string; error?: string };
type TranscriptionProgressEvent = {
  meeting_id?: string;
  meetingId?: string;
  progress_percentage: number;
  message?: string;
  stage?: string;
};
type TranscriptionResultEvent = {
  meeting_id?: string;
  meetingId?: string;
  segments_count?: number;
  error?: string;
};
type RefinementProgressEvent = { meeting_id?: string; meetingId?: string; percentage?: number; determinate?: boolean; message?: string; stage?: string };
type RefinementFinishedEvent = { meeting_id?: string; meetingId?: string; status: string; error?: string; result?: { changedCount?: number; changed_count?: number } };

const summaryToastId = (meetingId: string) => `background-summary-${meetingId}`;
const organizerToastId = (meetingId: string) => `background-organizer-${meetingId}`;
const profileToastId = (personId: string) => `background-profile-${personId}`;
const transcriptionToastId = (meetingId: string) => `background-transcription-${meetingId}`;
const refinementToastId = (meetingId: string) => `background-refinement-${meetingId}`;

export function BackgroundAiTaskMonitor() {
  const { t, locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const router = useRouter();
  const pathname = usePathname();
  const { meetings, refetchMeetings } = useSidebar();
  const meetingsRef = useRef(meetings);
  const visibleProgressRef = useRef(new Map<string, string>());
  useEffect(() => { meetingsRef.current = meetings; }, [meetings]);

  useEffect(() => {
    if (pathname.startsWith('/meeting-details')) return;
    if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return;
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const meetingTitle = (meetingId: string) => meetingsRef.current.find(item => item.id === meetingId)?.title || t('background.currentMeeting');
    const summaryProgress = (progress: AiProgress) => {
      switch (progress.stage) {
        case 'analyzing': return t('summary.progressAnalyzing');
        case 'chunking': return t('summary.progressChunking');
        case 'summarizing':
        case 'summarizing_chunks': return t('summary.progressProcessing');
        case 'combining': return t('summary.progressCombining');
        case 'formatting': return t('summary.progressFormatting');
        case 'translating':
        case 'translation': return t('summary.progressTranslating');
        default: return t('background.processing');
      }
    };
    const organizerProgress = (progress: AiProgress) => {
      switch (progress.stage) {
        case 'preparing': return t('background.organizerPreparing');
        case 'organizing': return t('background.organizerGenerating');
        case 'validating': return t('background.organizerValidating');
        case 'preview': return t('background.organizerSaving');
        default: return t('background.organizingContent');
      }
    };
    const transcriptionStage = (stage: string | undefined, percentage: number | null) => {
      if (stage === 'decoding' || stage === 'preparing') return zh ? '正在准备音频' : 'Preparing audio';
      if (stage === 'vad') return zh ? '正在检测有效语音' : 'Detecting speech';
      if (stage === 'loading_model') return zh ? '正在加载识别模型' : 'Loading ASR model';
      if (stage === 'analyzing_audio') return zh ? '模型已就绪，正在分析音频' : 'Model ready, analyzing audio';
      if (stage === 'recognizing' || stage === 'transcribing') return zh ? '正在识别语音' : 'Recognizing speech';
      if (stage === 'diarizing') return zh ? '正在区分讲话人' : 'Identifying speakers';
      if (stage === 'saving') return zh ? '正在整理并保存文字稿' : 'Organizing and saving transcript';
      if (stage === 'complete') return zh ? '正在完成转写' : 'Finishing transcription';
      if (percentage == null) return zh ? '正在处理录音' : 'Processing recording';
      if (percentage < 15) return zh ? '正在准备音频' : 'Preparing audio';
      if (percentage < 30) return zh ? '正在加载识别模型' : 'Loading ASR model';
      if (percentage < 88) return zh ? '正在识别语音' : 'Recognizing speech';
      if (percentage < 98) return zh ? '正在整理并保存文字稿' : 'Organizing and saving transcript';
      return zh ? '正在完成转写' : 'Finishing transcription';
    };
    const meetingIdOf = (payload: { meeting_id?: string; meetingId?: string }) => payload.meetingId || payload.meeting_id || '';
    const showProgress = (id: string, title: string, description: string, onOpen: () => void) => {
      const signature = `${title}\n${description}`;
      if (visibleProgressRef.current.get(id) === signature) return;
      visibleProgressRef.current.set(id, signature);
      toast.loading(title, {
        id,
        description,
        duration: Infinity,
        action: { label: t('background.openMeeting'), onClick: onOpen },
      });
    };
    const finishProgress = (id: string) => {
      visibleProgressRef.current.delete(id);
      toast.dismiss(id);
    };
    const showFailure = (scope: string, title: string, error: unknown) => {
      reportTechnicalError(scope, error);
      const friendly = toUserFacingError(error, locale);
      if (friendly.code === 'cancelled') toast.info(friendly.message);
      else toast.error(title, { description: friendly.message });
    };
    const openMeeting = (meetingId: string) => void openMeetingWorkspace(
      meetingId,
      url => router.push(url),
      { title: meetingTitle(meetingId) },
    );

    const addListener = async <T,>(eventName: string, handler: (payload: T) => void) => {
      const unlisten = await listen<T>(eventName, event => handler(event.payload));
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };

    void Promise.all([
      addListener<ProgressEvent>('summary-ai-progress', payload => {
        const percentage = boundedPercentage(payload.progress?.percentage);
        showProgress(
          summaryToastId(payload.meetingId),
          t('background.generating',{title:meetingTitle(payload.meetingId)}),
          progressDescription(summaryProgress(payload.progress || {}), percentage),
          () => openMeeting(payload.meetingId),
        );
      }),
      addListener<{ meetingId: string }>('summary-ai-complete', payload => {
        finishProgress(summaryToastId(payload.meetingId));
        void refetchMeetings();
        toast.success(t('background.summaryComplete',{title:meetingTitle(payload.meetingId)}), {
          duration: 10000,
          action: { label: t('background.viewSummary'), onClick: () => openMeeting(payload.meetingId) },
        });
      }),
      addListener<ErrorEvent>('summary-ai-error', payload => {
        finishProgress(summaryToastId(payload.meetingId));
        showFailure('summary-ai-error', t('background.summaryFailed',{title:meetingTitle(payload.meetingId)}), payload.error);
      }),
      addListener<{ meetingId: string }>('summary-ai-cancelled', payload => {
        finishProgress(summaryToastId(payload.meetingId));
        toast.info(t('background.summaryStopped',{title:meetingTitle(payload.meetingId)}));
      }),
      addListener<OrganizerProgress>('meeting-record-ai-progress', payload => {
        const percentage = boundedPercentage(payload.percentage);
        showProgress(
          organizerToastId(payload.meetingId),
          t('background.organizing',{title:meetingTitle(payload.meetingId)}),
          progressDescription(organizerProgress(payload), percentage),
          () => openMeeting(payload.meetingId),
        );
      }),
      addListener<{ meetingId: string; changedCount: number }>('meeting-record-ai-complete', payload => {
        finishProgress(organizerToastId(payload.meetingId));
        toast.success(t('background.organizerComplete',{title:meetingTitle(payload.meetingId)}), {
          description: t('background.organizerDescription',{count:payload.changedCount}),
          duration: 10000,
          action: { label: t('background.viewPreview'), onClick: () => openMeeting(payload.meetingId) },
        });
      }),
      addListener<ErrorEvent>('meeting-record-ai-error', payload => {
        finishProgress(organizerToastId(payload.meetingId));
        showFailure('meeting-record-ai-error', t('background.organizerFailed',{title:meetingTitle(payload.meetingId)}), payload.error);
      }),
      addListener<TranscriptionProgressEvent>('retranscription-progress', payload => {
        const meetingId = meetingIdOf(payload);
        if (!meetingId) return;
        const percentage = boundedPercentage(payload.progress_percentage);
        showProgress(
          transcriptionToastId(meetingId),
          zh ? `正在转写“${meetingTitle(meetingId)}”` : `Transcribing “${meetingTitle(meetingId)}”`,
          progressDescription(transcriptionStage(payload.stage, percentage), percentage),
          () => openMeeting(meetingId),
        );
      }),
      addListener<TranscriptionResultEvent>('retranscription-complete', payload => {
        const meetingId = meetingIdOf(payload);
        if (!meetingId) return;
        finishProgress(transcriptionToastId(meetingId));
        void refetchMeetings();
        toast.success(zh ? `“${meetingTitle(meetingId)}”转写完成` : `“${meetingTitle(meetingId)}” transcription complete`, {
          description: payload.segments_count == null ? undefined : (zh ? `共生成 ${payload.segments_count} 个发言段` : `${payload.segments_count} transcript segments created`),
          duration: 10000,
          action: { label: t('background.openMeeting'), onClick: () => openMeeting(meetingId) },
        });
      }),
      addListener<TranscriptionResultEvent>('retranscription-error', payload => {
        const meetingId = meetingIdOf(payload);
        if (!meetingId) return;
        finishProgress(transcriptionToastId(meetingId));
        showFailure('retranscription-error', zh ? `“${meetingTitle(meetingId)}”转写失败` : `“${meetingTitle(meetingId)}” transcription failed`, payload.error);
      }),
      addListener<RefinementProgressEvent>('transcript-refinement-progress', payload => {
        const meetingId = meetingIdOf(payload);
        if (!meetingId) return;
        const stage = payload.stage === 'saving'
          ? (zh ? '正在保存优化后的文字稿' : 'Saving the optimized transcript')
          : (zh ? 'AI 正在校对完整文字稿' : 'AI is reviewing the complete transcript');
        showProgress(
          refinementToastId(meetingId),
          zh ? `正在优化“${meetingTitle(meetingId)}”的文字稿` : `Optimizing the transcript for “${meetingTitle(meetingId)}”`,
          progressDescription(stage, payload.determinate ? boundedPercentage(payload.percentage) : null),
          () => openMeeting(meetingId),
        );
      }),
      addListener<RefinementFinishedEvent>('transcript-refinement-finished', payload => {
        const meetingId = meetingIdOf(payload);
        if (!meetingId) return;
        finishProgress(refinementToastId(meetingId));
        if (payload.status === 'completed') {
          toast.success(zh ? `“${meetingTitle(meetingId)}”文字稿优化完成` : `Transcript optimization complete — “${meetingTitle(meetingId)}”`, {
            duration: 10000,
            action: { label: t('background.openMeeting'), onClick: () => openMeeting(meetingId) },
          });
        } else if (payload.status === 'cancelled') {
          toast.info(zh ? 'AI 文字稿优化已取消' : 'AI transcript optimization cancelled');
        } else {
          showFailure('transcript-refinement-finished', zh ? `“${meetingTitle(meetingId)}”文字稿优化失败` : `Transcript optimization failed — “${meetingTitle(meetingId)}”`, payload.error);
        }
      }),
    ]);

    return () => {
      disposed = true;
      unlisteners.forEach(unlisten => unlisten());
    };
  }, [locale, pathname, router, refetchMeetings, t, zh]);

  // Person-profile tasks can start from Data and must keep reporting even if
  // the user moves into a meeting workspace, where the meeting task monitor is
  // intentionally suppressed to avoid duplicate summary notifications.
  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return;
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;
    const addListener = async <T,>(eventName: string, handler: (payload: T) => void) => {
      const unlisten = await listen<T>(eventName, event => handler(event.payload));
      if (disposed) unlisten(); else unlisteners.push(unlisten);
    };
    void Promise.all([
      addListener<ProfileProgressEvent>('person-profile-ai-progress', payload => {
        const percentage = boundedPercentage(payload.percentage);
        const stage = payload.stage === 'validating' ? (zh ? '正在核验证据' : 'Verifying evidence')
          : payload.stage === 'saving' ? (zh ? '正在保存画像' : 'Saving profile')
          : payload.stage === 'preparing' ? (zh ? '正在准备发言' : 'Preparing statements')
          : (zh ? '正在分析长期发言模式' : 'Analyzing speaking patterns');
        const id = profileToastId(payload.personId);
        const title = zh ? `正在生成 ${payload.personName} 的人物画像` : `Generating ${payload.personName}'s profile`;
        const description = progressDescription(stage, percentage);
        const signature = `${title}\n${description}`;
        if (visibleProgressRef.current.get(id) === signature) return;
        visibleProgressRef.current.set(id, signature);
        toast.loading(title, { id, description, duration: Infinity,
          action: { label: zh ? '打开数据' : 'Open Data', onClick: () => router.push('/knowledge') } });
      }),
      addListener<ProfileEvent>('person-profile-ai-complete', payload => {
        visibleProgressRef.current.delete(profileToastId(payload.personId));
        toast.dismiss(profileToastId(payload.personId));
        toast.success(zh ? `${payload.personName} 的人物画像已生成` : `${payload.personName}'s profile is ready`, {
          duration: 10000, action: { label: zh ? '打开数据' : 'Open Data', onClick: () => router.push('/knowledge') },
        });
      }),
      addListener<ProfileEvent>('person-profile-ai-error', payload => {
        visibleProgressRef.current.delete(profileToastId(payload.personId));
        toast.dismiss(profileToastId(payload.personId));
        reportTechnicalError('person-profile-ai-error', payload.error);
        const friendly = toUserFacingError(payload.error, locale);
        toast.error(zh ? `${payload.personName} 的人物画像生成失败` : `${payload.personName}'s profile failed`, { description: friendly.message });
      }),
      addListener<ProfileEvent>('person-profile-ai-cancelled', payload => {
        visibleProgressRef.current.delete(profileToastId(payload.personId));
        toast.dismiss(profileToastId(payload.personId));
        toast.info(zh ? `已停止生成 ${payload.personName} 的人物画像` : `Stopped ${payload.personName}'s profile generation`);
      }),
    ]);
    return () => { disposed = true; unlisteners.forEach(unlisten => unlisten()); };
  }, [locale, router, zh]);

  return null;
}
