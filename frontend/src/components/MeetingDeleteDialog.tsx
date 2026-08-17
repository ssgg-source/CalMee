'use client';

import { Loader2, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLanguage } from '@/contexts/LanguageContext';

interface MeetingDeleteDialogProps {
  open: boolean;
  meetingTitles: string[];
  deleting?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

export function MeetingDeleteDialog({
  open,
  meetingTitles,
  deleting = false,
  onOpenChange,
  onConfirm,
}: MeetingDeleteDialogProps) {
  const count = meetingTitles.length;
  const { t } = useLanguage();

  return (
    <Dialog open={open} onOpenChange={value => !deleting && onOpenChange(value)}>
      <DialogContent className="max-w-md rounded-3xl border-red-100 p-0 overflow-hidden">
        <div className="bg-red-50 px-6 py-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-100 text-red-600">
            <Trash2 className="h-5 w-5" />
          </div>
        </div>
        <div className="px-6 pb-6">
          <DialogHeader>
            <DialogTitle>{count > 1 ? t('delete.titleMany', { count }) : t('delete.titleOne')}</DialogTitle>
            <DialogDescription className="pt-2 leading-6">
              {t('delete.description')}
            </DialogDescription>
          </DialogHeader>

          {count > 0 && (
            <div className="my-5 max-h-32 overflow-y-auto rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
              {meetingTitles.slice(0, 4).map((title, index) => (
                <div key={`${title}-${index}`} className="truncate py-1">• {title}</div>
              ))}
              {count > 4 && <div className="py-1 text-slate-400">{t('delete.more', { count: count - 4 })}</div>}
            </div>
          )}

          <DialogFooter className="gap-2 sm:space-x-0">
            <button
              type="button"
              disabled={deleting}
              onClick={() => onOpenChange(false)}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={deleting || count === 0}
              onClick={() => void onConfirm()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {deleting ? t('common.deleting') : t('delete.confirm')}
            </button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
