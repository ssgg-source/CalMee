-- Keep speaker identification automatic while preventing predictions from
-- silently becoming trusted enrollment samples.

ALTER TABLE voiceprints ADD COLUMN status TEXT NOT NULL DEFAULT 'trusted';
ALTER TABLE voiceprints ADD COLUMN confirmation_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE voiceprints ADD COLUMN updated_at TEXT;

ALTER TABLE meeting_speaker_assignments ADD COLUMN candidate_person_id TEXT REFERENCES people(id) ON DELETE SET NULL;
ALTER TABLE meeting_speaker_assignments ADD COLUMN runner_up_confidence REAL;
ALTER TABLE meeting_speaker_assignments ADD COLUMN match_state TEXT NOT NULL DEFAULT 'unknown';

-- Preserve conflicting historic rows for review, but exclude them from the
-- active profile used for future automatic identification.
UPDATE voiceprints
SET status = 'conflicted'
WHERE source_meeting_id IS NOT NULL
  AND source_speaker IS NOT NULL
  AND (source_meeting_id, source_speaker) IN (
    SELECT source_meeting_id, source_speaker
    FROM voiceprints
    WHERE source_meeting_id IS NOT NULL AND source_speaker IS NOT NULL
    GROUP BY source_meeting_id, source_speaker
    HAVING COUNT(DISTINCT person_id) > 1
  );

-- Repeated writes for the same person/source are historical duplicates. Keep
-- the oldest active row and retire the rest instead of deleting evidence.
UPDATE voiceprints
SET status = 'retired'
WHERE status = 'trusted'
  AND id NOT IN (
    SELECT MIN(id)
    FROM voiceprints
    WHERE status = 'trusted'
    GROUP BY person_id, source_meeting_id, source_speaker
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_voiceprints_active_source
ON voiceprints(source_meeting_id, source_speaker)
WHERE source_meeting_id IS NOT NULL
  AND source_speaker IS NOT NULL
  AND status IN ('confirmed', 'trusted');

CREATE INDEX IF NOT EXISTS idx_voiceprints_status_person
ON voiceprints(status, person_id);

CREATE TABLE IF NOT EXISTS voiceprint_audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    meeting_id TEXT,
    local_speaker TEXT,
    previous_person_id TEXT,
    person_id TEXT,
    action TEXT NOT NULL,
    confidence REAL,
    created_at TEXT NOT NULL
);

