-- Speech-focused output is a meeting-summary presentation choice rather than
-- a separate top-level meeting document. Existing speech_summary documents
-- remain untouched for backward compatibility.
INSERT OR IGNORE INTO document_templates
    (id, kind, name, description, prompt, builtin, created_at, updated_at)
VALUES
    (
        'summary-speech',
        'meeting_summary',
        'Speech Summary',
        'Organize the meeting around each participant''s substantive contribution.',
        'Create a speech-focused meeting summary from the complete meeting record. Organize substantive contributions by participant. For each participant, preserve their main positions, reasoning, proposals, requirements, commitments, objections and open questions in meeting order. Clearly distinguish speakers and never attribute one person''s statement to another. Remove fillers and repetition, but preserve names, figures, dates, conditions, uncertainty and disagreements. End with shared decisions and action items only when they are supported by the source. Output clean Markdown only.',
        1,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    );
