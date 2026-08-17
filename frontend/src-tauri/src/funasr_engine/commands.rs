use super::{
    model_profiles, qwen3_asr_model_profiles, FunAsrConfig, FunAsrEngine, FunAsrModelProfile,
    FunAsrResult, FunAsrStatus,
};
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::Mutex;

static ENGINE: Lazy<Mutex<Option<Arc<FunAsrEngine>>>> = Lazy::new(|| Mutex::new(None));

fn config_path() -> Result<std::path::PathBuf, String> {
    dirs::config_dir()
        .map(|dir| dir.join("CalMee/funasr.json"))
        .ok_or_else(|| "Unable to resolve the CalMee configuration directory".to_string())
}

pub async fn load_saved_config() -> FunAsrConfig {
    let Ok(path) = config_path() else {
        return FunAsrConfig::default();
    };
    match tokio::fs::read_to_string(path).await {
        Ok(json) => serde_json::from_str(&json).unwrap_or_else(|error| {
            log::warn!("Invalid saved FunASR configuration: {}", error);
            FunAsrConfig::default()
        }),
        Err(_) => FunAsrConfig::default(),
    }
}

pub async fn get_or_init_engine() -> Result<Arc<FunAsrEngine>, String> {
    let mut guard = ENGINE.lock().await;
    if let Some(engine) = guard.as_ref() {
        return Ok(engine.clone());
    }
    let config = load_saved_config().await;
    let engine = Arc::new(FunAsrEngine::new(config));
    *guard = Some(engine.clone());
    Ok(engine)
}

#[tauri::command]
pub async fn funasr_init() -> Result<FunAsrStatus, String> {
    let engine = get_or_init_engine().await?;
    engine.status().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn funasr_get_config() -> Result<FunAsrConfig, String> {
    Ok(get_or_init_engine().await?.config().await)
}

#[tauri::command]
pub async fn funasr_save_config(config: FunAsrConfig) -> Result<FunAsrConfig, String> {
    config.validate()?;
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    tokio::fs::write(path, json)
        .await
        .map_err(|error| error.to_string())?;
    let engine = get_or_init_engine().await?;
    engine
        .set_config(config.clone())
        .await
        .map_err(|error| error.to_string())?;
    Ok(config)
}

#[tauri::command]
pub async fn funasr_reset_config() -> Result<FunAsrConfig, String> {
    funasr_save_config(FunAsrConfig::default()).await
}

#[tauri::command]
pub fn funasr_get_model_profiles() -> Vec<FunAsrModelProfile> {
    model_profiles()
}

#[tauri::command]
pub fn qwen3_asr_get_model_profiles() -> Vec<FunAsrModelProfile> {
    qwen3_asr_model_profiles()
}

#[tauri::command]
pub async fn funasr_load_model() -> Result<FunAsrStatus, String> {
    get_or_init_engine()
        .await?
        .load()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn funasr_unload_model() -> Result<(), String> {
    get_or_init_engine()
        .await?
        .unload()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn funasr_get_status() -> Result<FunAsrStatus, String> {
    get_or_init_engine()
        .await?
        .status()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn funasr_transcribe_audio(audio_data: Vec<f32>) -> Result<FunAsrResult, String> {
    get_or_init_engine()
        .await?
        .transcribe(&audio_data)
        .await
        .map_err(|error| error.to_string())
}

pub async fn shutdown() {
    super::bridge::shutdown().await;
}
