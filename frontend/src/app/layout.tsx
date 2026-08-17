'use client'

import './globals.css'
import Sidebar from '@/components/Sidebar'
import { SidebarProvider } from '@/components/Sidebar/SidebarProvider'
import MainContent from '@/components/MainContent'
import { Toaster, toast } from 'sonner'
import "sonner/dist/styles.css"
import { Suspense, useState, useEffect, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RecordingStateProvider } from '@/contexts/RecordingStateContext'
import { OllamaDownloadProvider } from '@/contexts/OllamaDownloadContext'
import { TranscriptProvider } from '@/contexts/TranscriptContext'
import { ConfigProvider } from '@/contexts/ConfigContext'
import { OnboardingProvider } from '@/contexts/OnboardingContext'
import { OnboardingFlow } from '@/components/onboarding'
import { DownloadProgressToastProvider } from '@/components/shared/DownloadProgressToast'
import { BackgroundAiTaskMonitor } from '@/components/shared/BackgroundAiTaskMonitor'
import { UpdateCheckProvider } from '@/components/UpdateCheckProvider'
import { RecordingPostProcessingProvider } from '@/contexts/RecordingPostProcessingProvider'
import { ImportAudioDialog, ImportDropOverlay } from '@/components/ImportAudio'
import { ImportDialogProvider } from '@/contexts/ImportDialogContext'
import { isAudioExtension, getAudioFormatsDisplayList } from '@/constants/audioFormats'
import { MeetingTabs } from '@/components/MeetingTabs'
import { LanguageProvider } from '@/contexts/LanguageContext'
import { usePathname } from 'next/navigation'
import { appCacheDir, join } from '@tauri-apps/api/path'
import { mkdir, writeFile } from '@tauri-apps/plugin-fs'

type DatabaseStartupStatus =
  | { status: 'initializing' }
  | { status: 'ready' }
  | { status: 'failed'; message: string };


// WKWebView may retain a development webpack runtime while Tauri restarts the
// native process. Register recovery in the server-rendered <head>, before any
// Next client chunk runs, so even a failed app/layout.js can recover itself.
const chunkRecoveryScript = `
(function () {
  var marker = 'calmee.chunk-recovery';
  function isChunkFailure(value) {
    var message = value && (value.message || value.reason && value.reason.message || String(value.reason || value));
    return /ChunkLoadError|Loading chunk|_next\\/static\\/chunks/i.test(String(message || ''));
  }
  function recover(value) {
    if (!isChunkFailure(value)) return;
    var now = Date.now();
    var previous = 0;
    try { previous = Number(sessionStorage.getItem(marker) || 0); } catch (_) {}
    if (now - previous < 12000) return;
    try { sessionStorage.setItem(marker, String(now)); } catch (_) {}
    var url = new URL(window.location.href);
    url.searchParams.set('__calmee_chunk_reload', String(now));
    window.location.replace(url.toString());
  }
  window.addEventListener('error', function (event) {
    var source = event && event.target && event.target.src;
    recover(source && /_next\\/static\\/chunks/.test(source) ? new Error('Loading chunk failed: ' + source) : event.error || event.message);
  }, true);
  window.addEventListener('unhandledrejection', function (event) { recover(event); });

})();`;

// Module-level component — stable reference across RootLayout re-renders.
// Defined here (not inside RootLayout) so React never sees a new function type
// on re-render, which would cause unmount/remount and break initialization logic.
function ConditionalImportDialog({
  showImportDialog,
  handleImportDialogClose,
  importFilePath,
  importRecordedAt,
}: {
  showImportDialog: boolean;
  handleImportDialogClose: (open: boolean) => void;
  importFilePath: string | null;
  importRecordedAt: string | null;
}) {
  return (
    <ImportAudioDialog
      open={showImportDialog}
      onOpenChange={handleImportDialogClose}
      preselectedFile={importFilePath}
      preselectedRecordedAt={importRecordedAt}
    />
  );
}

function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  if (pathname === '/recording-overlay') {
    return <div className="h-screen overflow-hidden bg-transparent">{children}</div>
  }
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f8f7fb]">
      <Suspense fallback={<div className="h-11 shrink-0 bg-[#e7e7eb]" />}>
        <MeetingTabs />
      </Suspense>
      <div className="min-h-0 flex-1 overflow-hidden [&>div]:!h-full">
        <div className="flex h-full"><Sidebar /><MainContent>{children}</MainContent></div>
      </div>
    </div>
  )
}

function DatabaseStartupScreen({ status }: { status: DatabaseStartupStatus }) {
  const failed = status.status === 'failed';
  return (
    <main className="flex h-screen items-center justify-center bg-[#f8f7fb] px-6 text-slate-900">
      <section className="w-full max-w-xl rounded-3xl border border-violet-100 bg-white p-8 shadow-sm">
        <p className="text-sm font-medium text-violet-600">CalMee</p>
        <h1 className="mt-2 text-2xl font-semibold">
          {failed ? '无法打开本地数据' : '正在准备本地数据…'}
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          {failed
            ? 'CalMee 没有进入功能页面，以避免在数据库未就绪时产生误导性错误。你的原数据库没有被修改。'
            : '首次启动会在开源版专属目录中创建全新的公共数据库。'}
        </p>
        {failed && (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-xs font-semibold text-red-700">启动详情</p>
            <p className="mt-2 break-words font-mono text-xs leading-5 text-red-700">{status.message}</p>
          </div>
        )}
        {failed && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 h-10 rounded-xl bg-violet-600 px-5 text-sm font-medium text-white hover:bg-violet-700"
          >
            重新尝试
          </button>
        )}
      </section>
    </main>
  );
}

// export { metadata } from './metadata'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingCompleted, setOnboardingCompleted] = useState(false)
  const [databaseStartup, setDatabaseStartup] = useState<DatabaseStartupStatus>({ status: 'initializing' })

  // Import audio state
  const [showDropOverlay, setShowDropOverlay] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importFilePath, setImportFilePath] = useState<string | null>(null)
  const [importRecordedAt, setImportRecordedAt] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const check = async () => {
      try {
        const status = await invoke<DatabaseStartupStatus>('get_database_startup_status');
        if (cancelled) return;
        setDatabaseStartup(status);
        if (status.status === 'initializing') timer = window.setTimeout(check, 250);
      } catch (error) {
        if (!cancelled) setDatabaseStartup({ status: 'failed', message: String(error) });
      }
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [])

  useEffect(() => {
    // A stable render proves the new webpack graph loaded successfully. Clear
    // the throttle so a genuinely separate future hot-reload failure can heal.
    const timer = window.setTimeout(() => {
      try { window.sessionStorage.removeItem('calmee.chunk-recovery'); } catch {}
      const url = new URL(window.location.href);
      if (url.searchParams.has('__calmee_chunk_reload')) {
        url.searchParams.delete('__calmee_chunk_reload');
        window.history.replaceState({}, '', url.toString());
      }
    }, 2500);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    // Check onboarding status first
    invoke<{ completed: boolean } | null>('get_onboarding_status')
      .then((status) => {
        const isComplete = status?.completed ?? false
        setOnboardingCompleted(isComplete)

        if (!isComplete) {
          console.log('[Layout] Onboarding not completed, showing onboarding flow')
          setShowOnboarding(true)
        } else {
          console.log('[Layout] Onboarding completed, showing main app')
        }
      })
      .catch((error) => {
        console.error('[Layout] Failed to check onboarding status:', error)
        // Default to showing onboarding if we can't check
        setShowOnboarding(true)
        setOnboardingCompleted(false)
      })
  }, [])

  // Disable context menu in production
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') {
      const handleContextMenu = (e: MouseEvent) => e.preventDefault();
      document.addEventListener('contextmenu', handleContextMenu);
      return () => document.removeEventListener('contextmenu', handleContextMenu);
    }
  }, []);
  useEffect(() => {
    // Listen for tray recording toggle request
    const unlisten = listen('request-recording-toggle', () => {
      console.log('[Layout] Received request-recording-toggle from tray');

      if (showOnboarding) {
        toast.error("Please complete setup first", {
          description: "You need to finish onboarding before you can start recording."
        });
      } else {
        // If in main app, forward to useRecordingStart via window event
        console.log('[Layout] Forwarding to start-recording-from-sidebar');
        window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [showOnboarding]);

  // Handle file drop for audio import
  const handleFileDrop = useCallback((paths: string[], recordedAt?: string | null) => {
    // Find the first audio file
    const audioFile = paths.find(p => {
      const ext = p.split('.').pop()?.toLowerCase();
      return !!ext && isAudioExtension(ext);
    });

    if (audioFile) {
      console.log('[Layout] Audio file dropped:', audioFile);
      setImportFilePath(audioFile);
      setImportRecordedAt(recordedAt || null);
      setShowImportDialog(true);
    } else if (paths.length > 0) {
      toast.error('Please drop an audio file', {
        description: `Supported formats: ${getAudioFormatsDisplayList()}`
      });
    }
  }, []);

  // The macOS Voice Memos app exports a recording as an NSFilePromise rather
  // than an existing filesystem path. Tauri's native path-only drop handler
  // consumes that drag before WebKit can fulfil the promise, producing an empty
  // paths array. Native drag/drop is disabled for the main window in
  // tauri.conf.json, so WebKit can materialize both promised Voice Memo items
  // and regular Finder files as File objects here. Stream them to AppCache,
  // then reuse the normal path-based import workflow.
  useEffect(() => {
    if (showOnboarding) return; // Don't handle drops during onboarding

    let dragDepth = 0;

    const containsFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const onDragEnter = (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setShowDropOverlay(true);
    };

    const onDragOver = (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setShowDropOverlay(true);
    };

    const onDragLeave = (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setShowDropOverlay(false);
    };

    const onDrop = async (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setShowDropOverlay(false);

      const files = Array.from(event.dataTransfer?.files ?? []);
      const audioFile = files.find(file => {
        const ext = file.name.split('.').pop()?.toLowerCase();
        return Boolean((ext && isAudioExtension(ext)) || file.type.startsWith('audio/'));
      });
      if (!audioFile) {
        toast.error('Please drop an audio file', {
          description: `Supported formats: ${getAudioFormatsDisplayList()}`
        });
        return;
      }

      try {
        const cacheRoot = await appCacheDir();
        const dropFolder = await join(cacheRoot, 'dropped-audio');
        await mkdir(dropFolder, { recursive: true });
        const safeName = audioFile.name.replace(/[^\p{L}\p{N}._ -]+/gu, '_') || 'Voice Memo.m4a';
        const cachedPath = await join(dropFolder, `${Date.now()}-${safeName}`);
        await writeFile(cachedPath, audioFile.stream() as ReadableStream<Uint8Array>);
        handleFileDrop([cachedPath], audioFile.lastModified > 0 ? new Date(audioFile.lastModified).toISOString() : null);
      } catch (error) {
        console.error('[Layout] Failed to receive dropped audio item:', error);
        toast.error('Failed to import the dropped recording', {
          description: error instanceof Error ? error.message : String(error)
        });
      }
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [showOnboarding, handleFileDrop]);

  // Handle import dialog close
  const handleImportDialogClose = useCallback((open: boolean) => {
    setShowImportDialog(open);
    if (!open) {
      setImportFilePath(null);
      setImportRecordedAt(null);
    }
  }, []);

  // Handler for ImportDialogProvider - opens import dialog from any child component
  const handleOpenImportDialog = useCallback((filePath?: string | null) => {
    setImportFilePath(filePath ?? null);
    setImportRecordedAt(null);
    setShowImportDialog(true);
  }, []);

  const handleOnboardingComplete = () => {
    console.log('[Layout] Onboarding completed, reloading app')
    setShowOnboarding(false)
    setOnboardingCompleted(true)
    // Optionally reload the window to ensure all state is fresh
    window.location.reload()
  }

  return (
    <html lang="en">
      <head><script dangerouslySetInnerHTML={{ __html: chunkRecoveryScript }} /></head>
      <body className="font-sans antialiased">
        <LanguageProvider>
          {databaseStartup.status !== 'ready' ? (
            <DatabaseStartupScreen status={databaseStartup} />
          ) : <RecordingStateProvider>
            <TranscriptProvider>
              <ConfigProvider>
                <OllamaDownloadProvider>
                  <OnboardingProvider>
                    <UpdateCheckProvider>
                      <SidebarProvider>
                        <TooltipProvider>
                          <RecordingPostProcessingProvider>
                            <ImportDialogProvider onOpen={handleOpenImportDialog}>
                              {/* Download progress toast provider - listens for background downloads */}
                              <DownloadProgressToastProvider />
                              <BackgroundAiTaskMonitor />

                              {/* Show onboarding or main app */}
                              {showOnboarding ? (
                                <OnboardingFlow onComplete={handleOnboardingComplete} />
                              ) : (
                                <AppFrame>{children}</AppFrame>
                              )}
                              {/* Import audio overlay and dialog */}
                              <ImportDropOverlay visible={showDropOverlay} />
                              <ConditionalImportDialog
                                showImportDialog={showImportDialog}
                                handleImportDialogClose={handleImportDialogClose}
                                importFilePath={importFilePath}
                                importRecordedAt={importRecordedAt}
                              />
                            </ImportDialogProvider>
                          </RecordingPostProcessingProvider>
                        </TooltipProvider>
                      </SidebarProvider>
                    </UpdateCheckProvider>
                  </OnboardingProvider>

                </OllamaDownloadProvider>
              </ConfigProvider>
            </TranscriptProvider>
          </RecordingStateProvider>}
        </LanguageProvider>

        <Toaster position="bottom-center" richColors closeButton />
      </body>
    </html>
  )
}
