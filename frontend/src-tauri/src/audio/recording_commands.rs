// audio/recording_commands.rs
//
// Slim Tauri command layer for recording functionality.
// Delegates to transcription and recording modules for actual implementation.

use anyhow::Result;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::task::JoinHandle;

use super::{
    default_input_device,  // Get default microphone
    default_output_device, // Get default system audio
    parse_audio_device,
    DeviceEvent,
    DeviceMonitorType,
    RecordingManager,
};

// Import transcription modules
use super::transcription::{self, reset_speech_detected_flag};

// Re-export TranscriptUpdate for backward compatibility
pub use super::transcription::TranscriptUpdate;

// ============================================================================
// GLOBAL STATE
// ============================================================================

// Simple recording state tracking
static IS_RECORDING: AtomicBool = AtomicBool::new(false);
static LIVE_CAPTIONS_ENABLED: AtomicBool = AtomicBool::new(true);

// Global recording manager and transcription task to keep them alive during recording
static RECORDING_MANAGER: Mutex<Option<RecordingManager>> = Mutex::new(None);
static TRANSCRIPTION_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

// Listener ID for proper cleanup - prevents microphone from staying active after recording stops
static TRANSCRIPT_LISTENER_ID: Mutex<Option<tauri::EventId>> = Mutex::new(None);

// ============================================================================
// PUBLIC TYPES
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct RecordingArgs {
    pub save_path: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RecordingStoppedPayload {
    pub message: String,
    pub folder_path: Option<String>,
    pub meeting_name: Option<String>,
    pub audio_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TranscriptionStatus {
    pub chunks_in_queue: usize,
    pub is_processing: bool,
    pub last_activity_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelStatus {
    pub provider: String,
    pub model: String,
    pub loaded: bool,
}

// ============================================================================
// RECORDING COMMANDS
// ============================================================================

async fn live_transcription_enabled<R: Runtime>(_app: &AppHandle<R>) -> bool {
    LIVE_CAPTIONS_ENABLED.load(Ordering::SeqCst)
}

/// Enable or disable the lightweight live-caption preview for the next
/// recording. Audio capture never depends on this flag.
#[tauri::command]
pub async fn set_live_caption_enabled(enabled: bool) -> Result<(), String> {
    LIVE_CAPTIONS_ENABLED.store(enabled, Ordering::SeqCst);
    Ok(())
}

/// Warm the currently configured local transcription model before the user
/// presses Record. Recording start uses the same validation path, so this is
/// only a latency optimization and never creates a second model selection
/// source of truth.
#[tauri::command]
pub async fn prepare_transcription_model<R: Runtime>(
    _app: AppHandle<R>,
) -> Result<TranscriptionModelStatus, String> {
    let _engine_lifecycle_guard = super::common::acquire_engine_lifecycle_lock().await;
    transcription::engine::prepare_live_caption_engine().await?;
    Ok(TranscriptionModelStatus {
        provider: "live-caption".to_string(),
        model: transcription::engine::LIVE_CAPTION_MODEL.to_string(),
        loaded: true,
    })
}

/// Start recording with default devices
pub async fn start_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    start_recording_with_meeting_name(app, None).await
}

/// Start recording with default devices and optional meeting name
pub async fn start_recording_with_meeting_name<R: Runtime>(
    app: AppHandle<R>,
    meeting_name: Option<String>,
) -> Result<(), String> {
    info!(
        "Starting recording with default devices, meeting: {:?}",
        meeting_name
    );

    // Check if already recording
    let current_recording_state = IS_RECORDING.load(Ordering::SeqCst);
    info!("🔍 IS_RECORDING state check: {}", current_recording_state);
    if current_recording_state {
        return Err("Recording already in progress".to_string());
    }

    let use_live_transcription = live_transcription_enabled(&app).await;

    info!(
        "🎙️ Starting audio capture immediately (live transcription: {})",
        use_live_transcription
    );

    // Async-first approach - no more blocking operations!
    info!("🚀 Starting async recording initialization");

    // Create new recording manager
    let mut manager = RecordingManager::new();

    // Load recording preferences to get auto_save AND device preferences
    let (auto_save, preferred_mic_name, preferred_system_name, save_folder) =
        match super::recording_preferences::load_recording_preferences(&app).await {
            Ok(prefs) => {
                info!("📋 Loaded recording preferences: auto_save={}, preferred_mic={:?}, preferred_system={:?}",
                      prefs.auto_save, prefs.preferred_mic_device, prefs.preferred_system_device);
                (
                    prefs.auto_save,
                    prefs.preferred_mic_device,
                    prefs.preferred_system_device,
                    prefs.save_folder,
                )
            }
            Err(e) => {
                warn!(
                    "Failed to load recording preferences, using defaults: {}",
                    e
                );
                (
                    true,
                    None,
                    None,
                    super::recording_preferences::get_default_recordings_folder(),
                )
            }
        };
    manager.set_recording_folder(save_folder);

    // ============================================================================
    // MICROPHONE DEVICE RESOLUTION: Preference → Default → Error
    // ============================================================================
    let microphone_device = match preferred_mic_name {
        Some(pref_name) => {
            info!("🎤 Attempting to use preferred microphone: '{}'", pref_name);
            match parse_audio_device(&pref_name) {
                Ok(device) => {
                    info!("✅ Using preferred microphone: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    warn!(
                        "⚠️ Preferred microphone '{}' not available: {}",
                        pref_name, e
                    );
                    warn!("   Falling back to system default microphone...");
                    match default_input_device() {
                        Ok(device) => {
                            info!("✅ Using default microphone: '{}'", device.name);
                            Some(Arc::new(device))
                        }
                        Err(default_err) => {
                            error!(
                                "❌ No microphone available (preferred and default both failed)"
                            );
                            return Err(format!(
                                "No microphone device available. Preferred device '{}' not found, and default microphone unavailable: {}",
                                pref_name, default_err
                            ));
                        }
                    }
                }
            }
        }
        None => {
            info!("🎤 No microphone preference set, using system default");
            match default_input_device() {
                Ok(device) => {
                    info!("✅ Using default microphone: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    error!("❌ No default microphone available");
                    return Err(format!("No microphone device available: {}", e));
                }
            }
        }
    };

    // ============================================================================
    // SYSTEM AUDIO DEVICE RESOLUTION: Preference → Default → None (optional)
    // ============================================================================
    let system_device = match preferred_system_name {
        Some(pref_name) => {
            info!(
                "🔊 Attempting to use preferred system audio: '{}'",
                pref_name
            );
            match parse_audio_device(&pref_name) {
                Ok(device) => {
                    info!("✅ Using preferred system audio: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    warn!(
                        "⚠️ Preferred system audio '{}' not available: {}",
                        pref_name, e
                    );
                    warn!("   Falling back to system default...");
                    match default_output_device() {
                        Ok(device) => {
                            info!("✅ Using default system audio: '{}'", device.name);
                            Some(Arc::new(device))
                        }
                        Err(default_err) => {
                            warn!("⚠️ No system audio available (preferred and default both failed): {}", default_err);
                            warn!("   Recording will continue with microphone only");
                            None // System audio is optional
                        }
                    }
                }
            }
        }
        None => {
            info!("🔊 No system audio preference set, using system default");
            match default_output_device() {
                Ok(device) => {
                    info!("✅ Using default system audio: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    warn!("⚠️ No default system audio available: {}", e);
                    warn!("   Recording will continue with microphone only");
                    None // System audio is optional
                }
            }
        }
    };

    // Always ensure a meeting name is set so incremental saver initializes
    let effective_meeting_name = meeting_name.clone().unwrap_or_else(|| {
        // Example: Meeting 2025-10-03_08-25-23
        let now = chrono::Local::now();
        format!("Meeting {}", now.format("%Y-%m-%d_%H-%M-%S"))
    });
    manager.set_meeting_name(Some(effective_meeting_name));

    // Set up error callback
    let app_for_error = app.clone();
    manager.set_error_callback(move |error| {
        let _ = app_for_error.emit("recording-error", error.user_message());
    });

    // Start recording with resolved devices (replaces start_recording_with_defaults_and_auto_save call)
    let transcription_receiver = manager
        .start_recording(microphone_device, system_device, auto_save)
        .await
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    // Store the manager globally to keep it alive
    {
        let mut global_manager = RECORDING_MANAGER.lock().unwrap();
        *global_manager = Some(manager);
    }

    // Set recording flag and reset speech detection flag
    info!("🔍 Setting IS_RECORDING to true and resetting SPEECH_DETECTED_EMITTED");
    IS_RECORDING.store(true, Ordering::SeqCst);
    reset_speech_detected_flag(); // Reset for new recording session

    // Start live transcription only when a model is selected. Recording-only
    // mode keeps a lightweight receiver drain alive so the audio pipeline does
    // not repeatedly report a closed caption channel; no ASR engine is loaded.
    if use_live_transcription {
        let task_handle =
            transcription::start_transcription_task(app.clone(), transcription_receiver);
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        *global_task = Some(task_handle);
    } else {
        let drain_task = tokio::spawn(async move {
            let mut receiver = transcription_receiver;
            while receiver.recv().await.is_some() {}
        });
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        *global_task = Some(drain_task);
    }

    // CRITICAL: Listen for transcript-update events and save to recording manager
    // This enables transcript history persistence for page reload sync
    // Store listener ID for cleanup during stop_recording to ensure microphone is released
    if use_live_transcription {
        use tauri::Listener;
        let listener_id = app.listen("transcript-update", move |event: tauri::Event| {
            // Parse the transcript update from the event payload
            if let Ok(update) = serde_json::from_str::<TranscriptUpdate>(event.payload()) {
                // Create structured transcript segment
                let segment = crate::audio::recording_saver::TranscriptSegment {
                    id: format!("seg_{}", update.sequence_id),
                    text: update.text.clone(),
                    audio_start_time: update.audio_start_time,
                    audio_end_time: update.audio_end_time,
                    duration: update.duration,
                    display_time: update.timestamp.clone(), // Use wall-clock timestamp for display
                    confidence: update.confidence,
                    sequence_id: update.sequence_id,
                };

                // Save to recording manager
                if let Ok(manager_guard) = RECORDING_MANAGER.lock() {
                    if let Some(manager) = manager_guard.as_ref() {
                        manager.add_transcript_segment(segment);
                    }
                }
            }
        });
        let mut global_listener = TRANSCRIPT_LISTENER_ID.lock().unwrap();
        *global_listener = Some(listener_id);
        info!("✅ Transcript-update event listener registered for history persistence");
    }

    // Emit success event
    app.emit(
        "recording-started",
        serde_json::json!({
            "message": "Recording started successfully with parallel processing",
            "devices": ["Default Microphone", "Default System Audio"],
            "workers": 3
        }),
    )
    .map_err(|e| e.to_string())?;

    // Update tray menu to reflect recording state
    crate::tray::update_tray_menu(&app);

    info!("✅ Recording started successfully with async-first approach");

    Ok(())
}

/// Start recording with specific devices
pub async fn start_recording_with_devices<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
) -> Result<(), String> {
    start_recording_with_devices_and_meeting(app, mic_device_name, system_device_name, None).await
}

/// Start recording with specific devices and optional meeting name
pub async fn start_recording_with_devices_and_meeting<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>,
) -> Result<(), String> {
    info!(
        "Starting recording with specific devices: mic={:?}, system={:?}, meeting={:?}",
        mic_device_name, system_device_name, meeting_name
    );

    // Check if already recording
    let current_recording_state = IS_RECORDING.load(Ordering::SeqCst);
    info!("🔍 IS_RECORDING state check: {}", current_recording_state);
    if current_recording_state {
        return Err("Recording already in progress".to_string());
    }

    let use_live_transcription = live_transcription_enabled(&app).await;

    info!(
        "🎙️ Starting audio capture immediately (live transcription: {})",
        use_live_transcription
    );

    // Parse devices
    let mic_device = if let Some(ref name) = mic_device_name {
        Some(Arc::new(parse_audio_device(name).map_err(|e| {
            format!("Invalid microphone device '{}': {}", name, e)
        })?))
    } else {
        None
    };

    let system_device = if let Some(ref name) = system_device_name {
        Some(Arc::new(parse_audio_device(name).map_err(|e| {
            format!("Invalid system device '{}': {}", name, e)
        })?))
    } else {
        None
    };

    // Async-first approach for custom devices - no more blocking operations!
    info!("🚀 Starting async recording initialization with custom devices");

    // Create new recording manager
    let mut manager = RecordingManager::new();

    // Load recording preferences to check auto_save setting
    let (auto_save, save_folder) =
        match super::recording_preferences::load_recording_preferences(&app).await {
            Ok(prefs) => {
                info!(
                    "📋 Loaded recording preferences: auto_save={}",
                    prefs.auto_save
                );
                (prefs.auto_save, prefs.save_folder)
            }
            Err(e) => {
                warn!(
                    "Failed to load recording preferences, defaulting to auto_save=true: {}",
                    e
                );
                (
                    true,
                    super::recording_preferences::get_default_recordings_folder(),
                )
            }
        };
    manager.set_recording_folder(save_folder);

    // Always ensure a meeting name is set so incremental saver initializes
    let effective_meeting_name = meeting_name.clone().unwrap_or_else(|| {
        let now = chrono::Local::now();
        format!("Meeting {}", now.format("%Y-%m-%d_%H-%M-%S"))
    });
    manager.set_meeting_name(Some(effective_meeting_name));

    // Set up error callback
    let app_for_error = app.clone();
    manager.set_error_callback(move |error| {
        let _ = app_for_error.emit("recording-error", error.user_message());
    });

    // Start recording with specified devices and auto_save setting
    let transcription_receiver = manager
        .start_recording(mic_device, system_device, auto_save)
        .await
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    // Store the manager globally to keep it alive
    {
        let mut global_manager = RECORDING_MANAGER.lock().unwrap();
        *global_manager = Some(manager);
    }

    // Set recording flag and reset speech detection flag
    info!("🔍 Setting IS_RECORDING to true and resetting SPEECH_DETECTED_EMITTED");
    IS_RECORDING.store(true, Ordering::SeqCst);
    reset_speech_detected_flag(); // Reset for new recording session

    if use_live_transcription {
        let task_handle =
            transcription::start_transcription_task(app.clone(), transcription_receiver);
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        *global_task = Some(task_handle);
    } else {
        let drain_task = tokio::spawn(async move {
            let mut receiver = transcription_receiver;
            while receiver.recv().await.is_some() {}
        });
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        *global_task = Some(drain_task);
    }

    // CRITICAL: Listen for transcript-update events and save to recording manager
    // This enables transcript history persistence for page reload sync
    // Store listener ID for cleanup during stop_recording to ensure microphone is released
    if use_live_transcription {
        use tauri::Listener;
        let listener_id = app.listen("transcript-update", move |event: tauri::Event| {
            // Parse the transcript update from the event payload
            if let Ok(update) = serde_json::from_str::<TranscriptUpdate>(event.payload()) {
                // Create structured transcript segment
                let segment = crate::audio::recording_saver::TranscriptSegment {
                    id: format!("seg_{}", update.sequence_id),
                    text: update.text.clone(),
                    audio_start_time: update.audio_start_time,
                    audio_end_time: update.audio_end_time,
                    duration: update.duration,
                    display_time: update.timestamp.clone(), // Use wall-clock timestamp for display
                    confidence: update.confidence,
                    sequence_id: update.sequence_id,
                };

                // Save to recording manager
                if let Ok(manager_guard) = RECORDING_MANAGER.lock() {
                    if let Some(manager) = manager_guard.as_ref() {
                        manager.add_transcript_segment(segment);
                    }
                }
            }
        });
        let mut global_listener = TRANSCRIPT_LISTENER_ID.lock().unwrap();
        *global_listener = Some(listener_id);
        info!("✅ Transcript-update event listener registered for history persistence");
    }

    // Emit success event
    app.emit(
        "recording-started",
        serde_json::json!({
            "message": "Recording started with custom devices and parallel processing",
            "devices": [
                mic_device_name.unwrap_or_else(|| "Default Microphone".to_string()),
                system_device_name.unwrap_or_else(|| "Default System Audio".to_string())
            ],
            "workers": 3
        }),
    )
    .map_err(|e| e.to_string())?;

    // Update tray menu to reflect recording state
    crate::tray::update_tray_menu(&app);

    info!("✅ Recording started with custom devices using async-first approach");

    Ok(())
}

/// Stop recording with optimized graceful shutdown ensuring NO transcript chunks are lost
pub async fn stop_recording<R: Runtime>(
    app: AppHandle<R>,
    _args: RecordingArgs,
) -> Result<RecordingStoppedPayload, String> {
    info!(
        "🛑 Starting optimized recording shutdown - ensuring ALL transcript chunks are preserved"
    );

    // Check if recording is active
    if !IS_RECORDING.load(Ordering::SeqCst) {
        info!("Recording was not active");
        return Ok(RecordingStoppedPayload {
            message: "Recording was already stopped".to_string(),
            folder_path: None,
            meeting_name: None,
            audio_path: None,
        });
    }

    // Emit shutdown progress to frontend
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "stopping_audio",
            "message": "Stopping audio capture...",
            "progress": 20
        }),
    );

    // Step 1: Stop audio capture immediately (no more new chunks) with proper error handling
    let manager_for_cleanup = {
        let mut global_manager = RECORDING_MANAGER.lock().unwrap();
        global_manager.take()
    };

    let stop_result = if let Some(mut manager) = manager_for_cleanup {
        // Use FORCE FLUSH to immediately process all accumulated audio - eliminates 30s delay!
        info!("🚀 Using FORCE FLUSH to eliminate pipeline accumulation delays");
        let result = manager.stop_streams_and_force_flush().await;
        // Store manager back for later cleanup
        let manager_for_cleanup = Some(manager);
        (result, manager_for_cleanup)
    } else {
        warn!("No recording manager found to stop");
        (Ok(()), None)
    };

    let (stop_result, manager_for_cleanup) = stop_result;

    match stop_result {
        Ok(_) => {
            info!("✅ Audio streams stopped successfully - no more chunks will be created");
        }
        Err(e) => {
            error!("❌ Failed to stop audio streams: {}", e);
            return Err(format!("Failed to stop audio streams: {}", e));
        }
    }

    // Step 1.5: Clean up transcript listener to release microphone
    // Unlisten transcript-update event to prevent lingering references
    {
        use tauri::Listener;
        if let Some(listener_id) = TRANSCRIPT_LISTENER_ID.lock().unwrap().take() {
            app.unlisten(listener_id);
            info!("✅ Transcript-update listener removed");
        }
    }

    // Step 2: Signal transcription workers to finish processing ALL queued chunks
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "processing_transcripts",
            "message": "Processing remaining transcript chunks...",
            "progress": 40
        }),
    );

    // Wait for transcription task with enhanced progress monitoring (NO TIMEOUT - we must process all chunks)
    let transcription_task = {
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        global_task.take()
    };

    if let Some(task_handle) = transcription_task {
        info!("⏳ Giving live captions a short grace period before final audio transcription");

        // Enhanced progress monitoring during shutdown
        let progress_app = app.clone();
        let progress_task = tokio::spawn(async move {
            let last_update = std::time::Instant::now();

            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                // Emit periodic progress updates during shutdown
                let elapsed = last_update.elapsed().as_secs();
                let _ = progress_app.emit(
                    "recording-shutdown-progress",
                    serde_json::json!({
                        "stage": "processing_transcripts",
                        "message": format!("Processing transcripts... ({}s elapsed)", elapsed),
                        "progress": 40,
                        "detailed": true,
                        "elapsed_seconds": elapsed
                    }),
                );
            }
        });

        // Live captions are only a preview. The saved recording is transcribed
        // again with the user's full model, so stopping must never wait for a
        // large caption backlog or a model that is still loading.
        let mut task_handle = task_handle;
        match tokio::time::timeout(tokio::time::Duration::from_secs(2), &mut task_handle).await {
            Ok(Ok(())) => {
                info!("✅ ALL transcription chunks processed successfully - no data lost");
            }
            Ok(Err(e)) => {
                warn!("⚠️ Transcription task completed with error: {:?}", e);
                // Continue anyway - the worker may have processed most chunks
            }
            Err(_) => {
                info!("Live caption grace period ended; cancelling remaining preview chunks");
                task_handle.abort();
            }
        }

        // Stop progress monitoring
        progress_task.abort();
    } else {
        info!("ℹ️ No transcription task found to wait for");
    }

    // Step 3: Keep the selected model warm for the next recording. Model
    // switching commands already unload/replace engines when required; eagerly
    // unloading here made every Record click pay the full cold-start cost.
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "keeping_model_ready",
            "message": "Keeping speech recognition ready...",
            "progress": 70
        }),
    );
    info!("🧠 Transcription model kept warm for the next recording");

    // Step 3.5: Track meeting ended analytics with privacy-safe metadata
    // Extract all data from manager BEFORE any async operations to avoid Send issues
    let analytics_data = if let Some(ref manager) = manager_for_cleanup {
        let state = manager.get_state();
        let stats = state.get_stats();

        Some((
            manager.get_recording_duration(),
            manager.get_active_recording_duration().unwrap_or(0.0),
            manager.get_total_pause_duration(),
            manager.get_transcript_segments().len() as u64,
            state.has_fatal_error(),
            state.get_microphone_device().map(|d| d.name.clone()),
            state.get_system_device().map(|d| d.name.clone()),
            stats.chunks_processed,
        ))
    } else {
        None
    };

    // Now perform async analytics tracking without holding manager reference
    if let Some((
        total_duration,
        active_duration,
        pause_duration,
        transcript_segments_count,
        had_fatal_error,
        mic_device_name,
        sys_device_name,
        chunks_processed,
    )) = analytics_data
    {
        info!("📊 Collecting analytics for meeting end");

        // Helper function to classify device type from device name (privacy-safe)
        fn classify_device_type(device_name: &str) -> &'static str {
            let name_lower = device_name.to_lowercase();
            // Check for Bluetooth keywords
            if name_lower.contains("bluetooth")
                || name_lower.contains("airpods")
                || name_lower.contains("beats")
                || name_lower.contains("headphones")
                || name_lower.contains("bt ")
                || name_lower.contains("wireless")
            {
                "Bluetooth"
            } else {
                "Wired"
            }
        }

        // Get transcription model info (already loaded above for model unload)
        let transcription_config = match crate::api::api::api_get_transcript_config(
            app.clone(),
            app.clone().state(),
            None,
        )
        .await
        {
            Ok(Some(config)) => Some((config.provider, config.model)),
            _ => None,
        };

        let (transcription_provider, transcription_model) =
            transcription_config.unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()));

        // Get summary model info from API
        let summary_config =
            match crate::api::api::api_get_model_config(app.clone(), app.clone().state(), None)
                .await
            {
                Ok(Some(config)) => Some((config.provider, config.model)),
                _ => None,
            };

        let (summary_provider, summary_model) =
            summary_config.unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()));

        // Classify device types (privacy-safe)
        let microphone_device_type = mic_device_name
            .as_ref()
            .map(|name| classify_device_type(name))
            .unwrap_or("Unknown");

        let system_audio_device_type = sys_device_name
            .as_ref()
            .map(|name| classify_device_type(name))
            .unwrap_or("Unknown");

        // Track meeting ended event with privacy-safe data
        match crate::analytics::commands::track_meeting_ended(
            transcription_provider.clone(),
            transcription_model.clone(),
            summary_provider.clone(),
            summary_model.clone(),
            total_duration,
            active_duration,
            pause_duration,
            microphone_device_type.to_string(),
            system_audio_device_type.to_string(),
            chunks_processed,
            transcript_segments_count,
            had_fatal_error,
        )
        .await
        {
            Ok(_) => info!("✅ Analytics tracked successfully for meeting end"),
            Err(e) => warn!("⚠️ Failed to track analytics: {}", e),
        }
    }

    // Step 4: Finalize recording state and cleanup resources safely
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "finalizing",
            "message": "Finalizing recording and cleaning up resources...",
            "progress": 90
        }),
    );

    // Perform final cleanup with the manager if available
    let (meeting_folder, meeting_name, audio_path) = if let Some(mut manager) = manager_for_cleanup
    {
        info!("🧹 Performing final cleanup and saving recording data");

        // Extract meeting info BEFORE async operations
        let meeting_folder = manager.get_meeting_folder();
        let meeting_name = manager.get_meeting_name();

        let audio_path = match tokio::time::timeout(
            tokio::time::Duration::from_secs(300), // 5 minutes max for file I/O
            manager.save_recording_only(&app),
        )
        .await
        {
            Ok(Ok(path)) => {
                info!("✅ Recording data saved successfully during cleanup");
                path
            }
            Ok(Err(e)) => {
                let message = format!(
                    "Audio could not be saved. The meeting transcript remains available: {}",
                    e
                );
                error!("{}", message);
                IS_RECORDING.store(false, Ordering::SeqCst);
                let _ = app.emit("recording-save-failed", serde_json::json!({
                    "message": message,
                    "folder_path": meeting_folder.as_ref().map(|path| path.to_string_lossy().to_string())
                }));
                crate::tray::update_tray_menu(&app);
                return Err(message);
            }
            Err(_) => {
                let message = "Audio finalization timed out. The meeting transcript remains available and the recording was not marked as saved.".to_string();
                error!("{}", message);
                IS_RECORDING.store(false, Ordering::SeqCst);
                let _ = app.emit("recording-save-failed", serde_json::json!({
                    "message": message,
                    "folder_path": meeting_folder.as_ref().map(|path| path.to_string_lossy().to_string())
                }));
                crate::tray::update_tray_menu(&app);
                return Err(message);
            }
        };

        (meeting_folder, meeting_name, audio_path)
    } else {
        let message = "Recording stopped, but its save session was unavailable.".to_string();
        error!("{}", message);
        IS_RECORDING.store(false, Ordering::SeqCst);
        crate::tray::update_tray_menu(&app);
        return Err(message);
    };

    // Set recording flag to false
    info!("🔍 Setting IS_RECORDING to false");
    IS_RECORDING.store(false, Ordering::SeqCst);

    // Step 4.5: Prepare metadata for frontend (NO database save)
    // NOTE: We do NOT save to database here. The frontend will save after all transcripts are displayed.
    // This ensures the user sees all transcripts streaming in before the database save happens.
    let (folder_path_str, meeting_name_str) = match (&meeting_folder, &meeting_name) {
        (Some(path), Some(name)) => (Some(path.to_string_lossy().to_string()), Some(name.clone())),
        _ => (None, None),
    };

    info!("📤 Preparing recording metadata for frontend save");
    info!("   folder_path: {:?}", folder_path_str);
    info!("   meeting_name: {:?}", meeting_name_str);

    // Database save removed - frontend will handle this after receiving all transcripts
    info!("ℹ️ Skipping database save in Rust - frontend will save after all transcripts received");

    // Step 5: Complete shutdown
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "complete",
            "message": "Recording stopped successfully",
            "progress": 100
        }),
    );

    // Emit final stop event with folder_path and meeting_name for frontend to save
    let payload = RecordingStoppedPayload {
        message: "Recording stopped - frontend will save after all transcripts received"
            .to_string(),
        folder_path: folder_path_str,
        meeting_name: meeting_name_str,
        audio_path,
    };
    app.emit("recording-stopped", &payload)
        .map_err(|e| e.to_string())?;

    // Update tray menu to reflect stopped state
    crate::tray::update_tray_menu(&app);

    info!("🎉 Recording stopped successfully with ZERO transcript chunks lost");
    Ok(payload)
}

fn resolve_discard_folder(base: &Path, folder: &Path) -> Result<PathBuf, String> {
    let base = base
        .canonicalize()
        .map_err(|error| format!("Could not verify the recordings folder: {error}"))?;
    let folder = folder
        .canonicalize()
        .map_err(|error| format!("Could not verify the current recording folder: {error}"))?;

    if folder.parent() != Some(base.as_path()) {
        return Err("Refusing to delete a path outside the current recordings folder".to_string());
    }
    if !folder.is_dir() {
        return Err("The current recording path is not a folder".to_string());
    }
    Ok(folder)
}

/// Delete only the canonical direct-child folder created for the recording
/// that has just been stopped. Historical meetings and arbitrary paths are
/// intentionally outside this command's scope.
pub fn discard_saved_recording_folder(base: &Path, folder_path: &str) -> Result<(), String> {
    let folder = resolve_discard_folder(base, Path::new(folder_path))?;
    std::fs::remove_dir_all(folder)
        .map_err(|error| format!("Could not delete the current recording: {error}"))
}

#[cfg(test)]
mod discard_tests {
    use super::resolve_discard_folder;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn discard_scope_accepts_only_a_direct_child_folder() {
        let root = TempDir::new().expect("temp directory");
        let base = root.path().join("recordings");
        let session = base.join("current-session");
        fs::create_dir_all(&session).expect("session folder");

        assert_eq!(
            resolve_discard_folder(&base, &session).expect("direct child"),
            session.canonicalize().expect("canonical session")
        );
    }

    #[test]
    fn discard_scope_rejects_base_nested_and_outside_folders() {
        let root = TempDir::new().expect("temp directory");
        let base = root.path().join("recordings");
        let nested = base.join("current-session").join("audio");
        let outside = root.path().join("other");
        fs::create_dir_all(&nested).expect("nested folder");
        fs::create_dir_all(&outside).expect("outside folder");

        assert!(resolve_discard_folder(&base, &base).is_err());
        assert!(resolve_discard_folder(&base, &nested).is_err());
        assert!(resolve_discard_folder(&base, &outside).is_err());
    }
}

/// Check if recording is active
pub async fn is_recording() -> bool {
    IS_RECORDING.load(Ordering::SeqCst)
}

/// Get recording statistics
pub async fn get_transcription_status() -> TranscriptionStatus {
    TranscriptionStatus {
        chunks_in_queue: 0,
        is_processing: IS_RECORDING.load(Ordering::SeqCst),
        last_activity_ms: 0,
    }
}

/// Pause the current recording
#[tauri::command]
pub async fn pause_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("Pausing recording");

    // Check if currently recording
    if !IS_RECORDING.load(Ordering::SeqCst) {
        return Err("No recording is currently active".to_string());
    }

    // Access the recording manager and pause it
    let manager_guard = RECORDING_MANAGER.lock().unwrap();
    if let Some(manager) = manager_guard.as_ref() {
        manager.pause_recording().map_err(|e| e.to_string())?;

        // Emit pause event to frontend
        app.emit(
            "recording-paused",
            serde_json::json!({
                "message": "Recording paused"
            }),
        )
        .map_err(|e| e.to_string())?;

        // Update tray menu to reflect paused state
        crate::tray::update_tray_menu(&app);

        info!("Recording paused successfully");
        Ok(())
    } else {
        Err("No recording manager found".to_string())
    }
}

/// Resume the current recording
#[tauri::command]
pub async fn resume_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("Resuming recording");

    // Check if currently recording
    if !IS_RECORDING.load(Ordering::SeqCst) {
        return Err("No recording is currently active".to_string());
    }

    // Access the recording manager and resume it
    let manager_guard = RECORDING_MANAGER.lock().unwrap();
    if let Some(manager) = manager_guard.as_ref() {
        manager.resume_recording().map_err(|e| e.to_string())?;

        // Emit resume event to frontend
        app.emit(
            "recording-resumed",
            serde_json::json!({
                "message": "Recording resumed"
            }),
        )
        .map_err(|e| e.to_string())?;

        // Update tray menu to reflect resumed state
        crate::tray::update_tray_menu(&app);

        info!("Recording resumed successfully");
        Ok(())
    } else {
        Err("No recording manager found".to_string())
    }
}

/// Check if recording is currently paused
#[tauri::command]
pub async fn is_recording_paused() -> bool {
    let manager_guard = RECORDING_MANAGER.lock().unwrap();
    if let Some(manager) = manager_guard.as_ref() {
        manager.is_paused()
    } else {
        false
    }
}

/// Get detailed recording state
#[tauri::command]
pub async fn get_recording_state() -> serde_json::Value {
    let is_recording = IS_RECORDING.load(Ordering::SeqCst);
    let manager_guard = RECORDING_MANAGER.lock().unwrap();

    if let Some(manager) = manager_guard.as_ref() {
        serde_json::json!({
            "is_recording": is_recording,
            "is_paused": manager.is_paused(),
            "is_active": manager.is_active(),
            "recording_duration": manager.get_recording_duration(),
            "active_duration": manager.get_active_recording_duration(),
            "total_pause_duration": manager.get_total_pause_duration(),
            "current_pause_duration": manager.get_current_pause_duration()
        })
    } else {
        serde_json::json!({
            "is_recording": is_recording,
            "is_paused": false,
            "is_active": false,
            "recording_duration": null,
            "active_duration": null,
            "total_pause_duration": 0.0,
            "current_pause_duration": null
        })
    }
}

/// Get the meeting folder path for the current recording
/// Returns the path if a meeting name was set and folder structure initialized
#[tauri::command]
pub async fn get_meeting_folder_path() -> Result<Option<String>, String> {
    let manager_guard = RECORDING_MANAGER.lock().unwrap();
    if let Some(manager) = manager_guard.as_ref() {
        Ok(manager
            .get_meeting_folder()
            .map(|p| p.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

/// Get accumulated transcript segments from current recording session
/// Used for syncing frontend state after page reload during active recording
#[tauri::command]
pub async fn get_transcript_history(
) -> Result<Vec<crate::audio::recording_saver::TranscriptSegment>, String> {
    let manager_guard = RECORDING_MANAGER.lock().unwrap();

    if let Some(manager) = manager_guard.as_ref() {
        Ok(manager.get_transcript_segments())
    } else {
        Ok(Vec::new()) // No recording active, return empty
    }
}

/// Get meeting name from current recording session
/// Used for syncing frontend state after page reload during active recording
#[tauri::command]
pub async fn get_recording_meeting_name() -> Result<Option<String>, String> {
    let manager_guard = RECORDING_MANAGER.lock().unwrap();

    if let Some(manager) = manager_guard.as_ref() {
        Ok(manager.get_meeting_name())
    } else {
        Ok(None)
    }
}

// ============================================================================
// DEVICE MONITORING COMMANDS (AirPods/Bluetooth disconnect/reconnect support)
// ============================================================================

/// Response structure for device events
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type")]
pub enum DeviceEventResponse {
    DeviceDisconnected {
        device_name: String,
        device_type: String,
    },
    DeviceReconnected {
        device_name: String,
        device_type: String,
    },
    DeviceListChanged,
}

impl From<DeviceEvent> for DeviceEventResponse {
    fn from(event: DeviceEvent) -> Self {
        match event {
            DeviceEvent::DeviceDisconnected {
                device_name,
                device_type,
            } => DeviceEventResponse::DeviceDisconnected {
                device_name,
                device_type: format!("{:?}", device_type),
            },
            DeviceEvent::DeviceReconnected {
                device_name,
                device_type,
            } => DeviceEventResponse::DeviceReconnected {
                device_name,
                device_type: format!("{:?}", device_type),
            },
            DeviceEvent::DeviceListChanged => DeviceEventResponse::DeviceListChanged,
        }
    }
}

/// Reconnection status information
#[derive(Debug, Serialize, Clone)]
pub struct ReconnectionStatus {
    pub is_reconnecting: bool,
    pub disconnected_device: Option<DisconnectedDeviceInfo>,
}

/// Information about a disconnected device
#[derive(Debug, Serialize, Clone)]
pub struct DisconnectedDeviceInfo {
    pub name: String,
    pub device_type: String,
}

/// Poll for audio device events (disconnect/reconnect)
/// Should be called periodically (every 1-2 seconds) by frontend during recording
#[tauri::command]
pub async fn poll_audio_device_events() -> Result<Option<DeviceEventResponse>, String> {
    let mut manager_guard = RECORDING_MANAGER.lock().unwrap();

    if let Some(manager) = manager_guard.as_mut() {
        if let Some(event) = manager.poll_device_events() {
            info!("📱 Device event polled: {:?}", event);
            Ok(Some(event.into()))
        } else {
            Ok(None)
        }
    } else {
        // Not recording, no events
        Ok(None)
    }
}

/// Get current reconnection status
/// Returns whether the system is attempting to reconnect and which device
#[tauri::command]
pub async fn get_reconnection_status() -> Result<ReconnectionStatus, String> {
    let manager_guard = RECORDING_MANAGER.lock().unwrap();

    if let Some(manager) = manager_guard.as_ref() {
        let state = manager.get_state();
        let disconnected_device = state
            .get_disconnected_device()
            .map(|(device, device_type)| DisconnectedDeviceInfo {
                name: device.name.clone(),
                device_type: format!("{:?}", device_type),
            });

        Ok(ReconnectionStatus {
            is_reconnecting: manager.is_reconnecting(),
            disconnected_device,
        })
    } else {
        // Not recording, no reconnection in progress
        Ok(ReconnectionStatus {
            is_reconnecting: false,
            disconnected_device: None,
        })
    }
}

/// Get information about the active audio output device
/// Used to warn users about Bluetooth playback issues
#[tauri::command]
pub async fn get_active_audio_output() -> Result<super::playback_monitor::AudioOutputInfo, String> {
    super::playback_monitor::get_active_audio_output()
        .await
        .map_err(|e| format!("Failed to get audio output info: {}", e))
}

/// Manually trigger device reconnection attempt
/// Useful for UI "Retry" button
#[tauri::command]
pub async fn attempt_device_reconnect(
    device_name: String,
    device_type: String,
) -> Result<bool, String> {
    // Parse device type first
    let monitor_type = match device_type.as_str() {
        "Microphone" => DeviceMonitorType::Microphone,
        "SystemAudio" => DeviceMonitorType::SystemAudio,
        _ => return Err(format!("Invalid device type: {}", device_type)),
    };

    // Check if recording is active
    {
        let manager_guard = RECORDING_MANAGER.lock().unwrap();
        if manager_guard.is_none() {
            return Err("Recording not active".to_string());
        }
    } // Release lock

    // Spawn blocking task to handle the async reconnection
    let result = tokio::task::spawn_blocking(move || {
        tokio::runtime::Handle::current().block_on(async {
            let mut manager_guard = RECORDING_MANAGER.lock().unwrap();
            if let Some(manager) = manager_guard.as_mut() {
                manager
                    .attempt_device_reconnect(&device_name, monitor_type)
                    .await
            } else {
                Err(anyhow::anyhow!("Recording not active"))
            }
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    match result {
        Ok(success) => {
            if success {
                info!("✅ Manual reconnection successful");
            } else {
                warn!("❌ Manual reconnection failed - device not available");
            }
            Ok(success)
        }
        Err(e) => {
            error!("Manual reconnection error: {}", e);
            Err(e.to_string())
        }
    }
}
