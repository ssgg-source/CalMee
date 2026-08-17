# CalMee AI Generation Harness

## Purpose

CalMee treats AI generation as a reproducible document pipeline rather than a single prompt call. The harness must support local and user-configured cloud models, long meetings, background execution, progress reporting, retries, validation, and quiet version recovery.

## Document graph

```text
Raw transcript
  -> transcript optimization
  -> smart meeting record
  -> meeting summary

Raw transcript + selected speaker
  -> speech summary
```

Each generated document stores its source revision. When the source changes, downstream documents are marked stale but are never deleted or silently regenerated.

## Pipeline

1. **Resolve source**: load the exact source document and speaker scope.
2. **Normalize**: preserve speaker and timestamps, remove transport-only metadata, and calculate a source hash.
3. **Plan chunks**: split on speaker turns and topic boundaries within the selected model context window.
4. **Map**: process chunks independently with bounded prompts and structured intermediate output.
5. **Reduce**: combine intermediate output without losing decisions, disagreements, figures, owners, or deadlines.
6. **Validate**: check Markdown, required sections, unsupported claims, action-item attribution, language, and output length.
7. **Repair**: run one focused repair pass only for failed validation rules.
8. **Commit**: keep the prior document version, save the new result atomically, and mark downstream documents stale.

## Prompt composition

Prompts are composed from three layers:

- **System contract**: non-editable accuracy, privacy, attribution, and output-format rules.
- **Business template**: user-manageable task instructions such as detailed record, executive brief, or speech record.
- **Runtime context**: language, meeting metadata, speaker scope, glossary, known participants, source text, and requested output schema.

Templates never contain API keys, provider URLs, or model-specific transport instructions.

## Task contracts

### Transcript optimization

- Preserve one-to-one traceability to original speaker turns.
- Fix punctuation, filler words, repetitions, and high-confidence terminology errors.
- Never change speaker attribution or invent missing content.
- Return aligned segments so timestamps remain usable.

### Smart meeting record

- Merge consecutive remarks by the same participant when logically continuous.
- Organize content by topic while retaining chronology inside each topic.
- Preserve reasoning, disagreements, decisions, figures, owners, and deadlines.
- Produce detailed Markdown suitable as the source for later summaries.

### Meeting summary

- Use the smart meeting record, not the raw transcript, as the default source.
- Make claims traceable to source blocks.
- Separate decisions, open questions, risks, and action items.
- Never infer an owner or deadline when it was not explicitly stated.

### Speech summary

- Use only the selected participant's source remarks.
- Preserve their positions, reasoning, examples, requests, and commitments.
- Do not blend statements from other participants.

## Background job states

```text
queued -> preparing -> chunking -> generating -> synthesizing
       -> validating -> repairing -> saving -> completed
                                  \-> failed
                                  \-> cancelled
```

The UI shows stage, meaningful message, chunk progress, and elapsed time. Navigation or window changes must not own or cancel a job. Jobs are keyed by meeting, document kind, context key, and source hash so duplicate requests can be coalesced.

## Model adapter boundary

Every provider adapter implements the same interface:

- model discovery
- context and output limits
- streaming or incremental progress
- cancellation
- retry classification
- token or character usage
- structured-output capability

The harness chooses chunk sizes from adapter limits. Provider-specific code must not contain business prompts.

## Privacy boundary

- Local model execution stays on device.
- Cloud execution is enabled only after the user explicitly selects a configured cloud provider and confirms that the relevant meeting text will be sent to that provider.
- The confirmation identifies the destination provider and the source document being transmitted.
- Logs contain hashes, lengths, timing, and errors, but never API keys or full meeting text.

## Evaluation

Maintain a private regression set containing short, long, multi-speaker, terminology-heavy, and low-quality ASR meetings. Score:

- factual consistency and unsupported-claim rate
- speaker attribution accuracy
- decision/action-item recall and precision
- terminology correction accuracy
- structure and readability
- latency, tokens, and peak memory

Prompt or model changes must be compared against the current baseline before becoming defaults.

## Implementation sequence

1. Consolidate prompt contracts and template storage.
2. Implement the local-model adapter and background runner.
3. Add source hashes, stale-state propagation, cancellation, and recovery.
4. Add cloud adapters after explicit data-transmission consent.
5. Add validators and one-pass repair.
6. Build the regression runner and publish benchmark summaries without meeting content.
