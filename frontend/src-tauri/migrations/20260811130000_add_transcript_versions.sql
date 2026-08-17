CREATE TABLE IF NOT EXISTS transcript_versions (
    meeting_id TEXT NOT NULL,
    version_kind TEXT NOT NULL CHECK (version_kind IN ('original', 'clustered')),
    speaker_count INTEGER NOT NULL DEFAULT 0,
    segments_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, version_kind),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transcript_versions_meeting
    ON transcript_versions(meeting_id);
