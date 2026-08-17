# Contributing to CalMee

Thank you for helping improve CalMee.

## Before you start

1. Read [README.md](./README.md), [docs/EDITION_BOUNDARIES.md](./docs/EDITION_BOUNDARIES.md), and [docs/DUAL_REPOSITORY_WORKFLOW.md](./docs/DUAL_REPOSITORY_WORKFLOW.md).
2. Never commit recordings, meeting databases, API keys, account credentials, model weights, Python virtual environments, or build artifacts.
3. Update [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) when adding third-party code, models, or services.
4. Review privacy implications whenever a change touches meeting data, cloud models, calendars, or external synchronization.
5. Keep source code, comments, documentation, and the default interface in English. Put user-facing Simplified Chinese only in `frontend/src/i18n/locales/zh-CN.ts`.
6. Do not add CalMee Pro code, hosted endpoints, proprietary prompts, entitlement logic, or commercial connector credentials to this repository.

## Development workflow

```bash
git switch -c feature/short-description
cd frontend
pnpm install
pnpm exec tsc --noEmit --incremental false
pnpm run build
cd ..
cargo check -p calmee --features coreml --no-default-features --features platform-default
```

Use Conventional Commits where practical:

- `feat: add calendar binding`
- `fix: keep summary task running in background`
- `docs: clarify model licenses`

Bug fixes that affect both CalMee and CalMee Pro belong in this public repository first.

## Upstream code

CalMee contains MIT-licensed code derived from Meetily. Do not remove original copyright or license notices. When synchronizing upstream changes, record the source commit and verify that no upstream branding, update channel, telemetry key, or proprietary service configuration was introduced.
