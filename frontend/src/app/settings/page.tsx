'use client';

import React, { useState, useEffect } from 'react';
import { Settings2, Mic, Database as DatabaseIcon, SparkleIcon, CalendarDays, HardDriveDownload, Brain } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { TranscriptSettings } from '@/components/TranscriptSettings';
import { RecordingSettings } from '@/components/RecordingSettings';
import { PreferenceSettings } from '@/components/PreferenceSettings';
import { SummaryModelSettings } from '@/components/SummaryModelSettings';
import { CalendarSettings } from '@/components/CalendarSettings';
import { DataMigrationSettings } from '@/components/DataMigrationSettings';
import { DedaoSettings } from '@/components/DedaoSettings';
import { useConfig } from '@/contexts/ConfigContext';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useLanguage } from '@/contexts/LanguageContext';
import { ProductPage, ProductPageContent, ProductPageHeader } from '@/components/layout/ProductPage';

// Tabs configuration (constant)
const TABS = [
  { value: 'general', labelKey: 'settings.general', icon: Settings2 },
  { value: 'recording', labelKey: 'settings.recordings', icon: Mic },
  { value: 'Transcriptionmodels', labelKey: 'settings.transcription', icon: DatabaseIcon },
  { value: 'summaryModels', labelKey: 'settings.summary', icon: SparkleIcon },
  { value: 'calendar', labelKey: 'settings.calendar', icon: CalendarDays },
  { value: 'dedao', labelKey: 'settings.dedao', icon: Brain },
  { value: 'dataMigration', labelKey: 'settings.dataMigration', icon: HardDriveDownload }
] as const;

export default function SettingsPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const { transcriptModelConfig, setTranscriptModelConfig } = useConfig();

  const [activeTab, setActiveTab] = useState('general');

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested && TABS.some(tab => tab.value === requested)) setActiveTab(requested);
  }, []);

  // Load saved transcript configuration on mount
  useEffect(() => {
    const loadTranscriptConfig = async () => {
      try {
        const config = await invoke('api_get_transcript_config') as any;
        if (config) {
          console.log('Loaded saved transcript config:', config);
          setTranscriptModelConfig({
            provider: config.provider || 'localWhisper',
            model: config.model || 'large-v3',
            apiKey: config.apiKey || null
          });
        }
      } catch (error) {
        console.error('Failed to load transcript config:', error);
      }
    };
    loadTranscriptConfig();
  }, [setTranscriptModelConfig]);

  return (
    <ProductPage>
      <ProductPageHeader
        title={t('settings.title')}
        backLabel={t('settings.back')}
        onBack={() => router.back()}
      />
      <ProductPageContent className="overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} orientation="vertical" className="mx-auto grid h-full max-w-[1180px] grid-cols-[210px_minmax(0,1fr)]">
          <aside className="border-r border-border/80 bg-card/55 px-3 py-5">
            <TabsList className="flex h-auto w-full flex-col items-stretch justify-start gap-1 rounded-none bg-transparent p-0">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    className="h-10 w-full justify-start gap-3 rounded-lg border-0 bg-transparent px-3 text-[13px] text-muted-foreground shadow-none transition-colors hover:bg-accent/70 hover:text-foreground data-[state=active]:bg-accent data-[state=active]:font-medium data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.8} />
                    {t(tab.labelKey)}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </aside>
          <div className="min-h-0 overflow-y-auto px-8 pb-12 pt-7">
            <TabsContent value="general" className="m-0">
              <PreferenceSettings />
            </TabsContent>
            <TabsContent value="recording" className="m-0">
              <RecordingSettings />
            </TabsContent>
            <TabsContent value="Transcriptionmodels" className="m-0">
              <TranscriptSettings
                transcriptModelConfig={transcriptModelConfig}
                setTranscriptModelConfig={setTranscriptModelConfig}
              />
            </TabsContent>
            <TabsContent value="summaryModels" className="m-0">
              <SummaryModelSettings />
            </TabsContent>
            <TabsContent value="calendar" className="m-0"><CalendarSettings /></TabsContent>
            <TabsContent value="dedao" className="m-0"><DedaoSettings /></TabsContent>
            <TabsContent value="dataMigration" className="m-0"><DataMigrationSettings /></TabsContent>
          </div>
        </Tabs>
      </ProductPageContent>
    </ProductPage>
  );
};
