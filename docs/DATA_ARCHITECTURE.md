# CalMee Data Architecture

This document defines the ownership and precedence of CalMee's transcript,
speaker identity, voiceprint, and generated-document data. It describes the
current database while identifying legacy storage that should be retired before
the first public release.

## Source and derived layers

1. `meetings` owns meeting metadata, including title, time, audio location, and
   calendar linkage.
2. `transcripts` owns the active time-aligned ASR segments. Text edits to the
   clustered transcript update this layer.
3. `transcript_versions` stores immutable transcript snapshots such as the raw
   ASR baseline and the latest clustered baseline.
4. `transcript_refinements` stores the AI-optimized transcript as a
   non-destructive overlay keyed by transcript segment ID.
5. `meeting_documents` owns saved Markdown outputs: Smart Record, Meeting
   Summary, and Speech Summary. It keeps only the current document and one
   recoverable previous Markdown value.

Downstream source precedence is:

- Meeting Summary: saved Smart Record, then AI refinement, then clustered
  transcript, then raw transcript.
- Speech Summary: AI refinement, then clustered transcript, then raw transcript.
- Smart Record generation: AI refinement, then clustered transcript, then raw
  transcript. A previously generated Smart Record is an output, never its own
  source.

## Speaker identity layers

Speaker identity is deliberately split into three levels.

### Meeting-local speaker assignment

`meeting_speaker_assignments` maps a local diarization label such as `Speaker 2`
to a person for one meeting. It also holds the meeting speaker embedding,
matching confidence, candidate, and confirmation state.

Changing this mapping relabels every utterance in that local speaker cluster.
Only an explicit, sufficiently reliable confirmation may become evidence for
global voiceprint learning.

### Utterance-level person override

`transcript_speaker_overrides` maps one transcript segment to a person. Its
product meaning is **utterance attribution override**, not text correction.

Use it when diarization placed one utterance in the wrong cluster but the rest
of that cluster is correct. Resolution order is:

1. utterance attribution override;
2. meeting-local speaker assignment;
3. local `Speaker N` label;
4. unknown speaker.

An utterance override must not silently rewrite a meeting cluster or enroll a
global voiceprint. A later explicit confirmation flow may promote high-quality
audio from that utterance, but that is a separate action.

### Global voiceprint identity

`people` owns the durable person identity. `voiceprints` owns one or more voice
embedding samples for that person, including trust status and provenance.

Voiceprints are model-space dependent. CalMee currently standardizes global
matching on CAM++ embeddings; embeddings from a different voice model must not
be compared or merged without a compatible migration.

## Text correction and recognition vocabulary

Text correction is independent of speaker identity:

- `hotwords` stores recognition vocabulary and learned replacements.
- `correction_events` records correction evidence and usage.
- raw or clustered text edits update `transcripts.transcript`.
- AI-optimized text edits update the segment inside
  `transcript_refinements.result_json`.

The UI action “Batch correction” may update all applicable text layers and add
the corrected term to `hotwords`; it must not write speaker identity tables.

## Legacy and transitional storage

The following data remains for compatibility and should not gain new features:

- `meeting_record_blocks` and `meeting_record_state.document_markdown` are the
  older rule-built Smart Record representation.
- `summary_processes.result` overlaps the Meeting Summary document.
- `transcripts.summary`, `transcripts.action_items`, and
  `transcripts.key_points` are inherited legacy fields.
- `document_generation_jobs` is currently unused while several background job
  states remain in memory.

Before public release, migrate any unique data into `meeting_documents`, verify
read paths no longer depend on the legacy fields, then remove the duplicate
columns and tables in a dedicated migration.

## Loading and performance rules

- Opening the meeting workspace must read stored data only. It must not start an
  ASR, diarization, voiceprint, or local LLM service.
- Expensive model status must be queried only when the related control is
  opened or a job is started.
- Raw transcript display must not build a Smart Record.
- Pagination may fill the transcript in the background, but the first page,
  meeting metadata, and saved documents should load independently.
- Editor remount counters are UI reload tokens, not persisted document version
  numbers.
