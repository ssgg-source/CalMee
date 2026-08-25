# CalMee feedback infrastructure

This document is the migration contract for prompts, task progress, errors, and legacy Meetily UI.

## Product hierarchy

1. Silent inline state is used for auto-save and ordinary loading.
2. A short toast is used only for the immediate result of a direct user action.
3. A long-running task stays inline on the page where it started.
4. A global task notification appears only when the user leaves that page, and one task owns one stable notification ID.
5. A modal is reserved for destructive actions, permissions, data migration, recovery, or a decision that blocks progress.

Progress is determinate only when the backend reports measurable completed work. Indeterminate stages show a stage label without a fabricated percentage.

## Error contract

Primary UI copy contains a user action and never exposes SQL, Python tracebacks, provider payloads, file-system paths, or Tauri command internals. `src/lib/feedback.ts` maps technical failures to stable user-facing categories. The original error is retained in the developer console for diagnosis.

Startup failures are the exception: technical detail is available behind a collapsed disclosure because the workspace cannot open. Existing data must never be changed as part of error recovery.

## First run and model choice

First-run setup does not download, verify, or preselect transcription or summary models. CalMee starts in recording-only mode. Users may later choose local ASR/AI models or a configured cloud provider in Settings. Model weights are independently downloadable and removable.

## Ownership now

- `BackgroundAiTaskMonitor` owns global summary, organization, retranscription, refinement, and profile task feedback.
- `DownloadProgressToastProvider` owns global Parakeet and built-in summary-model download feedback.
- Model settings own selection, readiness, retry, load, and deletion state inline.
- The database startup gate owns startup failure and prevents providers from invoking commands before `AppState` is ready.

## Migration backlog

- Move calendar page, meeting workspace, data migration, import/recovery, and remaining settings screens away from raw error descriptions.
- Replace legacy literal translation calls with typed keys.
- Consolidate FunASR/Qwen, Whisper, Parakeet, and built-in AI downloads into the same task registry.
- Remove the remaining live-transcript presentation only together with the recording workflow change, because the current recording stop/recovery hooks still consume transcript context state.
- Replace recovery and permission browser alerts with product dialogs.

Run `pnpm feedback:check` to prevent the legacy surface from growing while migration continues.
