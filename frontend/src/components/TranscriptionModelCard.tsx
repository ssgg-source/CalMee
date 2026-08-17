'use client';

import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

interface Props {
  name: string;
  description: string;
  icon: string;
  isSelected: boolean;
  isReady: boolean;
  isRecommended?: boolean;
  isBusy?: boolean;
  progress?: number | null;
  badges?: string[];
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
  isRecommended = false,
  isBusy = false,
  progress = null,
  badges = [],
  onSelect,
  onDownload,
}: Props) {
  const { lt } = useLanguage();
  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`relative rounded-lg border-2 transition-all ${isReady ? 'cursor-pointer' : 'cursor-default'} ${
        isSelected && isReady
          ? 'border-blue-500 bg-blue-50'
          : isReady
            ? 'border-gray-200 bg-white hover:border-gray-300'
            : 'border-gray-200 bg-gray-50'
      }`}
      onClick={() => { if (isReady && !isBusy) onSelect(); }}
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
              {isSelected && isReady && <span className="flex items-center rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">✓</span>}
            </div>
            <p className="ml-9 text-sm text-gray-600">{description}</p>
            {badges.length > 0 && <div className="ml-9 mt-2 flex flex-wrap gap-1.5">{badges.map(badge => <span key={badge} className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-[11px] text-slate-500">{badge}</span>)}</div>}
          </div>
          <div className="ml-4 flex shrink-0 items-center gap-2">
            {isReady ? (
              <div className="flex items-center gap-1.5 text-green-600">
                {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <div className="h-2 w-2 rounded-full bg-green-500" />}
                <span className="text-xs font-medium">{isBusy ? lt('Loading…') : lt('Ready')}</span>
              </div>
            ) : (
              <button
                type="button"
                disabled={isBusy}
                onClick={(event) => { event.stopPropagation(); onDownload(); }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
              >
                {isBusy ? <span className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" />{lt('Downloading…')}</span> : lt('Download')}
              </button>
            )}
          </div>
        </div>
        {isBusy && (
          <div className="mt-3 border-t border-gray-200 pt-3">
            <div className="mb-2 flex items-center justify-between text-sm font-medium text-blue-600">
              <span>{isReady ? lt('Loading model…') : lt('Downloading model…')}</span>
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
