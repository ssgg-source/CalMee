# Open-Source Release Checklist

## Source and history

- [ ] Establish a clean initial Git baseline and review every staged file
- [ ] Remove recordings, databases, logs, model weights, caches, and build outputs
- [ ] Search the tree and history for keys, tokens, passwords, private URLs, signing
      material, email addresses, and customer data
- [ ] Confirm that every committed file is intended to be MIT-licensed and public
- [ ] Remove dormant private or unreleased implementations, not only their navigation buttons
- [ ] Replace development-only identifiers and repository URLs

## Licenses and third parties

- [ ] Preserve the complete Meetily MIT notice and derivative attribution
- [ ] Generate Rust, npm, and Python dependency license inventories
- [ ] Run `node scripts/check-release-boundaries.mjs`; confirm exact Python pins, all target locks with hashes, ignored generated assets, and no staged runtime/model/user data
- [ ] Document each downloadable model's source, revision, size, and license
- [ ] Pin FFmpeg source, build configuration, checksum, and required notices
- [ ] Confirm that no model weights or incompatible assets are committed

## Security and privacy

- [ ] Run secret scanning on the working tree and Git history
- [ ] Require explicit user action and clear disclosure before cloud requests
- [ ] Store credentials with an operating-system credential facility before stable release
- [ ] Verify recording indicators, permission prompts, deletion, and data export
- [ ] Ensure `SECURITY.md` and the privacy policy match the implementation

## Quality

- [ ] TypeScript check and frontend production build pass
- [ ] Rust check and automated tests pass
- [ ] FunASR sidecar protocol tests pass
- [ ] Verify the release package contains no `funasr-runtime`, Python, PyTorch, model cache, or model weights
- [ ] Test the first-use installer only with temporary fixtures: staging, hash failure, cancellation, disk failure, retry, self-test failure, atomic activation, and old-runtime rollback
- [ ] Verify runtime manifest v3 fields: CPython 3.11.15/executable hash, target, pinned uv source/hash, requirements/lock hashes, and license-inventory hash
- [ ] Verify the installed runtime contains `third-party/NOTICE.txt`, CPython license, Python inventory, and copied package license files
- [ ] Verify the packaged app does not fall back to system Python and creates model caches only below `app_data_dir/models/funasr`
- [ ] Verify backend model readiness, disk-size display, confirmed deletion, and redownload after deletion
- [ ] Verify legacy model import shows source, target, count, and size; requires confirmation; rolls back failures; and leaves source checksum/mtime unchanged
- [ ] Fresh-machine setup succeeds without developer-machine files
- [ ] Recording, import, cancellation, recovery, and page switching are regression-tested
- [ ] Short and long recordings are tested for every advertised workflow

## GitHub and release

- [ ] Enable issues and discussions on the public `calmee` repository
- [ ] Add a description, topics, screenshots, and an alpha warning
- [ ] Protect `main` and require CI checks
- [ ] Never edit an applied SQL migration; add a new migration and update the checksum manifest instead
- [ ] Publish source first; publish binaries only after signing and notarization
- [ ] Tag the first release as `v0.1.0-alpha.1` or another clear pre-release
- [ ] Document supported systems, model sizes, disk locations, and known limitations
- [ ] Verify the release archive contains the notice generator and target locks, but no generated runtime
- [ ] Build each operating-system package on its native target and test the first-use installer there
