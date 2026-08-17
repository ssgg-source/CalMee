# CalMee Edition Boundaries

This document is the product and code-ownership boundary between the public
CalMee repository and the private CalMee Pro product.

## Governing rules

1. The public repository is the canonical upstream for shared functionality.
2. A feature required to record, transcribe, review, and export one meeting is
   a community feature unless it depends on a paid external service.
3. CalMee Pro may depend on community modules. Community modules must never
   import, reference, or require Pro modules.
4. Pro code is not hidden inside the public repository with a visual flag. It
   lives in the private Pro repository behind documented extension interfaces.
5. Security fixes and generally useful bug fixes are made in the public upstream
   first, then merged into Pro.

## Community edition

### Recording and import

- Microphone and system-audio recording where the operating system permits it
- Recording-only mode without loading an ASR model
- Import of common audio and video formats
- Recovery of interrupted local recordings
- Basic floating recording controls and timestamped meeting notes

### Transcription

- Whisper and Parakeet support inherited from the upstream foundation
- FunASR, Paraformer, SenseVoice, and Qwen3-ASR adapters
- First-use model download and local model lifecycle management
- Local single-speaker and meeting modes
- VAD, punctuation, ITN, timestamps, hotwords, and segment merging
- Local diarization, speaker-count correction, and manual speaker assignment
- Basic local voiceprint storage and an auditable manual correction path
- Raw, speaker-organized, and AI-refined transcript versions

### Meeting workspace

- Editable title, time, tags, and local audio attachment
- Audio playback and transcript synchronization
- Raw transcript, smart record, meeting summary, and speech summary documents
- Markdown editing, save, copy, export, and local full-text search
- Background jobs with progress, cancellation, and recovery

### AI and models

- Local language-model support
- Generic OpenAI-compatible bring-your-own-key connection
- Open adapters for commonly used cloud providers when the user supplies a key
- A safe default transcript-refinement harness
- Basic smart-record, summary, action-item, and speech-summary templates
- User-created templates stored locally

### Local data

- Meeting dashboard and batch deletion
- People, speaker aliases, voiceprint samples, and hotword management
- Optional evidence-backed profile for one person, generated from confirmed local statements
- Hotword tags, enable/disable state, frequency statistics, and import/export
- Local calendar and standards-based CalDAV support
- English and Simplified Chinese interfaces

## CalMee Pro

Pro is differentiated by maintained outcomes and connected workflows, not by
disabling the basic recorder or local ASR engine.

### Planned Pro capabilities

- Official signed/notarized installers, automatic updates, and priority support
- Tested model presets and hardware-aware automatic pipeline selection
- Curated high-quality harness packs, industry templates, and regression evals
- Advanced cross-meeting identity learning with confidence review and rollback
- Cross-person, team, and organization-level longitudinal meeting intelligence
- Meeting Wiki/RAG, citations, semantic retrieval, and knowledge lifecycle tools
- Commercial note-service connectors such as Dedao Brain
- Task, project-management, and enterprise calendar connectors
- Encrypted multi-device sync, backup, team spaces, and administration
- Managed cloud inference or bundled usage plans if offered in the future

### Features that must not enter the public repository by accident

- Provider credentials, signing certificates, updater secrets, or hosted endpoints
- Proprietary prompts, eval datasets, ranking rules, or licensed template packs
- Private service connectors and account entitlement logic
- Customer support tooling, analytics destinations, or commercial deployment code

## Decision test for a new feature

1. Is it necessary to complete one local meeting from audio to an editable result?
   If yes, it belongs in Community.
2. Is it a reusable engine, data model, security fix, or accessibility improvement?
   If yes, prefer Community.
3. Does it depend on maintained cloud infrastructure, a commercial connector,
   organization-wide data, or proprietary quality assets? If yes, it belongs in Pro.
4. Would placing it in Pro force Community to duplicate core logic? If yes, first
   extract the reusable foundation into Community and keep only the extension in Pro.

## First public alpha exclusions

The first public alpha should not advertise unfinished or unverified features,
even when foundational code exists. Experimental AI participant profiles,
commercial note-service imports, hosted sync, and managed cloud services remain
outside the public-alpha product surface until their privacy and quality behavior
has been reviewed.
