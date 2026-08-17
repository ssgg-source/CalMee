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
- [ ] Fresh-machine setup succeeds without developer-machine files
- [ ] Recording, import, cancellation, recovery, and page switching are regression-tested
- [ ] Short and long recordings are tested for every advertised workflow

## GitHub and release

- [ ] Enable issues and discussions on the public `calmee` repository
- [ ] Add a description, topics, screenshots, and an alpha warning
- [ ] Protect `main` and require CI checks
- [ ] Publish source first; publish binaries only after signing and notarization
- [ ] Tag the first release as `v0.1.0-alpha.1` or another clear pre-release
- [ ] Document supported systems, model sizes, disk locations, and known limitations
- [ ] Verify the release archive contains all required license and notice files
