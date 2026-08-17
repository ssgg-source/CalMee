ALTER TABLE meetings ADD COLUMN meeting_start_time TEXT;
ALTER TABLE meetings ADD COLUMN meeting_end_time TEXT;
ALTER TABLE meetings ADD COLUMN calendar_event_id TEXT;
ALTER TABLE meetings ADD COLUMN source TEXT NOT NULL DEFAULT 'calmee';
ALTER TABLE meetings ADD COLUMN external_id TEXT;

CREATE TABLE IF NOT EXISTS calendar_settings (
    id TEXT PRIMARY KEY NOT NULL DEFAULT 'default',
    local_enabled INTEGER NOT NULL DEFAULT 0,
    caldav_enabled INTEGER NOT NULL DEFAULT 0,
    caldav_url TEXT,
    caldav_username TEXT,
    caldav_password TEXT,
    caldav_calendar_path TEXT,
    sync_mode TEXT NOT NULL DEFAULT 'two_way',
    last_sync_at TEXT,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO calendar_settings (id, updated_at)
VALUES ('default', CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    calendar_name TEXT,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT,
    location TEXT,
    notes TEXT,
    meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_meeting ON calendar_events(meeting_id);
