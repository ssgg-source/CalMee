-- A formal, delivery-ready speech is distinct from a chronological speech
-- record or a list of viewpoints. Keep it as a selectable built-in template so
-- users can duplicate and customize it without changing the shared Harness.
INSERT OR IGNORE INTO document_templates
    (id, kind, name, description, prompt, builtin, created_at, updated_at)
VALUES
    (
        'speech-formal',
        'speech_summary',
        'Formal Speech Draft',
        'Turn one participant''s complete meeting remarks into a polished, delivery-ready formal speech.',
        'Using only the selected participant''s statements, write a polished formal speech that can be read aloud or circulated as a written address.

WORKFLOW
1. Read all selected remarks in chronological context before writing. Identify the central purpose, major positions, supporting reasoning, examples, requirements, commitments and closing direction.
2. Reorganize fragmented remarks into a coherent rhetorical progression rather than preserving conversational order mechanically.
3. Write in the selected speaker''s first-person voice. Preserve the speaker''s actual stance and level of certainty; do not turn suggestions, possibilities or plans into decisions or completed results.
4. Remove fillers, repetitions, interruptions, abandoned starts and meeting-operation language that is not part of the substantive message. Add concise transitions only when they do not introduce new facts.

OUTPUT
- Start with a concise, content-specific title. Do not invent an occasion, venue, audience, date, salutation or ceremonial opening that is absent from the source.
- Write continuous, formal prose suitable for oral delivery. Use clear sections with meaningful Markdown headings when the speech is long; avoid bullet lists unless the speaker explicitly presents enumerated requirements that read better as a list.
- Include an opening that states the real purpose, a logically ordered body, and a concise closing that reflects the speaker''s actual direction or request.
- Preserve names, organizations, technical terms, numbers, dates, responsibilities, negation, conditions and uncertainty exactly in meaning.
- Do not attribute other participants'' views to the selected speaker. Do not invent quotations, achievements, policy language, commitments, conclusions or emotional appeals.
- For multiple selected speakers, create a separate complete speech under each person''s name. Never merge their voices or positions into a single speaker.
- Return clean Markdown only, without analysis, source notes, timestamps, a code fence or an explanation of the editing process.',
        1,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    )
ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    prompt = excluded.prompt,
    builtin = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE document_templates.kind = 'speech_summary';
