"use client";

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { FolderOpen, RefreshCw, Sparkles } from 'lucide-react';
import Analytics from '@/lib/analytics';
import { useState } from 'react';
import { RetranscribeDialog } from './RetranscribeDialog';
import { TranscriptRefinementDialog } from './TranscriptRefinementDialog';
import { useLanguage } from '@/contexts/LanguageContext';
import { SummaryUpdaterButtonGroup } from './SummaryUpdaterButtonGroup';


interface TranscriptButtonGroupProps {
  transcriptCount: number;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
  onSaveTranscript?: () => Promise<void>;
  transcriptDirty?: boolean;
  isSaving?: boolean;
  onRefinementStarted?: () => void;
}


export function TranscriptButtonGroup({
  transcriptCount,
  onCopyTranscript,
  onOpenMeetingFolder,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
  onSaveTranscript,
  transcriptDirty = false,
  isSaving = false,
  onRefinementStarted,
}: TranscriptButtonGroupProps) {
  const { lt } = useLanguage();
  const [retranscribeOpen, setRetranscribeOpen] = useState(false);
  const [refinementOpen, setRefinementOpen] = useState(false);
  return (
    <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
      <span aria-hidden />
      <ButtonGroup className="justify-self-center">
        <Button
          size="icon"
          variant="outline"
          className="h-9 w-9"
          onClick={() => {
            Analytics.trackButtonClick('open_recording_folder', 'meeting_details');
            onOpenMeetingFolder();
          }}
          disabled={!meetingFolderPath}
          title={meetingFolderPath ? lt('Open Recording Folder') : lt('No recording file is available')}
        >
          <FolderOpen size={18} />
        </Button>

        <Button
          size="icon"
          variant="outline"
          className="h-9 w-9 border-blue-200 bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100"
          disabled={!meetingId || !meetingFolderPath}
          onClick={() => setRetranscribeOpen(true)}
          title={meetingFolderPath ? lt('Retranscribe Meeting') : lt('No recording file is available')}
        >
          <RefreshCw size={17} />
        </Button>

        <Button
          size="icon"
          variant="outline"
          className="h-9 w-9 border-blue-200 bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100"
          disabled={!meetingId || transcriptCount === 0}
          onClick={() => setRefinementOpen(true)}
          title={lt('Optimize Transcript with AI')}
        >
          <Sparkles size={17} />
        </Button>
      </ButtonGroup>
      <div className="justify-self-end border-l border-slate-200 pl-2">
        <SummaryUpdaterButtonGroup
          isSaving={isSaving}
          isDirty={transcriptDirty}
          onSave={async () => { await onSaveTranscript?.(); }}
          onCopy={async () => {
            Analytics.trackButtonClick('copy_transcript', 'meeting_details');
            await onCopyTranscript();
          }}
          onOpenFolder={onOpenMeetingFolder}
          hasSummary={transcriptCount > 0}
          saveTitle={lt('Save Transcript')}
          copyTitle={transcriptCount === 0 ? lt('No transcript available') : lt('Copy Transcript')}
        />
      </div>
      {meetingId && <RetranscribeDialog
        open={retranscribeOpen}
        onOpenChange={setRetranscribeOpen}
        meetingId={meetingId}
        meetingFolderPath={meetingFolderPath || null}
        onComplete={() => void onRefetchTranscripts?.()}
      />}
      {meetingId && <TranscriptRefinementDialog
        open={refinementOpen}
        onOpenChange={setRefinementOpen}
        meetingId={meetingId}
        transcriptCount={transcriptCount}
        beforeStart={onSaveTranscript}
        onStarted={() => onRefinementStarted?.()}
      />}
    </div>
  );
}
