import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { FolderCog, FolderOpen } from 'lucide-react';
import { invoke } from '@/lib/data-invoke';
import { DeviceSelection, SelectedDevices } from '@/components/DeviceSelection';
import Analytics from '@/lib/analytics';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { SettingsSection } from '@/components/layout/ProductPage';
import { ProductButton } from '@/components/ui/ProductControls';
import { reportTechnicalError, toUserFacingError } from '@/lib/feedback';

export interface RecordingPreferences {
  save_folder: string;
  auto_save: boolean;
  file_format: string;
  preferred_mic_device: string | null;
  preferred_system_device: string | null;
}

interface RecordingSettingsProps {
  onSave?: (preferences: RecordingPreferences) => void;
}

export function RecordingSettings({ onSave }: RecordingSettingsProps) {
  const { lt, locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const [preferences, setPreferences] = useState<RecordingPreferences>({
    save_folder: '',
    auto_save: true,
    file_format: 'm4a',
    preferred_mic_device: null,
    preferred_system_device: null
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showRecordingNotification, setShowRecordingNotification] = useState(true);

  // Load recording preferences on component mount
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
        setPreferences(prefs);
      } catch (error) {
        console.error('Failed to load recording preferences:', error);
        // If loading fails, get default folder path
        try {
          const defaultPath = await invoke<string>('get_default_recordings_folder_path');
          setPreferences(prev => ({ ...prev, save_folder: defaultPath }));
        } catch (defaultError) {
          console.error('Failed to get default folder path:', defaultError);
        }
      } finally {
        setLoading(false);
      }
    };

    loadPreferences();
  }, []);

  // Load recording notification preference
  useEffect(() => {
    const loadNotificationPref = async () => {
      try {
        const { Store } = await import('@tauri-apps/plugin-store');
        const store = await Store.load('preferences.json');
        const show = await store.get<boolean>('show_recording_notification') ?? true;
        setShowRecordingNotification(show);
      } catch (error) {
        console.error('Failed to load notification preference:', error);
      }
    };
    loadNotificationPref();
  }, []);

  const handleAutoSaveToggle = async (enabled: boolean) => {
    const newPreferences = { ...preferences, auto_save: enabled };
    setPreferences(newPreferences);
    await savePreferences(newPreferences);

    // Track auto-save setting change
    await Analytics.track('auto_save_recording_toggled', {
      enabled: enabled.toString()
    });
  };

  const handleDeviceChange = async (devices: SelectedDevices) => {
    const newPreferences = {
      ...preferences,
      preferred_mic_device: devices.micDevice,
      preferred_system_device: devices.systemDevice
    };
    setPreferences(newPreferences);
    await savePreferences(newPreferences);

    // Track default device preference changes
    // Note: Individual device selection analytics are tracked in DeviceSelection component
    await Analytics.track('default_devices_changed', {
      has_preferred_microphone: (!!devices.micDevice).toString(),
      has_preferred_system_audio: (!!devices.systemDevice).toString()
    });
  };

  const handleOpenFolder = async () => {
    try {
      await invoke('open_recordings_folder');
    } catch (error) {
      console.error('Failed to open recordings folder:', error);
    }
  };

  const handleChooseFolder = async () => {
    try {
      const selected = await invoke<string | null>('select_recording_folder');
      if (!selected) return;
      const next = { ...preferences, save_folder: selected };
      setPreferences(next);
      await savePreferences(next);
    } catch (error) {
      reportTechnicalError('recording-folder-select', error);
      toast.error(zh ? '无法更改录音保存位置' : 'Could not change the recording location', {
        description: toUserFacingError(error, locale).message,
      });
    }
  };

  const handleNotificationToggle = async (enabled: boolean) => {
    try {
      setShowRecordingNotification(enabled);
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('preferences.json');
      await store.set('show_recording_notification', enabled);
      await store.save();
      toast.success(lt('Preference saved'));
      await Analytics.track('recording_notification_preference_changed', {
        enabled: enabled.toString()
      });
    } catch (error) {
      console.error('Failed to save notification preference:', error);
      toast.error(lt('Failed to save preference'));
    }
  };

  const savePreferences = async (prefs: RecordingPreferences) => {
    setSaving(true);
    try {
      await invoke('set_recording_preferences', { preferences: prefs });
      onSave?.(prefs);

      toast.success(lt('Preference saved'));
    } catch (error) {
      console.error('Failed to save recording preferences:', error);
      toast.error(lt('Failed to save device preferences'), {
        description: toUserFacingError(error, locale).message
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-28 rounded-xl bg-muted" />
        <div className="h-44 rounded-xl bg-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsSection
        title={lt('Recording Settings')}
        description={lt('Configure how your audio recordings are saved during meetings.')}
      >
        <div className="divide-y divide-border/70 border-t border-border/70">
          <div className="flex items-center justify-between gap-6 py-4">
            <div className="flex-1">
              <div className="text-sm font-medium text-foreground">{lt('Save Audio Recordings')}</div>
              <div className="mt-1 text-sm text-muted-foreground">
            {lt('Automatically save audio files when recording stops')}
              </div>
            </div>
            <Switch
              checked={preferences.auto_save}
              onCheckedChange={handleAutoSaveToggle}
              disabled={saving}
            />
          </div>

          {preferences.auto_save ? (
            <div className="py-4">
              <div className="mb-2 text-sm font-medium text-foreground">{lt('Save Location')}</div>
              <div className="mb-3 break-all text-sm text-muted-foreground">
                {preferences.save_folder || lt('Default folder')}
              </div>
              <div className="flex flex-wrap gap-2">
                <ProductButton size="sm" onClick={() => void handleChooseFolder()}><FolderCog className="h-4 w-4" />{zh ? '更改位置' : 'Change location'}</ProductButton>
                <ProductButton size="sm" onClick={handleOpenFolder}><FolderOpen className="h-4 w-4" />{lt('Open Folder')}</ProductButton>
              </div>
              <div className="mt-3 grid gap-1 rounded-lg bg-muted/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                <div><strong className="text-foreground">{zh ? '目录命名：' : 'Folder name:'}</strong>{zh ? '会议标题_YYYY-MM-DD_HH-MM' : 'Meeting title_YYYY-MM-DD_HH-MM'}</div>
                <div><strong className="text-foreground">{zh ? '录音文件：' : 'Audio file:'}</strong>YYYY-MM-DD_HH-MM.m4a (AAC)</div>
                <div>{zh ? '录音中断或接续时，各段会先独立保留，结束后合成为可拖动播放的 M4A。' : 'Interrupted and continued segments are kept separately first, then finalized into a seekable M4A.'}</div>
              </div>
            </div>
          ) : (
            <div className="py-4">
              <div className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm leading-5 text-amber-900">
                {lt('Audio recording is disabled. Enable "Save Audio Recordings" to automatically save your meeting audio.')}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-6 py-4">
            <div className="flex-1">
              <div className="text-sm font-medium text-foreground">{lt('Recording Start Notification')}</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {lt('Show reminder to inform participants when recording starts')}
              </div>
            </div>
            <Switch
              checked={showRecordingNotification}
              onCheckedChange={handleNotificationToggle}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={lt('Default Audio Devices')}
        description={lt('Set your preferred microphone and system audio devices for recording. These will be automatically selected when starting new recordings.')}
      >
        <DeviceSelection
          selectedDevices={{
            micDevice: preferences.preferred_mic_device,
            systemDevice: preferences.preferred_system_device
          }}
          onDeviceChange={handleDeviceChange}
          disabled={saving}
        />
      </SettingsSection>
    </div>
  );
}
