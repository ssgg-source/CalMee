# Third-Party Notices

This document records significant third-party projects integrated into or used as a source for CalMee. Every component remains governed by its own license.

## Meetily

CalMee derived portions of its recording, desktop, transcript, and summary implementation from Meetily.

- Project: `Zackriya-Solutions/meetily`
- Copyright: Copyright (c) 2024 Zackriya Solutions
- License: MIT License
- Source: https://github.com/Zackriya-Solutions/meetily

The original copyright and MIT permission notice are preserved in `LICENSE.md`. CalMee is independent and is not affiliated with or endorsed by Zackriya Solutions.

## FunASR

- Toolkit: ModelScope FunASR
- Toolkit license: MIT License
- Source: https://github.com/modelscope/FunASR

FunASR toolkit source and pretrained model weights are licensed separately. CalMee does not commit or bundle model weights. Models are downloaded only after user selection, and each model card governs use and redistribution.

Representative models may include Paraformer, SenseVoice, FSMN-VAD, CT-Transformer punctuation, and CAM++. Review each license independently before distribution. SenseVoice model cards, in particular, reference the FunASR Model License rather than the toolkit MIT License.

## ModelScope

- Project: ModelScope SDK
- License: Apache License 2.0
- Source: https://github.com/modelscope/modelscope

## whisper.cpp and whisper-rs

CalMee retains optional Whisper-compatible transcription code and dependencies. Their copyright and license files must remain available when those components are distributed.

## FFmpeg

CalMee uses an external FFmpeg binary for media conversion. FFmpeg builds may be LGPL or GPL depending on configuration. A release must publish the exact binary provenance, source/build information, and notices required by that build.

## Other dependencies

Rust crates, npm packages, and Python packages retain their own licenses. Before a public binary release, generate a dependency license inventory from `Cargo.lock`, the pnpm lockfile, and `funasr_sidecar/requirements.txt`, then include every required notice.
