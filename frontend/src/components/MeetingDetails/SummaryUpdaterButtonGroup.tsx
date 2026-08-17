"use client";

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, Save, Loader2 } from 'lucide-react';
import Analytics from '@/lib/analytics';
import { useLanguage } from '@/contexts/LanguageContext';

interface SummaryUpdaterButtonGroupProps {
  isSaving: boolean;
  isDirty: boolean;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
  onFind?: () => void;
  onOpenFolder: () => Promise<void>;
  hasSummary: boolean;
  saveTitle?: string;
  copyTitle?: string;
}

export function SummaryUpdaterButtonGroup({
  isSaving,
  isDirty,
  onSave,
  onCopy,
  onFind,
  onOpenFolder,
  hasSummary,
  saveTitle,
  copyTitle,
}: SummaryUpdaterButtonGroupProps) {
  const { lt } = useLanguage();
  return (
    <ButtonGroup>
      {/* Save button */}
      <Button
        variant="outline"
        size="icon"
        className={`h-9 w-9 ${isDirty ? 'bg-green-200' : ""}`}
        title={isSaving ? lt('Saving') : (saveTitle || lt('Save Changes'))}
        aria-label={isSaving ? lt('Saving') : (saveTitle || lt('Save Changes'))}
        onClick={() => {
          Analytics.trackButtonClick('save_changes', 'meeting_details');
          onSave();
        }}
        disabled={isSaving}
      >
        {isSaving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Save className="h-4 w-4" />
        )}
      </Button>

      {/* Copy button */}
      <Button
        variant="outline"
        size="icon"
        title={copyTitle || lt('Copy Summary')}
        aria-label={copyTitle || lt('Copy Summary')}
        onClick={() => {
          Analytics.trackButtonClick('copy_summary', 'meeting_details');
          onCopy();
        }}
        disabled={!hasSummary}
        className="h-9 w-9 cursor-pointer"
      >
        <Copy className="h-4 w-4" />
      </Button>

      {/* Find button */}
      {/* {onFind && (
        <Button
          variant="outline"
          size="sm"
          title="Find in Summary"
          onClick={() => {
            Analytics.trackButtonClick('find_in_summary', 'meeting_details');
            onFind();
          }}
          disabled={!hasSummary}
          className="cursor-pointer"
        >
          <Search />
          <span className="hidden lg:inline">Find</span>
        </Button>
      )} */}
    </ButtonGroup>
  );
}
