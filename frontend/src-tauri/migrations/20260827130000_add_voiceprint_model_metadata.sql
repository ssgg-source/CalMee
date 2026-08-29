-- Voice embeddings are comparable only when produced by the same model
-- revision and dimension. Legacy rows remain usable with other legacy rows,
-- but never match versioned server embeddings implicitly.
ALTER TABLE voiceprints ADD COLUMN embedding_model_id TEXT;
ALTER TABLE voiceprints ADD COLUMN embedding_model_revision TEXT;
ALTER TABLE voiceprints ADD COLUMN embedding_dimension INTEGER;

ALTER TABLE meeting_speaker_assignments ADD COLUMN embedding_model_id TEXT;
ALTER TABLE meeting_speaker_assignments ADD COLUMN embedding_model_revision TEXT;
ALTER TABLE meeting_speaker_assignments ADD COLUMN embedding_dimension INTEGER;

CREATE INDEX IF NOT EXISTS idx_voiceprints_embedding_model
ON voiceprints(embedding_model_revision, embedding_dimension, status, person_id);
