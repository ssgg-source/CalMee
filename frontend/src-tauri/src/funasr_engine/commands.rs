use super::{
    bridge, model_profiles, model_storage, qwen3_asr_model_profiles, FunAsrConfig, FunAsrEngine,
    FunAsrLegacyImportPreview, FunAsrModelProfile, FunAsrModelState, FunAsrResult,
    FunAsrRuntimeInstallPlan, FunAsrRuntimeInstallStatus, FunAsrRuntimeStatus, FunAsrStatus,
};
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::Mutex;

static ENGINE: Lazy<Mutex<Option<Arc<FunAsrEngine>>>> = Lazy::new(|| Mutex::new(None));

fn config_path() -> Result<std::path::PathBuf, String> {
    crate::app_paths::funasr_config_path()
}

pub async fn load_saved_config() -> FunAsrConfig {
    let Ok(path) = config_path() else {
        return FunAsrConfig::default();
    };
    load_config_from(&path).await
}

async fn load_config_from(path: &std::path::Path) -> FunAsrConfig {
    match tokio::fs::read_to_string(path).await {
        Ok(json) => serde_json::from_str(&json).unwrap_or_else(|error| {
            log::warn!("Invalid saved FunASR configuration: {}", error);
            FunAsrConfig::default()
        }),
        Err(_) => FunAsrConfig::default(),
    }
}

async fn save_config_to(path: &std::path::Path, config: &FunAsrConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    tokio::fs::write(path, json)
        .await
        .map_err(|error| error.to_string())
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
    save_config_to(&path, &config).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn config_round_trip_uses_the_supplied_identifier_specific_path() {
        let temp = TempDir::new().unwrap();
        let isolated = temp
            .path()
            .join("io.github.ssgg-source.calmee/config/funasr.json");
        let shared_legacy = temp.path().join("CalMee/funasr.json");
        let mut config = FunAsrConfig::default();
        config.language = "zh".into();
        config.hotwords = "private test value".into();
        save_config_to(&isolated, &config).await.unwrap();
        assert_eq!(load_config_from(&isolated).await, config);
        assert!(isolated.is_file());
        assert!(!shared_legacy.exists());
    }

    #[tokio::test]
    async fn missing_isolated_config_returns_defaults_without_reading_legacy_file() {
        let temp = TempDir::new().unwrap();
        let isolated = temp
            .path()
            .join("io.github.ssgg-source.calmee/config/funasr.json");
        let shared_legacy = temp.path().join("CalMee/funasr.json");
        save_config_to(
            &shared_legacy,
            &FunAsrConfig {
                language: "zh".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(load_config_from(&isolated).await, FunAsrConfig::default());
    }
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
    if !bridge::runtime_status().await.available {
        super::runtime_installer::install(true).await?;
    }
    let engine = get_or_init_engine().await?;
    let config = engine.config().await;
    let status = engine.load().await.map_err(|error| error.to_string())?;
    let model_path = status.model_path.as_deref().ok_or_else(|| {
        "The model loaded, but its managed download path was not reported.".to_string()
    })?;
    let family = if config.hub == "hf" {
        "qwen3asr"
    } else {
        "funasr"
    };
    model_storage::record_ready(family, &config.model, std::path::Path::new(model_path))?;
    Ok(status)
}

#[tauri::command]
pub async fn funasr_download_model(family: String, model: String) -> Result<(), String> {
    let known = match family.as_str() {
        "funasr" => model_profiles().iter().any(|profile| profile.id == model),
        "qwen3asr" => qwen3_asr_model_profiles()
            .iter()
            .any(|profile| profile.id == model),
        _ => false,
    };
    if !known {
        return Err("Unknown transcription model.".into());
    }

    if !bridge::runtime_status().await.available {
        super::runtime_installer::install(true).await?;
    }

    let mut config = load_saved_config().await;
    config.model = model.clone();
    if family == "qwen3asr" {
        config.hub = "hf".into();
        config.vad_enabled = false;
        config.punc_enabled = false;
        config.speaker_enabled = false;
    } else {
        config.hub = "ms".into();
    }
    config.validate()?;
    bridge::download(&config)
        .await
        .map_err(|error| error.to_string())?;

    let downloaded = model_storage::states(&family, None)?
        .into_iter()
        .any(|state| state.id == model && state.downloaded);
    if !downloaded {
        return Err("The model download completed, but its files could not be verified.".into());
    }
    Ok(())
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
pub async fn funasr_get_runtime_status() -> FunAsrRuntimeStatus {
    bridge::runtime_status().await
}

#[tauri::command]
pub fn funasr_get_runtime_install_plan() -> FunAsrRuntimeInstallPlan {
    super::runtime_installer::install_plan()
}

#[tauri::command]
pub fn funasr_get_runtime_install_status() -> FunAsrRuntimeInstallStatus {
    super::runtime_installer::install_status()
}

#[tauri::command]
pub async fn funasr_install_runtime(confirmed: bool) -> Result<FunAsrRuntimeInstallStatus, String> {
    super::runtime_installer::install(confirmed).await
}

#[tauri::command]
pub fn funasr_cancel_runtime_install() -> FunAsrRuntimeInstallStatus {
    super::runtime_installer::cancel()
}

#[tauri::command]
pub async fn funasr_get_model_states(family: String) -> Result<Vec<FunAsrModelState>, String> {
    let engine = get_or_init_engine().await?;
    let loaded = engine.get_current_model().await;
    model_storage::states(&family, loaded.as_deref())
}

#[tauri::command]
pub async fn funasr_delete_model(
    family: String,
    model: String,
    confirmed: bool,
    expected_size_bytes: u64,
) -> Result<u64, String> {
    let engine = get_or_init_engine().await?;
    if engine.get_current_model().await.as_deref() == Some(model.as_str()) {
        engine.unload().await.map_err(|error| error.to_string())?;
    }
    model_storage::delete(&family, &model, confirmed, expected_size_bytes)
}

#[tauri::command]
pub async fn funasr_get_legacy_model_import_preview() -> Result<FunAsrLegacyImportPreview, String> {
    tokio::task::spawn_blocking(model_storage::legacy_import_preview)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn funasr_import_legacy_models(
    confirmed: bool,
    expected_size_bytes: u64,
) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || {
        model_storage::import_legacy_models(confirmed, expected_size_bytes)
    })
    .await
    .map_err(|error| error.to_string())?
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
