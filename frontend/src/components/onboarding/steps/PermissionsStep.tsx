import React, { useEffect, useState, useCallback } from 'react';
import { invoke } from '@/lib/data-invoke';
import { Mic, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { PermissionRow } from '../shared';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { toast } from 'sonner';

export function PermissionsStep() {
  const { setPermissionStatus, setPermissionsSkipped, permissions, completeOnboarding } = useOnboarding();
  const { locale } = useLanguage();
  const zh = locale === 'zh-CN';
  const [isPending, setIsPending] = useState(false);

  // Check permissions - only logs current state, doesn't auto-authorize
  // Actual permission checks are done via explicit user actions (clicking Enable)
  const checkPermissions = useCallback(async () => {
    console.log('[PermissionsStep] Current permission states:');
    console.log(`  - Microphone: ${permissions.microphone}`);
    console.log(`  - System Audio: ${permissions.systemAudio}`);
    // Don't auto-set permissions based on device availability
    // Permissions should only be set after explicit user action via Enable button
  }, [permissions.microphone, permissions.systemAudio]);

  // Check permissions on mount
  useEffect(() => {
    checkPermissions();
  }, [checkPermissions]);

  // Request microphone permission
  const handleMicrophoneAction = async () => {
    if (permissions.microphone === 'denied') {
      // Try to open system settings
      try {
        await invoke('open_system_settings');
      } catch {
        toast.info(zh ? '请在“系统设置 → 隐私与安全性 → 麦克风”中允许 CalMee 访问。' : 'Enable access in System Settings → Privacy & Security → Microphone.');
      }
      return;
    }

    setIsPending(true);
    try {
      console.log('[PermissionsStep] Triggering microphone permission...');
      const granted = await invoke<boolean>('trigger_microphone_permission');
      console.log('[PermissionsStep] Microphone permission result:', granted);

      if (granted) {
        setPermissionStatus('microphone', 'authorized');
      } else {
        // Permission was denied or dialog was dismissed
        setPermissionStatus('microphone', 'denied');
      }
    } catch (err) {
      console.error('[PermissionsStep] Failed to request microphone permission:', err);
      setPermissionStatus('microphone', 'denied');
    } finally {
      setIsPending(false);
    }
  };

  // Request system audio permission
  const handleSystemAudioAction = async () => {
    if (permissions.systemAudio === 'denied') {
      // Try to open system settings
      try {
        await invoke('open_system_settings');
      } catch {
        toast.info(zh ? '请在“系统设置 → 隐私与安全性 → 系统音频录制”中允许 CalMee 访问。' : 'Enable access in System Settings → Privacy & Security → Audio Capture.');
      }
      return;
    }

    setIsPending(true);
    try {
      console.log('[PermissionsStep] Triggering Audio Capture permission...');
      // Backend creates Core Audio tap, captures audio, and verifies it's not silence
      // Returns true if permission granted and audio verified, false if denied (silence)
      const granted = await invoke<boolean>('trigger_system_audio_permission_command');
      console.log('[PermissionsStep] System audio permission result:', granted);

      if (granted) {
        setPermissionStatus('systemAudio', 'authorized');
        console.log('[PermissionsStep] Audio Capture permission verified - audio is not silence');
      } else {
        // Permission was denied (audio is silence)
        setPermissionStatus('systemAudio', 'denied');
        console.log('[PermissionsStep] Audio Capture permission denied - audio is silence');
      }
    } catch (err) {
      console.error('[PermissionsStep] Failed to request system audio permission:', err);
      setPermissionStatus('systemAudio', 'denied');
    } finally {
      setIsPending(false);
    }
  };

  const handleFinish = async () => {
    try {
      await completeOnboarding();
      window.location.reload();
    } catch (error) {
      console.error('Failed to complete onboarding:', error);
    }
  };

  const handleSkip = async () => {
    setPermissionsSkipped(true);
    await handleFinish();
  };

  const allPermissionsGranted =
    permissions.microphone === 'authorized' &&
    permissions.systemAudio === 'authorized';

  return (
    <OnboardingContainer
      title={zh ? '设置录音权限' : 'Set recording permissions'}
      description={zh ? '仅在录音时使用麦克风和系统音频权限，也可以稍后再设置。' : 'These permissions are used only while recording. You can also configure them later.'}
      step={3}
      hideProgress={true}
      showNavigation={allPermissionsGranted}
      canGoNext={allPermissionsGranted}
    >
      <div className="max-w-lg mx-auto space-y-6">
        {/* Permission Rows */}
        <div className="space-y-4">
          {/* Microphone */}
          <PermissionRow
            icon={<Mic className="w-5 h-5" />}
            title={zh ? '麦克风' : 'Microphone'}
            description={zh ? '录制你在会议中的声音' : 'Records your voice during meetings'}
            status={permissions.microphone}
            isPending={isPending}
            onAction={handleMicrophoneAction}
          />

          {/* System Audio */}
          <PermissionRow
            icon={<Volume2 className="w-5 h-5" />}
            title={zh ? '系统音频' : 'System audio'}
            description={zh ? '录制电脑播放的会议声音' : 'Records meeting audio played by your computer'}
            status={permissions.systemAudio}
            isPending={isPending}
            onAction={handleSystemAudioAction}
          />
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col gap-3 pt-4">
          <Button onClick={handleFinish} disabled={!allPermissionsGranted} className="w-full h-11">
            {zh ? '完成设置' : 'Finish setup'}
          </Button>

          <button
            onClick={handleSkip}
            className="text-sm text-neutral-500 hover:text-neutral-700 transition-colors"
          >
            {zh ? '稍后再设置' : 'Set up later'}
          </button>

          {!allPermissionsGranted && (
            <p className="text-xs text-center text-muted-foreground">
              {zh ? '未授权前无法录音；之后可随时在设置中授权。' : 'Recording is unavailable until permission is granted. You can enable it later in Settings.'}
            </p>
          )}
        </div>
      </div>
    </OnboardingContainer>
  );
}
