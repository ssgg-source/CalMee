import React, { useEffect, useState } from 'react';
import { invoke } from '@/lib/data-invoke';
import { BarChart3, Clock3, FileText, Loader2, Mic2, NotebookPen } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { Switch } from '@/components/ui/switch';

const LOCAL_USAGE_VISIBLE_KEY = 'calmee.local-usage.visible';
type Period = '7d' | '30d' | 'all';
type UsageStats = { meetings:number; recordings:number; transcriptCharacters:number; noteCharacters:number; transcribedSeconds:number };

export default function AnalyticsConsentSwitch() {
  const { lt, locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const [visible, setVisible] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem(LOCAL_USAGE_VISIBLE_KEY) === 'true');
  const [period, setPeriod] = useState<Period>('30d');
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(LOCAL_USAGE_VISIBLE_KEY, String(visible));
    if (!visible) { setStats(null); return; }
    const since = period === 'all' ? null : new Date(Date.now() - (period === '7d' ? 7 : 30) * 86400000).toISOString();
    setStatsLoading(true);
    void invoke<UsageStats>('api_get_local_usage_stats', { since })
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setStatsLoading(false));
  }, [visible, period]);

  const metrics = stats ? [
    [FileText, lt('Meetings'), stats.meetings.toLocaleString()],
    [Mic2, lt('Recordings'), stats.recordings.toLocaleString()],
    [Clock3, lt('Transcribed audio'), `${Math.round(stats.transcribedSeconds / 60).toLocaleString()} ${zh ? '分钟' : 'min'}`],
    [BarChart3, lt('Transcript characters'), stats.transcriptCharacters.toLocaleString()],
    [NotebookPen, lt('Note characters'), stats.noteCharacters.toLocaleString()],
  ] as const : [];

  return <div className="space-y-4">
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-foreground">{lt('Usage Analytics')}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{zh ? '只在本机统计 CalMee 的使用概览，不上传会议、录音、文字稿或笔记内容。' : 'Shows a local CalMee usage overview. Meeting, recording, transcript, and note content never leaves this device.'}</p>
      </div>
      <Switch checked={visible} onCheckedChange={setVisible} aria-label={zh ? '显示本机使用概览' : 'Show local usage overview'} />
    </div>
    {visible && <div className="border-t border-border/70 pt-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{lt('Local usage overview')}</span>
        <div className="flex rounded-lg bg-muted p-0.5">{(['7d','30d','all'] as Period[]).map(value => <button type="button" key={value} onClick={() => setPeriod(value)} className={`rounded-md px-2.5 py-1 text-[11px] transition ${period === value ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{value === '7d' ? lt('7 days') : value === '30d' ? lt('30 days') : lt('All time')}</button>)}</div>
      </div>
      {statsLoading ? <div className="flex h-20 items-center justify-center rounded-lg bg-muted/45"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div> : stats ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{metrics.map(([Icon,label,value]) => <div key={label} className="rounded-lg bg-muted/45 p-3"><Icon className="mb-2 h-4 w-4 text-primary"/><div className="text-lg font-semibold tabular-nums text-foreground">{value}</div><div className="mt-0.5 text-[10px] text-muted-foreground">{label}</div></div>)}</div> : <div className="rounded-lg bg-muted/45 px-4 py-5 text-sm text-muted-foreground">{zh ? '暂时无法读取本机使用数据，请稍后再试。' : 'Local usage data is temporarily unavailable. Try again later.'}</div>}
    </div>}
  </div>;
}
