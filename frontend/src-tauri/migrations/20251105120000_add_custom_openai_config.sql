-- User-supplied OpenAI-compatible endpoint settings.
-- Stored as JSON: {endpoint, apiKey, model, maxTokens, temperature, topP}.
ALTER TABLE settings ADD COLUMN customOpenAIConfig TEXT;
