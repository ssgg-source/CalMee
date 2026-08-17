import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranscripts } from "@/contexts/TranscriptContext";
import { useSidebar } from "@/components/Sidebar/SidebarProvider";
import { useConfig } from "@/contexts/ConfigContext";
import {
  RecordingStatus,
  useRecordingState,
} from "@/contexts/RecordingStateContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { recordingService } from "@/services/recordingService";
import { clearLiveMeetingNotes } from "@/lib/live-meeting-notes";
import Analytics from "@/lib/analytics";
import { showRecordingNotification } from "@/lib/recordingNotification";
import { liveCaptionsEnabled as readLiveCaptionsEnabled } from "@/lib/live-captions";

interface UseRecordingStartReturn {
  handleRecordingStart: () => Promise<void>;
  isAutoStarting: boolean;
}

export function useRecordingStart(
  isRecording: boolean,
  setIsRecording: (value: boolean) => void,
  showModal?: (name: "modelSelector", message?: string) => void,
): UseRecordingStartReturn {
  const [isAutoStarting, setIsAutoStarting] = useState(false);
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const { clearTranscripts, setMeetingTitle } = useTranscripts();
  const { setIsMeetingActive } = useSidebar();
  const { selectedDevices, selectedLanguage } = useConfig();
  const { setStatus } = useRecordingState();

  const generateMeetingTitle = useCallback(() => {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, "0");
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const year = String(now.getFullYear()).slice(-2);
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    return `Meeting ${day}_${month}_${year}_${hours}_${minutes}_${seconds}`;
  }, []);

  const start = useCallback(
    async (source: "recording_page" | "sidebar_auto" | "sidebar_direct") => {
      if (isRecording || isAutoStarting) return;
      setIsAutoStarting(true);
      setStatus(
        RecordingStatus.STARTING,
        zh ? "正在启动录音…" : "Starting recording…",
      );

      const title = generateMeetingTitle();
      setMeetingTitle(title);
      clearTranscripts();
      clearLiveMeetingNotes();

      try {
        const liveCaptionsEnabled = readLiveCaptionsEnabled();
        await recordingService.setLiveCaptionEnabled(liveCaptionsEnabled);
        // The backend validates and loads the actually configured provider.
        // Do not initialize Parakeet here: it may not be the selected engine.
        await recordingService.startRecordingWithDevices(
          selectedDevices?.micDevice || null,
          selectedDevices?.systemDevice || null,
          title,
        );
        sessionStorage.setItem(
          "recording_live_transcription",
          String(liveCaptionsEnabled),
        );
        sessionStorage.setItem("recording_live_transcription_is_preview", String(liveCaptionsEnabled));
        if (liveCaptionsEnabled) {
          sessionStorage.setItem(
            "recording_transcription_model",
            JSON.stringify({
              provider: "live-caption",
              model: "iic/SenseVoiceSmall",
              language: selectedLanguage,
              startedAt: new Date().toISOString(),
            }),
          );
        } else {
          sessionStorage.removeItem("recording_transcription_model");
        }
        setIsRecording(true);
        setIsMeetingActive(true);
        Analytics.trackButtonClick("start_recording", source);
        await showRecordingNotification();
      } catch (error) {
        sessionStorage.removeItem("recording_live_transcription");
        sessionStorage.removeItem("recording_live_transcription_is_preview");
        sessionStorage.removeItem("recording_transcription_model");
        const message = error instanceof Error ? error.message : String(error);
        setStatus(RecordingStatus.ERROR, message);
        setIsRecording(false);
        Analytics.trackButtonClick("start_recording_error", source);
        toast.error(zh ? "录音启动失败" : "Recording failed to start", {
          description: message,
        });
        if (/model|transcription|download|provider/i.test(message)) {
          showModal?.(
            "modelSelector",
            zh ? "请检查转写模型配置" : "Check transcription model settings",
          );
        }
        throw error;
      } finally {
        setIsAutoStarting(false);
      }
    },
    [
      clearTranscripts,
      generateMeetingTitle,
      isAutoStarting,
      isRecording,
      selectedDevices,
      selectedLanguage,
      setIsMeetingActive,
      setIsRecording,
      setMeetingTitle,
      setStatus,
      showModal,
      zh,
    ],
  );

  const handleRecordingStart = useCallback(
    () => start("recording_page"),
    [start],
  );

  useEffect(() => {
    if (
      sessionStorage.getItem("autoStartRecording") !== "true" ||
      isRecording ||
      isAutoStarting
    )
      return;
    sessionStorage.removeItem("autoStartRecording");
    void start("sidebar_auto");
  }, [isAutoStarting, isRecording, start]);

  useEffect(() => {
    const handleDirectStart = () => void start("sidebar_direct");
    window.addEventListener("start-recording-from-sidebar", handleDirectStart);
    return () =>
      window.removeEventListener(
        "start-recording-from-sidebar",
        handleDirectStart,
      );
  }, [start]);

  return { handleRecordingStart, isAutoStarting };
}
