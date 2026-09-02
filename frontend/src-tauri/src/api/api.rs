use log::{debug as log_debug, error as log_error, info as log_info, warn as log_warn};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{AppHandle, Runtime};

use crate::{
    database::{
        models::{MeetingListModel, MeetingModel},
        repositories::{
            meeting::MeetingsRepository, setting::SettingsRepository,
            transcript::TranscriptsRepository,
        },
    },
    state::AppState,
    summary::CustomOpenAIConfig,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub meeting_start_time: Option<String>,
    pub meeting_end_time: Option<String>,
    pub calendar_event_id: Option<String>,
    pub source: String,
    pub has_audio: bool,
    pub has_notes: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchRequest {
    pub query: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomModelProfile {
    pub id: String,
    pub kind: String,
    pub protocol: String,
    pub display_name: String,
    pub endpoint: String,
    pub model: String,
    pub has_api_key: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptSearchResult {
    pub id: String,
    pub title: String,
    #[serde(rename = "matchContext")]
    pub match_context: String,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelConfig {
    pub provider: String,
    pub model: String,
    #[serde(rename = "whisperModel")]
    pub whisper_model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "ollamaEndpoint")]
    pub ollama_endpoint: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveModelConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "whisperModel")]
    pub whisper_model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "ollamaEndpoint")]
    pub ollama_endpoint: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GetApiKeyRequest {
    pub provider: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptConfig {
    pub provider: String,
    pub model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveTranscriptConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteMeetingRequest {
    pub meeting_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MeetingDetails {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub meeting_start_time: Option<String>,
    pub meeting_end_time: Option<String>,
    pub calendar_event_id: Option<String>,
    pub source: String,
    pub transcripts: Vec<MeetingTranscript>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MeetingTranscript {
    pub id: String,
    pub text: String,
    pub timestamp: String,
    // Recording-relative timestamps for audio-transcript synchronization
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_start_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_end_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
}

/// Meeting metadata without transcripts (for pagination)
#[derive(Debug, Serialize, Deserialize)]
pub struct MeetingMetadata {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    pub meeting_start_time: Option<String>,
    pub meeting_end_time: Option<String>,
    pub calendar_event_id: Option<String>,
    pub source: String,
}

/// Paginated transcripts response with total count
#[derive(Debug, Serialize, Deserialize)]
pub struct PaginatedTranscriptsResponse {
    pub transcripts: Vec<MeetingTranscript>,
    pub total_count: i64,
    pub has_more: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveMeetingTitleRequest {
    pub meeting_id: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveMeetingSummaryRequest {
    pub meeting_id: String,
    pub summary: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveTranscriptRequest {
    pub meeting_title: String,
    pub transcripts: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub text: String,
    pub timestamp: String,
    // NEW: Recording-relative timestamps for playback synchronization
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_start_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_end_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
}

// API Commands for Tauri

#[tauri::command]
pub async fn api_get_meetings<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    auth_token: Option<String>,
) -> Result<Vec<Meeting>, String> {
    log_info!(
        "api_get_meetings called with auth_token(native) : {}",
        auth_token.is_some()
    );
    let pool = state.db_manager.pool();
    let meetings: Result<Vec<MeetingListModel>, sqlx::Error> =
        MeetingsRepository::get_meetings(pool).await;

    match meetings {
        Ok(meeting_models) => {
            log_info!("Successfully got {} meetings", meeting_models.len());

            let result: Vec<Meeting> = meeting_models
                .into_iter()
                .map(|m| Meeting {
                    id: m.id,
                    title: m.title,
                    created_at: m.created_at.0.to_rfc3339(),
                    updated_at: m.updated_at.0.to_rfc3339(),
                    meeting_start_time: m.meeting_start_time,
                    meeting_end_time: m.meeting_end_time,
                    calendar_event_id: m.calendar_event_id,
                    source: m.source,
                    has_audio: m.has_audio,
                    has_notes: m.has_notes,
                })
                .collect();
            Ok(result)
        }
        Err(e) => {
            log_error!("Error getting meetings: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn api_search_transcripts<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    query: String,
    auth_token: Option<String>,
) -> Result<Vec<TranscriptSearchResult>, String> {
    log_info!(
        "api_search_transcripts called with query: '{}', auth_token: {}",
        query,
        auth_token.is_some()
    );

    let pool = state.db_manager.pool();

    match TranscriptsRepository::search_transcripts(pool, &query).await {
        Ok(results) => {
            log_info!(
                "Search completed successfully with {} results.",
                results.len()
            );
            Ok(results)
        }
        Err(e) => {
            log_error!("Error searching transcripts for query '{}': {}", query, e);
            Err(format!("Failed to search transcripts: {}", e))
        }
    }
}

#[tauri::command]
pub async fn api_get_model_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    _auth_token: Option<String>,
) -> Result<Option<ModelConfig>, String> {
    log_info!("api_get_model_config called (native)");
    let pool = state.db_manager.pool();

    match SettingsRepository::get_model_config(pool).await {
        Ok(Some(config)) => {
            log_info!(
                "✅ Found model config in database: provider={}, model={}, whisperModel={}, ollamaEndpoint={:?}",
                &config.provider,
                &config.model,
                &config.whisper_model,
                &config.ollama_endpoint
            );
            match SettingsRepository::get_api_key(pool, &config.provider).await {
                Ok(api_key) => {
                    log_info!("Successfully retrieved model config and API key.");
                    Ok(Some(ModelConfig {
                        provider: config.provider,
                        model: config.model,
                        whisper_model: config.whisper_model,
                        api_key,
                        ollama_endpoint: config.ollama_endpoint,
                    }))
                }
                Err(e) => {
                    log_error!(
                        "Failed to get API key for provider {}: {}",
                        &config.provider,
                        e
                    );
                    Err(e.to_string())
                }
            }
        }
        Ok(None) => {
            log_warn!("⚠️ No model config found in database - database may be empty or settings table not initialized");
            Ok(None)
        }
        Err(e) => {
            log_error!("❌ Failed to get model config from database: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn api_save_model_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    model: String,
    whisper_model: String,
    api_key: Option<String>,
    ollama_endpoint: Option<String>,
    _auth_token: Option<String>,
) -> Result<serde_json::Value, String> {
    log_info!(
        "💾 api_save_model_config called (native): provider='{}', model='{}', whisperModel='{}', ollamaEndpoint={:?}",
        &provider,
        &model,
        &whisper_model,
        &ollama_endpoint
    );
    let pool = state.db_manager.pool();

    if let Err(e) = SettingsRepository::save_model_config(
        pool,
        &provider,
        &model,
        &whisper_model,
        ollama_endpoint.as_deref(),
    )
    .await
    {
        log_error!("❌ Failed to save model config to database: {}", e);
        return Err(e.to_string());
    }

    // Skip API key saving for custom-openai provider (it uses customOpenAIConfig JSON instead)
    if let Some(key) = api_key {
        if !key.is_empty() && provider != "custom-openai" {
            log_info!("🔑 API key provided, saving...");
            if let Err(e) = SettingsRepository::save_api_key(pool, &provider, &key).await {
                log_error!("❌ Failed to save API key: {}", e);
                return Err(e.to_string());
            }
        }
    }

    // Trigger graceful shutdown of built-in AI sidecar if it's running
    // This ensures that if the user switched models/providers, the old one is cleaned up
    // The shutdown happens in the background, so it won't block the UI
    if let Err(e) = crate::summary::summary_engine::client::shutdown_sidecar_gracefully().await {
        log_warn!("Failed to initiate graceful sidecar shutdown: {}", e);
    }

    log_info!("✅ Successfully saved model configuration to database");
    Ok(
        serde_json::json!({ "status": "success", "message": "Model configuration saved successfully" }),
    )
}

#[tauri::command]
pub async fn api_get_api_key<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    _auth_token: Option<String>,
) -> Result<String, String> {
    log_info!(
        "api_get_api_key called (native) for provider '{}'",
        &provider
    );
    match SettingsRepository::get_api_key(&state.db_manager.pool(), &provider).await {
        Ok(key) => {
            log_info!(
                "Successfully retrieved API key for provider '{}'.",
                &provider
            );
            Ok(key.unwrap_or_default())
        }
        Err(e) => {
            log_error!("Failed to get API key for provider '{}': {}", &provider, e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn api_get_transcript_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    _auth_token: Option<String>,
) -> Result<Option<TranscriptConfig>, String> {
    log_info!("api_get_transcript_config called (native)");
    let pool = state.db_manager.pool();

    match SettingsRepository::get_transcript_config(pool).await {
        Ok(Some(config)) => {
            log_info!(
                "Found transcript config: provider={}, model={}",
                &config.provider,
                &config.model
            );
            match SettingsRepository::get_transcript_api_key(pool, &config.provider).await {
                Ok(api_key) => {
                    log_info!("Successfully retrieved transcript config and API key.");
                    Ok(Some(TranscriptConfig {
                        provider: config.provider,
                        model: config.model,
                        api_key,
                    }))
                }
                Err(e) => {
                    log_error!(
                        "Failed to get transcript API key for provider {}: {}",
                        &config.provider,
                        e
                    );
                    Err(e.to_string())
                }
            }
        }
        Ok(None) => {
            log_info!("No transcript config found, returning default.");
            Ok(Some(TranscriptConfig {
                provider: "parakeet".to_string(),
                model: crate::config::DEFAULT_PARAKEET_MODEL.to_string(),
                api_key: None,
            }))
        }
        Err(e) => {
            log_error!("Failed to get transcript config: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn api_save_transcript_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    model: String,
    api_key: Option<String>,
    _auth_token: Option<String>,
) -> Result<serde_json::Value, String> {
    log_info!(
        "api_save_transcript_config called (native) for provider '{}'",
        &provider
    );
    let pool = state.db_manager.pool();

    if let Err(e) = SettingsRepository::save_transcript_config(pool, &provider, &model).await {
        log_error!("Failed to save transcript config: {}", e);
        return Err(e.to_string());
    }

    if let Some(key) = api_key {
        if !key.is_empty() {
            log_info!("API key provided, saving for transcript provider...");
            if let Err(e) = SettingsRepository::save_transcript_api_key(pool, &provider, &key).await
            {
                log_error!("Failed to save transcript API key: {}", e);
                return Err(e.to_string());
            }
        }
    }

    log_info!("Successfully saved transcript configuration.");
    Ok(
        serde_json::json!({ "status": "success", "message": "Transcript configuration saved successfully" }),
    )
}

#[tauri::command]
pub async fn api_get_transcript_api_key<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    _auth_token: Option<String>,
) -> Result<String, String> {
    log_info!(
        "api_get_transcript_api_key called (native) for provider '{}'",
        &provider
    );
    match SettingsRepository::get_transcript_api_key(&state.db_manager.pool(), &provider).await {
        Ok(key) => {
            log_info!(
                "Successfully retrieved transcript API key for provider '{}'.",
                &provider
            );
            Ok(key.unwrap_or_default())
        }
        Err(e) => {
            log_error!(
                "Failed to get transcript API key for provider '{}': {}",
                &provider,
                e
            );
            Err(e.to_string())
        }
    }
}

/// Save credentials for a future cloud transcription without making that provider the active
/// recording engine. This prevents a configured-but-not-authorized cloud provider from breaking
/// local recording before the explicit audio-sharing step has been completed.
#[tauri::command]
pub async fn api_save_transcript_provider_credentials<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    model: String,
    api_key: Option<String>,
    credentials: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if model.trim().is_empty() {
        return Err("Provider and model are required".to_string());
    }
    if let Some(key) = api_key.as_deref().filter(|value| !value.trim().is_empty()) {
        SettingsRepository::save_transcript_api_key(state.db_manager.pool(), &provider, key.trim())
            .await
            .map_err(|e| e.to_string())?;
    }
    let stored_api_key = if provider == "funasr-server" {
        api_key.as_deref().map(str::trim)
    } else {
        api_key
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::trim)
    };
    sqlx::query("INSERT INTO transcript_provider_credentials(provider,api_key,extra_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(provider) DO UPDATE SET api_key=COALESCE(excluded.api_key,transcript_provider_credentials.api_key),extra_json=excluded.extra_json,updated_at=CURRENT_TIMESTAMP")
        .bind(&provider)
        .bind(stored_api_key)
        .bind(serde_json::json!({"model": model.trim(), "credentials": credentials.unwrap_or_else(|| serde_json::json!({}))}).to_string())
        .execute(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"status":"success","message":"Cloud transcription credentials saved; the active local engine was not changed"}),
    )
}

#[tauri::command]
pub async fn api_get_transcript_provider_credentials<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let extra: Option<String> = sqlx::query_scalar(
        "SELECT extra_json FROM transcript_provider_credentials WHERE provider=?",
    )
    .bind(&provider)
    .fetch_optional(state.db_manager.pool())
    .await
    .map_err(|e| e.to_string())?
    .flatten();
    let mut value = extra
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let api_key = SettingsRepository::get_transcript_api_key(state.db_manager.pool(), &provider)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "apiKey".to_string(),
            serde_json::json!(api_key.unwrap_or_default()),
        );
    }
    Ok(value)
}

fn validate_custom_model_profile(
    kind: &str,
    protocol: &str,
    display_name: &str,
    endpoint: &str,
    model: &str,
) -> Result<(), String> {
    if !matches!(kind, "transcription" | "ai") {
        return Err("Model kind must be transcription or ai".to_string());
    }
    if !matches!(protocol, "openai" | "anthropic") {
        return Err("Protocol must be openai or anthropic".to_string());
    }
    if kind == "transcription" && protocol != "openai" {
        return Err(
            "Transcription connections currently require an OpenAI-compatible API".to_string(),
        );
    }
    if display_name.trim().is_empty() || model.trim().is_empty() {
        return Err("Name and model are required".to_string());
    }
    let parsed = reqwest::Url::parse(endpoint.trim())
        .map_err(|_| "Enter a valid HTTP or HTTPS service address".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Enter a valid HTTP or HTTPS service address".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("The service address must not contain credentials".to_string());
    }
    if protocol == "anthropic" && parsed.host_str() != Some("api.anthropic.com") {
        return Err(
            "Anthropic profiles currently support the official api.anthropic.com service"
                .to_string(),
        );
    }
    Ok(())
}

fn profile_from_row(row: &sqlx::sqlite::SqliteRow) -> CustomModelProfile {
    CustomModelProfile {
        id: row.get("id"),
        kind: row.get("kind"),
        protocol: row.get("protocol"),
        display_name: row.get("display_name"),
        endpoint: row.get("endpoint"),
        model: row.get("model"),
        has_api_key: row
            .get::<Option<String>, _>("api_key")
            .is_some_and(|value| !value.trim().is_empty()),
    }
}

#[tauri::command]
pub async fn api_list_custom_model_profiles<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    kind: String,
) -> Result<Vec<CustomModelProfile>, String> {
    if !matches!(kind.as_str(), "transcription" | "ai") {
        return Err("Model kind must be transcription or ai".to_string());
    }
    let pool = state.db_manager.pool();
    if kind == "transcription" {
        if let Some(row) = sqlx::query("SELECT api_key,extra_json FROM transcript_provider_credentials WHERE provider='funasr-server'")
            .fetch_optional(pool).await.map_err(|error| error.to_string())?
        {
            let value = row.get::<Option<String>, _>("extra_json")
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            let model = value.get("model").and_then(|item| item.as_str()).unwrap_or_default();
            let credentials = value.get("credentials").and_then(|item| item.as_object());
            let endpoint = credentials.and_then(|item| item.get("endpoint")).and_then(|item| item.as_str()).unwrap_or_default();
            if !model.is_empty() && !endpoint.is_empty() {
                let display_name = credentials.and_then(|item| item.get("displayName")).and_then(|item| item.as_str()).unwrap_or("Imported cloud ASR");
                sqlx::query("INSERT OR IGNORE INTO custom_model_profiles(id,kind,protocol,display_name,endpoint,api_key,model) VALUES('legacy-funasr-server','transcription','openai',?,?,?,?)")
                    .bind(display_name).bind(endpoint).bind(row.get::<Option<String>, _>("api_key")).bind(model)
                    .execute(pool).await.map_err(|error| error.to_string())?;
            }
        }
    } else if let Some(config) = SettingsRepository::get_custom_openai_config(pool)
        .await
        .map_err(|error| error.to_string())?
    {
        sqlx::query("INSERT OR IGNORE INTO custom_model_profiles(id,kind,protocol,display_name,endpoint,api_key,model) VALUES('legacy-custom-openai','ai','openai','Imported custom model',?,?,?)")
            .bind(config.endpoint).bind(config.api_key).bind(config.model)
            .execute(pool).await.map_err(|error| error.to_string())?;
    }
    let rows = sqlx::query("SELECT id,kind,protocol,display_name,endpoint,model,api_key FROM custom_model_profiles WHERE kind=? ORDER BY updated_at DESC,display_name")
        .bind(kind)
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
    Ok(rows.iter().map(profile_from_row).collect())
}

#[tauri::command]
pub async fn api_save_custom_model_profile<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    id: Option<String>,
    kind: String,
    protocol: String,
    display_name: String,
    endpoint: String,
    api_key: Option<String>,
    model: String,
) -> Result<CustomModelProfile, String> {
    validate_custom_model_profile(&kind, &protocol, &display_name, &endpoint, &model)?;
    let id = id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    sqlx::query("INSERT INTO custom_model_profiles(id,kind,protocol,display_name,endpoint,api_key,model,updated_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,protocol=excluded.protocol,display_name=excluded.display_name,endpoint=excluded.endpoint,api_key=COALESCE(excluded.api_key,custom_model_profiles.api_key),model=excluded.model,updated_at=CURRENT_TIMESTAMP")
        .bind(&id)
        .bind(&kind)
        .bind(&protocol)
        .bind(display_name.trim())
        .bind(endpoint.trim().trim_end_matches('/'))
        .bind(key)
        .bind(model.trim())
        .execute(state.db_manager.pool())
        .await
        .map_err(|error| error.to_string())?;
    let row = sqlx::query("SELECT id,kind,protocol,display_name,endpoint,model,api_key FROM custom_model_profiles WHERE id=?")
        .bind(&id)
        .fetch_one(state.db_manager.pool())
        .await
        .map_err(|error| error.to_string())?;
    Ok(profile_from_row(&row))
}

#[tauri::command]
pub async fn api_delete_custom_model_profile<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    id: String,
    kind: String,
) -> Result<bool, String> {
    let result = sqlx::query("DELETE FROM custom_model_profiles WHERE id=? AND kind=?")
        .bind(id)
        .bind(kind)
        .execute(state.db_manager.pool())
        .await
        .map_err(|error| error.to_string())?;
    Ok(result.rows_affected() == 1)
}

async fn custom_model_profile_secret(
    pool: &sqlx::SqlitePool,
    id: &str,
) -> Result<(String, String, String, String, String, String), String> {
    let row = sqlx::query("SELECT kind,protocol,display_name,endpoint,model,COALESCE(api_key,'') AS api_key FROM custom_model_profiles WHERE id=?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(|error| error.to_string())?;
    Ok((
        row.get("kind"),
        row.get("protocol"),
        row.get("display_name"),
        row.get("endpoint"),
        row.get("model"),
        row.get("api_key"),
    ))
}

#[tauri::command]
pub async fn api_activate_custom_model_profile<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let pool = state.db_manager.pool();
    let (kind, protocol, display_name, endpoint, model, api_key) =
        custom_model_profile_secret(pool, &id).await?;
    if kind == "transcription" {
        let credentials = serde_json::json!({"displayName":display_name,"endpoint":endpoint,"apiKey":api_key,"profileId":id});
        sqlx::query("INSERT INTO transcript_provider_credentials(provider,api_key,extra_json,updated_at) VALUES('funasr-server',?,?,CURRENT_TIMESTAMP) ON CONFLICT(provider) DO UPDATE SET api_key=excluded.api_key,extra_json=excluded.extra_json,updated_at=CURRENT_TIMESTAMP")
            .bind(if api_key.is_empty() { None::<String> } else { Some(api_key) })
            .bind(serde_json::json!({"model":model,"credentials":credentials}).to_string())
            .execute(pool).await.map_err(|error| error.to_string())?;
        return Ok(serde_json::json!({"provider":"funasr-server","model":model}));
    }
    if protocol == "anthropic" {
        if api_key.trim().is_empty() {
            return Err("API Key is required".to_string());
        }
        SettingsRepository::save_api_key(pool, "claude", &api_key)
            .await
            .map_err(|error| error.to_string())?;
        SettingsRepository::save_model_config(pool, "claude", &model, "large-v3", None)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(serde_json::json!({"provider":"claude","model":model}));
    }
    let config = CustomOpenAIConfig {
        endpoint,
        api_key: (!api_key.is_empty()).then_some(api_key),
        model: model.clone(),
        max_tokens: None,
        temperature: None,
        top_p: None,
    };
    SettingsRepository::save_custom_openai_config(pool, &config)
        .await
        .map_err(|error| error.to_string())?;
    SettingsRepository::save_model_config(pool, "custom-openai", &model, "large-v3", None)
        .await
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({"provider":"custom-openai","model":model}))
}

fn custom_models_url(endpoint: &str, protocol: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(endpoint).map_err(|error| error.to_string())?;
    let path = url.path().trim_end_matches('/');
    let new_path = if protocol == "anthropic" {
        "/v1/models".to_string()
    } else if let Some(prefix) = path.strip_suffix("/audio/transcriptions") {
        format!("{prefix}/models")
    } else if path.ends_with("/models") {
        path.to_string()
    } else {
        format!("{path}/models")
    };
    url.set_path(&new_path);
    url.set_query(None);
    Ok(url)
}

#[tauri::command]
pub async fn api_discover_custom_profile_models<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    id: Option<String>,
    protocol: String,
    endpoint: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let stored_key = if let Some(profile_id) = id.as_deref() {
        custom_model_profile_secret(state.db_manager.pool(), profile_id)
            .await
            .map(|value| value.5)
            .unwrap_or_default()
    } else {
        String::new()
    };
    let key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or(stored_key);
    let url = custom_models_url(endpoint.trim(), &protocol)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(url);
    if protocol == "anthropic" {
        request = request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01");
    } else if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Model list request failed: {error}"))?;
    let status = response.status();
    let value = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Model list response was invalid: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Model list request failed with HTTP {}",
            status.as_u16()
        ));
    }
    let mut models = value
        .get("data")
        .and_then(|data| data.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
        .map(str::to_string)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    Ok(models)
}

#[tauri::command]
pub async fn api_test_custom_model_profile<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    id: Option<String>,
    kind: String,
    protocol: String,
    endpoint: String,
    api_key: Option<String>,
    model: String,
) -> Result<serde_json::Value, String> {
    let stored_key = if let Some(profile_id) = id.as_deref() {
        custom_model_profile_secret(state.db_manager.pool(), profile_id)
            .await
            .map(|value| value.5)
            .unwrap_or_default()
    } else {
        String::new()
    };
    let key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or(stored_key);
    validate_custom_model_profile(&kind, &protocol, "Connection test", &endpoint, &model)?;
    if kind == "transcription" {
        return crate::remote_funasr::test_connection(endpoint.trim(), key.trim()).await;
    }
    if protocol == "anthropic" {
        return api_test_llm_connection("claude".to_string(), key, model).await;
    }
    api_test_custom_openai_connection(_app, endpoint, (!key.is_empty()).then_some(key), model).await
}

#[cfg(test)]
mod custom_model_profile_tests {
    use super::{custom_models_url, validate_custom_model_profile};

    #[test]
    fn transcription_profiles_require_openai_compatible_protocol() {
        assert!(validate_custom_model_profile(
            "transcription",
            "anthropic",
            "Team ASR",
            "https://api.anthropic.com",
            "model"
        )
        .is_err());
    }

    #[test]
    fn profile_service_address_rejects_embedded_credentials() {
        assert!(validate_custom_model_profile(
            "ai",
            "openai",
            "Private model",
            "https://user:secret@example.com/v1",
            "model"
        )
        .is_err());
    }

    #[test]
    fn transcription_endpoint_maps_to_models_endpoint() {
        let url = custom_models_url("https://example.com/v1/audio/transcriptions", "openai")
            .expect("models URL");
        assert_eq!(url.as_str(), "https://example.com/v1/models");
    }
}

#[tauri::command]
pub async fn api_delete_api_key<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    _auth_token: Option<String>,
) -> Result<(), String> {
    log_info!(
        "log_api_delete_api_key called (native) for provider '{}'",
        &provider
    );
    match SettingsRepository::delete_api_key(&state.db_manager.pool(), &provider).await {
        Ok(_) => {
            log_info!("Successfully deleted API key for provider '{}'.", &provider);
            Ok(())
        }
        Err(e) => {
            log_error!(
                "Failed to delete API key for provider '{}': {}",
                &provider,
                e
            );
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn api_delete_meeting<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    auth_token: Option<String>,
) -> Result<serde_json::Value, String> {
    log_info!(
        "api_delete_meeting called for meeting_id(native): {}, auth_token: {}",
        meeting_id,
        auth_token.is_some()
    );

    let pool = state.db_manager.pool();

    match MeetingsRepository::delete_meeting(pool, &meeting_id).await {
        Ok(true) => {
            log_info!("Successfully deleted meeting {}", meeting_id);
            Ok(serde_json::json!({
                "status": "success",
                "message": "Meeting deleted successfully"
            }))
        }
        Ok(false) => {
            log_warn!("Meeting not found or already deleted: {}", meeting_id);
            Err(format!(
                "Meeting not found or could not be deleted: {}",
                meeting_id
            ))
        }
        Err(e) => {
            log_error!("Error deleting meeting {}: {}", meeting_id, e);
            Err(format!("Failed to delete meeting: {}", e))
        }
    }
}

#[tauri::command]
pub async fn api_get_meeting<R: Runtime>(
    _app: AppHandle<R>,
    meeting_id: String,
    state: tauri::State<'_, AppState>,
    auth_token: Option<String>,
) -> Result<MeetingDetails, String> {
    log_info!(
        "api_get_meeting called(native) for meeting_id: {}, auth_token: {}",
        meeting_id,
        auth_token.is_some()
    );

    let pool = state.db_manager.pool();

    match MeetingsRepository::get_meeting(pool, &meeting_id).await {
        Ok(Some(meeting)) => {
            log_info!("Successfully retrieved meeting {}", meeting_id);
            Ok(meeting)
        }
        Ok(None) => {
            log_warn!("Meeting not found: {}", meeting_id);
            Err(format!("Meeting not found: {}", meeting_id))
        }
        Err(e) => {
            log_error!("Error retrieving meeting {}: {}", meeting_id, e);
            Err(format!("Failed to retrieve meeting: {}", e))
        }
    }
}

/// Get meeting metadata without transcripts (for pagination)
#[tauri::command]
pub async fn api_get_meeting_metadata<R: Runtime>(
    _app: AppHandle<R>,
    meeting_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<MeetingMetadata, String> {
    log_info!(
        "api_get_meeting_metadata called for meeting_id: {}",
        meeting_id
    );

    let pool = state.db_manager.pool();

    match MeetingsRepository::get_meeting_metadata(pool, &meeting_id).await {
        Ok(Some(meeting)) => {
            log_info!("Successfully retrieved meeting metadata {}", meeting_id);
            Ok(MeetingMetadata {
                id: meeting.id,
                title: meeting.title,
                created_at: meeting.created_at.0.to_rfc3339(),
                updated_at: meeting.updated_at.0.to_rfc3339(),
                folder_path: meeting.folder_path,
                meeting_start_time: meeting.meeting_start_time,
                meeting_end_time: meeting.meeting_end_time,
                calendar_event_id: meeting.calendar_event_id,
                source: meeting.source,
            })
        }
        Ok(None) => {
            log_warn!("Meeting not found: {}", meeting_id);
            Err(format!("Meeting not found: {}", meeting_id))
        }
        Err(e) => {
            log_error!("Error retrieving meeting metadata {}: {}", meeting_id, e);
            Err(format!("Failed to retrieve meeting metadata: {}", e))
        }
    }
}

/// Get paginated transcripts for a meeting
#[tauri::command]
pub async fn api_get_meeting_transcripts<R: Runtime>(
    _app: AppHandle<R>,
    meeting_id: String,
    limit: i64,
    offset: i64,
    state: tauri::State<'_, AppState>,
) -> Result<PaginatedTranscriptsResponse, String> {
    log_info!(
        "api_get_meeting_transcripts called for meeting_id: {}, limit: {}, offset: {}",
        meeting_id,
        limit,
        offset
    );

    let pool = state.db_manager.pool();

    match MeetingsRepository::get_meeting_transcripts_paginated(pool, &meeting_id, limit, offset)
        .await
    {
        Ok((transcripts, total_count)) => {
            log_info!(
                "Successfully retrieved {} transcripts for meeting {} (total: {})",
                transcripts.len(),
                meeting_id,
                total_count
            );

            // Convert Transcript to MeetingTranscript
            let meeting_transcripts = transcripts
                .into_iter()
                .map(|t| MeetingTranscript {
                    id: t.id,
                    text: t.transcript,
                    timestamp: t.timestamp,
                    audio_start_time: t.audio_start_time,
                    audio_end_time: t.audio_end_time,
                    duration: t.duration,
                })
                .collect::<Vec<_>>();

            let has_more = (offset + meeting_transcripts.len() as i64) < total_count;

            Ok(PaginatedTranscriptsResponse {
                transcripts: meeting_transcripts,
                total_count,
                has_more,
            })
        }
        Err(e) => {
            log_error!(
                "Error retrieving transcripts for meeting {}: {}",
                meeting_id,
                e
            );
            Err(format!("Failed to retrieve transcripts: {}", e))
        }
    }
}

#[tauri::command]
pub async fn api_save_meeting_title<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    title: String,
    auth_token: Option<String>,
) -> Result<serde_json::Value, String> {
    log_info!(
        "api_save_meeting_title called for meeting_id: {}, auth_token: {}",
        meeting_id,
        auth_token.is_some()
    );
    let pool = state.db_manager.pool();
    match MeetingsRepository::update_meeting_title(pool, &meeting_id, &title).await {
        Ok(true) => {
            log_info!("Successfully saved meeting title");
            Ok(serde_json::json!({"message": "Meeting title saved successfully"}))
        }
        Ok(false) => {
            log_error!("No meeting found with id {}", meeting_id);
            Err(format!("No meeting found with id {}", meeting_id))
        }
        Err(e) => {
            log_error!("Failed to update meeting {}", e);
            Err(format!("Failed to update meeting: {}", e))
        }
    }
}

#[tauri::command]
pub async fn api_save_transcript<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_title: String,
    transcripts: Vec<serde_json::Value>,
    folder_path: Option<String>,
    auth_token: Option<String>,
) -> Result<serde_json::Value, String> {
    log_info!(
        "api_save_transcript called for meeting: {}, transcripts: {}, folder_path: {:?}, auth_token: {}",
        meeting_title,
        transcripts.len(),
        folder_path,
        auth_token.is_some()
    );

    // Log first transcript for debugging
    if let Some(first) = transcripts.first() {
        log_debug!(
            "First transcript data: {}",
            serde_json::to_string_pretty(first).unwrap_or_default()
        );
    }

    // Convert serde_json::Value to TranscriptSegment
    let transcripts_to_save: Vec<TranscriptSegment> = transcripts
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| {
            log_error!("Failed to parse transcript segments: {}", e);
            format!(
                "Invalid transcript data format: {}. Please check the data structure.",
                e
            )
        })?;

    // Log parsed segments count and first segment details
    if let Some(first_seg) = transcripts_to_save.first() {
        log_debug!("First parsed segment: text='{}', audio_start_time={:?}, audio_end_time={:?}, duration={:?}",
                   first_seg.text.chars().take(50).collect::<String>(),
                   first_seg.audio_start_time,
                   first_seg.audio_end_time,
                   first_seg.duration);
    }

    let pool = state.db_manager.pool();

    // Now, call the repository with the correctly typed data.
    match TranscriptsRepository::save_transcript(
        pool,
        &meeting_title,
        &transcripts_to_save,
        folder_path,
    )
    .await
    {
        Ok(meeting_id) => {
            log_info!(
                "Successfully saved transcript and created meeting with id: {}",
                meeting_id
            );
            Ok(serde_json::json!({
                "status": "success",
                "message": "Transcript saved successfully",
                "meeting_id": meeting_id
            }))
        }
        Err(e) => {
            log_error!(
                "Error saving transcript for meeting '{}': {}",
                meeting_title,
                e
            );
            Err(format!("Failed to save transcript: {}", e))
        }
    }
}

/// Opens the meeting's recording folder in the system file explorer
#[tauri::command]
pub async fn open_meeting_folder<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    log_info!("open_meeting_folder called for meeting_id: {}", meeting_id);

    let pool = state.db_manager.pool();

    // Get meeting with folder_path
    let meeting: Option<MeetingModel> = sqlx::query_as(
        "SELECT id,title,created_at,updated_at,folder_path,meeting_start_time,meeting_end_time,calendar_event_id,source,external_id FROM meetings WHERE id = ?",
    )
    .bind(&meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Database error: {}", e))?;

    match meeting {
        Some(m) => {
            if let Some(folder_path) = m.folder_path {
                log_info!("Opening meeting folder: {}", folder_path);

                // Verify folder exists
                let path = std::path::Path::new(&folder_path);
                if !path.exists() {
                    log_warn!("Folder path does not exist: {}", folder_path);
                    return Err(format!("Recording folder not found: {}", folder_path));
                }

                // Open folder based on OS
                #[cfg(target_os = "macos")]
                {
                    std::process::Command::new("open")
                        .arg(&folder_path)
                        .spawn()
                        .map_err(|e| format!("Failed to open folder: {}", e))?;
                }

                #[cfg(target_os = "windows")]
                {
                    std::process::Command::new("explorer")
                        .arg(&folder_path)
                        .spawn()
                        .map_err(|e| format!("Failed to open folder: {}", e))?;
                }

                #[cfg(target_os = "linux")]
                {
                    std::process::Command::new("xdg-open")
                        .arg(&folder_path)
                        .spawn()
                        .map_err(|e| format!("Failed to open folder: {}", e))?;
                }

                log_info!("Successfully opened folder: {}", folder_path);
                Ok(())
            } else {
                log_warn!("Meeting {} has no folder_path set", meeting_id);
                Err("Recording folder path not available for this meeting".to_string())
            }
        }
        None => {
            log_warn!("Meeting not found: {}", meeting_id);
            Err("Meeting not found".to_string())
        }
    }
}

#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    use std::process::Command;

    let result = if cfg!(target_os = "windows") {
        Command::new("cmd").args(&["/C", "start", &url]).output()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&url).output()
    } else {
        // Linux and other Unix-like systems
        Command::new("xdg-open").arg(&url).output()
    };

    match result {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to open URL: {}", e)),
    }
}

// ===== CUSTOM OPENAI API COMMANDS =====

/// Saves the custom OpenAI configuration
/// This configuration is stored as JSON and includes endpoint, apiKey, model, and optional parameters
#[tauri::command]
pub async fn api_save_custom_openai_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    endpoint: String,
    api_key: Option<String>,
    model: String,
    max_tokens: Option<i32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
) -> Result<serde_json::Value, String> {
    log_info!(
        "api_save_custom_openai_config called: endpoint='{}', model='{}'",
        &endpoint,
        &model
    );

    // Validate required fields
    if endpoint.trim().is_empty() {
        return Err("Endpoint URL is required".to_string());
    }
    if model.trim().is_empty() {
        return Err("Model name is required".to_string());
    }

    // Validate endpoint URL format
    if !endpoint.starts_with("http://") && !endpoint.starts_with("https://") {
        return Err("Endpoint must start with http:// or https://".to_string());
    }

    // Validate optional numeric parameters
    if let Some(temp) = temperature {
        if !(0.0..=2.0).contains(&temp) {
            return Err("Temperature must be between 0.0 and 2.0".to_string());
        }
    }
    if let Some(top) = top_p {
        if !(0.0..=1.0).contains(&top) {
            return Err("Top P must be between 0.0 and 1.0".to_string());
        }
    }
    if let Some(tokens) = max_tokens {
        if tokens < 1 {
            return Err("Max tokens must be at least 1".to_string());
        }
    }

    let config = CustomOpenAIConfig {
        endpoint: endpoint.trim().to_string(),
        api_key: api_key.filter(|k| !k.trim().is_empty()),
        model: model.trim().to_string(),
        max_tokens,
        temperature,
        top_p,
    };

    let pool = state.db_manager.pool();

    match SettingsRepository::save_custom_openai_config(pool, &config).await {
        Ok(()) => {
            log_info!(
                "✅ Successfully saved custom OpenAI config for endpoint: {}",
                config.endpoint
            );
            Ok(serde_json::json!({
                "status": "success",
                "message": "Custom OpenAI configuration saved successfully"
            }))
        }
        Err(e) => {
            log_error!("❌ Failed to save custom OpenAI config: {}", e);
            Err(format!("Failed to save custom OpenAI configuration: {}", e))
        }
    }
}

/// Gets the custom OpenAI configuration
#[tauri::command]
pub async fn api_get_custom_openai_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<Option<CustomOpenAIConfig>, String> {
    log_info!("api_get_custom_openai_config called");

    let pool = state.db_manager.pool();

    match SettingsRepository::get_custom_openai_config(pool).await {
        Ok(config) => {
            if let Some(ref c) = config {
                log_info!(
                    "✅ Found custom OpenAI config: endpoint='{}', model='{}'",
                    c.endpoint,
                    c.model
                );
            } else {
                log_info!("No custom OpenAI config found");
            }
            Ok(config)
        }
        Err(e) => {
            log_error!("❌ Failed to get custom OpenAI config: {}", e);
            Err(format!("Failed to get custom OpenAI configuration: {}", e))
        }
    }
}

/// Tests the connection to a custom OpenAI-compatible endpoint
/// Makes a minimal request to verify the endpoint is reachable and responds correctly
#[tauri::command]
pub async fn api_test_custom_openai_connection<R: Runtime>(
    _app: AppHandle<R>,
    endpoint: String,
    api_key: Option<String>,
    model: String,
) -> Result<serde_json::Value, String> {
    log_info!(
        "api_test_custom_openai_connection called: endpoint='{}', model='{}'",
        &endpoint,
        &model
    );

    // Validate endpoint URL format
    if !endpoint.starts_with("http://") && !endpoint.starts_with("https://") {
        return Err("Endpoint must start with http:// or https://".to_string());
    }

    // Build the URL - append /chat/completions to the base endpoint
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));

    // Create a minimal test request
    let test_request = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": "Hi"
            }
        ],
        "max_tokens": 5
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&test_request);

    // Add authorization if API key provided
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        request = request.header("Authorization", format!("Bearer {}", key));
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status();
            let response_text = response.text().await.unwrap_or_default();

            if status.is_success() {
                // Parse response as JSON to verify it's a valid OpenAI-compatible response
                match serde_json::from_str::<serde_json::Value>(&response_text) {
                    Ok(json) => {
                        // Verify the response has the expected OpenAI structure
                        if let Some(choices) = json.get("choices") {
                            if let Some(choices_array) = choices.as_array() {
                                if !choices_array.is_empty() {
                                    // Verify the first choice has the required message structure
                                    if let Some(first_choice) = choices_array.get(0) {
                                        // Check if message.content field exists (can be empty string)
                                        let has_message_structure = first_choice
                                            .get("message")
                                            .and_then(|m| {
                                                m.get("content")
                                                    .or_else(|| m.get("reasoning_content"))
                                            })
                                            .is_some();

                                        if has_message_structure {
                                            log_info!("✅ Custom OpenAI connection test successful - response validated");
                                            return Ok(serde_json::json!({
                                                "status": "success",
                                                "message": "Connection successful and response validated",
                                                "http_status": status.as_u16()
                                            }));
                                        }
                                    }
                                }
                            }
                        }

                        // Response was 200 but doesn't match OpenAI format
                        log_warn!(
                            "⚠️ Endpoint returned 200 but response doesn't match OpenAI format: {}",
                            response_text
                        );
                        Err("Endpoint is reachable but doesn't appear to be OpenAI-compatible. Response is missing 'choices' array or 'message.content' / 'message.reasoning_content' field.".to_string())
                    }
                    Err(e) => {
                        log_warn!(
                            "⚠️ Endpoint returned 200 but response is not valid JSON: {}",
                            e
                        );
                        Err(format!(
                            "Endpoint is reachable but returned invalid JSON: {}. Response: {}",
                            e, response_text
                        ))
                    }
                }
            } else {
                log_warn!(
                    "⚠️ Custom OpenAI connection test failed with status {}: {}",
                    status,
                    response_text
                );
                Err(format!(
                    "Connection failed with status {}: {}",
                    status, response_text
                ))
            }
        }
        Err(e) => {
            log_error!("❌ Custom OpenAI connection test failed: {}", e);
            if e.is_timeout() {
                Err("Connection timed out. Please check the endpoint URL.".to_string())
            } else if e.is_connect() {
                Err("Could not connect to endpoint. Please verify the URL is correct and the server is running.".to_string())
            } else {
                Err(format!("Connection failed: {}", e))
            }
        }
    }
}

fn connection_test_output_tokens(provider: &crate::summary::llm_client::LLMProvider) -> u32 {
    use crate::summary::llm_client::LLMProvider;

    // MiniMax M-series models account for hidden reasoning inside the completion
    // budget. Eight tokens can be consumed before the requested `OK` is emitted,
    // which makes a valid API key look like a failed connection.
    if provider == &LLMProvider::MiniMax {
        4_096
    } else {
        8
    }
}

/// Tests a configured cloud LLM with a minimal completion request.
#[tauri::command]
pub async fn api_test_llm_connection(
    provider: String,
    api_key: String,
    model: String,
) -> Result<serde_json::Value, String> {
    use crate::summary::llm_client::{generate_summary, LLMProvider};

    if api_key.trim().is_empty() {
        return Err("API Key is required".to_string());
    }
    if model.trim().is_empty() {
        return Err("Model is required".to_string());
    }

    let parsed_provider = LLMProvider::from_str(&provider)?;
    if matches!(
        parsed_provider,
        LLMProvider::Ollama | LLMProvider::BuiltInAI | LLMProvider::CustomOpenAI
    ) {
        return Err("This connection test is only for cloud providers".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    generate_summary(
        &client,
        &parsed_provider,
        model.trim(),
        api_key.trim(),
        "You are a connection test. Follow the user's instruction exactly.",
        "Reply with only: OK",
        None,
        None,
        Some(connection_test_output_tokens(&parsed_provider)),
        Some(0.0),
        None,
        None,
        None,
    )
    .await?;

    Ok(serde_json::json!({
        "status": "success",
        "message": format!("Connected to {} successfully", provider)
    }))
}

#[cfg(test)]
mod llm_connection_test_tests {
    use super::*;
    use crate::summary::llm_client::LLMProvider;

    #[test]
    fn minimax_connection_test_reserves_hidden_reasoning_budget() {
        assert_eq!(connection_test_output_tokens(&LLMProvider::MiniMax), 4_096);
        assert_eq!(connection_test_output_tokens(&LLMProvider::OpenAI), 8);
    }
}

/// Validate cloud-ASR credentials without uploading meeting audio.
#[tauri::command]
pub async fn api_test_transcript_connection(
    provider: String,
    api_key: String,
    endpoint: Option<String>,
) -> Result<serde_json::Value, String> {
    if provider == "funasr-server" {
        return crate::remote_funasr::test_connection(
            endpoint.as_deref().unwrap_or_default(),
            api_key.trim(),
        )
        .await;
    }
    if api_key.trim().is_empty() {
        return Err("API Key is required".to_string());
    }
    let url = match provider.as_str() {
        "openai" => "https://api.openai.com/v1/models",
        "groq" => "https://api.groq.com/openai/v1/models",
        "qwen-cloud" => "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
        "deepgram" => "https://api.deepgram.com/v1/projects",
        "doubao" => "https://ark.cn-beijing.volces.com/api/v3/models",
        _ => {
            return Err(format!(
                "Connection testing is not available for {}",
                provider
            ))
        }
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let request = client.get(url);
    let request = if provider == "deepgram" {
        request.header("Authorization", format!("Token {}", api_key.trim()))
    } else {
        request.bearer_auth(api_key.trim())
    };
    let response = request
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let detail = body.chars().take(300).collect::<String>();
        return Err(format!(
            "{} credential check failed (HTTP {}): {}",
            provider,
            status.as_u16(),
            detail
        ));
    }
    Ok(
        serde_json::json!({"status":"success","message":format!("Connected to {} successfully; no audio was uploaded", provider)}),
    )
}
