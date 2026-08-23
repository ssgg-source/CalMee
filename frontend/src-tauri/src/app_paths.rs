use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{AppHandle, Manager, Runtime};

static APP_DATA_ROOT: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));
static APP_RESOURCE_ROOT: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve the CalMee app-data directory: {error}"))?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create the CalMee app-data directory: {error}"))?;
    *APP_DATA_ROOT
        .write()
        .map_err(|_| "CalMee app-data path state is unavailable".to_string())? = Some(root);
    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve the CalMee resource directory: {error}"))?;
    *APP_RESOURCE_ROOT
        .write()
        .map_err(|_| "CalMee resource path state is unavailable".to_string())? =
        Some(resource_root);
    Ok(())
}

pub fn app_data_root() -> Result<PathBuf, String> {
    APP_DATA_ROOT
        .read()
        .map_err(|_| "CalMee app-data path state is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "CalMee app-data path has not been initialized".to_string())
}

pub fn funasr_config_path() -> Result<PathBuf, String> {
    Ok(funasr_config_path_for(&app_data_root()?))
}

pub fn resource_root() -> Result<PathBuf, String> {
    APP_RESOURCE_ROOT
        .read()
        .map_err(|_| "CalMee resource path state is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "CalMee resource path has not been initialized".to_string())
}

pub fn funasr_models_root() -> Result<PathBuf, String> {
    Ok(funasr_models_root_for(&app_data_root()?))
}

pub fn funasr_modelscope_cache() -> Result<PathBuf, String> {
    Ok(funasr_models_root()?.join("modelscope"))
}

pub fn funasr_huggingface_cache() -> Result<PathBuf, String> {
    Ok(funasr_models_root()?.join("huggingface"))
}

pub fn funasr_state_dir() -> Result<PathBuf, String> {
    Ok(funasr_models_root()?.join("state"))
}

pub fn funasr_audio_cache() -> Result<PathBuf, String> {
    Ok(funasr_models_root()?.join("audio-cache"))
}

pub fn funasr_runtime_root() -> Result<PathBuf, String> {
    Ok(funasr_runtime_root_for(&app_data_root()?))
}

pub fn notification_settings_path() -> Result<PathBuf, String> {
    Ok(notification_settings_path_for(&app_data_root()?))
}

pub fn custom_templates_dir() -> Result<PathBuf, String> {
    Ok(custom_templates_dir_for(&app_data_root()?))
}

fn funasr_config_path_for(root: &Path) -> PathBuf {
    root.join("config").join("funasr.json")
}

fn notification_settings_path_for(root: &Path) -> PathBuf {
    root.join("config").join("notifications.json")
}

fn custom_templates_dir_for(root: &Path) -> PathBuf {
    root.join("templates")
}

fn funasr_models_root_for(root: &Path) -> PathBuf {
    root.join("models").join("funasr")
}

fn funasr_runtime_root_for(root: &Path) -> PathBuf {
    root.join("runtimes").join("funasr")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_paths_are_scoped_below_the_identifier_specific_root() {
        let root = PathBuf::from("/tmp/io.github.ssgg-source.calmee");
        assert_eq!(
            funasr_config_path_for(&root),
            root.join("config/funasr.json")
        );
        assert_eq!(
            notification_settings_path_for(&root),
            root.join("config/notifications.json")
        );
        assert_eq!(custom_templates_dir_for(&root), root.join("templates"));
        assert_eq!(funasr_models_root_for(&root), root.join("models/funasr"));
        assert_eq!(funasr_runtime_root_for(&root), root.join("runtimes/funasr"));
    }

    #[test]
    fn persistent_paths_never_use_the_legacy_shared_directory_name() {
        let root = PathBuf::from("/tmp/io.github.ssgg-source.calmee");
        for path in [
            funasr_config_path_for(&root),
            notification_settings_path_for(&root),
            custom_templates_dir_for(&root),
            funasr_models_root_for(&root),
            funasr_runtime_root_for(&root),
        ] {
            assert!(path.starts_with(&root));
            assert!(!path.to_string_lossy().contains("/CalMee/"));
        }
    }
}
