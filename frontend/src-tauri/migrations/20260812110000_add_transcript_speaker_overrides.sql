-- A manual correction for one ASR utterance. It intentionally does not alter
-- diarization clusters, meeting-wide speaker assignments, or voiceprints.
CREATE TABLE IF NOT EXISTS transcript_speaker_overrides (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, transcript_id)
);
CREATE INDEX IF NOT EXISTS idx_transcript_speaker_overrides_person
    ON transcript_speaker_overrides(person_id);
