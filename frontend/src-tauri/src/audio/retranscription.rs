// Retranscription module - allows re-processing stored audio with different settings

use super::common::{
    create_transcript_segments, funasr_result_to_transcripts, split_segment_at_silence,
    write_transcripts_json,
};
use super::constants::AUDIO_EXTENSIONS;
use crate::audio::decoder::{decode_to_whisper_format_ffmpeg, probe_audio_duration};
use crate::audio::vad::get_speech_chunks_with_progress;
use crate::config::{DEFAULT_PARAKEET_MODEL, DEFAULT_WHISPER_MODEL};
use crate::parakeet_engine::ParakeetEngine;
use crate::state::AppState;
use crate::whisper_engine::WhisperEngine;
use anyhow::{anyhow, Result};
use log::{debug, error, info, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Global flag to track if retranscription is in progress
static RETRANSCRIPTION_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Global flag to signal cancellation
static RETRANSCRIPTION_CANCELLED: AtomicBool = AtomicBool::new(false);
static SPEAKER_RECLUSTER_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Persisted task state is owned by the backend, so reopening or switching the
/// meeting workspace does not make an active job look as if it disappeared.
static RETRANSCRIPTION_JOB: Lazy<Mutex<Option<RetranscriptionJobStatus>>> =
    Lazy::new(|| Mutex::new(None));

/// RAII guard for RETRANSCRIPTION_IN_PROGRESS flag
/// Ensures flag is cleared even if retranscription panics or returns early
struct RetranscriptionGuard;

impl RetranscriptionGuard {
    /// Create guard and set flag atomically
    fn acquire() -> Result<Self, String> {
        if RETRANSCRIPTION_IN_PROGRESS
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Retranscription already in progress".to_string());
        }
        Ok(RetranscriptionGuard)
    }
}

impl Drop for RetranscriptionGuard {
    fn drop(&mut self) {
        RETRANSCRIPTION_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

/// VAD redemption time in milliseconds - bridges natural pauses in speech
/// Batch processing needs longer redemption (2000ms) than live pipeline (400ms)
/// because the entire file is processed at once by VAD, and 400ms fragments
/// speech at every natural sentence/topic pause (500ms-2s)
const VAD_REDEMPTION_TIME_MS: u32 = 2000;

/// Progress update emitted during retranscription
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetranscriptionProgress {
    pub meeting_id: String,
    pub stage: String, // "decoding", "transcribing", "saving"
    pub progress_percentage: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerReclusterProgress {
    pub meeting_id: String,
    pub progress_percentage: u32,
    pub message: String,
    pub cancelled: bool,
}

fn emit_speaker_recluster_progress<R: Runtime>(
    app: &AppHandle<R>,
    meeting_id: &str,
    progress: u32,
    message: &str,
    cancelled: bool,
) {
    let _ = app.emit(
        "speaker-recluster-progress",
        SpeakerReclusterProgress {
            meeting_id: meeting_id.to_string(),
            progress_percentage: progress.min(100),
            message: message.to_string(),
            cancelled,
        },
    );
}

/// Result of retranscription
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetranscriptionResult {
    pub meeting_id: String,
    pub segments_count: usize,
    pub duration_seconds: f64,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptVersionSnapshot {
    pub meeting_id: String,
    pub version_kind: String,
    pub speaker_count: usize,
    pub segments: Vec<crate::api::TranscriptSegment>,
}

async fn save_transcript_version(
    pool: &sqlx::SqlitePool,
    meeting_id: &str,
    version_kind: &str,
    speaker_count: usize,
    segments: &[crate::api::TranscriptSegment],
    preserve_existing: bool,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let encoded = serde_json::to_string(segments).map_err(|error| error.to_string())?;
    if preserve_existing {
        sqlx::query("INSERT OR IGNORE INTO transcript_versions (meeting_id, version_kind, speaker_count, segments_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(meeting_id).bind(version_kind).bind(speaker_count as i64).bind(encoded).bind(&now).bind(&now)
            .execute(pool).await.map_err(|error| error.to_string())?;
    } else {
        sqlx::query("INSERT INTO transcript_versions (meeting_id, version_kind, speaker_count, segments_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(meeting_id, version_kind) DO UPDATE SET speaker_count=excluded.speaker_count, segments_json=excluded.segments_json, updated_at=excluded.updated_at")
            .bind(meeting_id).bind(version_kind).bind(speaker_count as i64).bind(encoded).bind(&now).bind(&now)
            .execute(pool).await.map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn transcript_speaker_count(segments: &[crate::api::TranscriptSegment]) -> usize {
    let mut speakers = std::collections::BTreeSet::new();
    for segment in segments {
        let text = segment.text.trim_start();
        if let Some(rest) = text.strip_prefix("[Speaker ") {
            if let Some(end) = rest.find(']') {
                if let Ok(value) = rest[..end].trim().parse::<usize>() {
                    speakers.insert(value);
                }
            }
        }
    }
    speakers.len().max(if segments.is_empty() { 0 } else { 1 })
}

fn strip_transcript_speaker_prefix(text: &str) -> &str {
    let trimmed = text.trim();
    for prefix in ["[Speaker ", "[说话人"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            if let Some(end) = rest.find(']') {
                return rest[end + 1..].trim_start_matches([' ', ':', '：']);
            }
        }
    }
    trimmed
}

/// Single-person mode is a promise about the document structure, not merely a
/// hint to the diarization engine. Remove any stale/model-provided speaker IDs
/// and coalesce adjacent ASR slices into readable paragraphs before saving.
fn normalize_single_speaker_transcripts(
    transcripts: &[(String, f64, f64)],
) -> Vec<(String, f64, f64)> {
    let mut paragraphs: Vec<(String, f64, f64)> = Vec::new();
    for (text, start_ms, end_ms) in transcripts {
        let cleaned = strip_transcript_speaker_prefix(text);
        if cleaned.is_empty() {
            continue;
        }
        if let Some((previous, _, previous_end)) = paragraphs.last_mut() {
            let gap_ms = (*start_ms - *previous_end).max(0.0);
            if gap_ms <= 5_000.0 && previous.chars().count() + cleaned.chars().count() <= 800 {
                let needs_space = previous.chars().last().is_some_and(|ch| ch.is_ascii_alphanumeric())
                    && cleaned.chars().next().is_some_and(|ch| ch.is_ascii_alphanumeric());
                if needs_space {
                    previous.push(' ');
                }
                previous.push_str(cleaned);
                *previous_end = *end_ms;
                continue;
            }
        }
        paragraphs.push((cleaned.to_string(), *start_ms, *end_ms));
    }
    paragraphs
        .into_iter()
        .map(|(text, start_ms, end_ms)| (format!("[Speaker 1] {}", text), start_ms, end_ms))
        .collect()
}

#[tauri::command]
pub async fn get_transcript_version_command(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    version_kind: String,
) -> Result<Option<TranscriptVersionSnapshot>, String> {
    if !matches!(version_kind.as_str(), "original" | "clustered") {
        return Err("Unknown transcript version".to_string());
    }
    use sqlx::Row;
    let row = sqlx::query("SELECT speaker_count, segments_json FROM transcript_versions WHERE meeting_id = ? AND version_kind = ?")
        .bind(&meeting_id).bind(&version_kind)
        .fetch_optional(state.db_manager.pool()).await.map_err(|error| error.to_string())?;
    row.map(|row| {
        let encoded: String = row.get("segments_json");
        let segments = serde_json::from_str(&encoded).map_err(|error| error.to_string())?;
        Ok(TranscriptVersionSnapshot {
            meeting_id,
            version_kind,
            speaker_count: row.get::<i64, _>("speaker_count").max(0) as usize,
            segments,
        })
    })
    .transpose()
}

/// Error during retranscription
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetranscriptionError {
    pub meeting_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetranscriptionJobStatus {
    pub meeting_id: String,
    pub status: String,
    pub progress: Option<RetranscriptionProgress>,
    pub result: Option<RetranscriptionResult>,
    pub error: Option<String>,
}

fn store_job_status(status: RetranscriptionJobStatus) {
    let mut job = RETRANSCRIPTION_JOB
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *job = Some(status);
}

/// Check if retranscription is currently in progress
pub fn is_retranscription_in_progress() -> bool {
    RETRANSCRIPTION_IN_PROGRESS.load(Ordering::SeqCst)
}

/// Cancel ongoing retranscription
pub fn cancel_retranscription() {
    RETRANSCRIPTION_CANCELLED.store(true, Ordering::SeqCst);
}

/// Start retranscription of a meeting's audio
pub async fn start_retranscription<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    meeting_folder_path: String,
    language: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    workflow_mode: Option<String>,
    global_voiceprint_matching: Option<bool>,
) -> Result<RetranscriptionResult> {
    // Acquire guard - ensures flag is cleared even on panic/early return
    let _guard = RetranscriptionGuard::acquire().map_err(|e| anyhow!(e))?;

    // Reset cancellation flag
    RETRANSCRIPTION_CANCELLED.store(false, Ordering::SeqCst);

    let use_parakeet = provider.as_deref() == Some("parakeet");
    let use_funasr = matches!(provider.as_deref(), Some("funasr" | "qwen3asr"));
    let result = run_retranscription(
        app.clone(),
        meeting_id.clone(),
        meeting_folder_path,
        language,
        model,
        provider,
        workflow_mode,
        global_voiceprint_matching,
    )
    .await;

    // Unload the engine after the batch job (success, failure, or cancellation)
    if !use_funasr {
        super::common::unload_engine_after_batch(use_parakeet).await;
    }
    // Keep FunASR resident for the next recording or retranscription.

    // Guard will automatically clear flag on drop
    // No need for manual: RETRANSCRIPTION_IN_PROGRESS.store(false, Ordering::SeqCst);

    match &result {
        Ok(res) => {
            store_job_status(RetranscriptionJobStatus {
                meeting_id: meeting_id.clone(),
                status: "completed".to_string(),
                progress: None,
                result: Some(res.clone()),
                error: None,
            });
            let _ = app.emit(
                "retranscription-complete",
                serde_json::json!({
                    "meeting_id": res.meeting_id,
                    "segments_count": res.segments_count,
                    "duration_seconds": res.duration_seconds,
                    "language": res.language
                }),
            );
        }
        Err(e) => {
            store_job_status(RetranscriptionJobStatus {
                meeting_id: meeting_id.clone(),
                status: "error".to_string(),
                progress: None,
                result: None,
                error: Some(e.to_string()),
            });
            let _ = app.emit(
                "retranscription-error",
                RetranscriptionError {
                    meeting_id: meeting_id.clone(),
                    error: e.to_string(),
                },
            );
        }
    }

    result
}

/// Find audio file in meeting folder
/// Tries common names first, then scans for any file with an audio extension
fn find_audio_file(folder: &Path) -> Result<PathBuf> {
    // A manually-created meeting can point directly to a user-selected file.
    // Recorded/imported meetings continue to point to their managed folder.
    if folder.is_file() {
        let extension = folder
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if AUDIO_EXTENSIONS.contains(&extension.as_str()) {
            return Ok(folder.to_path_buf());
        }
        return Err(anyhow!("Unsupported audio file: {}", folder.display()));
    }

    let candidates = [
        "audio.mp4",
        "audio.m4a",
        "audio.wav",
        "audio.mp3",
        "audio.flac",
        "audio.ogg",
        "recording.mp4",
        "audio.mkv",
        "audio.webm",
        "audio.wma",
    ];

    for name in candidates {
        let path = folder.join(name);
        if path.exists() {
            return Ok(path);
        }
    }

    // Fallback: scan folder for any file with an audio extension
    if let Ok(entries) = std::fs::read_dir(folder) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                let ext = ext.to_string_lossy().to_lowercase();
                if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
                    return Ok(path);
                }
            }
        }
    }

    Err(anyhow!("No audio file found in: {}", folder.display()))
}

/// Internal function to run retranscription
async fn run_retranscription<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    meeting_folder_path: String,
    language: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    workflow_mode: Option<String>,
    global_voiceprint_matching: Option<bool>,
) -> Result<RetranscriptionResult> {
    let folder_path = PathBuf::from(&meeting_folder_path);
    let audio_path = find_audio_file(&folder_path)?;

    // Determine which provider to use (default to whisper)
    let use_parakeet = provider.as_deref() == Some("parakeet");
    let use_funasr = matches!(provider.as_deref(), Some("funasr" | "qwen3asr"));
    let meeting_mode = workflow_mode.as_deref() == Some("meeting");
    let save_global_voiceprints = meeting_mode && global_voiceprint_matching.unwrap_or(true);

    info!(
        "Starting retranscription for meeting {} with language {:?}, model {:?}, provider {:?}",
        meeting_id, language, model, provider
    );

    // Emit progress: decoding
    emit_progress(&app, &meeting_id, "decoding", 5, "Decoding audio file...");

    // Check for cancellation
    if RETRANSCRIPTION_CANCELLED.load(Ordering::SeqCst) {
        return Err(anyhow!("Retranscription cancelled"));
    }

    let (audio_samples, mut duration_seconds) = if use_funasr {
        let path_for_probe = audio_path.clone();
        let duration = tokio::task::spawn_blocking(move || probe_audio_duration(&path_for_probe))
            .await
            .map_err(|e| anyhow!("Audio metadata task panicked: {}", e))?
            .unwrap_or_else(|error| {
                warn!("Could not read audio duration before FunASR: {}", error);
                0.0
            });
        (Vec::new(), duration)
    } else {
        // Whisper and Parakeet still consume 16kHz samples in the Rust pipeline.
        let path_for_decode = audio_path.clone();
        tokio::task::spawn_blocking(move || decode_to_whisper_format_ffmpeg(&path_for_decode, None))
            .await
            .map_err(|e| anyhow!("Audio conversion task panicked: {}", e))??
    };

    emit_progress(
        &app,
        &meeting_id,
        if use_funasr {
            "transcribing"
        } else {
            "decoding"
        },
        20,
        if use_funasr {
            "Preparing audio for FunASR..."
        } else {
            "Audio conversion complete"
        },
    );

    // Check for cancellation
    if RETRANSCRIPTION_CANCELLED.load(Ordering::SeqCst) {
        return Err(anyhow!("Retranscription cancelled"));
    }

    info!(
        "Converted to 16kHz mono format: {} samples",
        audio_samples.len()
    );

    let mut funasr_speaker_embeddings = std::collections::HashMap::new();
    let funasr_transcripts = if use_funasr {
        emit_progress(
            &app,
            &meeting_id,
            "transcribing",
            20,
            "Loading FunASR and transcribing audio...",
        );
        let engine = get_or_init_funasr(model.as_deref(), language.as_deref()).await?;
        let mut task_config = engine.config().await;
        let mut config_changed = task_config.speaker_enabled != meeting_mode;
        task_config.speaker_enabled = meeting_mode;
        if provider.as_deref() == Some("qwen3asr") && meeting_mode {
            config_changed |= !task_config.vad_enabled || task_config.speaker_mode != "vad_segment";
            task_config.vad_enabled = true;
            task_config.speaker_mode = "vad_segment".to_string();
        }
        if config_changed {
            engine.set_config(task_config).await?;
        }
        let app_for_funasr = app.clone();
        let meeting_for_funasr = meeting_id.clone();
        let progress_callback = std::sync::Arc::new(move |progress: u32, message: &str| {
            let overall_progress = 20 + ((progress as f32 * 0.62) as u32);
            emit_progress(
                &app_for_funasr,
                &meeting_for_funasr,
                "transcribing",
                overall_progress.min(82),
                message,
            );
        });
        let result = engine
            .transcribe_file_cached(&audio_path, &meeting_id, Some(progress_callback))
            .await
            .map_err(|e| anyhow!("FunASR transcription failed: {}", e))?;
        if duration_seconds <= 0.0 {
            duration_seconds = result
                .segments
                .iter()
                .map(|segment| segment.end_ms)
                .max()
                .unwrap_or_default() as f64
                / 1000.0;
        }
        funasr_speaker_embeddings = result.speaker_embeddings.clone();
        Some(funasr_result_to_transcripts(&result, duration_seconds))
    } else {
        None
    };

    if !use_funasr {
        emit_progress(&app, &meeting_id, "vad", 20, "Detecting speech segments...");
    }

    // Check for cancellation
    if RETRANSCRIPTION_CANCELLED.load(Ordering::SeqCst) {
        return Err(anyhow!("Retranscription cancelled"));
    }

    // Use VAD to find natural speech boundaries (same approach as live transcription)
    // IMPORTANT: Run VAD in a blocking task to avoid blocking the async runtime
    // For large files (35+ minutes), VAD processing can take several minutes
    let app_for_vad = app.clone();
    let meeting_id_for_vad = meeting_id.clone();

    let speech_segments = if use_funasr {
        Vec::new()
    } else {
        tokio::task::spawn_blocking(move || {
            get_speech_chunks_with_progress(
                &audio_samples,
                VAD_REDEMPTION_TIME_MS,
                |vad_progress, segments_found| {
                    // Map VAD progress (0-100) to overall progress (20-25)
                    let overall_progress = 20 + (vad_progress as f32 * 0.05) as u32;
                    emit_progress(
                        &app_for_vad,
                        &meeting_id_for_vad,
                        "vad",
                        overall_progress,
                        &format!(
                            "Detecting speech segments... {}% ({} found)",
                            vad_progress, segments_found
                        ),
                    );

                    // Return false to cancel if cancellation requested
                    !RETRANSCRIPTION_CANCELLED.load(Ordering::SeqCst)
                },
            )
        })
        .await
        .map_err(|e| anyhow!("VAD task panicked: {}", e))?
        .map_err(|e| anyhow!("VAD processing failed: {}", e))?
    };

    let total_segments = speech_segments.len();
    info!(
        "VAD detected {} speech segments (redemption_time={}ms)",
        total_segments, VAD_REDEMPTION_TIME_MS
    );

    // Diagnostic: log segment duration distribution
    if !speech_segments.is_empty() {
        let durations_ms: Vec<f64> = speech_segments
            .iter()
            .map(|s| s.end_timestamp_ms - s.start_timestamp_ms)
            .collect();
        let total_speech_ms: f64 = durations_ms.iter().sum();
        let avg_duration = total_speech_ms / durations_ms.len() as f64;
        let min_duration = durations_ms.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_duration = durations_ms
            .iter()
            .cloned()
            .fold(f64::NEG_INFINITY, f64::max);
        info!(
            "VAD segment stats: avg={:.0}ms, min={:.0}ms, max={:.0}ms, total_speech={:.1}s/{:.1}s ({:.0}%)",
            avg_duration, min_duration, max_duration,
            total_speech_ms / 1000.0, duration_seconds,
            (total_speech_ms / 1000.0 / duration_seconds) * 100.0
        );
        // Log first 10 segments for detailed inspection
        for (i, seg) in speech_segments.iter().take(10).enumerate() {
            let dur = seg.end_timestamp_ms - seg.start_timestamp_ms;
            debug!(
                "  Segment {}: {:.0}ms-{:.0}ms ({:.0}ms, {} samples)",
                i,
                seg.start_timestamp_ms,
                seg.end_timestamp_ms,
                dur,
                seg.samples.len()
            );
        }
        if total_segments > 10 {
            debug!("  ... and {} more segments", total_segments - 10);
        }
    }

    if total_segments == 0 && !use_funasr {
        warn!("No speech detected in audio");
        return Err(anyhow!("No speech detected in audio file"));
    }

    emit_progress(
        &app,
        &meeting_id,
        "transcribing",
        25,
        "Loading transcription engine...",
    );

    // Initialize the appropriate engine once (not per-segment)
    let whisper_engine = if !use_parakeet && !use_funasr {
        Some(get_or_init_whisper(&app, model.as_deref()).await?)
    } else {
        None
    };
    let parakeet_engine = if use_parakeet {
        Some(get_or_init_parakeet(&app, model.as_deref()).await?)
    } else {
        None
    };

    // Split very long segments at silence boundaries for better transcription quality.
    // Hard cuts at arbitrary sample positions lose words at boundaries. Instead, scan
    // for the lowest-energy window near the target split point and cut there.
    const MAX_SEGMENT_SAMPLES: usize = 25 * 16000; // 25 seconds at 16kHz

    let mut processable_segments: Vec<crate::audio::vad::SpeechSegment> = Vec::new();
    for segment in &speech_segments {
        if segment.samples.len() > MAX_SEGMENT_SAMPLES {
            debug!(
                "Splitting large segment ({:.0}ms, {} samples) at silence boundaries",
                segment.end_timestamp_ms - segment.start_timestamp_ms,
                segment.samples.len()
            );

            let sub_segments = split_segment_at_silence(segment, MAX_SEGMENT_SAMPLES);
            debug!("Split into {} sub-segments", sub_segments.len());
            processable_segments.extend(sub_segments);
        } else {
            processable_segments.push(segment.clone());
        }
    }

    let processable_count = processable_segments.len();
    info!(
        "Processing {} segments (after splitting)",
        processable_count
    );

    // Process each speech segment with progress updates
    let mut all_transcripts: Vec<(String, f64, f64)> = funasr_transcripts.unwrap_or_default(); // (text, start_ms, end_ms)
    let mut total_confidence = 0.0f32;

    for (i, segment) in processable_segments.iter().enumerate() {
        // Check for cancellation before each segment
        if RETRANSCRIPTION_CANCELLED.load(Ordering::SeqCst) {
            return Err(anyhow!("Retranscription cancelled"));
        }

        // Calculate progress (25% to 80% range for transcription)
        let progress = 25 + ((i as f32 / processable_count as f32) * 55.0) as u32;
        let segment_duration_sec = (segment.end_timestamp_ms - segment.start_timestamp_ms) / 1000.0;
        emit_progress(
            &app,
            &meeting_id,
            "transcribing",
            progress,
            &format!(
                "Transcribing segment {} of {} ({:.1}s)...",
                i + 1,
                processable_count,
                segment_duration_sec
            ),
        );

        // Skip very short segments (< 100ms of audio = 1600 samples at 16kHz)
        if segment.samples.len() < 1600 {
            debug!(
                "Skipping short segment {} with {} samples",
                i,
                segment.samples.len()
            );
            continue;
        }

        // Transcribe this segment
        let (text, conf) = if use_parakeet {
            let engine = parakeet_engine.as_ref().unwrap();
            let text = engine
                .transcribe_audio(segment.samples.clone())
                .await
                .map_err(|e| anyhow!("Parakeet transcription failed on segment {}: {}", i, e))?;
            (text, 0.9f32)
        } else {
            let engine = whisper_engine.as_ref().unwrap();
            let (text, conf, _) = engine
                .transcribe_audio_with_confidence(segment.samples.clone(), language.clone())
                .await
                .map_err(|e| anyhow!("Whisper transcription failed on segment {}: {}", i, e))?;
            (text, conf)
        };

        // Skip empty transcripts
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            debug!(
                "Segment {}/{}: {:.1}s, conf={:.2}, text='{}'",
                i + 1,
                processable_count,
                segment_duration_sec,
                conf,
                if trimmed.len() > 80 {
                    let mut end = 80;
                    while !trimmed.is_char_boundary(end) {
                        end -= 1;
                    }
                    &trimmed[..end]
                } else {
                    trimmed
                }
            );
            all_transcripts.push((text, segment.start_timestamp_ms, segment.end_timestamp_ms));
            total_confidence += conf;
        } else {
            debug!(
                "Segment {}/{}: {:.1}s — empty transcription",
                i + 1,
                processable_count,
                segment_duration_sec
            );
        }
    }

    // Whisper and Parakeet provide text and timestamps only. In Meeting mode,
    // run the same canonical FunASR CAM++ model used by the FunASR/Qwen path,
    // then attach meeting-local Speaker IDs to their ASR segments.
    if meeting_mode && !use_funasr && !all_transcripts.is_empty() {
        emit_progress(
            &app,
            &meeting_id,
            "diarizing",
            81,
            "Separating speakers with CAM++...",
        );
        let diarization_segments = all_transcripts
            .iter()
            .map(
                |(text, start_ms, end_ms)| crate::funasr_engine::DiarizationInputSegment {
                    start_ms: start_ms.max(0.0).round() as u64,
                    end_ms: end_ms.max(*start_ms + 100.0).round() as u64,
                    text: text.clone(),
                },
            )
            .collect::<Vec<_>>();
        let engine = crate::funasr_engine::get_or_init_engine()
            .await
            .map_err(|error| anyhow!(error))?;
        let app_for_diarization = app.clone();
        let meeting_for_diarization = meeting_id.clone();
        let progress_callback = Arc::new(move |progress: u32, message: &str| {
            let overall = 81 + ((progress.min(100) as f32 * 0.08) as u32);
            emit_progress(
                &app_for_diarization,
                &meeting_for_diarization,
                "diarizing",
                overall.min(89),
                message,
            );
        });
        let diarization = engine
            .diarize_segments_cached(
                &audio_path,
                &diarization_segments,
                &meeting_id,
                Some(progress_callback),
            )
            .await
            .map_err(|error| anyhow!("CAM++ speaker diarization failed: {}", error))?;
        if diarization.assignments.len() != all_transcripts.len() {
            return Err(anyhow!(
                "CAM++ returned {} speaker assignments for {} transcript segments",
                diarization.assignments.len(),
                all_transcripts.len()
            ));
        }
        if diarization.speaker_count > 1 {
            for (transcript, speaker) in all_transcripts
                .iter_mut()
                .zip(diarization.assignments.iter())
            {
                transcript.0 = format!("[Speaker {}] {}", speaker, transcript.0.trim());
            }
        }
        funasr_speaker_embeddings = diarization.speaker_embeddings;
    }

    if !meeting_mode {
        all_transcripts = normalize_single_speaker_transcripts(&all_transcripts);
        funasr_speaker_embeddings.clear();
    }

    let transcribed_count = all_transcripts.len();
    if use_funasr && transcribed_count == 0 {
        return Err(anyhow!(
            "FunASR returned no transcript; existing transcripts were left unchanged"
        ));
    }
    let avg_confidence = if transcribed_count > 0 {
        total_confidence / transcribed_count as f32
    } else {
        0.0
    };

    info!(
        "Transcription complete: {} segments transcribed out of {}, avg confidence: {:.2}",
        transcribed_count, processable_count, avg_confidence
    );

    // Check for cancellation
    if RETRANSCRIPTION_CANCELLED.load(Ordering::SeqCst) {
        return Err(anyhow!("Retranscription cancelled"));
    }

    emit_progress(&app, &meeting_id, "saving", 90, "Saving transcripts...");

    // Create transcript segments with proper timestamps from VAD
    let segments = create_transcript_segments(&all_transcripts);

    // Save to database
    let app_state = app
        .try_state::<AppState>()
        .ok_or_else(|| anyhow!("App state not available"))?;

    // Wrap delete+insert+update in a transaction to prevent data loss
    let pool = app_state.db_manager.pool();
    let mut conn = pool
        .acquire()
        .await
        .map_err(|e| anyhow!("DB error: {}", e))?;
    let mut tx = sqlx::Connection::begin(&mut *conn)
        .await
        .map_err(|e| anyhow!("Failed to start transaction: {}", e))?;

    sqlx::query("DELETE FROM transcripts WHERE meeting_id = ?")
        .bind(&meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("Failed to delete existing transcripts: {}", e))?;

    for segment in &segments {
        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration)
             VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&segment.id)
        .bind(&meeting_id)
        .bind(&segment.text)
        .bind(&segment.timestamp)
        .bind(segment.audio_start_time)
        .bind(segment.audio_end_time)
        .bind(segment.duration)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow!("Failed to insert transcript: {}", e))?;
    }

    tx.commit()
        .await
        .map_err(|e| anyhow!("Failed to commit transaction: {}", e))?;

    // A full ASR run establishes a new immutable baseline. The initial CAM++
    // estimate is also the first clustered version until the user adjusts it.
    let initial_speaker_count = transcript_speaker_count(&segments);
    save_transcript_version(
        pool,
        &meeting_id,
        "original",
        initial_speaker_count,
        &segments,
        false,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    save_transcript_version(
        pool,
        &meeting_id,
        "clustered",
        initial_speaker_count,
        &segments,
        false,
    )
    .await
    .map_err(anyhow::Error::msg)?;

    if save_global_voiceprints && !funasr_speaker_embeddings.is_empty() {
        if let Err(error) = crate::knowledge::store_meeting_speaker_embeddings(
            pool,
            &meeting_id,
            &funasr_speaker_embeddings,
        )
        .await
        {
            warn!("Failed to save FunASR speaker voiceprints: {}", error);
        }
    }

    info!(
        "Updated {} transcripts for meeting {} in transaction",
        segments.len(),
        meeting_id
    );

    // Write updated transcripts.json and metadata.json to the meeting folder
    emit_progress(
        &app,
        &meeting_id,
        "saving",
        95,
        "Writing transcript files...",
    );

    let managed_meeting_folder = folder_path.is_dir();
    if managed_meeting_folder {
        if let Err(e) = write_transcripts_json(&folder_path, &segments) {
            warn!("Failed to write transcripts.json: {}", e);
        }
    }

    // Find audio filename for metadata
    let audio_filename = audio_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio.mp4")
        .to_string();

    if managed_meeting_folder {
        if let Err(e) = write_retranscription_metadata(
            &folder_path,
            &meeting_id,
            duration_seconds,
            &audio_filename,
        ) {
            warn!("Failed to update metadata.json: {}", e);
        }
    }

    emit_progress(
        &app,
        &meeting_id,
        "complete",
        100,
        "Retranscription complete",
    );

    Ok(RetranscriptionResult {
        meeting_id,
        segments_count: segments.len(),
        duration_seconds,
        language,
    })
}

/// Emit progress event
fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    meeting_id: &str,
    stage: &str,
    progress: u32,
    message: &str,
) {
    let payload = RetranscriptionProgress {
        meeting_id: meeting_id.to_string(),
        stage: stage.to_string(),
        progress_percentage: progress,
        message: message.to_string(),
    };
    store_job_status(RetranscriptionJobStatus {
        meeting_id: meeting_id.to_string(),
        status: "processing".to_string(),
        progress: Some(payload.clone()),
        result: None,
        error: None,
    });
    let _ = app.emit("retranscription-progress", payload);
}

/// Get or initialize the Whisper engine, auto-loading the model if needed
/// If `requested_model` is provided, ensures that specific model is loaded
async fn get_or_init_whisper<R: Runtime>(
    app: &AppHandle<R>,
    requested_model: Option<&str>,
) -> Result<Arc<WhisperEngine>> {
    use crate::whisper_engine::commands::WHISPER_ENGINE;

    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };

    match engine {
        Some(e) => {
            // Determine which model to use
            let target_model = match requested_model {
                Some(model) => model.to_string(),
                None => get_configured_whisper_model(app).await?,
            };

            // Check if the correct model is already loaded
            let current_model = e.get_current_model().await;
            let needs_load = match &current_model {
                Some(loaded) => loaded != &target_model,
                None => true,
            };

            if needs_load {
                info!(
                    "Loading Whisper model '{}' (current: {:?})",
                    target_model, current_model
                );

                // Discover available models first (populates the internal cache)
                info!("Discovering available Whisper models...");
                if let Err(discover_err) = e.discover_models().await {
                    warn!(
                        "Error during model discovery (continuing anyway): {}",
                        discover_err
                    );
                }

                match e.load_model(&target_model).await {
                    Ok(_) => {
                        info!("Whisper model '{}' loaded successfully", target_model);
                        Ok(e)
                    }
                    Err(load_err) => {
                        error!(
                            "Failed to load Whisper model '{}': {}",
                            target_model, load_err
                        );
                        Err(anyhow!(
                            "Failed to load Whisper model '{}': {}",
                            target_model,
                            load_err
                        ))
                    }
                }
            } else {
                info!("Whisper model '{}' already loaded", target_model);
                Ok(e)
            }
        }
        None => Err(anyhow!("Whisper engine not initialized")),
    }
}

/// Get the configured Whisper model name from the database
async fn get_configured_whisper_model<R: Runtime>(app: &AppHandle<R>) -> Result<String> {
    debug!("Getting configured Whisper model from database...");

    let app_state = app.try_state::<AppState>().ok_or_else(|| {
        error!("App state not available");
        anyhow!("App state not available")
    })?;

    debug!("Querying transcript_settings table...");

    // Query the transcript settings from the database - get both provider and model
    let result: Option<(String, String)> =
        sqlx::query_as("SELECT provider, model FROM transcript_settings WHERE id = '1'")
            .fetch_optional(app_state.db_manager.pool())
            .await
            .map_err(|e| {
                error!("Failed to query transcript config: {}", e);
                anyhow!("Failed to query transcript config: {}", e)
            })?;

    match result {
        Some((provider, model)) => {
            info!(
                "Found transcript config: provider={}, model={}",
                provider, model
            );

            // Check if provider is Whisper-based
            if provider == "localWhisper" || provider == "whisper" {
                Ok(model)
            } else {
                error!(
                    "Retranscription requires Whisper provider, but configured provider is: {}",
                    provider
                );
                Err(anyhow!("Retranscription requires Whisper. Current provider '{}' does not support retranscription with language selection.", provider))
            }
        }
        None => {
            // Default to configured Whisper model if no config exists
            warn!(
                "No transcript config found, using default model '{}'",
                DEFAULT_WHISPER_MODEL
            );
            Ok(DEFAULT_WHISPER_MODEL.to_string())
        }
    }
}

/// Get or initialize the Parakeet engine, auto-loading the model if needed
async fn get_or_init_parakeet<R: Runtime>(
    app: &AppHandle<R>,
    requested_model: Option<&str>,
) -> Result<Arc<ParakeetEngine>> {
    use crate::parakeet_engine::commands::PARAKEET_ENGINE;

    let engine = {
        let guard = PARAKEET_ENGINE.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };

    match engine {
        Some(e) => {
            // Determine which model to use
            let target_model = match requested_model {
                Some(model) => model.to_string(),
                None => get_configured_parakeet_model(app).await?,
            };

            // Check if the correct model is already loaded
            let current_model = e.get_current_model().await;
            let needs_load = match &current_model {
                Some(loaded) => loaded != &target_model,
                None => true,
            };

            if needs_load {
                info!(
                    "Loading Parakeet model '{}' (current: {:?})",
                    target_model, current_model
                );

                // Discover available models first
                info!("Discovering available Parakeet models...");
                if let Err(discover_err) = e.discover_models().await {
                    warn!(
                        "Error during Parakeet model discovery (continuing anyway): {}",
                        discover_err
                    );
                }

                match e.load_model(&target_model).await {
                    Ok(_) => {
                        info!("Parakeet model '{}' loaded successfully", target_model);
                        Ok(e)
                    }
                    Err(load_err) => {
                        error!(
                            "Failed to load Parakeet model '{}': {}",
                            target_model, load_err
                        );
                        Err(anyhow!(
                            "Failed to load Parakeet model '{}': {}",
                            target_model,
                            load_err
                        ))
                    }
                }
            } else {
                info!("Parakeet model '{}' already loaded", target_model);
                Ok(e)
            }
        }
        None => Err(anyhow!("Parakeet engine not initialized")),
    }
}

async fn get_or_init_funasr(
    requested_model: Option<&str>,
    requested_language: Option<&str>,
) -> Result<Arc<crate::funasr_engine::FunAsrEngine>> {
    let engine = crate::funasr_engine::get_or_init_engine()
        .await
        .map_err(|e| anyhow!(e))?;
    let mut config = engine.config().await;
    let mut changed = false;
    if let Some(model) = requested_model {
        if config.model != model {
            config.model = model.to_string();
            changed = true;
        }
    }
    if let Some(language) = requested_language {
        if !language.is_empty() && config.language != language {
            config.language = language.to_string();
            changed = true;
        }
    }
    if changed {
        engine.set_config(config).await?;
    }
    Ok(engine)
}

/// Get the configured Parakeet model name from the database
async fn get_configured_parakeet_model<R: Runtime>(app: &AppHandle<R>) -> Result<String> {
    debug!("Getting configured Parakeet model from database...");

    let app_state = app.try_state::<AppState>().ok_or_else(|| {
        error!("App state not available");
        anyhow!("App state not available")
    })?;

    // Query the transcript settings from the database
    let result: Option<(String, String)> =
        sqlx::query_as("SELECT provider, model FROM transcript_settings WHERE id = '1'")
            .fetch_optional(app_state.db_manager.pool())
            .await
            .map_err(|e| {
                error!("Failed to query transcript config: {}", e);
                anyhow!("Failed to query transcript config: {}", e)
            })?;

    match result {
        Some((provider, model)) => {
            info!(
                "Found transcript config: provider={}, model={}",
                provider, model
            );

            if provider == "parakeet" {
                Ok(model)
            } else {
                // Default to configured Parakeet model
                warn!("Configured provider is not Parakeet, using default model");
                Ok(DEFAULT_PARAKEET_MODEL.to_string())
            }
        }
        None => {
            // Default to configured Parakeet model if no config exists
            warn!("No transcript config found, using default Parakeet model");
            Ok(DEFAULT_PARAKEET_MODEL.to_string())
        }
    }
}

/// Write or update metadata.json for retranscription (preserves existing fields, adds retranscribed_at)
fn write_retranscription_metadata(
    folder: &Path,
    meeting_id: &str,
    duration_seconds: f64,
    audio_filename: &str,
) -> Result<()> {
    let metadata_path = folder.join("metadata.json");
    let temp_path = folder.join(".metadata.json.tmp");
    let now = chrono::Utc::now().to_rfc3339();

    // Try to read existing metadata and update it
    let json = if metadata_path.exists() {
        let existing = std::fs::read_to_string(&metadata_path)?;
        let mut value: serde_json::Value = serde_json::from_str(&existing)?;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("retranscribed_at".to_string(), serde_json::json!(now));
            obj.insert("status".to_string(), serde_json::json!("completed"));
            obj.insert(
                "transcript_file".to_string(),
                serde_json::json!("transcripts.json"),
            );
            obj.remove("detected_summary_language");
        }
        value
    } else {
        serde_json::json!({
            "version": "1.0",
            "meeting_id": meeting_id,
            "created_at": now,
            "completed_at": now,
            "retranscribed_at": now,
            "duration_seconds": duration_seconds,
            "audio_file": audio_filename,
            "transcript_file": "transcripts.json",
            "status": "completed",
            "source": "retranscription"
        })
    };

    let json_string = serde_json::to_string_pretty(&json)?;
    std::fs::write(&temp_path, &json_string)?;
    std::fs::rename(&temp_path, &metadata_path)?;

    info!("Wrote metadata.json to {}", metadata_path.display());
    Ok(())
}

// Tauri commands

/// Response when retranscription is started
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetranscriptionStarted {
    pub meeting_id: String,
    pub message: String,
}

#[tauri::command]
pub async fn get_speaker_recluster_status_command(
    meeting_id: String,
) -> Result<crate::funasr_engine::SpeakerReclusterStatus, String> {
    let engine = crate::funasr_engine::get_or_init_engine().await?;
    engine
        .recluster_status(&meeting_id)
        .await
        .map_err(|error| error.to_string())
}

/// Build the canonical CAM++ speaker cache for a freshly recorded meeting.
/// Live ASR stays lightweight and responsive; once the recording is saved we
/// analyze the complete audio once, apply the initial Speaker IDs, and retain
/// embeddings so changing the expected count does not run ASR again.
#[tauri::command]
pub async fn prepare_recording_speaker_diarization_command<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<crate::funasr_engine::SpeakerReclusterStatus, String> {
    use sqlx::Row;

    let pool = state.db_manager.pool();
    let folder_path: Option<String> = sqlx::query_scalar(
        "SELECT folder_path FROM meetings WHERE id = ?",
    )
    .bind(&meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| error.to_string())?
    .flatten();
    let folder_path = folder_path.ok_or_else(|| "Meeting audio is not available".to_string())?;
    let audio_path = find_audio_file(Path::new(&folder_path)).map_err(|error| error.to_string())?;

    let rows = sqlx::query(
        "SELECT id, transcript, timestamp, audio_start_time, audio_end_time, duration FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time, timestamp",
    )
    .bind(&meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|error| error.to_string())?;
    let original_segments = rows
        .iter()
        .map(|row| crate::api::TranscriptSegment {
            id: row.get("id"),
            text: row.get("transcript"),
            timestamp: row.get("timestamp"),
            audio_start_time: row.get("audio_start_time"),
            audio_end_time: row.get("audio_end_time"),
            duration: row.get("duration"),
        })
        .collect::<Vec<_>>();
    if original_segments.is_empty() {
        return Err("No transcript segments are available for speaker analysis".to_string());
    }
    let diarization_segments = original_segments
        .iter()
        .map(|segment| {
            let start = segment.audio_start_time.unwrap_or_default().max(0.0);
            let end = segment
                .audio_end_time
                .or_else(|| segment.duration.map(|duration| start + duration))
                .unwrap_or(start + 0.1)
                .max(start + 0.1);
            crate::funasr_engine::DiarizationInputSegment {
                start_ms: (start * 1000.0).round() as u64,
                end_ms: (end * 1000.0).round() as u64,
                text: segment.text.clone(),
            }
        })
        .collect::<Vec<_>>();

    save_transcript_version(
        pool,
        &meeting_id,
        "original",
        transcript_speaker_count(&original_segments),
        &original_segments,
        true,
    )
    .await?;
    emit_speaker_recluster_progress(&app, &meeting_id, 8, "Preparing speaker analysis…", false);
    let app_for_progress = app.clone();
    let meeting_for_progress = meeting_id.clone();
    let progress_callback = Arc::new(move |progress: u32, message: &str| {
        emit_speaker_recluster_progress(
            &app_for_progress,
            &meeting_for_progress,
            8 + ((progress.min(100) as f32 * 0.78) as u32),
            message,
            false,
        );
    });
    let engine = crate::funasr_engine::get_or_init_engine().await?;
    let result = engine
        .diarize_segments_cached(
            &audio_path,
            &diarization_segments,
            &meeting_id,
            Some(progress_callback),
        )
        .await
        .map_err(|error| format!("CAM++ speaker analysis failed: {}", error))?;
    if result.assignments.len() != original_segments.len() {
        return Err(format!(
            "CAM++ returned {} assignments for {} transcript segments",
            result.assignments.len(),
            original_segments.len()
        ));
    }

    emit_speaker_recluster_progress(&app, &meeting_id, 90, "Saving speaker groups…", false);
    let clustered_segments = original_segments
        .iter()
        .zip(result.assignments.iter())
        .map(|(segment, speaker)| {
            let text = segment.text.trim_start();
            let clean_text = if text.starts_with("[Speaker ") {
                text.find(']').map(|end| text[end + 1..].trim_start()).unwrap_or(text)
            } else {
                text
            };
            crate::api::TranscriptSegment {
                id: segment.id.clone(),
                text: format!("[Speaker {}] {}", speaker, clean_text),
                timestamp: segment.timestamp.clone(),
                audio_start_time: segment.audio_start_time,
                audio_end_time: segment.audio_end_time,
                duration: segment.duration,
            }
        })
        .collect::<Vec<_>>();
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    for segment in &clustered_segments {
        sqlx::query("UPDATE transcripts SET transcript = ? WHERE id = ? AND meeting_id = ?")
            .bind(&segment.text)
            .bind(&segment.id)
            .bind(&meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    }
    tx.commit().await.map_err(|error| error.to_string())?;
    save_transcript_version(
        pool,
        &meeting_id,
        "clustered",
        result.speaker_count,
        &clustered_segments,
        false,
    )
    .await?;
    if !result.speaker_embeddings.is_empty() {
        crate::knowledge::store_meeting_speaker_embeddings(
            pool,
            &meeting_id,
            &result.speaker_embeddings,
        )
        .await?;
    }
    let status = engine
        .recluster_status(&meeting_id)
        .await
        .map_err(|error| error.to_string())?;
    let _ = app.emit("speaker-recluster-complete", serde_json::json!({
        "meeting_id": meeting_id,
        "available": status.available,
        "estimated_count": status.estimated_count,
        "current_count": status.current_count,
    }));
    emit_speaker_recluster_progress(&app, &meeting_id, 100, "Speaker analysis complete", false);
    Ok(status)
}

/// Re-run only CAM++ clustering against retained embeddings. The immutable ASR
/// baseline is saved first, then a new word-aligned clustered version replaces
/// the active working rows. The baseline remains available for instant review
/// and recovery.
#[tauri::command]
pub async fn recluster_meeting_speakers_command<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    speaker_count: usize,
) -> Result<crate::funasr_engine::SpeakerReclusterStatus, String> {
    if is_retranscription_in_progress() {
        return Err(
            "Please wait for transcription to finish before adjusting speakers".to_string(),
        );
    }
    if !(1..=20).contains(&speaker_count) {
        return Err("Speaker count must be between 1 and 20".to_string());
    }
    SPEAKER_RECLUSTER_CANCELLED.store(false, Ordering::SeqCst);
    emit_speaker_recluster_progress(
        &app,
        &meeting_id,
        8,
        "Preparing cached speaker features…",
        false,
    );
    emit_speaker_recluster_progress(&app, &meeting_id, 22, "Loading the speaker model…", false);
    let engine = crate::funasr_engine::get_or_init_engine().await?;
    emit_speaker_recluster_progress(
        &app,
        &meeting_id,
        38,
        "Recalculating speaker groups…",
        false,
    );
    let result = engine
        .recluster_transcript(&meeting_id, speaker_count)
        .await
        .map_err(|error| error.to_string())?;
    if SPEAKER_RECLUSTER_CANCELLED.load(Ordering::SeqCst) {
        emit_speaker_recluster_progress(
            &app,
            &meeting_id,
            0,
            "Speaker reclustering cancelled",
            true,
        );
        return Err("Speaker reclustering cancelled".to_string());
    }
    emit_speaker_recluster_progress(
        &app,
        &meeting_id,
        62,
        "Aligning speaker changes to words and pauses…",
        false,
    );

    let pool = state.db_manager.pool();
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT id, transcript, timestamp, audio_start_time, audio_end_time, duration FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time, timestamp",
    )
    .bind(&meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|error| error.to_string())?;
    let current_segments = rows
        .iter()
        .map(|row| crate::api::TranscriptSegment {
            id: row.get("id"),
            text: row.get("transcript"),
            timestamp: row.get("timestamp"),
            audio_start_time: row.get("audio_start_time"),
            audio_end_time: row.get("audio_end_time"),
            duration: row.get("duration"),
        })
        .collect::<Vec<_>>();
    save_transcript_version(
        pool,
        &meeting_id,
        "original",
        transcript_speaker_count(&current_segments),
        &current_segments,
        true,
    )
    .await?;

    let duration_seconds = result
        .segments
        .iter()
        .map(|segment| segment.end_ms)
        .max()
        .unwrap_or_default() as f64
        / 1000.0;
    let rebuilt_transcripts = funasr_result_to_transcripts(&result, duration_seconds);
    let rebuilt_segments = create_transcript_segments(&rebuilt_transcripts);
    if rebuilt_segments.is_empty() {
        return Err("Speaker reclustering produced no usable transcript".to_string());
    }
    if SPEAKER_RECLUSTER_CANCELLED.load(Ordering::SeqCst) {
        emit_speaker_recluster_progress(
            &app,
            &meeting_id,
            0,
            "Speaker reclustering cancelled",
            true,
        );
        return Err("Speaker reclustering cancelled".to_string());
    }
    emit_speaker_recluster_progress(
        &app,
        &meeting_id,
        84,
        "Saving the clustered speaker version…",
        false,
    );

    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    sqlx::query("DELETE FROM transcripts WHERE meeting_id = ?")
        .bind(&meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    for segment in &rebuilt_segments {
        sqlx::query("INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(&segment.id).bind(&meeting_id).bind(&segment.text).bind(&segment.timestamp)
            .bind(segment.audio_start_time).bind(segment.audio_end_time).bind(segment.duration)
            .execute(&mut *tx).await.map_err(|error| error.to_string())?;
    }
    sqlx::query("DELETE FROM meeting_speaker_assignments WHERE meeting_id = ? AND confirmed = 0")
        .bind(&meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    save_transcript_version(
        pool,
        &meeting_id,
        "clustered",
        result.speaker_count,
        &rebuilt_segments,
        false,
    )
    .await?;

    if !result.speaker_embeddings.is_empty() {
        crate::knowledge::store_meeting_speaker_embeddings(
            pool,
            &meeting_id,
            &result.speaker_embeddings,
        )
        .await
        .map_err(|error| error.to_string())?;
    }
    let status = engine
        .recluster_status(&meeting_id)
        .await
        .map_err(|error| error.to_string())?;
    app.emit("speaker-recluster-complete", serde_json::json!({
        "meeting_id": meeting_id,
        "available": status.available,
        "estimated_count": status.estimated_count,
        "current_count": status.current_count,
    }))
        .map_err(|error| error.to_string())?;
    emit_speaker_recluster_progress(
        &app,
        &meeting_id,
        100,
        "Speaker reclustering complete",
        false,
    );
    Ok(status)
}

#[tauri::command]
pub async fn cancel_speaker_recluster_command<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
) -> Result<(), String> {
    SPEAKER_RECLUSTER_CANCELLED.store(true, Ordering::SeqCst);
    emit_speaker_recluster_progress(
        &app,
        &meeting_id,
        0,
        "Cancelling speaker reclustering…",
        true,
    );
    Ok(())
}

// Start retranscription (Beta gated using configContext.betaFeatures)
#[tauri::command]
pub async fn start_retranscription_command<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    meeting_folder_path: String,
    language: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    workflow_mode: Option<String>,
    global_voiceprint_matching: Option<bool>,
) -> Result<RetranscriptionStarted, String> {
    // Check if retranscription is already in progress (guard will be acquired in start_retranscription)
    if RETRANSCRIPTION_IN_PROGRESS.load(Ordering::SeqCst) {
        return Err("Retranscription already in progress".to_string());
    }

    store_job_status(RetranscriptionJobStatus {
        meeting_id: meeting_id.clone(),
        status: "processing".to_string(),
        progress: Some(RetranscriptionProgress {
            meeting_id: meeting_id.clone(),
            stage: "preparing".to_string(),
            progress_percentage: 1,
            message: "Preparing transcription...".to_string(),
        }),
        result: None,
        error: None,
    });

    // Clone values for the spawned task
    let meeting_id_clone = meeting_id.clone();

    // Spawn the retranscription in a background task
    tauri::async_runtime::spawn(async move {
        let result = start_retranscription(
            app,
            meeting_id_clone,
            meeting_folder_path,
            language,
            model,
            provider,
            workflow_mode,
            global_voiceprint_matching,
        )
        .await;

        // Errors are already emitted as events in start_retranscription
        // so we just log here for debugging
        if let Err(e) = result {
            error!("Retranscription failed: {}", e);
        }
    });

    Ok(RetranscriptionStarted {
        meeting_id,
        message: "Retranscription started".to_string(),
    })
}

#[tauri::command]
pub async fn cancel_retranscription_command() -> Result<(), String> {
    if !is_retranscription_in_progress() {
        return Err("No retranscription in progress".to_string());
    }
    cancel_retranscription();
    Ok(())
}

#[tauri::command]
pub async fn is_retranscription_in_progress_command() -> bool {
    is_retranscription_in_progress()
}

#[tauri::command]
pub async fn get_retranscription_status_command(meeting_id: String) -> RetranscriptionJobStatus {
    let job = RETRANSCRIPTION_JOB
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    job.clone()
        .filter(|status| status.meeting_id == meeting_id)
        .unwrap_or(RetranscriptionJobStatus {
            meeting_id,
            status: "idle".to_string(),
            progress: None,
            result: None,
            error: None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_transcript_segments_empty() {
        let transcripts: Vec<(String, f64, f64)> = vec![];
        let segments = create_transcript_segments(&transcripts);
        assert!(segments.is_empty());
    }

    #[test]
    fn single_person_mode_removes_speaker_ids_and_merges_adjacent_slices() {
        let transcripts = vec![
            ("[Speaker 3] 我们开始".to_string(), 0.0, 1_000.0),
            ("[Speaker 8]讨论这个问题。".to_string(), 1_100.0, 2_500.0),
            ("[Speaker 2]下一项。".to_string(), 9_000.0, 10_000.0),
        ];
        let normalized = normalize_single_speaker_transcripts(&transcripts);
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0].0, "[Speaker 1] 我们开始讨论这个问题。");
        assert_eq!(normalized[1].0, "[Speaker 1] 下一项。");
        assert!(normalized.iter().all(|item| !item.0.contains("Speaker 2")
            && !item.0.contains("Speaker 3")
            && !item.0.contains("Speaker 8")));
    }

    #[test]
    fn test_create_transcript_segments_single() {
        let transcripts = vec![
            ("Hello world".to_string(), 0.0, 1500.0), // 0-1.5 seconds
        ];
        let segments = create_transcript_segments(&transcripts);

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Hello world");
        assert_eq!(segments[0].audio_start_time, Some(0.0));
        assert_eq!(segments[0].audio_end_time, Some(1.5));
        assert_eq!(segments[0].duration, Some(1.5));
    }

    #[test]
    fn test_create_transcript_segments_multiple() {
        let transcripts = vec![
            ("First segment".to_string(), 0.0, 2000.0), // 0-2 seconds
            ("Second segment".to_string(), 3000.0, 5000.0), // 3-5 seconds
            ("Third segment".to_string(), 6500.0, 8000.0), // 6.5-8 seconds
        ];
        let segments = create_transcript_segments(&transcripts);

        assert_eq!(segments.len(), 3);

        // First segment
        assert_eq!(segments[0].text, "First segment");
        assert_eq!(segments[0].audio_start_time, Some(0.0));
        assert_eq!(segments[0].audio_end_time, Some(2.0));
        assert_eq!(segments[0].duration, Some(2.0));

        // Second segment
        assert_eq!(segments[1].text, "Second segment");
        assert_eq!(segments[1].audio_start_time, Some(3.0));
        assert_eq!(segments[1].audio_end_time, Some(5.0));
        assert_eq!(segments[1].duration, Some(2.0));

        // Third segment
        assert_eq!(segments[2].text, "Third segment");
        assert_eq!(segments[2].audio_start_time, Some(6.5));
        assert_eq!(segments[2].audio_end_time, Some(8.0));
        assert_eq!(segments[2].duration, Some(1.5));
    }

    #[test]
    fn test_create_transcript_segments_trims_whitespace() {
        let transcripts = vec![("  Hello with spaces  ".to_string(), 0.0, 1000.0)];
        let segments = create_transcript_segments(&transcripts);

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Hello with spaces");
    }

    #[test]
    fn test_create_transcript_segments_generates_unique_ids() {
        let transcripts = vec![
            ("Segment one".to_string(), 0.0, 1000.0),
            ("Segment two".to_string(), 1000.0, 2000.0),
        ];
        let segments = create_transcript_segments(&transcripts);

        assert_eq!(segments.len(), 2);
        assert_ne!(segments[0].id, segments[1].id);
        assert!(segments[0].id.starts_with("transcript-"));
        assert!(segments[1].id.starts_with("transcript-"));
    }

    #[test]
    fn test_cancellation_flag() {
        // Reset flag to known state
        RETRANSCRIPTION_CANCELLED.store(false, Ordering::SeqCst);
        RETRANSCRIPTION_IN_PROGRESS.store(false, Ordering::SeqCst);

        assert!(!is_retranscription_in_progress());

        // Test cancellation
        cancel_retranscription();
        assert!(RETRANSCRIPTION_CANCELLED.load(Ordering::SeqCst));

        // Reset for other tests
        RETRANSCRIPTION_CANCELLED.store(false, Ordering::SeqCst);
    }

    #[test]
    fn test_vad_redemption_time_constant() {
        // Batch processing uses 2000ms to bridge natural pauses in full-file VAD
        assert_eq!(VAD_REDEMPTION_TIME_MS, 2000);
    }

    #[test]
    fn test_find_audio_file_common_candidates() {
        let dir = tempfile::tempdir().unwrap();

        // No audio file → error
        assert!(find_audio_file(dir.path()).is_err());

        // Create audio.mp4 — should be found first
        std::fs::write(dir.path().join("audio.mp4"), b"fake").unwrap();
        let found = find_audio_file(dir.path()).unwrap();
        assert_eq!(found.file_name().unwrap(), "audio.mp4");
    }

    #[test]
    fn test_find_audio_file_non_mp4_extensions() {
        let dir = tempfile::tempdir().unwrap();

        // Create audio.wav (imported as .wav, not .mp4)
        std::fs::write(dir.path().join("audio.wav"), b"fake").unwrap();
        let found = find_audio_file(dir.path()).unwrap();
        assert_eq!(found.file_name().unwrap(), "audio.wav");
    }

    #[test]
    fn test_find_audio_file_accepts_direct_user_selected_file() {
        let file = tempfile::Builder::new().suffix(".mp3").tempfile().unwrap();
        let found = find_audio_file(file.path()).unwrap();
        assert_eq!(found, file.path());
    }

    #[test]
    fn test_find_audio_file_fallback_scan() {
        let dir = tempfile::tempdir().unwrap();

        // Create a file with an audio extension but non-standard name
        std::fs::write(dir.path().join("my_recording.flac"), b"fake").unwrap();
        // Also add a non-audio file that should be ignored
        std::fs::write(dir.path().join("notes.txt"), b"text").unwrap();

        let found = find_audio_file(dir.path()).unwrap();
        assert_eq!(found.file_name().unwrap(), "my_recording.flac");
    }

    #[test]
    fn test_find_audio_file_priority_order() {
        let dir = tempfile::tempdir().unwrap();

        // Create both audio.m4a and audio.mp4 — mp4 should win (listed first in candidates)
        std::fs::write(dir.path().join("audio.m4a"), b"fake").unwrap();
        std::fs::write(dir.path().join("audio.mp4"), b"fake").unwrap();
        let found = find_audio_file(dir.path()).unwrap();
        assert_eq!(found.file_name().unwrap(), "audio.mp4");
    }

    #[test]
    fn test_find_audio_file_empty_folder() {
        let dir = tempfile::tempdir().unwrap();
        let result = find_audio_file(dir.path());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("No audio file found"));
    }

    #[test]
    fn test_find_audio_file_nonexistent_folder() {
        let result = find_audio_file(Path::new("/nonexistent/path/12345"));
        assert!(result.is_err());
    }

    #[test]
    fn test_audio_extensions_constant() {
        // Verify all expected formats are covered
        assert!(AUDIO_EXTENSIONS.contains(&"mp4"));
        assert!(AUDIO_EXTENSIONS.contains(&"m4a"));
        assert!(AUDIO_EXTENSIONS.contains(&"wav"));
        assert!(AUDIO_EXTENSIONS.contains(&"mp3"));
        assert!(AUDIO_EXTENSIONS.contains(&"flac"));
        assert!(AUDIO_EXTENSIONS.contains(&"ogg"));
        assert!(AUDIO_EXTENSIONS.contains(&"aac"));
        // FFmpeg-backed formats
        assert!(AUDIO_EXTENSIONS.contains(&"mkv"));
        assert!(AUDIO_EXTENSIONS.contains(&"webm"));
        assert!(AUDIO_EXTENSIONS.contains(&"wma"));
        // Non-audio formats
        assert!(!AUDIO_EXTENSIONS.contains(&"txt"));
        assert!(!AUDIO_EXTENSIONS.contains(&"pdf"));
    }
}
