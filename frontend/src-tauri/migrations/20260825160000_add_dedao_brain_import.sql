ALTER TABLE calendar_settings ADD COLUMN dedao_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calendar_settings ADD COLUMN dedao_api_key TEXT;
ALTER TABLE calendar_settings ADD COLUMN dedao_client_id TEXT;
ALTER TABLE calendar_settings ADD COLUMN dedao_recording_only INTEGER NOT NULL DEFAULT 1;
ALTER TABLE calendar_settings ADD COLUMN dedao_content_mode TEXT NOT NULL DEFAULT 'note';
ALTER TABLE calendar_settings ADD COLUMN dedao_conflict_mode TEXT NOT NULL DEFAULT 'skip';
ALTER TABLE calendar_settings ADD COLUMN dedao_authorized_at TEXT;
ALTER TABLE calendar_settings ADD COLUMN dedao_last_sync_at TEXT;
