-- User-supplied OpenAI-compatible endpoint settings.
-- Stored as JSON: {endpoint, apiKey, model, maxTokens, temperature, topP}.
-- This community-edition migration intentionally uses a version that does not
-- collide with the retired commercial repository's historical migration.
ALTER TABLE settings ADD COLUMN customOpenAIConfig TEXT;
