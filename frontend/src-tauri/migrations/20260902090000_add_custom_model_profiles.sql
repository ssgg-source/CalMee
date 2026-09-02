CREATE TABLE IF NOT EXISTS custom_model_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('transcription', 'ai')),
    protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
    display_name TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    api_key TEXT,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_custom_model_profiles_kind
ON custom_model_profiles(kind, updated_at DESC);
