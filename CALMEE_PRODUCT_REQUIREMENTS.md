# CalMee Product and Development Requirements

## Target workflow

FunASR first creates a timestamped, speaker-aware raw transcript from a live recording or imported file. CalMee then creates an editable, traceable meeting record and generates AI meeting notes only from that record.

Raw transcript → Meeting record → AI meeting notes

## 1. Meeting record

- [x] Preserve the raw transcript instead of overwriting it during organization.
- [x] Merge continuous sentences using speaker, pause duration, paragraph duration, and character count.
- [x] Remove isolated or leading fillers without aggressively rewriting meaning.
- [x] Support editing, merging with the next paragraph, and splitting at the cursor.
- [x] Preserve source sentence IDs for every paragraph and expose them in the interface.
- [x] Detect retranscription changes and rebuild the meeting record.
- [x] Mark existing AI notes as potentially outdated after record edits.
- [x] Keep AI organization separate from rule-based rebuilding. Process in batches while preserving paragraph IDs, speakers, times, and source references.
- [x] Preview AI organization before applying it; preserve original text for failed batches.

## 2. People and voiceprints

- [x] Enable CAM++ in meeting mode and disable it in single-speaker mode; keep hotwords in both modes.
- [x] Store the CAM++ centroid vector for each temporary speaker.
- [x] Store the voiceprint sample when a user maps `Speaker N` to a person.
- [x] Infer people in later meetings with cosine similarity, using a threshold and a clear margin over the second candidate.
- [x] Keep people and voiceprints on the device.
- [x] Support creating, renaming, and deleting people.
- [ ] Add person merging, sample playback/deletion, incorrect-match feedback, and threshold visualization.

## 3. Hotword library

- [x] Support preferred terms and `incorrect → correct` mappings.
- [x] Learn short, unambiguous record edits automatically without learning large rewrites.
- [x] Synchronize enabled terms and mappings into the next FunASR job.
- [x] Support bulk import, copy/export, enable, disable, categorize, and delete.
- [x] Import prior FunASR configuration during first use.
- [ ] Add project/meeting scopes, usage counts, and duplicate suggestions.

## 4. AI meeting notes

- [x] Use the meeting record rather than sentence-level raw transcript as AI input.
- [x] Show preparation, analysis, generation, translation, saving, and elapsed-time progress.
- [x] Prompt for regeneration after meeting-record edits and clear the outdated state after success.
- [ ] Link conclusions and action items back to source meeting-record paragraphs.

## 5. Internationalization

- [x] Use English for source code, comments, documentation, and the default interface.
- [x] Provide a persistent English / Simplified Chinese switch in Settings.
- [x] Keep Simplified Chinese UI strings in a dedicated locale resource.
- [ ] Add automated checks for untranslated literals and locale-key parity.

## 6. Acceptance criteria

- Meeting mode returns timestamps, speaker IDs, and voiceprint centroid vectors.
- Continuous sentences from one speaker merge, while speaker changes and long pauses split paragraphs.
- The raw transcript and source sentences remain available.
- A person labeled once can be inferred in later meetings.
- Correcting a proper noun produces an appropriate hotword mapping for the next transcription.
- AI notes use the current meeting record and clearly show when they are outdated.
- The default interface is English; changing to Simplified Chinese updates the main workflow immediately and persists after restart.
