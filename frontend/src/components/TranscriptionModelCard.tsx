'use client';

import { motion } from 'framer-motion';
import { Loader2, Trash2 } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

interface Props {
  name: string;
  description: string;
  icon: string;
  isSelected: boolean;
  isReady: boolean;
  isDownloaded?: boolean;
  isRecommended?: boolean;
  isBusy?: boolean;
  busyAction?: 'download' | 'load' | null;
  progress?: number | null;
  badges?: string[];
  sizeText?: string;
  onDelete?: () => void;
  onSelect: () => void;
  onDownload: () => void;
}

/** Shared visual pattern used by local transcription model managers. */
export function TranscriptionModelCard({
  name,
  description,
  icon,
  isSelected,
  isReady,
  isDownloaded = isReady,
  isRecommended = false,
  isBusy = false,
  busyAction = null,
  progress = null,
  badges = [],
  sizeText,
  onDelete,
  onSelect,
  onDownload,
}: Props) {
  const { lt } = useLanguage();
  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`relative rounded-lg border-2 transition-all ${isReady || isDownloaded ? 'cursor-pointer' : 'cursor-default'} ${
        isSelected
          ? 'border-blue-500 bg-blue-50'
          : isReady
            ? 'border-gray-200 bg-white hover:border-gray-300'
            : 'border-gray-200 bg-gray-50'
      }`}
      onClick={() => { if ((isReady || isDownloaded) && !isBusy) onSelect(); }}
    >
      {isRecommended && (
        <div className="absolute -right-2 -top-2 rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
          {lt('Recommended')}
        </div>
      )}
      <div className="p-4">
        <div className="mb-3 flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-2xl">{icon}</span>
              <h3 className="font-semibold text-gray-900">{name}</h3>
              {isSelected && <span className="flex items-center rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">✓</span>}
            </div>
            <p className="ml-9 text-sm text-gray-600">{description}</p>
            {(badges.length > 0 || sizeText) && <div className="ml-9 mt-2 flex flex-wrap gap-1.5">{badges.map(badge => <span key={badge} className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-[11px] text-slate-500">{badge}</span>)}{sizeText && <span className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-[11px] text-slate-500">{sizeText}</span>}</div>}
          </div>
          <div className="ml-4 flex shrink-0 items-center gap-2">
            {isBusy ? (
              <span className="flex items-center gap-1.5 text-sm font-medium text-blue-600">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {busyAction === 'load' ? lt('Loading…') : lt('Downloading…')}
              </span>
            ) : isReady ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 text-green-600">
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                  <span className="text-xs font-medium">{lt('Ready')}</span>
                </div>
                {onDelete && <button type="button" aria-label={lt('Delete model')} title={lt('Delete model')} onClick={(event) => { event.stopPropagation(); onDelete(); }} className="rounded-md p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}
              </div>
            ) : isDownloaded ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-500">{lt('Downloaded')}</span>
                {onDelete && <button type="button" aria-label={lt('Delete model')} title={lt('Delete model')} onClick={(event) => { event.stopPropagation(); onDelete(); }} className="rounded-md p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}
              </div>
            ) : (
              <button
                type="button"
                disabled={isBusy}
                onClick={(event) => { event.stopPropagation(); onDownload(); }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
              >
                {lt('Download')}
              </button>
            )}
          </div>
        </div>
        {isBusy && (
          <div className="mt-3 border-t border-gray-200 pt-3">
            <div className="mb-2 flex items-center justify-between text-sm font-medium text-blue-600">
              <span>{busyAction === 'load' ? lt('Loading model…') : lt('Downloading model…')}</span>
              {progress !== null && <span>{Math.round(progress)}%</span>}
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
              {progress === null ? <div className="h-full w-1/3 animate-pulse rounded-full bg-blue-600" /> : <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
