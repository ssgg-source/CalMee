use super::{
    DiarizationInputSegment, DiarizationResult, FunAsrConfig, FunAsrResult, FunAsrRuntimeStatus,
    FunAsrStatus, FunAsrStreamingResult, SpeakerReclusterStatus,
};
use anyhow::{anyhow, Context, Result};
use once_cell::sync::Lazy;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use uuid::Uuid;

pub type ProgressCallback = Arc<dyn Fn(u32, &str) + Send + Sync>;

static SIDECAR: Lazy<Arc<Mutex<Option<Sidecar>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

struct Sidecar {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
}

fn development_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn first_existing(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.exists())
}

fn script_path() -> Result<PathBuf> {
    let mut candidates = vec![
        development_root().join("funasr_sidecar/main.py"),
        PathBuf::from("funasr_sidecar/main.py"),
    ];
    if let Ok(resource_dir) = crate::app_paths::resource_root() {
        candidates.insert(0, resource_dir.join("funasr_sidecar/main.py"));
        candidates.insert(1, resource_dir.join("_up_/_up_/funasr_sidecar/main.py"));
    }
    first_existing(candidates).ok_or_else(|| anyhow!("CalMee FunASR sidecar script was not found"))
}

fn python_path() -> Result<(PathBuf, &'static str)> {
    if let Ok(value) = std::env::var("CALMEE_FUNASR_PYTHON") {
        let path = PathBuf::from(value);
        if path.exists() {
            return Ok((path, "override"));
        }
        return Err(anyhow!(
            "The configured CalMee FunASR runtime does not exist. Check CALMEE_FUNASR_PYTHON."
        ));
    }
    if let Ok(path) = super::runtime_installer::active_python() {
        return Ok((path, "managed"));
    }
    if let Some(path) = first_existing([
        development_root().join(".venv-funasr/bin/python"),
        development_root().join(".venv-funasr/Scripts/python.exe"),
    ]) {
        return Ok((path, "development"));
    }
    Err(anyhow!(
        "CalMee's isolated FunASR runtime has not been installed. Choose a local model to review and install the runtime first. System Python is not used."
    ))
}

fn managed_cache_paths() -> Result<(PathBuf, PathBuf)> {
    let modelscope = crate::app_paths::funasr_modelscope_cache().map_err(anyhow::Error::msg)?;
    let huggingface = crate::app_paths::funasr_huggingface_cache().map_err(anyhow::Error::msg)?;
    std::fs::create_dir_all(&modelscope)?;
    std::fs::create_dir_all(&huggingface)?;
    Ok((modelscope, huggingface))
}

pub async fn runtime_status() -> FunAsrRuntimeStatus {
    let (python, source) = match python_path() {
        Ok(value) => value,
        Err(error) => {
            return FunAsrRuntimeStatus {
                available: false,
                source: None,
                message: error.to_string(),
            }
        }
    };
    let script = match script_path() {
        Ok(path) => path,
        Err(error) => {
            return FunAsrRuntimeStatus {
                available: false,
                source: Some(source.into()),
                message: error.to_string(),
            }
        }
    };
    let (modelscope_cache, huggingface_cache) = match managed_cache_paths() {
        Ok(paths) => paths,
        Err(error) => {
            return FunAsrRuntimeStatus {
                available: false,
                source: Some(source.into()),
                message: format!("Could not prepare CalMee's private model directory: {error}"),
            }
        }
    };
    match tokio::process::Command::new(python)
        .arg(script)
        .arg("--self-test")
        .env("MODELSCOPE_CACHE", &modelscope_cache)
        .env("HF_HOME", &huggingface_cache)
        .env("HUGGINGFACE_HUB_CACHE", huggingface_cache.join("hub"))
        .output()
        .await
    {
        Ok(output) if output.status.success() => FunAsrRuntimeStatus {
            available: true,
            source: Some(source.into()),
            message: "FunASR runtime is ready.".into(),
        },
        Ok(output) => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            FunAsrRuntimeStatus {
                available: false,
                source: Some(source.into()),
                message: if detail.is_empty() {
                    "The CalMee FunASR runtime failed its self-test.".into()
                } else {
                    format!("The CalMee FunASR runtime is incomplete: {detail}")
                },
            }
        }
        Err(error) => FunAsrRuntimeStatus {
            available: false,
            source: Some(source.into()),
            message: format!("Could not start the CalMee FunASR runtime: {error}"),
        },
    }
}

impl Sidecar {
    async fn start() -> Result<Self> {
        let (python, _) = python_path()?;
        let script = script_path()?;
        let (modelscope_cache, huggingface_cache) = managed_cache_paths()?;
        log::info!(
            "Starting CalMee FunASR sidecar: {} {}",
            python.display(),
            script.display()
        );
        let mut child = tokio::process::Command::new(&python)
            .arg(&script)
            .arg("--stdio")
            .env("PYTHONUNBUFFERED", "1")
            .env("MODELSCOPE_LOG_LEVEL", "30")
            .env("MODELSCOPE_CACHE", &modelscope_cache)
            .env("HF_HOME", &huggingface_cache)
            .env("HUGGINGFACE_HUB_CACHE", huggingface_cache.join("hub"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("failed to start FunASR Python at {}", python.display()))?;
        let stdin = child
            .stdin
            .take()
            .context("FunASR sidecar stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("FunASR sidecar stdout unavailable")?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::info!("[funasr] {}", line);
                }
            });
        }
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    async fn request<T: DeserializeOwned>(
        &mut self,
        mut request: Value,
        progress_callback: Option<ProgressCallback>,
    ) -> Result<T> {
        let request_id = Uuid::new_v4().to_string();
        request["id"] = Value::String(request_id.clone());
        let mut encoded = serde_json::to_vec(&request)?;
        encoded.push(b'\n');
        self.stdin.write_all(&encoded).await?;
        self.stdin.flush().await?;

        loop {
            let mut line = String::new();
            if self.stdout.read_line(&mut line).await? == 0 {
                let status = self.child.try_wait().ok().flatten();
                return Err(anyhow!("FunASR sidecar exited unexpectedly: {:?}", status));
            }
            let response: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => {
                    log::warn!("Ignoring non-JSON FunASR output: {}", line.trim());
                    continue;
                }
            };
            if response.get("id").and_then(Value::as_str) != Some(&request_id) {
                log::warn!("Ignoring FunASR response with an unexpected request id");
                continue;
            }
            if response.get("event").and_then(Value::as_str) == Some("progress") {
                if let Some(callback) = &progress_callback {
                    let progress = response
                        .get("progress")
                        .and_then(Value::as_u64)
                        .unwrap_or_default()
                        .min(100) as u32;
                    let message = response
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Processing audio with FunASR...");
                    callback(progress, message);
                }
                continue;
            }
            if response.get("ok").and_then(Value::as_bool) != Some(true) {
                let message = response
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown FunASR error");
                return Err(anyhow!(message.to_string()));
            }
            return serde_json::from_value(response["result"].clone()).map_err(Into::into);
        }
    }
}

async fn with_sidecar<T: DeserializeOwned>(
    request: Value,
    progress_callback: Option<ProgressCallback>,
) -> Result<T> {
    let mut guard = SIDECAR.lock().await;
    if guard.is_none() {
        *guard = Some(Sidecar::start().await?);
    }
    guard
        .as_mut()
        .expect("sidecar initialized")
        .request(request, progress_callback)
        .await
}

pub async fn ping() -> Result<FunAsrStatus> {
    with_sidecar(json!({"action": "ping"}), None).await
}

pub async fn load(config: &FunAsrConfig) -> Result<FunAsrStatus> {
    with_sidecar(json!({"action": "load", "config": config}), None).await
}

pub async fn download(config: &FunAsrConfig) -> Result<Value> {
    with_sidecar(json!({"action": "download", "config": config}), None).await
}

pub async fn stream_start(config: &FunAsrConfig) -> Result<FunAsrStatus> {
    with_sidecar(json!({"action": "stream_start", "config": config}), None).await
}

pub async fn stream_chunk(samples: &[f32], is_final: bool) -> Result<FunAsrStreamingResult> {
    with_sidecar(
        json!({"action": "stream_chunk", "samples": samples, "is_final": is_final}),
        None,
    )
    .await
}

pub async fn status() -> Result<FunAsrStatus> {
    with_sidecar(json!({"action": "status"}), None).await
}

pub async fn unload() -> Result<FunAsrStatus> {
    let mut guard = SIDECAR.lock().await;
    if let Some(mut sidecar) = guard.take() {
        let _: Result<Value> = sidecar.request(json!({"action": "shutdown"}), None).await;
        let _ = sidecar.child.kill().await;
    }
    Ok(FunAsrStatus {
        ready: true,
        loaded: false,
        model: None,
        device: None,
        model_path: None,
    })
}

pub async fn transcribe(config: &FunAsrConfig, samples: &[f32]) -> Result<FunAsrResult> {
    let cache_dir = std::env::var("CALMEE_FUNASR_CACHE_DIR")
        .map(PathBuf::from)
        .map_or_else(|_| crate::app_paths::funasr_audio_cache(), Ok)
        .map_err(anyhow::Error::msg)?;
    tokio::fs::create_dir_all(&cache_dir).await?;
    let path = cache_dir.join(format!("{}.wav", Uuid::new_v4()));
    write_wav(&path, samples, 16_000).await?;
    let result = with_sidecar(
        json!({"action": "transcribe", "config": config, "audio_path": path}),
        None,
    )
    .await;
    if result.is_ok() {
        let _ = tokio::fs::remove_file(&path).await;
    } else {
        log::warn!(
            "Keeping failed FunASR input for diagnostics: {}",
            path.display()
        );
    }
    result
}

/// Transcribe an existing audio file without materializing the full recording in Rust memory.
pub async fn transcribe_file(
    config: &FunAsrConfig,
    path: &Path,
    progress_callback: Option<ProgressCallback>,
) -> Result<FunAsrResult> {
    if !path.is_file() {
        return Err(anyhow!("Audio file not found: {}", path.display()));
    }
    with_sidecar(
        json!({"action": "transcribe", "config": config, "audio_path": path}),
        progress_callback,
    )
    .await
}

/// Transcribe a meeting and retain the CAM++ window embeddings for fast
/// speaker-count correction without running ASR again.
pub async fn transcribe_file_cached(
    config: &FunAsrConfig,
    path: &Path,
    cache_key: &str,
    progress_callback: Option<ProgressCallback>,
) -> Result<FunAsrResult> {
    if !path.is_file() {
        return Err(anyhow!("Audio file not found: {}", path.display()));
    }
    with_sidecar(
        json!({
            "action": "transcribe",
            "config": config,
            "audio_path": path,
            "cache_key": cache_key,
        }),
        progress_callback,
    )
    .await
}

pub async fn recluster_status(cache_key: &str) -> Result<SpeakerReclusterStatus> {
    with_sidecar(
        json!({"action": "recluster_status", "cache_key": cache_key}),
        None,
    )
    .await
}

pub async fn recluster_transcript(cache_key: &str, speaker_count: usize) -> Result<FunAsrResult> {
    with_sidecar(
        json!({
            "action": "recluster_transcript",
            "cache_key": cache_key,
            "speaker_count": speaker_count,
        }),
        None,
    )
    .await
}

/// Run the shared CAM++ speaker pipeline against timestamped output from any ASR.
pub async fn diarize_segments(
    config: &FunAsrConfig,
    path: &Path,
    segments: &[DiarizationInputSegment],
    progress_callback: Option<ProgressCallback>,
) -> Result<DiarizationResult> {
    if !path.is_file() {
        return Err(anyhow!("Audio file not found: {}", path.display()));
    }
    with_sidecar(
        json!({
            "action": "diarize_segments",
            "config": config,
            "audio_path": path,
            "segments": segments,
        }),
        progress_callback,
    )
    .await
}

pub async fn diarize_segments_cached(
    config: &FunAsrConfig,
    path: &Path,
    segments: &[DiarizationInputSegment],
    cache_key: &str,
    progress_callback: Option<ProgressCallback>,
) -> Result<DiarizationResult> {
    if !path.is_file() {
        return Err(anyhow!("Audio file not found: {}", path.display()));
    }
    with_sidecar(
        json!({
            "action": "diarize_segments",
            "config": config,
            "audio_path": path,
            "segments": segments,
            "cache_key": cache_key,
        }),
        progress_callback,
    )
    .await
}

async fn write_wav(path: &Path, samples: &[f32], sample_rate: u32) -> Result<()> {
    let mut file = tokio::fs::File::create(path).await?;
    let data_size = (samples.len() * 2) as u32;
    file.write_all(b"RIFF").await?;
    file.write_all(&(36 + data_size).to_le_bytes()).await?;
    file.write_all(b"WAVEfmt ").await?;
    file.write_all(&16u32.to_le_bytes()).await?;
    file.write_all(&1u16.to_le_bytes()).await?;
    file.write_all(&1u16.to_le_bytes()).await?;
    file.write_all(&sample_rate.to_le_bytes()).await?;
    file.write_all(&(sample_rate * 2).to_le_bytes()).await?;
    file.write_all(&2u16.to_le_bytes()).await?;
    file.write_all(&16u16.to_le_bytes()).await?;
    file.write_all(b"data").await?;
    file.write_all(&data_size.to_le_bytes()).await?;
    for sample in samples {
        let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        file.write_all(&pcm.to_le_bytes()).await?;
    }
    file.flush().await?;
    Ok(())
}

pub async fn shutdown() {
    let _ = unload().await;
}
