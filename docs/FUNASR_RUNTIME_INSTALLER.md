# FunASR first-use runtime installer

CalMee release packages do not contain CPython, PyTorch, FunASR, ModelScope,
model weights, or a generated `funasr-runtime` directory. Local transcription
uses two explicit layers:

1. A one-time, identifier-scoped runtime under `runtimes/funasr`.
2. User-selected model weights under `models/funasr`, removable per model.

Before layer 1 begins, the UI shows the estimated network and disk sizes,
runtime and model destinations, network requirement, third-party notice
location, and the fact that interrupted downloads are retried rather than
resumed. Intel macOS and any target outside the reviewed matrix are blocked
before network access.

## State machine

`notInstalled → checking → downloadingBootstrap → installingPython →
installingDependencies → generatingNotices → verifying → ready`

Any working state can end in `failed` or `cancelled`. Both are retryable and
never write `ready`. Cancellation requested during an external package command
takes effect at the next safe boundary; activation is still forbidden.
`unsupported` is determined by the install plan before download.

## Atomic activation and rollback

- New work is created only in `staging/<uuid>`.
- A complete interpreter, packages, notices, inventory, and manifest remain in
  that staging version until the sidecar self-test passes.
- The complete runtime is moved to immutable `versions/<runtime-id>`.
- A same-directory temporary pointer is synced and persisted as `active.json`.
- Existing version directories are never modified during an upgrade.
- Hash mismatch, network failure, insufficient disk, cancellation, notice
  failure, or self-test failure leaves the previous pointer untouched.
- Offline reuse validates manifest schema 3, platform, Python and uv versions,
  Python executable SHA-256, requirements/lock hashes, inventory SHA-256, and
  required notice files, then reruns the sidecar self-test without networking.

## Network sources and integrity roots

- Bootstrap: Astral `uv` 0.11.7 release assets on GitHub. The Rust installer
  contains the fixed HTTPS URL and official SHA-256 for each supported target.
- CPython: exact 3.11.15 managed by the verified `uv` binary. `uv`'s embedded
  Python-build registry validates the fetched Python distribution.
- Python packages: indexes resolved by `uv`, constrained by the reviewed
  target lock and `--require-hashes`; every accepted distribution must match a
  SHA-256 in that lock.
- Model weights: separate provider downloads initiated only after runtime setup
  and a user model choice. Runtime readiness never implies model readiness.

The manifest records the bootstrap source/version/hash, exact Python version
and executable hash, target, requirements hash, lock hash, and generated
package/license inventory hash. Tests use temporary directories and fixtures;
they must never target a real application-data directory.
