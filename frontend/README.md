# CalMee Desktop

The CalMee desktop app combines a Next.js interface with a Rust/Tauri local core.

## Development

```bash
pnpm install
pnpm run tauri:dev
```

The Apple Silicon development script enables Metal and CoreML when available. Prepare FunASR from the repository root first:

```bash
./scripts/setup-funasr.sh
```

## Validation

```bash
pnpm exec tsc --noEmit --incremental false
node --test tests/lib/*.test.mjs
pnpm run build
```

Run the Rust check from the repository root:

```bash
cargo check -p calmee --features coreml --no-default-features --features platform-default
```

## Architecture

- `src/`: Next.js pages, components, state, localization, and Tauri calls
- `src-tauri/`: recording, transcription, database, AI, calendar, and native integrations
- `src-tauri/migrations/`: SQLite migrations
- `../funasr_sidecar/`: FunASR local process protocol and inference entry point

CalMee does not require the legacy FastAPI, Docker, or standalone whisper-server backend. Root-level documents govern release, privacy, and licensing requirements.
