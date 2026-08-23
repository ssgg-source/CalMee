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

FunASR toolkit source and pretrained model weights are licensed separately. CalMee does not commit or bundle model weights or a Python/FunASR/PyTorch runtime. After explicit first-use confirmation, the app installs a target-native isolated runtime below its identifier-specific application-data directory. The installer generates `third-party/python-packages.json`, copies package license/notice files below `third-party/licenses`, and retains the CPython license and generated notice beside the installed runtime. Model weights remain separate opt-in downloads, and each model card governs use and redistribution.

Representative models may include Paraformer, SenseVoice, FSMN-VAD, CT-Transformer punctuation, and CAM++. Review each license independently before distribution. SenseVoice model cards, in particular, reference the FunASR Model License rather than the toolkit MIT License.

## ModelScope

- Project: ModelScope SDK
- License: Apache License 2.0
- Source: https://github.com/modelscope/modelscope

## whisper.cpp and whisper-rs

CalMee retains optional Whisper-compatible transcription code and dependencies. Their copyright and license files must remain available when those components are distributed.

## FFmpeg

CalMee uses an external FFmpeg binary for media conversion. FFmpeg builds may be LGPL or GPL depending on configuration. A release must publish the exact binary provenance, source/build information, and notices required by that build.

## Installed CPython and Python dependency inventory

The first-use interpreter is pinned to an exact target-native CPython version.
Its `LICENSE.txt` is retained as `third-party/CPYTHON-LICENSE.txt`. Every
installed Python distribution—including PyTorch, torchaudio, FunASR,
ModelScope, and all transitive packages—is recorded with its exact version,
license metadata, project URL, and copied license files in the generated
runtime inventory. The runtime manifest records and verifies that inventory's
SHA-256 hash.

## Other dependencies

Rust crates and npm packages retain their own licenses. Before a public binary
release, generate their inventories from `Cargo.lock` and the pnpm lockfile and
include every required notice. The Python inventory is generated automatically
inside the hash-locked installed runtime.
