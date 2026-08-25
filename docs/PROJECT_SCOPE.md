# CalMee Project Scope

CalMee is an open-source, local-first desktop application for recording,
transcription, and AI-assisted meeting documents. This page describes the
current public-alpha scope; it is not a promise that every experimental path is
ready for production use.

## Recording and import

- Microphone and system-audio recording where the operating system permits it
- Recording-only mode without loading an ASR model
- Import of common audio and video formats
- Recovery of interrupted local recordings
- Basic floating recording controls and timestamped meeting notes

## Transcription

- Whisper and Parakeet support inherited from the upstream foundation
- FunASR, Paraformer, SenseVoice, and Qwen3-ASR adapters
- First-use model download and local model lifecycle management
- Local single-speaker and meeting modes
- VAD, punctuation, ITN, timestamps, hotwords, and segment merging
- Local diarization, speaker-count correction, and manual speaker assignment
- Basic local voiceprint storage and an auditable manual correction path
- Raw, speaker-organized, and AI-refined transcript versions

## Meeting workspace

- Editable title, time, tags, and local audio attachment
- Audio playback and transcript synchronization
- Raw transcript, smart record, meeting summary, and speech summary documents
- Markdown editing, save, copy, export, and local full-text search
- Background jobs with progress, cancellation, and recovery

## AI and models

- Local language-model support
- Generic OpenAI-compatible bring-your-own-key connection
- Open adapters for commonly used cloud providers when the user supplies a key
- A safe default transcript-refinement harness
- Basic smart-record, summary, action-item, and speech-summary templates
- User-created templates stored locally

## Local data

- Meeting dashboard and batch deletion
- People, speaker aliases, voiceprint samples, and hotword management
- Optional evidence-backed person profiles generated from confirmed local statements
- Hotword tags, enable/disable state, frequency statistics, and import/export
- Local calendar and standards-based CalDAV support
- Explicit, user-authorized import from supported external note services (currently Dedao Brain)
- English and Simplified Chinese interfaces

## First public-alpha exclusions

The first public alpha does not advertise unfinished or unverified features,
even when foundational code exists. Hosted synchronization and enterprise-managed
services stay outside the product surface until their privacy and quality behavior
has been reviewed. CalMee has no separate commercial edition or entitlement gate.
