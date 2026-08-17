import { useState, useEffect, useCallback } from 'react';
import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';
import { useLanguage } from '@/contexts/LanguageContext';
import type { TranslationKey } from '@/i18n/locales/en';

const TEMPLATE_KEYS: Record<string, { name: TranslationKey; description: TranslationKey }> = {
  daily_standup: { name: 'templates.daily_standup.name', description: 'templates.daily_standup.description' },
  project_sync: { name: 'templates.project_sync.name', description: 'templates.project_sync.description' },
  psychatric_session: { name: 'templates.psychatric_session.name', description: 'templates.psychatric_session.description' },
  retrospective: { name: 'templates.retrospective.name', description: 'templates.retrospective.description' },
  sales_marketing_client_call: { name: 'templates.sales_marketing_client_call.name', description: 'templates.sales_marketing_client_call.description' },
  standard_meeting: { name: 'templates.standard_meeting.name', description: 'templates.standard_meeting.description' },
};

export function useTemplates() {
  const { t } = useLanguage();
  const [availableTemplates, setAvailableTemplates] = useState<Array<{
    id: string;
    name: string;
    description: string;
  }>>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('standard_meeting');

  // Fetch available templates on mount
  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        const templates = await invokeTauri('api_list_templates') as Array<{
          id: string;
          name: string;
          description: string;
        }>;
        console.log('Available templates:', templates);
        setAvailableTemplates(templates.map(template => {
          const keys = TEMPLATE_KEYS[template.id];
          return keys ? { ...template, name: t(keys.name), description: t(keys.description) } : template;
        }));
      } catch (error) {
        console.error('Failed to fetch templates:', error);
      }
    };
    fetchTemplates();
  }, [t]);

  // Handle template selection
  const handleTemplateSelection = useCallback((templateId: string, templateName: string) => {
    setSelectedTemplate(templateId);
    toast.success(t('templates.selected'), {
      description: t('templates.using', { name: templateName }),
    });
    Analytics.trackFeatureUsed('template_selected');
  }, [t]);

  return {
    availableTemplates,
    selectedTemplate,
    handleTemplateSelection,
  };
}
