'use client';

import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  CalendarDays,
  Info,
  LayoutDashboard,
  Database,
  Mic2,
  Settings,
  Upload,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useLanguage } from '@/contexts/LanguageContext';
import { useSidebar } from './SidebarProvider';
import { openMeetingWorkspace } from '@/lib/meeting-window';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

const mainItems = [
  { href: '/', labelKey: 'nav.home', icon: LayoutDashboard },
  { href: '/recording', labelKey: 'nav.recording', icon: Mic2 },
  { href: '/upload', labelKey: 'nav.upload', icon: Upload },
  { href: '/calendar', labelKey: 'nav.calendar', icon: CalendarDays },
  { href: '/knowledge', labelKey: 'nav.knowledge', icon: Database },
] as const;

const footerItems = [
  { href: '/settings', labelKey: 'nav.settings', icon: Settings },
  { href: '/about', labelKey: 'nav.about', icon: Info },
] as const;

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { t, locale } = useLanguage();
  const { refetchMeetings } = useSidebar();
  const [creatingMeeting, setCreatingMeeting] = useState(false);
  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  const navigate = (href: string) => {
    router.push(href);
  };

  const createBlankMeeting = async () => {
    if (creatingMeeting) return;
    setCreatingMeeting(true);
    try {
      const result = await invoke<{ meeting_id: string }>('api_save_transcript', {
        meetingTitle: t('meeting.untitled'),
        transcripts: [],
        folderPath: null,
      });
      await refetchMeetings();
      await openMeetingWorkspace(result.meeting_id, url => router.push(url), {
        source: 'calmee',
        title: t('meeting.untitled'),
      });
    } catch (error) {
      reportTechnicalError('meeting-create', error);
      toast.error(t('meeting.createFailed'), { description: toUserFacingError(error, locale).message });
    } finally {
      setCreatingMeeting(false);
    }
  };

  const itemButton = ({ href, labelKey, icon: Icon }: (typeof mainItems)[number] | (typeof footerItems)[number]) => {
    const label = t(labelKey);
    return (
    <Tooltip key={href} delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={() => navigate(href)}
          className={`group flex h-11 w-11 items-center justify-center rounded-2xl transition-colors ${
            isActive(href)
              ? 'bg-violet-100 text-violet-700 shadow-sm'
              : 'text-slate-500 hover:bg-violet-50 hover:text-violet-700'
          }`}
        >
          <Icon className="h-5 w-5" strokeWidth={isActive(href) ? 2.25 : 1.8} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>{label}</TooltipContent>
    </Tooltip>
    );
  };

  return (
    <TooltipProvider>
      <aside className="absolute bottom-0 left-0 top-0 z-40 flex w-20 flex-col items-center border-r border-violet-100 bg-white/95 pb-4 pt-9 shadow-[4px_0_24px_rgba(76,29,149,0.04)] backdrop-blur">
        <button
          type="button"
          onClick={() => void createBlankMeeting()}
          disabled={creatingMeeting}
          className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl transition-transform hover:scale-105 disabled:cursor-wait disabled:opacity-60"
          aria-label={t('meeting.createBlank')}
          title={t('meeting.createBlank')}
        >
          <Image
            src="/calmee-awake-cat.png"
            alt="CalMee"
            width={48}
            height={48}
            priority
            className="h-12 w-12 object-contain"
          />
        </button>

        <nav className="flex flex-1 flex-col items-center gap-2" aria-label={t('nav.main')}>
          {mainItems.map(itemButton)}
        </nav>

        <nav className="flex flex-col items-center gap-2 border-t border-violet-100 pt-4" aria-label={t('nav.secondary')}>
          {footerItems.map(itemButton)}
        </nav>
      </aside>
    </TooltipProvider>
  );
}
