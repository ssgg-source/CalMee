use super::{
    bridge, DiarizationInputSegment, DiarizationResult, FunAsrConfig, FunAsrResult, FunAsrStatus,
    SpeakerReclusterStatus,
};
use anyhow::Result;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct FunAsrEngine {
    config: Arc<RwLock<FunAsrConfig>>,
    status: Arc<RwLock<FunAsrStatus>>,
}

impl FunAsrEngine {
    pub fn new(config: FunAsrConfig) -> Self {
        Self {
            config: Arc::new(RwLock::new(config)),
            status: Arc::new(RwLock::new(FunAsrStatus::default())),
        }
    }

    pub async fn config(&self) -> FunAsrConfig {
        self.config.read().await.clone()
    }

    pub async fn set_config(&self, config: FunAsrConfig) -> Result<()> {
        config.validate().map_err(anyhow::Error::msg)?;
        let old = self.config.read().await.clone();
        let requires_reload = old.requires_reload(&config);
        *self.config.write().await = config;
        if requires_reload && self.is_model_loaded().await {
            self.unload().await?;
        }
        Ok(())
    }

    pub async fn load(&self) -> Result<FunAsrStatus> {
        let config = self.config().await;
        let status = bridge::load(&config).await?;
        *self.status.write().await = status.clone();
        Ok(status)
    }

    /// Live capture already has Rust-side VAD and performs complete speaker
    /// analysis after save. Avoid loading duplicate VAD/CAM++ models before
    /// the microphone can start.
    pub async fn load_live(&self) -> Result<FunAsrStatus> {
        let mut config = self.config().await;
        config.vad_enabled = false;
        config.speaker_enabled = false;
        let status = bridge::load(&config).await?;
        *self.status.write().await = status.clone();
        Ok(status)
    }

    pub async fn load_streaming(&self) -> Result<FunAsrStatus> {
        let mut config = self.config().await;
        config.vad_enabled = false;
        config.punc_enabled = true;
        config.speaker_enabled = false;
        let status = bridge::stream_start(&config).await?;
        *self.status.write().await = status.clone();
        Ok(status)
    }

    pub async fn transcribe_streaming(
        &self,
        samples: &[f32],
        is_final: bool,
    ) -> Result<super::FunAsrStreamingResult> {
        if !self.is_model_loaded().await {
            self.load_streaming().await?;
        }
        bridge::stream_chunk(samples, is_final).await
    }

    pub async fn punctuate_streaming_endpoint(&self, text: &str) -> Result<String> {
        Ok(bridge::stream_punctuate(text).await?.text)
    }

    pub async fn unload(&self) -> Result<()> {
        let status = bridge::unload().await?;
        *self.status.write().await = status;
        Ok(())
    }

    pub async fn is_model_loaded(&self) -> bool {
        self.status.read().await.loaded
    }

    pub async fn get_current_model(&self) -> Option<String> {
        self.status.read().await.model.clone()
    }

    pub async fn status(&self) -> Result<FunAsrStatus> {
        let status = bridge::status().await?;
        *self.status.write().await = status.clone();
        Ok(status)
    }

    pub async fn transcribe(&self, samples: &[f32]) -> Result<FunAsrResult> {
        if !self.is_model_loaded().await {
            self.load_live().await?;
        }
        let mut config = self.config().await;
        config.vad_enabled = false;
        config.speaker_enabled = false;
        bridge::transcribe(&config, samples).await
    }

    pub async fn transcribe_file(
        &self,
        path: &Path,
        progress_callback: Option<bridge::ProgressCallback>,
    ) -> Result<FunAsrResult> {
        if !self.is_model_loaded().await {
            self.load().await?;
        }
        let config = self.config().await;
        bridge::transcribe_file(&config, path, progress_callback).await
    }

    pub async fn transcribe_file_cached(
        &self,
        path: &Path,
        cache_key: &str,
        progress_callback: Option<bridge::ProgressCallback>,
    ) -> Result<FunAsrResult> {
        if !self.is_model_loaded().await {
            self.load().await?;
        }
        let config = self.config().await;
        bridge::transcribe_file_cached(&config, path, cache_key, progress_callback).await
    }

    pub async fn recluster_status(&self, cache_key: &str) -> Result<SpeakerReclusterStatus> {
        bridge::recluster_status(cache_key).await
    }

    pub async fn recluster_transcript(
        &self,
        cache_key: &str,
        speaker_count: usize,
    ) -> Result<FunAsrResult> {
        bridge::recluster_transcript(cache_key, speaker_count).await
    }

    pub async fn diarize_segments(
        &self,
        path: &Path,
        segments: &[DiarizationInputSegment],
        progress_callback: Option<bridge::ProgressCallback>,
    ) -> Result<DiarizationResult> {
        // Deliberately do not load the configured ASR model here. The sidecar
        // loads only the canonical CAM++ embedding model for this operation.
        let config = self.config().await;
        bridge::diarize_segments(&config, path, segments, progress_callback).await
    }

    pub async fn diarize_segments_cached(
        &self,
        path: &Path,
        segments: &[DiarizationInputSegment],
        cache_key: &str,
        progress_callback: Option<bridge::ProgressCallback>,
    ) -> Result<DiarizationResult> {
        let config = self.config().await;
        bridge::diarize_segments_cached(&config, path, segments, cache_key, progress_callback).await
    }
}
