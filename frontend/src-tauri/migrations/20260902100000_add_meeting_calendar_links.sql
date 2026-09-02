-- One authoritative, one-to-one association between a CalMee meeting and a
-- cached calendar event. The two legacy columns remain as read projections
-- during the compatibility period.
CREATE TABLE IF NOT EXISTS meeting_calendar_links (
    meeting_id TEXT PRIMARY KEY NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    calendar_event_id TEXT NOT NULL UNIQUE REFERENCES calendar_events(id) ON DELETE CASCADE,
    link_method TEXT NOT NULL DEFAULT 'manual',
    sync_schedule INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    linked_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meeting_calendar_links_event
ON meeting_calendar_links(calendar_event_id);

-- Preserve every old claim before normalizing. Ambiguous/dangling claims stay
-- here for explicit review; no winner is guessed from timestamps.
CREATE TABLE meeting_calendar_link_legacy_claims (
    meeting_id TEXT NOT NULL,
    calendar_event_id TEXT NOT NULL,
    claim_source TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(meeting_id, calendar_event_id, claim_source)
);
INSERT INTO meeting_calendar_link_legacy_claims(meeting_id,calendar_event_id,claim_source)
SELECT id,calendar_event_id,'meeting' FROM meetings WHERE calendar_event_id IS NOT NULL;
INSERT INTO meeting_calendar_link_legacy_claims(meeting_id,calendar_event_id,claim_source)
SELECT meeting_id,id,'event' FROM calendar_events WHERE meeting_id IS NOT NULL;

-- Import only unambiguous one-to-one pairs, including consistent one-sided
-- legacy links. A contradictory connected pair remains unlinked for review.
INSERT OR IGNORE INTO meeting_calendar_links (
    meeting_id, calendar_event_id, link_method, sync_schedule, linked_at, updated_at
)
SELECT DISTINCT c.meeting_id,c.calendar_event_id,'legacy',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM meeting_calendar_link_legacy_claims c
JOIN meetings m ON m.id=c.meeting_id
JOIN calendar_events e ON e.id=c.calendar_event_id
WHERE (SELECT COUNT(DISTINCT x.calendar_event_id) FROM meeting_calendar_link_legacy_claims x WHERE x.meeting_id=c.meeting_id)=1
AND (SELECT COUNT(DISTINCT x.meeting_id) FROM meeting_calendar_link_legacy_claims x WHERE x.calendar_event_id=c.calendar_event_id)=1;
UPDATE meeting_calendar_link_legacy_claims SET resolved=1
WHERE EXISTS (SELECT 1 FROM meeting_calendar_links l WHERE l.meeting_id=meeting_calendar_link_legacy_claims.meeting_id AND l.calendar_event_id=meeting_calendar_link_legacy_claims.calendar_event_id);

-- Rebuild both legacy projections exclusively from the canonical table.
UPDATE meetings SET calendar_event_id = NULL
WHERE calendar_event_id IS NOT NULL;
UPDATE calendar_events SET meeting_id = NULL
WHERE meeting_id IS NOT NULL;
UPDATE meetings
SET calendar_event_id = (
    SELECT l.calendar_event_id FROM meeting_calendar_links l
    WHERE l.meeting_id = meetings.id
)
WHERE EXISTS (
    SELECT 1 FROM meeting_calendar_links l WHERE l.meeting_id = meetings.id
);

CREATE TRIGGER meeting_calendar_link_insert_projection AFTER INSERT ON meeting_calendar_links BEGIN
    UPDATE meetings SET calendar_event_id=NEW.calendar_event_id WHERE id=NEW.meeting_id;
    UPDATE calendar_events SET meeting_id=NEW.meeting_id WHERE id=NEW.calendar_event_id;
END;
CREATE TRIGGER meeting_calendar_link_delete_projection AFTER DELETE ON meeting_calendar_links BEGIN
    UPDATE meetings SET calendar_event_id=NULL WHERE id=OLD.meeting_id AND calendar_event_id=OLD.calendar_event_id;
    UPDATE calendar_events SET meeting_id=NULL WHERE id=OLD.calendar_event_id AND meeting_id=OLD.meeting_id;
END;
UPDATE calendar_events
SET meeting_id = (
    SELECT l.meeting_id FROM meeting_calendar_links l
    WHERE l.calendar_event_id = calendar_events.id
)
WHERE EXISTS (
    SELECT 1 FROM meeting_calendar_links l
    WHERE l.calendar_event_id = calendar_events.id
);
