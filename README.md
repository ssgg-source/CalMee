# CalMee

CalMee is an open-source, local-first desktop app for recording, audio import,
speech transcription, and AI-assisted meeting notes.

The community edition is useful on its own. It is not a demo or a time-limited
build: users can record meetings, run local ASR, edit transcripts, and create
meeting documents with a local model or their own API credentials.

> Status: pre-release. The source repository is being prepared for its first
> public alpha. Do not rely on the current build as the only copy of an important
> recording.

## Community features

- Microphone and system-audio recording on supported platforms
- Audio and video import without forced background transcription
- Whisper, Parakeet, FunASR, SenseVoice, Paraformer, and Qwen3-ASR adapters
- Model download and local model management; model weights are not committed
- Single-speaker and meeting workflows, timestamps, punctuation, VAD, and hotwords
- Local speaker diarization, manual speaker correction, and local voiceprint data
- Raw, speaker-organized, and AI-refined transcript versions
- Smart records, meeting summaries, speech summaries, and editable Markdown output
- Local AI and bring-your-own-key cloud model connections
- Meeting dashboard, search, tags, calendar linking, and local data management
- English and Simplified Chinese interfaces

The exact edition boundary is documented in
[docs/EDITION_BOUNDARIES.md](./docs/EDITION_BOUNDARIES.md).

## CalMee Pro

CalMee Pro is a separate product built on the same open-source foundation. The
open repository remains the canonical home of shared code. Pro-specific code is
kept in a private repository and integrated through explicit extension points,
rather than by copying the community source.

See [docs/DUAL_REPOSITORY_WORKFLOW.md](./docs/DUAL_REPOSITORY_WORKFLOW.md).

## Privacy

Local ASR and local language models can run without uploading meeting content.
When a user explicitly chooses a cloud model or an external service, the relevant
content is sent to that provider. CalMee must show that boundary before the
operation begins. See [PRIVACY_POLICY.md](./PRIVACY_POLICY.md).

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

Model files are downloaded only after the user selects a model. The development
virtual environment, model caches, recordings, databases, credentials, and build
artifacts must never be committed.

Before publishing a binary, follow
[docs/OPEN_SOURCE_RELEASE_CHECKLIST.md](./docs/OPEN_SOURCE_RELEASE_CHECKLIST.md).
For the first repository launch, follow
[docs/FIRST_GITHUB_RELEASE.md](./docs/FIRST_GITHUB_RELEASE.md).

## Contributing

Please read [CONTRIBUTING.md](./CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md), and [SECURITY.md](./SECURITY.md).

## License and upstream attribution

CalMee is derived in part from the MIT-licensed Meetily project by Zackriya
Solutions. CalMee is independent and is not affiliated with or endorsed by
Zackriya Solutions.

The upstream copyright notice is retained. New community-edition code is also
released under the MIT License. Model weights and other dependencies can use
different licenses; consult [LICENSE.md](./LICENSE.md) and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
