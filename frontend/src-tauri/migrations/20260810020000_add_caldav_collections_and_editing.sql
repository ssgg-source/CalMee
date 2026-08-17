CREATE TABLE IF NOT EXISTS calendar_collections (
    id TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL,
    account_key TEXT NOT NULL,
    href TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#0A84FF',
    read_only INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    UNIQUE(source, account_key, href)
);

ALTER TABLE calendar_events ADD COLUMN calendar_id TEXT REFERENCES calendar_collections(id) ON DELETE SET NULL;
ALTER TABLE calendar_events ADD COLUMN href TEXT;
ALTER TABLE calendar_events ADD COLUMN etag TEXT;
ALTER TABLE calendar_events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_calendar_events_calendar ON calendar_events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_calendar_collections_account ON calendar_collections(account_key);

UPDATE calendar_settings SET sync_mode = 'two_way' WHERE sync_mode = 'read_only';
