-- CalMee knowledge layer: derived meeting records, reusable people/voiceprints,
-- and a managed hotword/correction library. Raw transcripts remain immutable.

CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    auto_identify INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voiceprints (
    id TEXT PRIMARY KEY NOT NULL,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    embedding TEXT NOT NULL,
    source_meeting_id TEXT,
    source_speaker TEXT,
    quality REAL NOT NULL DEFAULT 1.0,
    sample_duration REAL NOT NULL DEFAULT 0.0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voiceprints_person ON voiceprints(person_id);

CREATE TABLE IF NOT EXISTS meeting_speaker_assignments (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    local_speaker TEXT NOT NULL,
    person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    confidence REAL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    embedding TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, local_speaker)
);

CREATE TABLE IF NOT EXISTS meeting_record_state (
    meeting_id TEXT PRIMARY KEY NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    summary_stale INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_record_blocks (
    id TEXT PRIMARY KEY NOT NULL,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    local_speaker TEXT,
    person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    source_transcript_ids TEXT NOT NULL DEFAULT '[]',
    is_edited INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_record_blocks_order
    ON meeting_record_blocks(meeting_id, sequence);

CREATE TABLE IF NOT EXISTS hotwords (
    id TEXT PRIMARY KEY NOT NULL,
    term TEXT NOT NULL,
    normalized_term TEXT NOT NULL,
    replacement_from TEXT,
    category TEXT NOT NULL DEFAULT '通用',
    scope TEXT NOT NULL DEFAULT 'global',
    source TEXT NOT NULL DEFAULT 'manual',
    confidence REAL NOT NULL DEFAULT 1.0,
    enabled INTEGER NOT NULL DEFAULT 1,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hotwords_unique
    ON hotwords(normalized_term, IFNULL(replacement_from, ''), scope);

CREATE TABLE IF NOT EXISTS correction_events (
    id TEXT PRIMARY KEY NOT NULL,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    block_id TEXT REFERENCES meeting_record_blocks(id) ON DELETE SET NULL,
    original_text TEXT NOT NULL,
    corrected_text TEXT NOT NULL,
    learned_hotword_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
