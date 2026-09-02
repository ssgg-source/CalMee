"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { BlockNoteSummaryView, BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

type RecordBlock = {
  id: string;
  localSpeaker?: string;
  personName?: string;
  startMs: number;
  endMs: number;
  text: string;
};

type MeetingRecord = {
  meetingId: string;
  blocks: RecordBlock[];
  documentMarkdown?: string;
};

type AiOrganizerJob = {
  status: 'idle' | 'processing' | 'completed' | 'error';
  preview?: { record: MeetingRecord };
  error?: string;
};

const clock = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
};

function recordMarkdown(record: MeetingRecord) {
  if (record.documentMarkdown?.trim()) return record.documentMarkdown.trim();
  return record.blocks.map(block => {
    const speaker = block.personName || block.localSpeaker;
    const heading = speaker ? `### ${speaker} · ${clock(block.startMs)}\n\n` : '';
    return `${heading}${block.text.trim()}`;
  }).join('\n\n');
}

export interface MeetingRecordViewRef {
  save: () => Promise<void>;
  copy: () => Promise<void>;
}

interface MeetingRecordViewProps {
  meetingId: string;
  onDirtyChange?: (dirty: boolean) => void;
}

export const MeetingRecordView = forwardRef<MeetingRecordViewRef, MeetingRecordViewProps>(function MeetingRecordView({ meetingId, onDirtyChange }, ref) {
  const { t, lt, locale } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [markdown, setMarkdown] = useState('');
  const editorRef = useRef<BlockNoteSummaryViewRef>(null);

  useEffect(() => {
    let active = true;
    invoke<MeetingRecord>('api_get_or_build_meeting_record', { meetingId })
      .then(record => {
        if (!active) return;
        const markdown = recordMarkdown(record);
        setMarkdown(markdown);
      })
      .catch(error => {
        reportTechnicalError('meeting-record-generate', error);
        toast.error(t('record.generateFailed'), { description: toUserFacingError(error, locale).message });
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [meetingId, t]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const job = await invoke<AiOrganizerJob>('api_get_ai_organize_meeting_record_status', { meetingId });
        if (!active) return;
        if (job.status === 'processing') {
          timer = window.setTimeout(() => void poll(), 1500);
        } else if (job.status === 'completed' && job.preview?.record) {
          setMarkdown(recordMarkdown(job.preview.record));
          await invoke('api_clear_ai_organize_meeting_record', { meetingId });
        } else if (job.status === 'error' && job.error) {
          reportTechnicalError('meeting-record-job', job.error);
          toast.error(t('record.aiFailed'), { description: toUserFacingError(job.error, locale).message });
        }
      } catch (error) {
        console.warn('Failed to read meeting-record organizer state:', error);
      }
    };
    void poll();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [meetingId, t]);

  useImperativeHandle(ref, () => ({
    save: async () => { await editorRef.current?.saveSummary(); },
    copy: async () => {
      const value = await editorRef.current?.getMarkdown() || markdown;
      await navigator.clipboard.writeText(value);
      toast.success(lt('Transcript copied to clipboard'));
    },
  }), [lt, markdown]);

  if (loading) return <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />{t('record.loading')}</div>;

  return <div className="h-full overflow-y-auto bg-white p-6">
    <BlockNoteSummaryView
      ref={editorRef}
      summaryData={{ markdown } as any}
      onDirtyChange={onDirtyChange}
      onSave={async data => {
        const value = data.markdown?.trim();
        if (!value) throw new Error(t('record.documentPlaceholder'));
        await invoke('api_update_meeting_record_document', { meetingId, markdown: value });
        setMarkdown(value);
        toast.success(t('record.saved'));
      }}
    />
  </div>;
});
