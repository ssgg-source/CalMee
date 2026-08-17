# CalMee

[English](./README.md) · [简体中文](./README.zh-CN.md)

**A local-first, model-flexible desktop workspace for the complete meeting-notes workflow.**

CalMee connects the stages that are often split across separate tools: calendar
context, meeting capture, speech recognition, transcript refinement, AI-generated
minutes, and long-term meeting knowledge. Record a live meeting or import existing
audio/video, transcribe it with a local ASR engine, turn the transcript into editable
meeting documents with a local or cloud AI model, and link the result back to the
calendar event it belongs to.

CalMee is designed to be useful as an open-source application on its own. The
community edition is not a demo or a time-limited build.

> **Status:** pre-release. The repository is being prepared for its first public
> alpha. Do not rely on the current build as the only copy of an important recording.

## What makes CalMee different

### 1. One workflow, from calendar to minutes

CalMee is more than a recorder or a transcription front end. It provides a connected
workflow for:

1. bringing in meeting context from an on-device calendar or a standard CalDAV account;
2. recording microphone and system audio, or importing existing audio/video;
3. producing raw, speaker-organized, and AI-refined transcript versions;
4. generating editable meeting minutes, smart records, and speech documents; and
5. linking the finished notes back to the calendar event for later search and review.

This keeps the schedule, source recording, transcript, and final documents attached to
the same meeting instead of leaving them scattered across unrelated tools.

### 2. Local-first without locking you to one model

CalMee is model-flexible by design. Choose a local workflow for privacy and offline use,
or connect a cloud model with your own credentials when that better fits the task.

- **ASR adapters:** Whisper, Parakeet, FunASR, SenseVoice, Paraformer, and Qwen3-ASR
- **AI documents:** local language models and bring-your-own-key cloud providers
- **Workflow choice:** recording and importing do not have to be tied to one ASR or
  summarization provider

Model weights, credentials, recordings, and meeting databases remain outside the source
repository.

### 3. Chinese meeting transcription is a first-class workflow

Chinese support is not treated as a translated UI around an English-first pipeline.
CalMee includes a dedicated FunASR integration aimed at real Chinese meeting scenarios,
including:

- VAD, punctuation, timestamps, and configurable hotwords;
- lightweight single-speaker and CAM++ multi-speaker meeting modes;
- speaker-aware transcript organization and correction workflows;
- support for SenseVoice, Paraformer, Qwen3-ASR, and custom FunASR/ModelScope model IDs;
- local processing paths for both live recordings and imported media; and
- English and Simplified Chinese interfaces.

The goal is to make names, domain terminology, multiple speakers, and long-form Chinese
meetings practical to review and refine—not merely to expose a generic speech-to-text
button.

### 4. Calendar-aware meeting knowledge

CalMee can read supported on-device calendars and connect to standards-based CalDAV
servers. Meeting notes can be linked to events, while unlinked recordings and imports
remain visible in a meeting-notes inbox until they are organized. The result is a
searchable meeting workspace built around when and why a conversation happened.

## Core community features

- Microphone and system-audio recording on supported platforms
- Audio and video import without forced background transcription
- Local model download and management; model weights are not committed
- Timestamps, punctuation, VAD, hotwords, speaker diarization, and manual correction
- Raw, speaker-organized, and AI-refined transcript versions
- Smart records, meeting summaries, speech documents, and editable Markdown output
- Local AI and bring-your-own-key cloud model connections
- Meeting dashboard, search, tags, calendar linking, and local data management
- On-device macOS calendar support and standards-based CalDAV integration
- English and Simplified Chinese interfaces

The current public-alpha scope is documented in
[docs/PROJECT_SCOPE.md](./docs/PROJECT_SCOPE.md).

## Privacy

Local ASR and local language models can run without uploading meeting content. When a
user explicitly chooses a cloud model or an external service, the relevant content is
sent to that provider. CalMee must show that boundary before the operation begins. See
[PRIVACY_POLICY.md](./PRIVACY_POLICY.md).

## Development

Requirements for the current macOS development path:

- macOS and Xcode command-line tools
- Rust 1.77 or newer
- Node.js 24 LTS and pnpm
- Python 3.11 for the FunASR sidecar

```bash
git clone <your-calmee-repository-url>
cd CalMee
./scripts/setup-funasr.sh
cd frontend
pnpm install
pnpm run tauri:dev
```

Model files are downloaded only after the user selects a model. The development virtual
environment, model caches, recordings, databases, credentials, and build artifacts must
never be committed.

Before publishing a binary, follow
[docs/OPEN_SOURCE_RELEASE_CHECKLIST.md](./docs/OPEN_SOURCE_RELEASE_CHECKLIST.md).
For the first repository launch, follow
[docs/FIRST_GITHUB_RELEASE.md](./docs/FIRST_GITHUB_RELEASE.md).

## Contributing

Please read [CONTRIBUTING.md](./CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md), and [SECURITY.md](./SECURITY.md).

## License and upstream attribution

CalMee is derived in part from the MIT-licensed Meetily project by Zackriya Solutions.
CalMee is independent and is not affiliated with or endorsed by Zackriya Solutions.

The upstream copyright notice is retained. New community-edition code is also released
under the MIT License. Model weights and other dependencies can use different licenses;
consult [LICENSE.md](./LICENSE.md) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
