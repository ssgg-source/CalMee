'use client';

import { useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { usePathname, useRouter } from 'next/navigation';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { openMeetingWorkspace } from '@/lib/meeting-window';
import { useLanguage } from '@/contexts/LanguageContext';

type AiProgress = { stage?: string; percentage?: number; message?: string };
type ProgressEvent = { meetingId: string; progress: AiProgress };
type OrganizerProgress = AiProgress & { meetingId: string };
type ErrorEvent = { meetingId: string; error: string };
type ProfileProgressEvent = AiProgress & { personId: string; personName: string };
type ProfileEvent = { personId: string; personName: string; error?: string };
type TranscriptionProgressEvent = {
  meeting_id: string;
  progress_percentage: number;
  message?: string;
};
type TranscriptionResultEvent = {
  meeting_id: string;
  segments_count?: number;
  error?: string;
};
type RefinementProgressEvent = { meeting_id: string; percentage?: number; message?: string };
type RefinementFinishedEvent = { meeting_id: string; status: string; error?: string; result?: { changed_count?: number } };

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
    const transcriptionStage = (percentage: number) => {
      if (percentage < 15) return zh ? '正在准备音频' : 'Preparing audio';
      if (percentage < 30) return zh ? '正在加载识别模型' : 'Loading ASR model';
      if (percentage < 88) return zh ? '正在识别语音' : 'Recognizing speech';
      if (percentage < 98) return zh ? '正在整理并保存文字稿' : 'Organizing and saving transcript';
      return zh ? '正在完成转写' : 'Finishing transcription';
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
        const percentage = Math.max(1, Math.min(99, Math.round(payload.progress?.percentage ?? 1)));
        toast.loading(t('background.generating',{title:meetingTitle(payload.meetingId)}), {
          id: summaryToastId(payload.meetingId),
          description: `${summaryProgress(payload.progress || {})} — ${percentage}%`,
          duration: Infinity,
          action: { label: t('background.openMeeting'), onClick: () => openMeeting(payload.meetingId) },
        });
      }),
      addListener<{ meetingId: string }>('summary-ai-complete', payload => {
        toast.dismiss(summaryToastId(payload.meetingId));
        void refetchMeetings();
        toast.success(t('background.summaryComplete',{title:meetingTitle(payload.meetingId)}), {
          duration: 10000,
          action: { label: t('background.viewSummary'), onClick: () => openMeeting(payload.meetingId) },
        });
      }),
      addListener<ErrorEvent>('summary-ai-error', payload => {
        toast.dismiss(summaryToastId(payload.meetingId));
        toast.error(t('background.summaryFailed',{title:meetingTitle(payload.meetingId)}), { description: payload.error });
      }),
      addListener<{ meetingId: string }>('summary-ai-cancelled', payload => {
        toast.dismiss(summaryToastId(payload.meetingId));
        toast.info(t('background.summaryStopped',{title:meetingTitle(payload.meetingId)}));
      }),
      addListener<OrganizerProgress>('meeting-record-ai-progress', payload => {
        const percentage = Math.max(1, Math.min(99, Math.round(payload.percentage ?? 1)));
        toast.loading(t('background.organizing',{title:meetingTitle(payload.meetingId)}), {
          id: organizerToastId(payload.meetingId),
          description: `${organizerProgress(payload)} — ${percentage}%`,
          duration: Infinity,
          action: { label: t('background.openMeeting'), onClick: () => openMeeting(payload.meetingId) },
        });
      }),
      addListener<{ meetingId: string; changedCount: number }>('meeting-record-ai-complete', payload => {
        toast.dismiss(organizerToastId(payload.meetingId));
        toast.success(t('background.organizerComplete',{title:meetingTitle(payload.meetingId)}), {
          description: t('background.organizerDescription',{count:payload.changedCount}),
          duration: 10000,
          action: { label: t('background.viewPreview'), onClick: () => openMeeting(payload.meetingId) },
        });
      }),
      addListener<ErrorEvent>('meeting-record-ai-error', payload => {
        toast.dismiss(organizerToastId(payload.meetingId));
        toast.error(t('background.organizerFailed',{title:meetingTitle(payload.meetingId)}), { description: payload.error });
      }),
      addListener<TranscriptionProgressEvent>('retranscription-progress', payload => {
        const percentage = Math.max(1, Math.min(99, Math.round(payload.progress_percentage || 1)));
        toast.loading(zh ? `正在转写“${meetingTitle(payload.meeting_id)}”` : `Transcribing “${meetingTitle(payload.meeting_id)}”`, {
          id: transcriptionToastId(payload.meeting_id),
          description: `${transcriptionStage(percentage)} — ${percentage}%`,
          duration: Infinity,
          action: { label: t('background.openMeeting'), onClick: () => openMeeting(payload.meeting_id) },
        });
      }),
      addListener<TranscriptionResultEvent>('retranscription-complete', payload => {
        toast.dismiss(transcriptionToastId(payload.meeting_id));
        void refetchMeetings();
        toast.success(zh ? `“${meetingTitle(payload.meeting_id)}”转写完成` : `“${meetingTitle(payload.meeting_id)}” transcription complete`, {
          description: payload.segments_count == null ? undefined : (zh ? `共生成 ${payload.segments_count} 个发言段` : `${payload.segments_count} transcript segments created`),
          duration: 10000,
          action: { label: t('background.openMeeting'), onClick: () => openMeeting(payload.meeting_id) },
        });
      }),
      addListener<TranscriptionResultEvent>('retranscription-error', payload => {
        toast.dismiss(transcriptionToastId(payload.meeting_id));
        const cancelled = String(payload.error || '').toLowerCase().includes('cancel');
        if (cancelled) toast.info(zh ? '语音转写已取消' : 'Transcription cancelled');
        else toast.error(zh ? `“${meetingTitle(payload.meeting_id)}”转写失败` : `“${meetingTitle(payload.meeting_id)}” transcription failed`, { description: payload.error });
      }),
      addListener<RefinementProgressEvent>('transcript-refinement-progress', payload => {
        const percentage = Math.max(1, Math.min(99, Math.round(payload.percentage || 1)));
        toast.loading(zh ? `正在优化“${meetingTitle(payload.meeting_id)}”的文字稿` : `Optimizing the transcript for “${meetingTitle(payload.meeting_id)}”`, {
          id: refinementToastId(payload.meeting_id),
          description: `${zh ? 'AI 正在校对完整文字稿' : 'AI is reviewing the complete transcript'} — ${percentage}%`,
          duration: Infinity,
          action: { label: t('background.openMeeting'), onClick: () => openMeeting(payload.meeting_id) },
        });
      }),
      addListener<RefinementFinishedEvent>('transcript-refinement-finished', payload => {
        toast.dismiss(refinementToastId(payload.meeting_id));
        if (payload.status === 'completed') {
          toast.success(zh ? `“${meetingTitle(payload.meeting_id)}”文字稿优化完成` : `Transcript optimization complete — “${meetingTitle(payload.meeting_id)}”`, {
            duration: 10000,
            action: { label: t('background.openMeeting'), onClick: () => openMeeting(payload.meeting_id) },
          });
        } else if (payload.status === 'cancelled') {
          toast.info(zh ? 'AI 文字稿优化已取消' : 'AI transcript optimization cancelled');
        } else {
          toast.error(zh ? `“${meetingTitle(payload.meeting_id)}”文字稿优化失败` : `Transcript optimization failed — “${meetingTitle(payload.meeting_id)}”`, { description: payload.error });
        }
      }),
    ]);

    return () => {
      disposed = true;
      unlisteners.forEach(unlisten => unlisten());
    };
  }, [pathname, router, refetchMeetings, t, zh]);

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
        const percentage = Math.max(1, Math.min(99, Math.round(payload.percentage ?? 1)));
        const stage = payload.stage === 'validating' ? (zh ? '正在核验证据' : 'Verifying evidence')
          : payload.stage === 'saving' ? (zh ? '正在保存画像' : 'Saving profile')
          : payload.stage === 'preparing' ? (zh ? '正在准备发言' : 'Preparing statements')
          : (zh ? '正在分析长期发言模式' : 'Analyzing speaking patterns');
        toast.loading(zh ? `正在生成 ${payload.personName} 的人物画像` : `Generating ${payload.personName}'s profile`, {
          id: profileToastId(payload.personId), description: `${stage} — ${percentage}%`, duration: Infinity,
          action: { label: zh ? '打开数据' : 'Open Data', onClick: () => router.push('/knowledge') },
        });
      }),
      addListener<ProfileEvent>('person-profile-ai-complete', payload => {
        toast.dismiss(profileToastId(payload.personId));
        toast.success(zh ? `${payload.personName} 的人物画像已生成` : `${payload.personName}'s profile is ready`, {
          duration: 10000, action: { label: zh ? '打开数据' : 'Open Data', onClick: () => router.push('/knowledge') },
        });
      }),
      addListener<ProfileEvent>('person-profile-ai-error', payload => {
        toast.dismiss(profileToastId(payload.personId));
        toast.error(zh ? `${payload.personName} 的人物画像生成失败` : `${payload.personName}'s profile failed`, { description: payload.error });
      }),
      addListener<ProfileEvent>('person-profile-ai-cancelled', payload => {
        toast.dismiss(profileToastId(payload.personId));
        toast.info(zh ? `已停止生成 ${payload.personName} 的人物画像` : `Stopped ${payload.personName}'s profile generation`);
      }),
    ]);
    return () => { disposed = true; unlisteners.forEach(unlisten => unlisten()); };
  }, [router, zh]);

  return null;
}
