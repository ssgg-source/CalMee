# Publishing CalMee on GitHub for the First Time

This guide assumes that the local Community repository has already passed the
checks in `OPEN_SOURCE_RELEASE_CHECKLIST.md`. Publishing is intentionally split
into a reviewable repository launch and a later binary release.

## 1. Choose the repository identity

- Repository name: `calmee`
- Visibility: public
- Default branch: `main`
- Short description: `Local-first meeting recording, ASR transcription, and AI-assisted notes.`
- Topics: `asr`, `funasr`, `whisper`, `tauri`, `meeting-notes`, `local-first`
- Do not let GitHub create another README, license, or `.gitignore`; they already
  exist in this repository.

## 2. Review the local baseline

```bash
cd /path/to/CalMee
git status
git log --oneline --decorate -5
git ls-files | less
```

Confirm that recordings, databases, API keys, model weights, virtual environments,
signing material, packaged applications, and build directories are absent.

## 3. Create and connect the public repository

Create an empty public repository in the GitHub web interface, then run:

```bash
git remote add origin git@github.com:<owner>/calmee.git
git push -u origin main
```

If HTTPS authentication is preferred, use the HTTPS repository URL instead.

## 4. Configure GitHub before inviting users

- Enable Issues and Discussions.
- Add the repository description, topics, and social preview.
- Protect `main`: require pull requests, require the CI check, dismiss stale
  approvals, and block force pushes and deletion.
- Enable Dependabot security updates and secret scanning when available.
- Add a `CODEOWNERS` file after maintainers are known.
- Do not enable an updater or binary release workflow until signing, notices,
  checksums, and model-license documentation are complete.

## 5. Publish the source alpha

Tag the first reviewed source snapshot rather than calling it stable:

```bash
git tag -a v0.1.0-alpha.1 -m "CalMee Community source alpha"
git push origin v0.1.0-alpha.1
```

Create GitHub release notes that clearly state supported platforms, known defects,
privacy boundaries, and that no model weights are bundled. A source tag is enough
for the first alpha; a DMG can follow after signing and clean-machine testing.

## 6. Before announcing broadly

Complete every item in `OPEN_SOURCE_RELEASE_CHECKLIST.md`, test on a clean Mac user
account, verify microphone and system-audio permissions, download every promoted
model from scratch, and run a long-recording recovery test.
