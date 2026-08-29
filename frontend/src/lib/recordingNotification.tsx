import { toast } from 'sonner';
import Analytics from '@/lib/analytics';
import type { AppLocale } from '@/contexts/LanguageContext';

/**
 * Shows the recording notification toast with compliance message.
 * Checks user preferences and displays a dismissible toast with:
 * - notice to inform participants
 * - "Don't show again" checkbox
 * - Acknowledgment button
 *
 * @returns Promise<void> - Resolves when notification is shown or skipped
 */
export async function showRecordingNotification(locale: AppLocale): Promise<void> {
  try {
    const { Store } = await import('@tauri-apps/plugin-store');
    const store = await Store.load('preferences.json');
    const showNotification = await store.get<boolean>('show_recording_notification') ?? true;

    if (showNotification) {
      const zh = locale === 'zh-CN';
      toast.info(zh ? '录音已开始' : 'Recording started', {
        description: zh
          ? '请告知所有参会者本次会议正在录音。'
          : 'Inform all participants that this meeting is being recorded.',
        action: {
          label: zh ? '不再提示' : 'Do not show again',
          onClick: async () => {
            await store.set('show_recording_notification', false);
            await store.save();
            Analytics.trackButtonClick('recording_notification_disabled', 'toast');
          },
        },
        duration: 10000,
      });
    }
  } catch (notificationError) {
    console.error('Failed to show recording notification:', notificationError);
    // Don't fail the recording if notification fails
  }
}
