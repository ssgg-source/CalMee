use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use tracing::info;

const REQUEST_TIMEOUT_DURATION: Duration = Duration::from_secs(300);
pub const LONG_TRANSCRIPT_TIMEOUT_DURATION: Duration = Duration::from_secs(1_800);

// Generic structure for OpenAI-compatible API chat messages
#[derive(Debug, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

// Generic structure for OpenAI-compatible API chat requests
#[derive(Debug, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
}

// Generic structure for OpenAI-compatible API chat responses
#[derive(Deserialize, Debug)]
pub struct ChatResponse {
    pub choices: Vec<Choice>,
}

#[derive(Deserialize, Debug)]
pub struct Choice {
    pub message: MessageContent,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct MessageContent {
    #[serde(default)]
    pub content: Option<serde_json::Value>,
    #[serde(default)]
    pub reasoning_content: Option<serde_json::Value>,
    #[serde(default)]
    pub reasoning_details: Option<serde_json::Value>,
}

fn message_value_text(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str().map(str::to_owned).or_else(|| {
                    part.get("text")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                })
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

async fn read_openai_stream(
    response: reqwest::Response,
    request_timeout: Duration,
    cancellation_token: Option<&CancellationToken>,
) -> Result<String, String> {
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut pending = String::new();
    let mut raw_body = String::new();
    let mut content = String::new();
    let mut finish_reason: Option<String> = None;

    loop {
        let next = if let Some(token) = cancellation_token {
            tokio::select! {
                item = stream.next() => item,
                _ = token.cancelled() => return Err("Summary generation was cancelled".into()),
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|error| {
            if error.is_timeout() {
                format!(
                    "LLM request timed out after {} seconds",
                    request_timeout.as_secs()
                )
            } else {
                format!("Failed while reading the LLM stream: {}", error)
            }
        })?;
        let chunk_text = String::from_utf8_lossy(&chunk);
        raw_body.push_str(&chunk_text);
        pending.push_str(&chunk_text);

        while let Some(newline) = pending.find('\n') {
            let line = pending[..newline].trim_end_matches('\r').trim().to_string();
            pending.drain(..=newline);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(data)
                .map_err(|error| format!("Failed to parse an LLM stream event: {}", error))?;
            let Some(choice) = value
                .get("choices")
                .and_then(serde_json::Value::as_array)
                .and_then(|choices| choices.first())
            else {
                continue;
            };
            if let Some(reason) = choice
                .get("finish_reason")
                .and_then(serde_json::Value::as_str)
            {
                finish_reason = Some(reason.to_string());
            }
            let delta_content = choice.get("delta").and_then(|delta| delta.get("content"));
            content.push_str(&message_value_text(delta_content));
        }
    }

    // Some OpenAI-compatible gateways ignore `stream: true` and return a
    // regular JSON response. Accept that response rather than reporting an
    // empty stream.
    if content.trim().is_empty() {
        if let Ok(response) = serde_json::from_str::<ChatResponse>(raw_body.trim()) {
            if let Some(choice) = response.choices.first() {
                finish_reason = choice.finish_reason.clone();
                content = message_value_text(choice.message.content.as_ref());
            }
        }
    }

    if matches!(finish_reason.as_deref(), Some("length" | "max_tokens")) {
        return Err("The AI response was truncated because it reached the model output limit. Choose a model with a larger output capacity and try again.".into());
    }
    if content.trim().is_empty() {
        return Err(format!(
            "The AI service returned no final text (finish reason: {}). Please retry or choose another model.",
            finish_reason.as_deref().unwrap_or("unknown")
        ));
    }
    Ok(content.trim().to_string())
}

// Claude-specific request structure
#[derive(Debug, Serialize)]
pub struct ClaudeRequest {
    pub model: String,
    pub max_tokens: u32,
    pub system: String,
    pub messages: Vec<ChatMessage>,
}

// Claude-specific response structure
#[derive(Deserialize, Debug)]
pub struct ClaudeChatResponse {
    pub content: Vec<ClaudeChatContent>,
}

#[derive(Deserialize, Debug)]
pub struct ClaudeChatContent {
    pub text: String,
}

/// LLM Provider enumeration for multi-provider support
#[derive(Debug, Clone, PartialEq)]
pub enum LLMProvider {
    OpenAI,
    Claude,
    Groq,
    Ollama,
    OpenRouter,
    MiniMax,
    DeepSeek,
    Kimi,
    Gemini,
    Qwen,
    Doubao,
    Zhipu,
    BuiltInAI,
    CustomOpenAI,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LongDocumentTask {
    TranscriptRefinement,
    SmartRecord,
    MeetingSummary,
    SpeechSummary,
}

/// Completion budgets must account for both the visible document and hidden
/// reasoning tokens. Reasoning models can otherwise stop with `length` while
/// the final Markdown is still incomplete even when the requested document is
/// much shorter than the source transcript.
pub fn recommended_long_document_output_tokens(
    provider: &LLMProvider,
    model_name: &str,
    input_tokens: usize,
    task: LongDocumentTask,
) -> u32 {
    let normalized_model = model_name.to_ascii_lowercase();
    let reasoning_model = provider == &LLMProvider::MiniMax
        || normalized_model.contains("reason")
        || normalized_model.contains("deepseek-r1")
        || normalized_model.contains("deepseek-reasoner")
        || normalized_model.contains("minimax-m");

    let value = if reasoning_model {
        match task {
            LongDocumentTask::TranscriptRefinement => input_tokens.saturating_mul(4) + 8_192,
            LongDocumentTask::SmartRecord => input_tokens.saturating_mul(3) + 8_192,
            LongDocumentTask::MeetingSummary => input_tokens.saturating_mul(2) + 8_192,
            LongDocumentTask::SpeechSummary => input_tokens.saturating_mul(3) + 8_192,
        }
        .clamp(24_000, 120_000)
    } else {
        match task {
            LongDocumentTask::TranscriptRefinement => input_tokens.saturating_mul(2) + 4_096,
            LongDocumentTask::SmartRecord => input_tokens / 2 + 4_096,
            LongDocumentTask::MeetingSummary => input_tokens / 3 + 4_096,
            LongDocumentTask::SpeechSummary => input_tokens / 2 + 4_096,
        }
        .clamp(8_000, 32_000)
    };
    value as u32
}

impl LLMProvider {
    /// Parse provider from string (case-insensitive)
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s.to_lowercase().as_str() {
            "openai" => Ok(Self::OpenAI),
            "claude" => Ok(Self::Claude),
            "groq" => Ok(Self::Groq),
            "ollama" => Ok(Self::Ollama),
            "openrouter" => Ok(Self::OpenRouter),
            "minimax" => Ok(Self::MiniMax),
            "deepseek" => Ok(Self::DeepSeek),
            "kimi" | "moonshot" => Ok(Self::Kimi),
            "gemini" => Ok(Self::Gemini),
            "qwen" | "dashscope" => Ok(Self::Qwen),
            "doubao" | "volcengine" => Ok(Self::Doubao),
            "zhipu" | "glm" => Ok(Self::Zhipu),
            "builtin-ai" | "local-llama" | "localllama" => Ok(Self::BuiltInAI),
            "custom-openai" => Ok(Self::CustomOpenAI),
            _ => Err(format!("Unsupported LLM provider: {}", s)),
        }
    }
}

/// Generates a summary using the specified LLM provider
///
/// # Arguments
/// * `client` - Reqwest HTTP client (reused for performance)
/// * `provider` - The LLM provider to use
/// * `model_name` - The specific model to use (e.g., "gpt-4", "claude-3-opus")
/// * `api_key` - API key for the provider (not needed for Ollama)
/// * `system_prompt` - System instructions for the LLM
/// * `user_prompt` - User query/content to process
/// * `ollama_endpoint` - Optional custom Ollama endpoint (defaults to localhost:11434)
/// * `custom_openai_endpoint` - Optional custom OpenAI-compatible endpoint
/// * `max_tokens` - Optional max tokens (for CustomOpenAI provider)
/// * `temperature` - Optional temperature (for CustomOpenAI provider)
/// * `top_p` - Optional top_p (for CustomOpenAI provider)
/// * `app_data_dir` - Optional app data directory (for BuiltInAI provider)
/// * `cancellation_token` - Optional token to cancel the request
///
/// # Returns
/// The generated summary text or an error message
pub async fn generate_summary(
    client: &Client,
    provider: &LLMProvider,
    model_name: &str,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    ollama_endpoint: Option<&str>,
    custom_openai_endpoint: Option<&str>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
    app_data_dir: Option<&PathBuf>,
    cancellation_token: Option<&CancellationToken>,
) -> Result<String, String> {
    generate_text_with_policy(
        client,
        provider,
        model_name,
        api_key,
        system_prompt,
        user_prompt,
        ollama_endpoint,
        custom_openai_endpoint,
        max_tokens,
        temperature,
        top_p,
        app_data_dir,
        cancellation_token,
        REQUEST_TIMEOUT_DURATION,
        false,
    )
    .await
}

/// Long document generation uses a separate timeout and may request a streaming
/// transport. It remains one model request; streaming only prevents a long
/// complete response from sitting behind a single HTTP body wait.
pub async fn generate_long_document(
    client: &Client,
    provider: &LLMProvider,
    model_name: &str,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    ollama_endpoint: Option<&str>,
    custom_openai_endpoint: Option<&str>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
    app_data_dir: Option<&PathBuf>,
    cancellation_token: Option<&CancellationToken>,
) -> Result<String, String> {
    generate_text_with_policy(
        client,
        provider,
        model_name,
        api_key,
        system_prompt,
        user_prompt,
        ollama_endpoint,
        custom_openai_endpoint,
        max_tokens,
        temperature,
        top_p,
        app_data_dir,
        cancellation_token,
        LONG_TRANSCRIPT_TIMEOUT_DURATION,
        provider != &LLMProvider::Claude && provider != &LLMProvider::BuiltInAI,
    )
    .await
}

async fn generate_text_with_policy(
    client: &Client,
    provider: &LLMProvider,
    model_name: &str,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    ollama_endpoint: Option<&str>,
    custom_openai_endpoint: Option<&str>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
    app_data_dir: Option<&PathBuf>,
    cancellation_token: Option<&CancellationToken>,
    request_timeout: Duration,
    stream_response: bool,
) -> Result<String, String> {
    // Check if cancelled before starting
    if let Some(token) = cancellation_token {
        if token.is_cancelled() {
            return Err("Summary generation was cancelled".to_string());
        }
    }

    // Handle BuiltInAI provider separately (uses local sidecar, no HTTP API)
    if provider == &LLMProvider::BuiltInAI {
        let app_data_dir = app_data_dir
            .ok_or_else(|| "app_data_dir is required for BuiltInAI provider".to_string())?;

        return crate::summary::summary_engine::generate_with_builtin(
            app_data_dir,
            model_name,
            system_prompt,
            user_prompt,
            cancellation_token,
        )
        .await
        .map_err(|e| e.to_string());
    }

    let (api_url, mut headers) = match provider {
        LLMProvider::OpenAI => (
            "https://api.openai.com/v1/chat/completions".to_string(),
            header::HeaderMap::new(),
        ),
        LLMProvider::Groq => (
            "https://api.groq.com/openai/v1/chat/completions".to_string(),
            header::HeaderMap::new(),
        ),
        LLMProvider::OpenRouter => (
            "https://openrouter.ai/api/v1/chat/completions".to_string(),
            header::HeaderMap::new(),
        ),
        LLMProvider::MiniMax => (
            "https://api.minimaxi.com/v1/chat/completions".to_string(),
            header::HeaderMap::new(),
        ),
        LLMProvider::DeepSeek => (
            "https://api.deepseek.com/chat/completions".to_string(),
            header::HeaderMap::new(),
        ),
        LLMProvider::Kimi => (
            "https://api.moonshot.cn/v1/chat/completions".to_string(),
            header::HeaderMap::new(),
        ),
        LLMProvider::Gemini => (
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions".to_string(),
            header::HeaderMap::new(),
        ),
        LLMProvider::Qwen => (
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions".to_string(),
            header::HeaderMap::new(),
        ),
        LLMProvider::Doubao => (
            "https://ark.cn-beijing.volces.com/api/v3/chat/completions".to_string(),
            header::HeaderMap::new(),
        ),
        LLMProvider::Zhipu => (
            "https://open.bigmodel.cn/api/paas/v4/chat/completions".to_string(),
            header::HeaderMap::new(),
        ),
        LLMProvider::Ollama => {
            let host = ollama_endpoint
                .map(|s| s.to_string())
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            (
                format!("{}/v1/chat/completions", host),
                header::HeaderMap::new(),
            )
        }
        LLMProvider::CustomOpenAI => {
            let endpoint = custom_openai_endpoint
                .ok_or_else(|| "Custom OpenAI endpoint not configured".to_string())?;
            (
                format!("{}/chat/completions", endpoint.trim_end_matches('/')),
                header::HeaderMap::new(),
            )
        }
        LLMProvider::Claude => {
            let mut header_map = header::HeaderMap::new();
            header_map.insert(
                "x-api-key",
                api_key
                    .parse()
                    .map_err(|_| "Invalid API key format".to_string())?,
            );
            header_map.insert(
                "anthropic-version",
                "2023-06-01"
                    .parse()
                    .map_err(|_| "Invalid anthropic version".to_string())?,
            );
            (
                "https://api.anthropic.com/v1/messages".to_string(),
                header_map,
            )
        }
        LLMProvider::BuiltInAI => {
            // This case is handled earlier with early returns
            unreachable!("BuiltInAI is handled before this match statement")
        }
    };

    // Add authorization header for non-Claude providers
    if provider != &LLMProvider::Claude {
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", api_key)
                .parse()
                .map_err(|_| "Invalid authorization header".to_string())?,
        );
    }
    headers.insert(
        header::CONTENT_TYPE,
        "application/json"
            .parse()
            .map_err(|_| "Invalid content type".to_string())?,
    );

    // Build request body based on provider
    let request_body = if provider != &LLMProvider::Claude {
        // OpenAI-compatible domestic providers accept the same optional sampling fields.
        let supports_optional_parameters = matches!(
            provider,
            LLMProvider::OpenAI
                | LLMProvider::Groq
                | LLMProvider::OpenRouter
                | LLMProvider::CustomOpenAI
                | LLMProvider::MiniMax
                | LLMProvider::DeepSeek
                | LLMProvider::Kimi
                | LLMProvider::Gemini
                | LLMProvider::Qwen
                | LLMProvider::Doubao
                | LLMProvider::Zhipu
        );
        let (max_tokens_val, temperature_val, top_p_val) = if supports_optional_parameters {
            (max_tokens, temperature, top_p)
        } else {
            (None, None, None)
        };

        let mut body = serde_json::json!(ChatRequest {
            model: model_name.to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt.to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: user_prompt.to_string(),
                }
            ],
            max_tokens: max_tokens_val,
            temperature: temperature_val,
            top_p: top_p_val,
        });
        // MiniMax's OpenAI-compatible endpoint uses max_completion_tokens.
        // Keep reasoning separate from the final content. The task-level budget
        // above reserves room for both hidden reasoning and the requested final
        // document; callers consume only `content`.
        if provider == &LLMProvider::MiniMax {
            if let Some(object) = body.as_object_mut() {
                object.remove("max_tokens");
                if let Some(value) = max_tokens_val {
                    object.insert("max_completion_tokens".into(), value.into());
                }
                // MiniMax's official OpenAI-compatible API recommends this for
                // M-series reasoning models. Keep hidden reasoning out of the
                // final transcript stream; the caller only consumes `content`.
                object.insert("reasoning_split".into(), true.into());
            }
        }
        if stream_response {
            if let Some(object) = body.as_object_mut() {
                object.insert("stream".into(), true.into());
            }
        }
        body
    } else {
        serde_json::json!(ClaudeRequest {
            system: system_prompt.to_string(),
            model: model_name.to_string(),
            max_tokens: max_tokens.unwrap_or(4096),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: user_prompt.to_string(),
            }]
        })
    };

    info!(
        "🐞 LLM Request to {}: model={}",
        provider_name(provider),
        model_name
    );

    // Send request with timeout and cancellation support
    let request_future = client
        .post(api_url)
        .headers(headers)
        .json(&request_body)
        .timeout(request_timeout)
        .send();

    // Use tokio::select to race between cancellation and request completion
    let response = if let Some(token) = cancellation_token {
        tokio::select! {
            result = request_future => {
                result.map_err(|e| {
                    if e.is_timeout() {
                        format!("LLM request timed out after {} seconds", request_timeout.as_secs())
                    } else {
                        format!("Failed to send request to LLM: {}", e)
                    }
                })?
            }
            _ = token.cancelled() => {
                return Err("Summary generation was cancelled".to_string());
            }
        }
    } else {
        request_future.await.map_err(|e| {
            if e.is_timeout() {
                format!(
                    "LLM request timed out after {} seconds",
                    request_timeout.as_secs()
                )
            } else {
                format!("Failed to send request to LLM: {}", e)
            }
        })?
    };

    if !response.status().is_success() {
        let error_body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("LLM API request failed: {}", error_body));
    }

    if stream_response {
        return read_openai_stream(response, request_timeout, cancellation_token).await;
    }

    // Parse response based on provider
    if provider == &LLMProvider::Claude {
        let chat_response = response
            .json::<ClaudeChatResponse>()
            .await
            .map_err(|e| format!("Failed to parse LLM response: {}", e))?;

        info!("🐞 LLM Response received from Claude");

        let content = chat_response
            .content
            .get(0)
            .ok_or("No content in LLM response")?
            .text
            .trim();
        Ok(content.to_string())
    } else {
        let chat_response = response
            .json::<ChatResponse>()
            .await
            .map_err(|e| format!("Failed to parse LLM response: {}", e))?;

        info!("🐞 LLM Response received from {}", provider_name(provider));

        let choice = chat_response
            .choices
            .get(0)
            .ok_or("No content in LLM response")?;
        if matches!(
            choice.finish_reason.as_deref(),
            Some("length" | "max_tokens")
        ) {
            return Err("The AI response was truncated because it reached the model output limit. Choose a model with a larger output capacity and try again.".into());
        }
        let content = message_value_text(choice.message.content.as_ref());
        if content.trim().is_empty() {
            let reasoning = message_value_text(choice.message.reasoning_content.as_ref());
            let reasoning_details = message_value_text(choice.message.reasoning_details.as_ref());
            let has_reasoning = !reasoning.trim().is_empty()
                || !reasoning_details.trim().is_empty()
                || choice.message.reasoning_details.is_some();
            return if !has_reasoning {
                Err(format!(
                    "The AI service returned no final text (finish reason: {}). Please retry or choose another model.",
                    choice.finish_reason.as_deref().unwrap_or("unknown")
                ))
            } else {
                Err("The AI model used its response budget for reasoning but returned no final transcript. Please retry with a larger output limit or choose a model with a larger output capacity.".into())
            };
        }
        Ok(content.trim().to_string())
    }
}

/// Helper function to get provider name for logging
fn provider_name(provider: &LLMProvider) -> &str {
    match provider {
        LLMProvider::OpenAI => "OpenAI",
        LLMProvider::Claude => "Claude",
        LLMProvider::Groq => "Groq",
        LLMProvider::Ollama => "Ollama",
        LLMProvider::BuiltInAI => "Built-in AI",
        LLMProvider::OpenRouter => "OpenRouter",
        LLMProvider::MiniMax => "MiniMax",
        LLMProvider::DeepSeek => "DeepSeek",
        LLMProvider::Kimi => "Kimi",
        LLMProvider::Gemini => "Gemini",
        LLMProvider::Qwen => "Qwen",
        LLMProvider::Doubao => "Doubao",
        LLMProvider::Zhipu => "Zhipu",
        LLMProvider::CustomOpenAI => "Custom OpenAI",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimax_smart_record_reserves_reasoning_and_document_budget() {
        let budget = recommended_long_document_output_tokens(
            &LLMProvider::MiniMax,
            "MiniMax-M3",
            8_000,
            LongDocumentTask::SmartRecord,
        );

        assert_eq!(budget, 32_192);
        assert!(budget > 8_000);
    }

    #[test]
    fn ordinary_smart_record_keeps_a_conservative_budget() {
        let budget = recommended_long_document_output_tokens(
            &LLMProvider::OpenAI,
            "standard-model",
            8_000,
            LongDocumentTask::SmartRecord,
        );

        assert_eq!(budget, 8_096);
    }

    #[test]
    fn long_document_budgets_are_capped() {
        assert_eq!(
            recommended_long_document_output_tokens(
                &LLMProvider::MiniMax,
                "MiniMax-M3",
                100_000,
                LongDocumentTask::TranscriptRefinement,
            ),
            120_000
        );
    }
}
