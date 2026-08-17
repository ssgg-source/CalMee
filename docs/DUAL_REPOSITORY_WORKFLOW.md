# Maintaining CalMee and CalMee Pro

## Repository roles

Use two independent Git repositories:

- `calmee`: public, MIT-licensed, canonical upstream for shared code
- `calmee-pro`: private, commercial product, regularly synchronized with `calmee`

Do not use two long-lived branches in one repository for permanent product variants.

## Recommended private-repository setup

Create CalMee Pro from a copy of the public repository, then configure remotes:

```bash
git remote rename origin upstream
git remote add origin git@github.com:<owner>/calmee-pro.git
git fetch upstream
```

`origin` is the private Pro repository. `upstream` is the public CalMee repository.

## Target source layout

Shared code stays public and gradually moves into explicit packages as it is touched:

```text
calmee/
  crates/
    calmee-domain/          meeting and transcript types
    calmee-audio/           recording and decoding
    calmee-asr/             provider interfaces and shared pipeline
    calmee-storage/         migrations and repositories
  packages/
    ui/                     shared React components and tokens
    meeting-workspace/      shared meeting editor
  apps/
    desktop/                community composition root
```

The private repository may add:

```text
calmee-pro/
  crates/calmee-pro-services/
  packages/pro-ui/
  apps/desktop-pro/
```

The current repository has not yet been physically moved into all these packages.
Extraction should be incremental: introduce an interface at a real dependency seam,
move one tested subsystem, and keep the app working after every step.

## Extension interfaces

The public app should own stable interfaces for ASR providers, LLM providers,
transcript post-processors, document generators, template catalogs, importers,
calendar connectors, knowledge indexes, and feature registration.

Community supplies open implementations. Pro supplies additional implementations
from private modules. Shared components receive capabilities through interfaces or
registries; they must not contain scattered `if product === "pro"` checks.

## Daily development rules

### Shared change

1. Create a branch in public `calmee`.
2. Implement and test the change without any Pro dependency.
3. Merge it into public `main`.
4. In `calmee-pro`, run `git fetch upstream` and merge `upstream/main`.
5. Resolve only Pro composition conflicts; shared files should normally merge cleanly.

### Pro-only change

1. Create a branch only in `calmee-pro`.
2. Put the implementation under a Pro-specific module or package.
3. If a shared interface is missing, add the minimal interface to public CalMee first.
4. Register the Pro implementation from the Pro composition root.

### Bug found in Pro

- If the bug exists in shared code, fix it in public CalMee first.
- If it exists only in a Pro implementation, fix it only in the private repository.
- Never fix the same shared bug independently in both repositories.

## Synchronization cadence

- Merge public `main` into Pro at least weekly and before every Pro release.
- Tag compatible public versions, for example `v0.1.0`.
- Record the public base in each Pro release, such as
  `CalMee Pro 0.1.0 based on CalMee v0.1.0`.
- Keep a CI job in Pro that fails when its public base is incompatible.

## Conflict prevention

- Keep Pro navigation additions in a registry rather than editing the public sidebar.
- Keep Pro commands in a Pro command registry rather than growing one handler list.
- Keep Pro database migrations in a reserved range or separate namespace.
- Do not rename or rewrite public Git history after publication.
- Do not copy a public file into Pro merely to change one line; add an extension point.

## Licensing discipline

Files published in the MIT repository remain MIT, including copies used by CalMee
Pro. New Pro-only files can use a commercial license. Do not mix MIT and proprietary
implementations in the same source file.
