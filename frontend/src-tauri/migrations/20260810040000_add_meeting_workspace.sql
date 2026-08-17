-- Unified meeting workspace documents, tags, templates and per-task preferences.

CREATE TABLE IF NOT EXISTS meeting_documents (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('smart_record', 'meeting_summary', 'speech_summary')),
    context_key TEXT NOT NULL DEFAULT '',
    markdown TEXT NOT NULL DEFAULT '',
    previous_markdown TEXT,
    language TEXT NOT NULL DEFAULT 'auto',
    template_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, kind, context_key)
);

CREATE TABLE IF NOT EXISTS meeting_tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    color TEXT NOT NULL DEFAULT '#8B5CF6',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_tag_links (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES meeting_tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_tag_links_tag ON meeting_tag_links(tag_id);

CREATE TABLE IF NOT EXISTS document_templates (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('smart_record', 'meeting_summary', 'speech_summary')),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_templates_kind ON document_templates(kind, builtin, name);

CREATE TABLE IF NOT EXISTS generation_preferences (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'auto',
    template_id TEXT,
    provider TEXT,
    model TEXT,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, kind)
);

INSERT OR IGNORE INTO document_templates
    (id, kind, name, description, prompt, builtin, created_at, updated_at)
VALUES
    ('smart-detailed', 'smart_record', 'Detailed Meeting Record', 'A clear and complete structured record that preserves important details.',
     'Transform the transcript into a detailed, logically structured meeting record. Merge consecutive remarks by the same speaker, remove filler words, correct obvious transcription errors without inventing facts, preserve decisions, reasoning, disagreements, names, figures and action context. Output clean Markdown only.', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('smart-clean', 'smart_record', 'Clean Conversation Record', 'A lightly edited record close to the original conversation.',
     'Lightly edit the transcript for readability. Preserve the original meaning and speaking order, merge fragmented sentences, remove filler words and repetitions, and correct only obvious transcription errors. Output clean Markdown only.', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('summary-standard', 'meeting_summary', 'Standard Meeting Summary', 'Summary, topics, decisions, risks and action items.',
     'Create a professional meeting summary from the structured meeting record. Include a concise overview, major topics, decisions, unresolved issues, risks and action items with owners and deadlines when explicitly stated. Do not invent information. Output clean Markdown only.', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('summary-executive', 'meeting_summary', 'Executive Brief', 'A concise decision-oriented brief for leaders.',
     'Create a concise executive brief. Prioritize conclusions, decisions, business impact, risks and next actions. Omit conversational detail unless it is necessary to explain a decision. Do not invent information. Output clean Markdown only.', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('speech-complete', 'speech_summary', 'Complete Speech Record', 'A coherent record of one participant''s full contribution.',
     'Using only the selected speaker''s remarks, create a coherent and complete speech record in chronological order. Preserve their positions, reasoning, requirements, examples and commitments. Remove filler words and repetition but do not change intent or add facts. Output clean Markdown only.', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('speech-points', 'speech_summary', 'Views and Key Points', 'The selected participant''s views, requests and commitments.',
     'Summarize the selected speaker''s views, arguments, decisions, requests, commitments and open questions. Attribute everything to the selected speaker and do not mix in other participants'' statements. Output clean Markdown only.', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
