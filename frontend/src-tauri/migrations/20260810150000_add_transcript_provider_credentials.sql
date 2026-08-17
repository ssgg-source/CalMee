CREATE TABLE IF NOT EXISTS transcript_provider_credentials (
    provider TEXT PRIMARY KEY NOT NULL,
    api_key TEXT,
    endpoint TEXT,
    extra_json TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
