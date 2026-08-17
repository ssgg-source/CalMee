CREATE TABLE IF NOT EXISTS ai_harness_settings (
    harness_key TEXT PRIMARY KEY NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
