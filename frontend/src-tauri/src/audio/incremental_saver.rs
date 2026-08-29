use super::encode::encode_single_audio;
use super::recording_state::AudioChunk;
use anyhow::{anyhow, Result};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::ffmpeg::find_ffmpeg_path;

const CANONICAL_AUDIO_FILE: &str = "audio.m4a";
const SEGMENTS_DIRECTORY: &str = "audio-segments";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioSegmentEntry {
    file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioManifest {
    version: u32,
    canonical_audio: String,
    container: String,
    codec: String,
    segments: Vec<AudioSegmentEntry>,
    updated_at: String,
}

fn is_checkpoint_audio(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("m4a" | "mp4")
    )
}

fn archived_segments(meeting_folder: &Path) -> Vec<PathBuf> {
    let mut segments = std::fs::read_dir(meeting_folder.join(SEGMENTS_DIRECTORY))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_checkpoint_audio(path))
        .collect::<Vec<_>>();
    segments.sort();
    segments
}

fn concat_file_line(path: &Path) -> Result<String> {
    let canonical = path.canonicalize()?;
    let escaped = canonical.to_string_lossy().replace('\'', "'\\''");
    Ok(format!("file '{}'\n", escaped))
}

fn archive_checkpoints(
    meeting_folder: &Path,
    checkpoints_dir: &Path,
    checkpoint_files: &[PathBuf],
) -> Result<Vec<PathBuf>> {
    let segments_dir = meeting_folder.join(SEGMENTS_DIRECTORY);
    std::fs::create_dir_all(&segments_dir)?;

    let mut next_index = std::fs::read_dir(&segments_dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !is_checkpoint_audio(&path) {
                return None;
            }
            path.file_stem()?
                .to_str()?
                .strip_prefix("segment-")?
                .parse::<usize>()
                .ok()
        })
        .max()
        .map_or(0, |index| index + 1);
    let mut archived = Vec::with_capacity(checkpoint_files.len());

    for source in checkpoint_files {
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("m4a")
            .to_ascii_lowercase();
        let destination = segments_dir.join(format!("segment-{:04}.{}", next_index, extension));
        std::fs::rename(source, &destination)?;
        archived.push(destination);
        next_index += 1;
    }

    let _ = std::fs::remove_file(checkpoints_dir.join("concat_list.txt"));
    // A platform may leave harmless metadata in this private staging folder.
    // The playable segments have already been moved into durable storage.
    std::fs::remove_dir_all(checkpoints_dir)?;
    Ok(archived)
}

fn write_audio_manifest(meeting_folder: &Path) -> Result<()> {
    let segments = archived_segments(meeting_folder);

    let manifest = AudioManifest {
        version: 1,
        canonical_audio: CANONICAL_AUDIO_FILE.to_string(),
        container: "m4a".to_string(),
        codec: "aac".to_string(),
        segments: segments
            .into_iter()
            .filter_map(|path| {
                path.file_name().map(|name| AudioSegmentEntry {
                    file: format!("{}/{}", SEGMENTS_DIRECTORY, name.to_string_lossy()),
                })
            })
            .collect(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    let destination = meeting_folder.join("audio-manifest.json");
    let temporary = meeting_folder.join(".audio-manifest.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(&manifest)?)?;
    std::fs::rename(temporary, destination)?;
    Ok(())
}

/// Audio data without device type (we only store mixed audio)
#[derive(Clone)]
struct AudioData {
    data: Vec<f32>,
    // sample_rate: u32,
}

/// Incremental audio saver that writes checkpoints every 30 seconds
/// to minimize memory usage and enable crash recovery
pub struct IncrementalAudioSaver {
    checkpoint_buffer: Vec<AudioData>,
    checkpoint_interval_samples: usize, // 30s at 48kHz = 1,440,000 samples
    checkpoint_count: u32,
    checkpoints_dir: PathBuf,
    meeting_folder: PathBuf,
    sample_rate: u32,
}

impl IncrementalAudioSaver {
    /// Create a new incremental saver
    ///
    /// # Arguments
    /// * `meeting_folder` - Path to the meeting folder (contains .checkpoints/)
    /// * `sample_rate` - Sample rate of audio (typically 48000)
    pub fn new(meeting_folder: PathBuf, sample_rate: u32) -> Result<Self> {
        let checkpoints_dir = meeting_folder.join(".checkpoints");

        // Verify checkpoints directory exists
        if !checkpoints_dir.exists() {
            return Err(anyhow!(
                "Checkpoints directory does not exist: {}",
                checkpoints_dir.display()
            ));
        }

        Ok(Self {
            checkpoint_buffer: Vec::new(),
            checkpoint_interval_samples: sample_rate as usize * 30, // 30 seconds
            checkpoint_count: 0,
            checkpoints_dir,
            meeting_folder,
            sample_rate,
        })
    }

    /// Add an audio chunk to the buffer
    /// Automatically saves a checkpoint when buffer reaches 30 seconds
    pub fn add_chunk(&mut self, chunk: AudioChunk) -> Result<()> {
        let audio_data = AudioData {
            data: chunk.data,
            // sample_rate: chunk.sample_rate,
        };

        self.checkpoint_buffer.push(audio_data);

        // Calculate total samples in buffer
        let total_samples: usize = self.checkpoint_buffer.iter().map(|c| c.data.len()).sum();

        // Save checkpoint when buffer reaches threshold (30 seconds)
        if total_samples >= self.checkpoint_interval_samples {
            self.save_checkpoint()?;
            self.checkpoint_buffer.clear();
        }

        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn buffered_sample_count(&self) -> usize {
        self.checkpoint_buffer
            .iter()
            .map(|chunk| chunk.data.len())
            .sum()
    }

    /// Save current buffer as a checkpoint file
    fn save_checkpoint(&mut self) -> Result<()> {
        // Concatenate all chunks in buffer
        let audio_data: Vec<f32> = self
            .checkpoint_buffer
            .iter()
            .flat_map(|c| &c.data)
            .cloned()
            .collect();

        if audio_data.is_empty() {
            warn!("Attempted to save empty checkpoint, skipping");
            return Ok(());
        }

        // Generate checkpoint filename
        let checkpoint_path = self
            .checkpoints_dir
            .join(format!("audio_chunk_{:03}.m4a", self.checkpoint_count));

        // Encode and save checkpoint
        encode_single_audio(
            bytemuck::cast_slice(&audio_data),
            self.sample_rate,
            1, // mono
            &checkpoint_path,
        )?;

        let duration_seconds = audio_data.len() as f32 / self.sample_rate as f32;
        self.checkpoint_count += 1;

        info!(
            "Saved checkpoint {}: {:.2}s of audio ({} samples)",
            self.checkpoint_count,
            duration_seconds,
            audio_data.len()
        );

        Ok(())
    }

    /// Finalize the recording: save final checkpoint, merge all checkpoints, cleanup
    ///
    /// Returns the path to the canonical, seekable audio.m4a file. Individual
    /// segments remain available for recovery and future continuation.
    pub async fn finalize(&mut self) -> Result<PathBuf> {
        info!("Finalizing incremental recording...");

        // Save final buffer if not empty
        if !self.checkpoint_buffer.is_empty() {
            info!(
                "Saving final checkpoint with remaining {} chunks",
                self.checkpoint_buffer.len()
            );
            self.save_checkpoint()?;
            self.checkpoint_buffer.clear();
        }

        if self.checkpoint_count == 0 {
            return Err(anyhow!(
                "No audio checkpoints to merge - recording may have failed"
            ));
        }

        // Merge all checkpoints using FFmpeg concat
        let final_audio_path = self.meeting_folder.join(CANONICAL_AUDIO_FILE);
        let staged_audio_path = self.meeting_folder.join(".audio-finalizing.m4a");
        let _ = std::fs::remove_file(&staged_audio_path);
        self.merge_checkpoints(&staged_audio_path).await?;
        std::fs::rename(&staged_audio_path, &final_audio_path)?;

        let checkpoint_files = (0..self.checkpoint_count)
            .map(|index| {
                self.checkpoints_dir
                    .join(format!("audio_chunk_{:03}.m4a", index))
            })
            .collect::<Vec<_>>();
        archive_checkpoints(
            &self.meeting_folder,
            &self.checkpoints_dir,
            &checkpoint_files,
        )?;
        write_audio_manifest(&self.meeting_folder)?;

        info!("Finalized recording: {}", final_audio_path.display());

        Ok(final_audio_path)
    }

    /// Merge all checkpoint files into a seekable M4A using FFmpeg concat.
    /// Uses concat demuxer for fast merging without re-encoding
    async fn merge_checkpoints(&self, output: &PathBuf) -> Result<()> {
        info!(
            "Merging {} checkpoints into final audio file...",
            self.checkpoint_count
        );

        // Create concat list file for FFmpeg
        let list_file = self.checkpoints_dir.join("concat_list.txt");
        let mut list_content = String::new();

        // A future/continued recording reuses the durable segment list. This
        // keeps the canonical playback copy ordered across recording sessions.
        for segment in archived_segments(&self.meeting_folder) {
            list_content.push_str(&concat_file_line(&segment)?);
        }

        for i in 0..self.checkpoint_count {
            let checkpoint_path = self
                .checkpoints_dir
                .join(format!("audio_chunk_{:03}.m4a", i));

            // Verify checkpoint exists
            if !checkpoint_path.exists() {
                return Err(anyhow!(
                    "Checkpoint file missing: {}",
                    checkpoint_path.display()
                ));
            }

            // Use an absolute, concat-demuxer-safe path.
            list_content.push_str(&concat_file_line(&checkpoint_path)?);
        }

        std::fs::write(&list_file, list_content)?;

        let ffmpeg_path = find_ffmpeg_path().ok_or_else(|| {
            anyhow!("FFmpeg not found. Please install FFmpeg to finalize recordings.")
        })?;
        info!("Using FFmpeg at: {:?}", ffmpeg_path);

        // Run FFmpeg concat command
        // Using concat demuxer with copy codec for fast merging (no re-encoding)

        let mut command = std::process::Command::new(ffmpeg_path);

        command.args(&[
            "-f",
            "concat", // Use concat demuxer
            "-safe",
            "0", // Allow absolute paths
            "-i",
            list_file.to_str().unwrap(),
            "-c",
            "copy", // Copy codec - no re-encoding!
            "-movflags",
            "+faststart", // Put the seek index at the start for WebView/QuickTime.
            "-avoid_negative_ts",
            "make_zero",
            "-y", // Overwrite output file
            output.to_str().unwrap(),
        ]);

        // Hide console window on Windows to prevent CMD popup during finalization
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let ffmpeg_output = command.output()?;

        if !ffmpeg_output.status.success() {
            let stderr = String::from_utf8_lossy(&ffmpeg_output.stderr);
            error!("FFmpeg merge failed: {}", stderr);
            return Err(anyhow!("FFmpeg concat failed: {}", stderr));
        }

        // Verify output file was created
        if !output.exists() {
            return Err(anyhow!(
                "Merged audio file was not created: {}",
                output.display()
            ));
        }

        info!(
            "Successfully merged {} checkpoints → {}",
            self.checkpoint_count,
            output.display()
        );

        Ok(())
    }

    /// Get the meeting folder path
    pub fn get_meeting_folder(&self) -> &PathBuf {
        &self.meeting_folder
    }

    /// Get current checkpoint count
    pub fn get_checkpoint_count(&self) -> u32 {
        self.checkpoint_count
    }
}

/// Audio recovery status for transcript recovery feature
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioRecoveryStatus {
    pub status: String, // "success" | "partial" | "failed" | "none"
    pub chunk_count: u32,
    pub estimated_duration_seconds: f64,
    pub audio_file_path: Option<String>,
    pub message: String,
}

/// Recover audio from checkpoint files
/// This is called by the transcript recovery system to merge audio chunks after a crash
#[tauri::command]
pub async fn recover_audio_from_checkpoints(
    meeting_folder: String,
    _sample_rate: u32,
) -> Result<AudioRecoveryStatus, String> {
    info!("Starting audio recovery for folder: {}", meeting_folder);

    let folder_path = PathBuf::from(&meeting_folder);
    let checkpoints_dir = folder_path.join(".checkpoints");

    // Check if checkpoints directory exists
    if !checkpoints_dir.exists() {
        info!(
            "No checkpoints directory found at: {}",
            checkpoints_dir.display()
        );
        return Ok(AudioRecoveryStatus {
            status: "none".to_string(),
            chunk_count: 0,
            estimated_duration_seconds: 0.0,
            audio_file_path: None,
            message: "No audio checkpoints found".to_string(),
        });
    }

    // Scan for checkpoint files
    let mut checkpoint_files: Vec<_> = std::fs::read_dir(&checkpoints_dir)
        .map_err(|e| format!("Failed to read checkpoints directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| is_checkpoint_audio(&entry.path()))
        .collect();

    if checkpoint_files.is_empty() {
        info!(
            "No checkpoint files found in: {}",
            checkpoints_dir.display()
        );
        return Ok(AudioRecoveryStatus {
            status: "none".to_string(),
            chunk_count: 0,
            estimated_duration_seconds: 0.0,
            audio_file_path: None,
            message: "No audio checkpoint files found".to_string(),
        });
    }

    // Sort by filename (audio_chunk_000.m4a, audio_chunk_001.m4a, etc.)
    checkpoint_files.sort_by_key(|entry| entry.path());

    let chunk_count = checkpoint_files.len() as u32;
    let estimated_duration = (chunk_count as f64) * 30.0; // 30 seconds per chunk

    info!(
        "Found {} checkpoint files, estimated duration: {:.2}s",
        chunk_count, estimated_duration
    );

    // Create FFmpeg concat file
    let concat_file_path = checkpoints_dir.join("concat_list.txt");
    let mut concat_content = String::new();

    for segment in archived_segments(&folder_path) {
        concat_content.push_str(
            &concat_file_line(&segment)
                .map_err(|e| format!("Failed to prepare existing segment: {}", e))?,
        );
    }
    for entry in &checkpoint_files {
        concat_content.push_str(
            &concat_file_line(&entry.path())
                .map_err(|e| format!("Failed to prepare checkpoint: {}", e))?,
        );
    }

    std::fs::write(&concat_file_path, concat_content)
        .map_err(|e| format!("Failed to write concat file: {}", e))?;

    // Run FFmpeg to merge chunks
    let output_path = folder_path.join(CANONICAL_AUDIO_FILE);
    let staged_output_path = folder_path.join(".audio-recovery.m4a");
    let _ = std::fs::remove_file(&staged_output_path);
    let staged_output_path_str = staged_output_path
        .to_str()
        .ok_or("Invalid output path")?
        .to_string();
    let output_path_str = output_path
        .to_str()
        .ok_or("Invalid output path")?
        .to_string();

    let ffmpeg_path = find_ffmpeg_path()
        .ok_or_else(|| "FFmpeg not found. Please install FFmpeg to recover audio.".to_string())?;
    info!("Using FFmpeg at: {:?}", ffmpeg_path);

    let mut command = std::process::Command::new(ffmpeg_path);

    command.args(&[
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concat_file_path.to_str().unwrap(),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-avoid_negative_ts",
        "make_zero",
        "-y", // Overwrite if exists
        &staged_output_path_str,
    ]);

    // Hide console window on Windows
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let ffmpeg_result = command.output();

    match ffmpeg_result {
        Ok(output) if output.status.success() => {
            if let Err(error) = std::fs::rename(&staged_output_path, &output_path) {
                return Ok(AudioRecoveryStatus {
                    status: "failed".to_string(),
                    chunk_count,
                    estimated_duration_seconds: estimated_duration,
                    audio_file_path: None,
                    message: format!("Recovered audio could not be activated: {}", error),
                });
            }
            if let Err(error) = archive_checkpoints(
                &folder_path,
                &checkpoints_dir,
                &checkpoint_files
                    .iter()
                    .map(|entry| entry.path())
                    .collect::<Vec<_>>(),
            )
            .and_then(|_| write_audio_manifest(&folder_path))
            {
                return Ok(AudioRecoveryStatus {
                    status: "partial".to_string(),
                    chunk_count,
                    estimated_duration_seconds: estimated_duration,
                    audio_file_path: Some(output_path_str),
                    message: format!(
                        "Audio recovered, but segment metadata could not be finalized: {}",
                        error
                    ),
                });
            }

            info!("Successfully recovered audio: {}", output_path_str);

            Ok(AudioRecoveryStatus {
                status: "success".to_string(),
                chunk_count,
                estimated_duration_seconds: estimated_duration,
                audio_file_path: Some(output_path_str),
                message: format!("Successfully recovered {} audio chunks", chunk_count),
            })
        }
        Ok(output) => {
            let error = String::from_utf8_lossy(&output.stderr);
            error!("FFmpeg recovery failed: {}", error);
            Ok(AudioRecoveryStatus {
                status: "failed".to_string(),
                chunk_count,
                estimated_duration_seconds: estimated_duration,
                audio_file_path: None,
                message: format!("FFmpeg failed: {}", error),
            })
        }
        Err(e) => {
            error!("Failed to run FFmpeg: {}", e);
            Ok(AudioRecoveryStatus {
                status: "failed".to_string(),
                chunk_count,
                estimated_duration_seconds: estimated_duration,
                audio_file_path: None,
                message: format!("Failed to run FFmpeg: {}", e),
            })
        }
    }
}

/// Clean up checkpoint files after successful recording or recovery
/// This command is called by the frontend after successful save to clean up checkpoint files
#[tauri::command]
pub async fn cleanup_checkpoints(meeting_folder: String) -> Result<(), String> {
    info!("Cleaning up checkpoints for folder: {}", meeting_folder);

    let folder_path = PathBuf::from(&meeting_folder);
    let checkpoints_dir = folder_path.join(".checkpoints");

    if checkpoints_dir.exists() {
        std::fs::remove_dir_all(&checkpoints_dir)
            .map_err(|e| format!("Failed to remove checkpoints directory: {}", e))?;
        info!("Successfully cleaned up checkpoints directory");
    } else {
        info!("No checkpoints directory to clean up");
    }

    Ok(())
}

/// Check if a meeting folder has audio checkpoint files
/// Returns true if .checkpoints/ contains legacy MP4 or current M4A files.
#[tauri::command]
pub async fn has_audio_checkpoints(meeting_folder: String) -> Result<bool, String> {
    let folder_path = PathBuf::from(&meeting_folder);
    let checkpoints_dir = folder_path.join(".checkpoints");

    // Check if checkpoints directory exists
    if !checkpoints_dir.exists() {
        return Ok(false);
    }

    let has_audio_files = std::fs::read_dir(&checkpoints_dir)
        .map_err(|e| format!("Failed to read checkpoints directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .any(|entry| is_checkpoint_audio(&entry.path()));

    Ok(has_audio_files)
}

#[cfg(test)]
mod tests {
    use super::super::recording_state::DeviceType;
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_checkpoint_creation() {
        // Create temp meeting folder
        let temp_dir = tempdir().unwrap();
        let meeting_folder = temp_dir.path().join("Test_Meeting");
        std::fs::create_dir_all(&meeting_folder).unwrap();
        std::fs::create_dir_all(meeting_folder.join(".checkpoints")).unwrap();

        let mut saver = IncrementalAudioSaver::new(meeting_folder.clone(), 48000).unwrap();

        // Add 60 seconds worth of audio (should create 2 checkpoints)
        for i in 0..120 {
            // 120 chunks of 0.5s each
            let chunk = AudioChunk {
                data: vec![0.5f32; 24000], // 0.5s at 48kHz
                sample_rate: 48000,
                timestamp: i as f64 * 0.5, // timestamp in seconds
                chunk_id: i as u64,
                device_type: DeviceType::Microphone,
            };
            saver.add_chunk(chunk).unwrap();
        }

        // Verify 2 checkpoints created
        assert_eq!(saver.checkpoint_count, 2);

        // Finalize and verify merge
        let final_path = saver.finalize().await.unwrap();
        assert!(final_path.exists());
        assert_eq!(final_path.file_name().unwrap(), "audio.m4a");

        // Verify recoverable source segments and their manifest are retained.
        assert!(!meeting_folder.join(".checkpoints").exists());
        assert!(meeting_folder
            .join("audio-segments/segment-0000.m4a")
            .exists());
        assert!(meeting_folder
            .join("audio-segments/segment-0001.m4a")
            .exists());
        let manifest: AudioManifest = serde_json::from_slice(
            &std::fs::read(meeting_folder.join("audio-manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.canonical_audio, "audio.m4a");
        assert_eq!(manifest.segments.len(), 2);
    }

    #[tokio::test]
    async fn test_empty_recording() {
        let temp_dir = tempdir().unwrap();
        let meeting_folder = temp_dir.path().join("Empty_Test");
        std::fs::create_dir_all(&meeting_folder).unwrap();
        std::fs::create_dir_all(meeting_folder.join(".checkpoints")).unwrap();

        let mut saver = IncrementalAudioSaver::new(meeting_folder.clone(), 48000).unwrap();

        // Try to finalize without adding any chunks
        let result = saver.finalize().await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("No audio checkpoints"));
    }

    #[test]
    fn archived_segments_append_without_overwriting_an_earlier_part() {
        let temp_dir = tempdir().unwrap();
        let meeting_folder = temp_dir.path().join("Continued_Meeting");
        let checkpoints = meeting_folder.join(".checkpoints");
        let segments = meeting_folder.join(SEGMENTS_DIRECTORY);
        std::fs::create_dir_all(&checkpoints).unwrap();
        std::fs::create_dir_all(&segments).unwrap();
        std::fs::write(segments.join("segment-0000.m4a"), b"earlier part").unwrap();
        let first = checkpoints.join("audio_chunk_000.m4a");
        let second = checkpoints.join("audio_chunk_001.m4a");
        std::fs::write(&first, b"continued part one").unwrap();
        std::fs::write(&second, b"continued part two").unwrap();

        archive_checkpoints(&meeting_folder, &checkpoints, &[first, second]).unwrap();
        write_audio_manifest(&meeting_folder).unwrap();

        assert_eq!(
            std::fs::read(segments.join("segment-0000.m4a")).unwrap(),
            b"earlier part"
        );
        assert!(segments.join("segment-0001.m4a").is_file());
        assert!(segments.join("segment-0002.m4a").is_file());
        let manifest: AudioManifest = serde_json::from_slice(
            &std::fs::read(meeting_folder.join("audio-manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.segments.len(), 3);
    }

    #[test]
    fn concat_list_escapes_apostrophes_in_recording_paths() {
        let temp_dir = tempdir().unwrap();
        let audio = temp_dir.path().join("team's recording.m4a");
        std::fs::write(&audio, b"audio").unwrap();

        let line = concat_file_line(&audio).unwrap();

        assert!(line.contains("team'\\''s recording.m4a"));
        assert!(line.starts_with("file '"));
        assert!(line.ends_with("'\n"));
    }
}
