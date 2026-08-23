mod bridge;
mod commands;
mod config;
mod engine;
mod model_storage;
mod runtime_installer;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub use commands::*;
pub use config::{model_profiles, qwen3_asr_model_profiles, FunAsrConfig, FunAsrModelProfile};
pub use engine::FunAsrEngine;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FunAsrStatus {
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub loaded: bool,
    pub model: Option<String>,
    pub device: Option<String>,
    #[serde(default)]
    pub model_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunAsrRuntimeStatus {
    pub available: bool,
    pub source: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunAsrRuntimeInstallPlan {
    pub supported: bool,
    pub platform: String,
    pub runtime_download_bytes: u64,
    pub runtime_disk_bytes: u64,
    pub runtime_directory: String,
    pub model_directory: String,
    pub network_required: bool,
    pub resumable: bool,
    pub license_path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunAsrRuntimeInstallStatus {
    pub state: String,
    pub progress: u32,
    pub message: String,
    pub retryable: bool,
}

impl FunAsrRuntimeInstallStatus {
    fn idle(message: impl Into<String>) -> Self {
        Self {
            state: "notInstalled".into(),
            progress: 0,
            message: message.into(),
            retryable: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunAsrModelState {
    pub id: String,
    pub family: String,
    pub downloaded: bool,
    pub ready: bool,
    pub size_bytes: u64,
    pub loaded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunAsrLegacyImportPreview {
    pub available: bool,
    pub model_count: usize,
    pub size_bytes: u64,
    pub source_locations: Vec<String>,
    pub target_location: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunAsrSegment {
    pub index: usize,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: Option<u32>,
    #[serde(default)]
    pub timestamp: Vec<Vec<u64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunAsrResult {
    pub text: String,
    pub raw_text: Option<String>,
    pub language: String,
    #[serde(default)]
    pub segments: Vec<FunAsrSegment>,
    #[serde(default)]
    pub timestamp: Vec<Vec<u64>>,
    #[serde(default)]
    pub speaker_count: usize,
    #[serde(default)]
    pub speaker_embeddings: HashMap<String, Vec<f32>>,
    #[serde(default)]
    pub hotword_matches: Vec<serde_json::Value>,
    pub elapsed_ms: u64,
    pub device: String,
    pub model: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FunAsrStreamingResult {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub is_final: bool,
    #[serde(default)]
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpeakerReclusterStatus {
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub estimated_count: usize,
    #[serde(default)]
    pub current_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationInputSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiarizationResult {
    #[serde(default)]
    pub assignments: Vec<u32>,
    #[serde(default)]
    pub speaker_embeddings: HashMap<String, Vec<f32>>,
    #[serde(default)]
    pub speaker_count: usize,
    pub device: Option<String>,
    pub model: Option<String>,
}
