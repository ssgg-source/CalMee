import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { PermissionWarning } from '@/components/PermissionWarning';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, GlobeIcon } from 'lucide-react';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { ModalType } from '@/hooks/useModalState';
import { useIsLinux } from '@/hooks/usePlatform';
import { useMemo } from 'react';
import { AudioLines } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

/**
 * TranscriptPanel Component
 *
 * Displays transcript content with controls for copying and language settings.
 * Uses TranscriptContext, ConfigContext, and RecordingStateContext internally.
 */

interface TranscriptPanelProps {
  // indicates stop-processing state for transcripts; derived from backend statuses.
  isProcessingStop: boolean;
  isStopping: boolean;
  showModal: (name: ModalType, message?: string) => void;
}

const appendStreamingText = (current: string, incoming: string) => {
  const maxOverlap = Math.min(10, current.length, incoming.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (current.slice(-length) === incoming.slice(0, length)) {
      return current + incoming.slice(length);
    }
  }
  const addSpace = /[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(incoming);
  return `${current}${addSpace ? ' ' : ''}${incoming}`;
};

export function TranscriptPanel({
  isProcessingStop,
  isStopping,
  showModal
}: TranscriptPanelProps) {
  // Contexts
  const { transcripts, transcriptContainerRef, copyTranscript } = useTranscripts();
  const { transcriptModelConfig } = useConfig();
  const { locale } = useLanguage();
  const { isRecording, isPaused } = useRecordingState();
  const { checkPermissions, isChecking, hasSystemAudio, hasMicrophone } = usePermissionCheck();
  const isLinux = useIsLinux();

  // Convert transcripts to segments for virtualized view
  const segments = useMemo(() => transcripts.reduce<Array<{
    id: string;
    timestamp: number;
    endTime?: number;
    text: string;
    confidence?: number;
    streaming: boolean;
  }>>((rows, transcript) => {
    const current = rows.at(-1);
    if (transcript.is_partial && current?.streaming) {
      current.text = appendStreamingText(current.text, transcript.text);
      current.endTime = transcript.audio_end_time;
      current.confidence = transcript.confidence;
      return rows;
    }
    rows.push({
      id: transcript.id,
      timestamp: transcript.audio_start_time ?? 0,
      endTime: transcript.audio_end_time,
      text: transcript.text,
      confidence: transcript.confidence,
      streaming: Boolean(transcript.is_partial),
    });
    return rows;
  }, []).map(({ streaming: _streaming, ...segment }) => segment), [transcripts]);

  return (
    <div ref={transcriptContainerRef} className="flex h-full min-h-0 w-full flex-col bg-white">
      {/* Title area - Sticky header */}
      <div className="sticky top-0 z-10 bg-white p-4 border-gray-200">
        <div className="flex flex-col space-y-3">
          <div className="flex  flex-col space-y-2">
            <div className="flex justify-center  items-center space-x-2">
              <ButtonGroup>
                {transcripts?.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copyTranscript}
                    title="Copy Transcript"
                  >
                    <Copy />
                    <span className='hidden md:inline'>
                      Copy
                    </span>
                  </Button>
                )}
                {transcriptModelConfig.provider === "localWhisper" &&
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => showModal('languageSettings')}
                    title="Language"
                  >
                    <GlobeIcon />
                    <span className='hidden md:inline'>
                      Language
                    </span>
                  </Button>
                }
              </ButtonGroup>
            </div>
          </div>
        </div>
      </div>

      {/* Permission Warning - Not needed on Linux */}
      {!isRecording && !isChecking && !isLinux && (
        <div className="flex justify-center px-4 pt-4">
          <PermissionWarning
            hasMicrophone={hasMicrophone}
            hasSystemAudio={hasSystemAudio}
            onRecheck={checkPermissions}
            isRechecking={isChecking}
          />
        </div>
      )}

      {/* Transcript content */}
      <div className="min-h-0 flex-1 overflow-hidden pb-20">
        <div className="flex h-full min-h-0 justify-center">
          <div className="h-full min-h-0 w-full max-w-[900px]">
            {isRecording && transcriptModelConfig.provider === 'none' ? (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50 text-violet-600">
                  <AudioLines className="h-6 w-6" />
                </div>
                <p className="text-sm font-medium text-slate-700">{locale === 'zh-CN' ? '正在进行纯录音' : 'Recording audio only'}</p>
                <p className="mt-1 max-w-sm text-xs leading-5 text-slate-400">{locale === 'zh-CN' ? '当前不会加载转写模型。停止并保存后，可在会议页面选择模型进行完整转写。' : 'No transcription model is loaded. Stop and save, then choose a model on the meeting page to transcribe the full recording.'}</p>
              </div>
            ) : (
            <VirtualizedTranscriptView
              segments={segments}
              isRecording={isRecording}
              isPaused={isPaused}
              isProcessing={isProcessingStop}
              isStopping={isStopping}
              // FunASR already delivers frequent incremental revisions. A
              // second character-by-character animation can repeatedly hide
              // and reveal the same sentence when the decoder corrects text.
              enableStreaming={false}
              showConfidence={true}
            />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
