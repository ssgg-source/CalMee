use super::{
    model_profiles, qwen3_asr_model_profiles, FunAsrLegacyImportPreview, FunAsrModelState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use url::form_urlencoded::byte_serialize;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyRecord {
    id: String,
    family: String,
    model_path: PathBuf,
}

fn allowed_model(family: &str, id: &str) -> bool {
    match family {
        "funasr" => model_profiles().iter().any(|profile| profile.id == id),
        "qwen3asr" => qwen3_asr_model_profiles()
            .iter()
            .any(|profile| profile.id == id),
        _ => false,
    }
}

fn marker_name(family: &str, id: &str) -> String {
    let encoded: String = byte_serialize(id.as_bytes()).collect();
    format!("{family}-{encoded}.json")
}

fn marker_path(state_dir: &Path, family: &str, id: &str) -> PathBuf {
    state_dir.join(marker_name(family, id))
}

fn read_record(state_dir: &Path, family: &str, id: &str) -> Option<ReadyRecord> {
    let content = fs::read_to_string(marker_path(state_dir, family, id)).ok()?;
    let record: ReadyRecord = serde_json::from_str(&content).ok()?;
    (record.family == family && record.id == id).then_some(record)
}

fn canonical_managed_path(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve downloaded model path: {error}"))?;
    for root in roots {
        if let Ok(canonical_root) = root.canonicalize() {
            if canonical.starts_with(canonical_root) {
                return Ok(canonical);
            }
        }
    }
    Err("Refusing to manage a model outside CalMee's model directory.".into())
}

fn path_size(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.is_file() {
        return metadata.len();
    }
    if !metadata.is_dir() {
        return 0;
    }
    fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| path_size(&entry.path()))
                .sum()
        })
        .unwrap_or(0)
}

fn downloaded_cache_root(family: &str, id: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let relative = match (family, id) {
        ("funasr", "paraformer-zh") => {
            "models/iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
        }
        ("funasr", "iic/SenseVoiceSmall") => "models/iic--SenseVoiceSmall",
        ("funasr", "FunAudioLLM/Fun-ASR-Nano-2512") => "models/FunAudioLLM--Fun-ASR-Nano-2512",
        ("funasr", "FunAudioLLM/Fun-ASR-MLT-Nano-2512") => {
            "models/FunAudioLLM--Fun-ASR-MLT-Nano-2512"
        }
        ("qwen3asr", "Qwen/Qwen3-ASR-0.6B") => "hub/models--Qwen--Qwen3-ASR-0.6B",
        ("qwen3asr", "Qwen/Qwen3-ASR-1.7B") => "hub/models--Qwen--Qwen3-ASR-1.7B",
        _ => return None,
    };
    let root = if family == "qwen3asr" {
        roots.get(1)?
    } else {
        roots.first()?
    }
    .join(relative);
    contains_model_weights(&root).then_some(root)
}

fn contains_model_weights(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.is_file() || metadata.file_type().is_symlink() {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        return name.ends_with(".pt") || name.ends_with(".bin") || name.ends_with(".safetensors");
    }
    metadata.is_dir()
        && fs::read_dir(path)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .any(|entry| contains_model_weights(&entry.path()))
            })
            .unwrap_or(false)
}

fn write_record(state_dir: &Path, record: &ReadyRecord) -> Result<(), String> {
    fs::create_dir_all(state_dir).map_err(|error| error.to_string())?;
    let target = marker_path(state_dir, &record.family, &record.id);
    let temporary = target.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&temporary, &target).map_err(|error| error.to_string())
}

pub fn record_ready(family: &str, id: &str, model_path: &Path) -> Result<(), String> {
    if !allowed_model(family, id) {
        return Err("Unknown FunASR model.".into());
    }
    let roots = [
        crate::app_paths::funasr_modelscope_cache()?,
        crate::app_paths::funasr_huggingface_cache()?,
    ];
    let model_path = canonical_managed_path(model_path, &roots)?;
    write_record(
        &crate::app_paths::funasr_state_dir()?,
        &ReadyRecord {
            id: id.into(),
            family: family.into(),
            model_path,
        },
    )
}

pub fn states(family: &str, loaded_model: Option<&str>) -> Result<Vec<FunAsrModelState>, String> {
    let profiles = match family {
        "funasr" => model_profiles(),
        "qwen3asr" => qwen3_asr_model_profiles(),
        _ => return Err("Unknown transcription model family.".into()),
    };
    let state_dir = crate::app_paths::funasr_state_dir()?;
    let roots = [
        crate::app_paths::funasr_modelscope_cache()?,
        crate::app_paths::funasr_huggingface_cache()?,
    ];
    Ok(profiles
        .into_iter()
        .map(|profile| {
            let record = read_record(&state_dir, family, profile.id);
            let (ready, size_bytes) = record
                .filter(|record| record.model_path.exists())
                .map(|record| (true, path_size(&record.model_path)))
                .unwrap_or((false, 0));
            let downloaded_root = downloaded_cache_root(family, profile.id, &roots);
            let downloaded = ready || downloaded_root.is_some();
            let size_bytes = size_bytes.max(
                downloaded_root
                    .as_deref()
                    .map(path_size)
                    .unwrap_or_default(),
            );
            FunAsrModelState {
                id: profile.id.into(),
                family: family.into(),
                downloaded,
                ready,
                size_bytes,
                loaded: loaded_model == Some(profile.id),
            }
        })
        .collect())
}

fn delete_from(
    family: &str,
    id: &str,
    state_dir: &Path,
    roots: &[PathBuf],
    trash_parent: &Path,
    expected_size_bytes: u64,
) -> Result<u64, String> {
    if !allowed_model(family, id) {
        return Err("Unknown FunASR model.".into());
    }
    let record = read_record(state_dir, family, id);
    let candidate = record
        .as_ref()
        .map(|record| record.model_path.clone())
        .or_else(|| downloaded_cache_root(family, id, roots))
        .ok_or_else(|| "This model is not managed by CalMee or is already deleted.".to_string())?;
    let model_path = canonical_managed_path(&candidate, roots)?;
    let size_bytes = path_size(&model_path);
    if size_bytes != expected_size_bytes {
        return Err(format!(
            "The model size changed from {expected_size_bytes} to {size_bytes} bytes. Refresh before deleting."
        ));
    }
    let trash_root = trash_parent.join(Uuid::new_v4().to_string());
    fs::create_dir_all(&trash_root).map_err(|error| error.to_string())?;
    let staged = trash_root.join("model");
    fs::rename(&model_path, &staged)
        .map_err(|error| format!("Could not stage the model for deletion: {error}"))?;
    let remove_result = if staged.is_dir() {
        fs::remove_dir_all(&staged)
    } else {
        fs::remove_file(&staged)
    };
    if let Err(error) = remove_result {
        let _ = fs::rename(&staged, &model_path);
        return Err(format!(
            "Could not delete the model; CalMee attempted to restore it: {error}"
        ));
    }
    let _ = fs::remove_dir_all(&trash_root);
    if record.is_some() {
        fs::remove_file(marker_path(state_dir, family, id)).map_err(|error| error.to_string())?;
    }
    Ok(size_bytes)
}

pub fn delete(
    family: &str,
    id: &str,
    confirmed: bool,
    expected_size_bytes: u64,
) -> Result<u64, String> {
    if !confirmed {
        return Err("Explicit confirmation is required before deleting a model.".into());
    }
    let state_dir = crate::app_paths::funasr_state_dir()?;
    let roots = [
        crate::app_paths::funasr_modelscope_cache()?,
        crate::app_paths::funasr_huggingface_cache()?,
    ];
    let trash_parent = crate::app_paths::funasr_models_root()?.join(".deleting");
    delete_from(
        family,
        id,
        &state_dir,
        &roots,
        &trash_parent,
        expected_size_bytes,
    )
}

#[derive(Debug, Clone)]
struct LegacyCopy {
    model_key: &'static str,
    source: PathBuf,
    destination: PathBuf,
}

fn legacy_copy_plan(
    home: &Path,
    modelscope_target: &Path,
    huggingface_target: &Path,
) -> Vec<LegacyCopy> {
    let modelscope = home.join(".cache/modelscope");
    let huggingface = home.join(".cache/huggingface/hub");
    let mut candidates = vec![
        (
            "funasr:paraformer-zh",
            "hub/iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        ),
        (
            "funasr:paraformer-zh",
            "hub/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        ),
        (
            "funasr:paraformer-zh",
            "hub/iic/punc_ct-transformer_cn-en-common-vocab471067-large",
        ),
        (
            "funasr:paraformer-zh",
            "hub/iic/speech_campplus_sv_zh-cn_16k-common",
        ),
        ("funasr:iic/SenseVoiceSmall", "models/iic--SenseVoiceSmall"),
        (
            "funasr:FunAudioLLM/Fun-ASR-Nano-2512",
            "models/FunAudioLLM--Fun-ASR-Nano-2512",
        ),
        (
            "funasr:FunAudioLLM/Fun-ASR-MLT-Nano-2512",
            "models/FunAudioLLM--Fun-ASR-MLT-Nano-2512",
        ),
    ]
    .into_iter()
    .map(|(model_key, relative)| LegacyCopy {
        model_key,
        source: modelscope.join(relative),
        destination: modelscope_target.join(relative),
    })
    .collect::<Vec<_>>();
    candidates.extend(
        [
            (
                "qwen3asr:Qwen/Qwen3-ASR-0.6B",
                "models--Qwen--Qwen3-ASR-0.6B",
            ),
            (
                "qwen3asr:Qwen/Qwen3-ASR-1.7B",
                "models--Qwen--Qwen3-ASR-1.7B",
            ),
        ]
        .into_iter()
        .map(|(model_key, relative)| LegacyCopy {
            model_key,
            source: huggingface.join(relative),
            destination: huggingface_target.join("hub").join(relative),
        }),
    );
    candidates
        .into_iter()
        .filter(|item| item.source.is_dir() && !item.destination.exists())
        .collect()
}

fn preview_from_plan(plan: &[LegacyCopy], target: &Path) -> FunAsrLegacyImportPreview {
    let models = plan
        .iter()
        .map(|item| item.model_key)
        .collect::<HashSet<_>>();
    let mut sources = plan
        .iter()
        .filter_map(|item| item.source.parent())
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    sources.sort();
    sources.dedup();
    FunAsrLegacyImportPreview {
        available: !plan.is_empty(),
        model_count: models.len(),
        size_bytes: plan.iter().map(|item| path_size(&item.source)).sum(),
        source_locations: sources,
        target_location: target.to_string_lossy().to_string(),
    }
}

pub fn legacy_import_preview() -> Result<FunAsrLegacyImportPreview, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not resolve the user home directory.".to_string())?;
    let target = crate::app_paths::funasr_models_root()?;
    let plan = legacy_copy_plan(
        &home,
        &crate::app_paths::funasr_modelscope_cache()?,
        &crate::app_paths::funasr_huggingface_cache()?,
    );
    Ok(preview_from_plan(&plan, &target))
}

fn copy_tree(source: &Path, destination: &Path, allowed_root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        let resolved = source
            .canonicalize()
            .map_err(|error| format!("Could not resolve a legacy cache link: {error}"))?;
        let allowed = allowed_root
            .canonicalize()
            .map_err(|error| format!("Could not resolve the legacy cache root: {error}"))?;
        if !resolved.starts_with(allowed) || !resolved.is_file() {
            return Err("A legacy cache link points outside its model directory.".into());
        }
        fs::copy(resolved, destination).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if metadata.is_file() {
        fs::copy(source, destination).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err("Unsupported entry in the legacy model cache.".into());
    }
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        copy_tree(
            &entry.path(),
            &destination.join(entry.file_name()),
            allowed_root,
        )?;
    }
    Ok(())
}

fn import_from_plan(
    plan: &[LegacyCopy],
    staging_root: &Path,
    expected_size_bytes: u64,
) -> Result<u64, String> {
    let actual_size: u64 = plan.iter().map(|item| path_size(&item.source)).sum();
    if actual_size != expected_size_bytes {
        return Err(format!(
            "The legacy cache changed from {expected_size_bytes} to {actual_size} bytes. Preview it again before importing."
        ));
    }
    if plan.iter().any(|item| item.destination.exists()) {
        return Err("A target model appeared after the preview. Refresh before importing.".into());
    }
    fs::create_dir_all(staging_root).map_err(|error| error.to_string())?;
    for (index, item) in plan.iter().enumerate() {
        let staged = staging_root.join(index.to_string());
        if let Err(error) = copy_tree(&item.source, &staged, &item.source) {
            let _ = fs::remove_dir_all(staging_root);
            return Err(error);
        }
    }
    let copied_size: u64 = plan.iter().map(|item| path_size(&item.source)).sum();
    if copied_size != expected_size_bytes {
        let _ = fs::remove_dir_all(staging_root);
        return Err(
            "The legacy cache changed while it was being copied. Nothing was imported.".into(),
        );
    }
    let mut installed = Vec::new();
    for (index, item) in plan.iter().enumerate() {
        let staged = staging_root.join(index.to_string());
        let install_result = item
            .destination
            .parent()
            .ok_or_else(|| "The managed model destination has no parent directory.".to_string())
            .and_then(|parent| fs::create_dir_all(parent).map_err(|error| error.to_string()))
            .and_then(|_| {
                fs::rename(&staged, &item.destination).map_err(|error| error.to_string())
            });
        if let Err(error) = install_result {
            for destination in installed.iter().rev() {
                let _ = fs::rename(
                    destination,
                    staging_root.join(format!("rollback-{}", Uuid::new_v4())),
                );
            }
            let _ = fs::remove_dir_all(staging_root);
            return Err(format!("Could not complete the legacy model import; imported files were rolled back: {error}"));
        }
        installed.push(item.destination.clone());
    }
    let _ = fs::remove_dir_all(staging_root);
    Ok(expected_size_bytes)
}

pub fn import_legacy_models(confirmed: bool, expected_size_bytes: u64) -> Result<u64, String> {
    if !confirmed {
        return Err("Explicit confirmation is required before importing legacy models.".into());
    }
    let home =
        dirs::home_dir().ok_or_else(|| "Could not resolve the user home directory.".to_string())?;
    let target = crate::app_paths::funasr_models_root()?;
    let plan = legacy_copy_plan(
        &home,
        &crate::app_paths::funasr_modelscope_cache()?,
        &crate::app_paths::funasr_huggingface_cache()?,
    );
    if plan.is_empty() {
        return Err("No eligible legacy models are available to import.".into());
    }
    let staging = target.join(".importing").join(Uuid::new_v4().to_string());
    import_from_plan(&plan, &staging, expected_size_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn state_requires_a_real_marker_and_real_files() {
        let temp = TempDir::new().unwrap();
        let state = temp.path().join("state");
        let model = temp.path().join("models/model-a");
        fs::create_dir_all(&model).unwrap();
        fs::write(model.join("model.pt"), [1_u8; 8]).unwrap();
        write_record(
            &state,
            &ReadyRecord {
                id: "paraformer-zh".into(),
                family: "funasr".into(),
                model_path: model.clone(),
            },
        )
        .unwrap();
        let record = read_record(&state, "funasr", "paraformer-zh").unwrap();
        assert_eq!(path_size(&record.model_path), 8);
        fs::remove_dir_all(model).unwrap();
        assert!(!record.model_path.exists());
    }

    #[test]
    fn completed_downloads_are_detected_without_being_marked_ready() {
        let temp = TempDir::new().unwrap();
        let modelscope = temp.path().join("modelscope");
        let huggingface = temp.path().join("huggingface");
        let snapshot = modelscope.join(
            "models/iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/snapshots/master",
        );
        fs::create_dir_all(&snapshot).unwrap();
        fs::write(snapshot.join("model.pt"), [1_u8; 8]).unwrap();
        assert!(
            downloaded_cache_root("funasr", "paraformer-zh", &[modelscope, huggingface]).is_some()
        );
    }

    #[test]
    fn partial_download_directories_are_not_reported_as_downloaded() {
        let temp = TempDir::new().unwrap();
        let modelscope = temp.path().join("modelscope");
        let huggingface = temp.path().join("huggingface");
        let partial = modelscope.join(
            "models/iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/.incomplete",
        );
        fs::create_dir_all(&partial).unwrap();
        fs::write(partial.join("model.pt.part"), [1_u8; 8]).unwrap();
        assert!(
            downloaded_cache_root("funasr", "paraformer-zh", &[modelscope, huggingface]).is_none()
        );
    }

    #[test]
    fn model_ids_are_encoded_as_single_safe_marker_names() {
        let name = marker_name("funasr", "iic/SenseVoiceSmall");
        assert!(!name.contains('/'));
        assert!(name.ends_with(".json"));
    }

    #[test]
    fn paths_outside_managed_roots_are_rejected() {
        let temp = TempDir::new().unwrap();
        let managed = temp.path().join("managed");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&managed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        assert!(canonical_managed_path(&outside, &[managed]).is_err());
    }

    #[test]
    fn deletion_is_limited_to_the_previewed_managed_model() {
        let temp = TempDir::new().unwrap();
        let managed = temp.path().join("managed");
        let state = temp.path().join("state");
        let trash = temp.path().join("trash");
        let model = managed.join("model-a");
        let sibling = managed.join("keep-me");
        fs::create_dir_all(&model).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(model.join("model.pt"), [1_u8; 8]).unwrap();
        fs::write(sibling.join("model.pt"), [2_u8; 4]).unwrap();
        write_record(
            &state,
            &ReadyRecord {
                id: "paraformer-zh".into(),
                family: "funasr".into(),
                model_path: model.clone(),
            },
        )
        .unwrap();

        assert!(delete_from(
            "funasr",
            "paraformer-zh",
            &state,
            std::slice::from_ref(&managed),
            &trash,
            7,
        )
        .is_err());
        assert!(model.exists());
        assert_eq!(
            delete_from("funasr", "paraformer-zh", &state, &[managed], &trash, 8,).unwrap(),
            8
        );
        assert!(!model.exists());
        assert!(sibling.exists());
        assert!(read_record(&state, "funasr", "paraformer-zh").is_none());
    }

    #[test]
    fn downloaded_model_can_be_deleted_before_it_has_been_loaded() {
        let temp = TempDir::new().unwrap();
        let modelscope = temp.path().join("modelscope");
        let huggingface = temp.path().join("huggingface");
        let state = temp.path().join("state");
        let trash = temp.path().join("trash");
        let model = modelscope.join(
            "models/iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        );
        fs::create_dir_all(model.join("snapshots/master")).unwrap();
        fs::write(model.join("snapshots/master/model.pt"), [1_u8; 8]).unwrap();

        assert_eq!(
            delete_from(
                "funasr",
                "paraformer-zh",
                &state,
                &[modelscope, huggingface],
                &trash,
                8,
            )
            .unwrap(),
            8
        );
        assert!(!model.exists());
    }

    #[test]
    fn legacy_preview_only_includes_allowlisted_models_missing_from_the_target() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let target = temp.path().join("target");
        let source = home.join(".cache/modelscope/models/iic--SenseVoiceSmall");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("model.pt"), [1_u8; 9]).unwrap();
        let unrelated = home.join(".cache/modelscope/models/customer-private-model");
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(unrelated.join("secret"), [2_u8; 20]).unwrap();
        let plan = legacy_copy_plan(
            &home,
            &target.join("modelscope"),
            &target.join("huggingface"),
        );
        let preview = preview_from_plan(&plan, &target);
        assert_eq!(preview.model_count, 1);
        assert_eq!(preview.size_bytes, 9);
        assert_eq!(plan.len(), 1);
        assert!(!plan[0]
            .source
            .to_string_lossy()
            .contains("customer-private"));
    }

    #[test]
    fn legacy_import_copies_without_modifying_source_and_rolls_back_on_size_change() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("managed/model");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("model.pt"), [3_u8; 7]).unwrap();
        let source_mtime = fs::metadata(source.join("model.pt"))
            .unwrap()
            .modified()
            .unwrap();
        let plan = vec![LegacyCopy {
            model_key: "funasr:iic/SenseVoiceSmall",
            source: source.clone(),
            destination: destination.clone(),
        }];
        let staging = temp.path().join("managed/.importing/one");
        assert!(import_from_plan(&plan, &staging, 6).is_err());
        assert!(!destination.exists());
        assert_eq!(fs::read(source.join("model.pt")).unwrap(), [3_u8; 7]);
        assert_eq!(import_from_plan(&plan, &staging, 7).unwrap(), 7);
        assert!(destination.join("model.pt").is_file());
        assert_eq!(fs::read(source.join("model.pt")).unwrap(), [3_u8; 7]);
        assert_eq!(
            fs::metadata(source.join("model.pt"))
                .unwrap()
                .modified()
                .unwrap(),
            source_mtime
        );
    }
}
