'use client';

import React, { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useRecordingStop } from '@/hooks/useRecordingStop';

/**
 * RecordingPostProcessingProvider
 *
 * This provider handles post-processing when recording stops from any source:
 * - Tray menu stop
 * - Global keyboard shortcut
 * - Overlay stop button
 * - Main UI stop button
 *
 * It listens for the 'recording-stop-complete' event from Rust backend
 * and triggers the full post-processing flow (save to database, navigate, analytics)
 * regardless of which page the user is currently on.
 */
export function RecordingPostProcessingProvider({ children }: { children: React.ReactNode }) {
  const overlayStopInProgress = useRef(false);
  // No-op functions since the global RecordingStateContext already handles state updates
  // These are only needed for the hook's local component state management
  const setIsRecording = () => { };
  const setIsRecordingDisabled = () => { };

  const {
    handleRecordingStop,
  } = useRecordingStop(setIsRecording, setIsRecordingDisabled);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    const setupListener = async () => {
      try {
        // Listen for recording-stop-complete event from Rust
        unlistenFn = await listen<boolean>('recording-stop-complete', (event) => {
          console.log('[RecordingPostProcessing] Received recording-stop-complete event:', event.payload);

          // Call the post-processing handler
          // event.payload is the callApi boolean (true for normal stops)
          handleRecordingStop(event.payload);
        });

        console.log('[RecordingPostProcessing] Event listener set up successfully');
      } catch (error) {
        console.error('[RecordingPostProcessing] Failed to set up event listener:', error);
      }
    };

    setupListener();

    return () => {
      if (unlistenFn) {
        console.log('[RecordingPostProcessing] Cleaning up event listener');
        unlistenFn();
      }
    };
  }, [handleRecordingStop]);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    const setup = async () => {
      unlistenFn = await listen('recording-overlay-stop-request', async () => {
        if (overlayStopInProgress.current) return;
        overlayStopInProgress.current = true;
        try {
          const result = await invoke<{
            folder_path?: string;
            meeting_name?: string;
          }>('stop_recording', {
            args: { save_path: '' },
          });
          if (result.folder_path) {
            sessionStorage.setItem('last_recording_folder_path', result.folder_path);
          }
          if (result.meeting_name) {
            sessionStorage.setItem('last_recording_meeting_name', result.meeting_name);
          }
          await handleRecordingStop(true);
        } catch (error) {
          console.error('[RecordingPostProcessing] Overlay stop failed:', error);
          await handleRecordingStop(false);
        } finally {
          overlayStopInProgress.current = false;
        }
      });
    };
    void setup();
    return () => unlistenFn?.();
  }, [handleRecordingStop]);

  return <>{children}</>;
}
