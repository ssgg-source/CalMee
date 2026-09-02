"use client"

import { useEffect, useState, useRef } from "react"
import { Switch } from "./ui/switch"
import { FolderOpen } from "lucide-react"
import { invoke } from "@/lib/data-invoke"
import Analytics from "@/lib/analytics"
import AnalyticsConsentSwitch from "./AnalyticsConsentSwitch"
import { useConfig, NotificationSettings } from "@/contexts/ConfigContext"
import { InterfaceLanguageSettings } from "@/components/InterfaceLanguageSettings"
import { useLanguage } from "@/contexts/LanguageContext"
import { SettingsSection } from "@/components/layout/ProductPage"
import { ProductButton } from "@/components/ui/ProductControls"

export function PreferenceSettings() {
  const { lt } = useLanguage();
  const {
    notificationSettings,
    storageLocations,
    isLoadingPreferences,
    loadPreferences,
    updateNotificationSettings
  } = useConfig();

  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [previousNotificationsEnabled, setPreviousNotificationsEnabled] = useState<boolean | null>(null);
  const hasTrackedViewRef = useRef(false);

  // Lazy load preferences on mount (only loads if not already cached)
  useEffect(() => {
    loadPreferences();
    // Reset tracking ref on mount (every tab visit)
    hasTrackedViewRef.current = false;
  }, [loadPreferences]);

  // Track preferences viewed analytics on every tab visit (once per mount)
  useEffect(() => {
    if (hasTrackedViewRef.current) return;

    const trackPreferencesViewed = async () => {
      // Wait for notification settings to be available (either from cache or after loading)
      if (notificationSettings) {
        await Analytics.track('preferences_viewed', {
          notifications_enabled: notificationSettings.notification_preferences.show_recording_started ? 'true' : 'false'
        });
        hasTrackedViewRef.current = true;
      } else if (!isLoadingPreferences) {
        // If not loading and no settings available, track with default value
        await Analytics.track('preferences_viewed', {
          notifications_enabled: 'false'
        });
        hasTrackedViewRef.current = true;
      }
    };

    trackPreferencesViewed();
  }, [notificationSettings, isLoadingPreferences]);

  // Update notificationsEnabled when notificationSettings are loaded from global state
  useEffect(() => {
    if (notificationSettings) {
      // Notification enabled means both started and stopped notifications are enabled
      const enabled =
        notificationSettings.notification_preferences.show_recording_started &&
        notificationSettings.notification_preferences.show_recording_stopped;
      setNotificationsEnabled(enabled);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(enabled);
        setIsInitialLoad(false);
      }
    } else if (!isLoadingPreferences) {
      // If not loading and no settings, use default
      setNotificationsEnabled(true);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(true);
        setIsInitialLoad(false);
      }
    }
  }, [notificationSettings, isLoadingPreferences, isInitialLoad])

  useEffect(() => {
    // Skip update on initial load or if value hasn't actually changed
    if (isInitialLoad || notificationsEnabled === null || notificationsEnabled === previousNotificationsEnabled) return;
    if (!notificationSettings) return;

    const handleUpdateNotificationSettings = async () => {
      console.log("Updating notification settings to:", notificationsEnabled);

      try {
        // Update the notification preferences
        const updatedSettings: NotificationSettings = {
          ...notificationSettings,
          notification_preferences: {
            ...notificationSettings.notification_preferences,
            show_recording_started: notificationsEnabled,
            show_recording_stopped: notificationsEnabled,
          }
        };

        console.log("Calling updateNotificationSettings with:", updatedSettings);
        await updateNotificationSettings(updatedSettings);
        setPreviousNotificationsEnabled(notificationsEnabled);
        console.log("Successfully updated notification settings to:", notificationsEnabled);

        // Track notification preference change - only fires when user manually toggles
        await Analytics.track('notification_settings_changed', {
          notifications_enabled: notificationsEnabled.toString()
        });
      } catch (error) {
        console.error('Failed to update notification settings:', error);
      }
    };

    handleUpdateNotificationSettings();
  }, [notificationsEnabled, notificationSettings, isInitialLoad, previousNotificationsEnabled, updateNotificationSettings])

  const handleOpenFolder = async (folderType: 'database' | 'models' | 'recordings') => {
    try {
      switch (folderType) {
        case 'database':
          await invoke('open_database_folder');
          break;
        case 'models':
          await invoke('open_models_folder');
          break;
        case 'recordings':
          await invoke('open_recordings_folder');
          break;
      }

      // Track storage folder access
      await Analytics.track('storage_folder_opened', {
        folder_type: folderType
      });
    } catch (error) {
      console.error(`Failed to open ${folderType} folder:`, error);
    }
  };

  // Show loading only if we're actually loading and don't have cached data
  if (isLoadingPreferences && !notificationSettings && !storageLocations) {
    return <div className="h-28 animate-pulse rounded-xl bg-muted" aria-label={lt('Loading Preferences...')} />
  }

  // Show loading if notificationsEnabled hasn't been determined yet
  if (notificationsEnabled === null && !isLoadingPreferences) {
    return <div className="h-28 animate-pulse rounded-xl bg-muted" aria-label={lt('Loading Preferences...')} />
  }

  // Ensure we have a boolean value for the Switch component
  const notificationsEnabledValue = notificationsEnabled ?? false;
  const notificationsLabel = lt('Notifications');

  return (
    <div className="space-y-5">
      <InterfaceLanguageSettings />
      <SettingsSection
        title={notificationsLabel}
        description={lt('Enable or disable notifications of start and end of meeting')}
        actions={<Switch checked={notificationsEnabledValue} onCheckedChange={setNotificationsEnabled} />}
      />

      <SettingsSection
        title={lt('Data Storage Locations')}
        description={lt('View and access where CalMee stores your data')}
      >
        <div className="rounded-lg border border-border/70 bg-muted/35 p-4">
          <div className="mb-2 text-sm font-medium text-foreground">{lt('Application Data')}</div>
          <div className="mb-3 break-all font-mono text-xs text-muted-foreground">
            {storageLocations?.database || lt('Loading...')}
          </div>
          <div className="flex flex-wrap gap-2">
            <ProductButton size="sm" onClick={() => handleOpenFolder('database')}><FolderOpen className="h-4 w-4" />{lt('Open Folder')}</ProductButton>
            <ProductButton size="sm" onClick={() => handleOpenFolder('models')}><FolderOpen className="h-4 w-4" />{lt('Open Models Folder')}</ProductButton>
          </div>
        </div>
        <div className="mt-3 text-xs leading-5 text-muted-foreground">
          {lt('The application data location is managed by the operating system and cannot be changed here. The recording location can be changed under Recording.')}
        </div>
      </SettingsSection>

      <SettingsSection>
        <AnalyticsConsentSwitch />
      </SettingsSection>
    </div>
  )
}
