use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct FunAsrConfig {
    pub model: String,
    pub model_revision: Option<String>,
    pub hub: String,
    pub device: String,
    pub ncpu: u16,
    pub trust_remote_code: bool,
    pub language: String,
    pub vad_enabled: bool,
    pub vad_model: String,
    pub vad_model_revision: Option<String>,
    pub vad_max_segment_ms: u32,
    pub merge_vad: bool,
    pub merge_length_s: u32,
    pub punc_enabled: bool,
    pub punc_model: String,
    pub punc_model_revision: Option<String>,
    pub speaker_enabled: bool,
    pub speaker_model: String,
    pub speaker_model_revision: Option<String>,
    pub speaker_mode: String,
    pub speaker_merge_threshold: f32,
    pub preset_speaker_count: Option<u16>,
    pub hotwords: String,
    pub postprocess_hotwords: String,
    pub postprocess_hotword_threshold: f32,
    pub sentence_timestamp: bool,
    pub use_itn: bool,
    pub return_raw_text: bool,
    pub batch_size_s: u32,
}

impl Default for FunAsrConfig {
    fn default() -> Self {
        Self {
            model: "paraformer-zh".into(),
            model_revision: None,
            hub: "ms".into(),
            device: "auto".into(),
            ncpu: 4,
            trust_remote_code: false,
            language: "auto".into(),
            vad_enabled: true,
            vad_model: "fsmn-vad".into(),
            vad_model_revision: None,
            vad_max_segment_ms: 60_000,
            merge_vad: true,
            merge_length_s: 15,
            punc_enabled: true,
            punc_model: "ct-punc".into(),
            punc_model_revision: None,
            speaker_enabled: false,
            speaker_model: "cam++".into(),
            speaker_model_revision: None,
            speaker_mode: "punc_segment".into(),
            speaker_merge_threshold: 0.78,
            preset_speaker_count: None,
            hotwords: String::new(),
            postprocess_hotwords: String::new(),
            postprocess_hotword_threshold: 0.8,
            sentence_timestamp: true,
            use_itn: true,
            return_raw_text: false,
            batch_size_s: 60,
        }
    }
}

impl FunAsrConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.model.trim().is_empty() {
            return Err("FunASR model cannot be empty".into());
        }
        if !matches!(self.hub.as_str(), "ms" | "hf") {
            return Err("FunASR hub must be 'ms' or 'hf'".into());
        }
        if self.ncpu == 0 || self.ncpu > 128 {
            return Err("FunASR CPU thread count must be between 1 and 128".into());
        }
        if self.vad_max_segment_ms < 1_000 || self.vad_max_segment_ms > 600_000 {
            return Err("FunASR VAD segment length must be between 1000 and 600000 ms".into());
        }
        if self.merge_length_s == 0 || self.merge_length_s > 600 {
            return Err("FunASR VAD merge length must be between 1 and 600 seconds".into());
        }
        if self.batch_size_s == 0 || self.batch_size_s > 3_600 {
            return Err("FunASR batch size must be between 1 and 3600 seconds".into());
        }
        if !(0.0..=1.0).contains(&self.postprocess_hotword_threshold) {
            return Err("FunASR postprocess hotword threshold must be between 0 and 1".into());
        }
        if !matches!(
            self.speaker_mode.as_str(),
            "default" | "vad_segment" | "punc_segment"
        ) {
            return Err("FunASR speaker mode must be default, vad_segment, or punc_segment".into());
        }
        if !(0.4..=0.95).contains(&self.speaker_merge_threshold) {
            return Err("FunASR speaker merge threshold must be between 0.4 and 0.95".into());
        }
        if self
            .preset_speaker_count
            .is_some_and(|count| count == 0 || count > 20)
        {
            return Err("Expected speaker count must be between 1 and 20".into());
        }
        Ok(())
    }

    pub fn requires_reload(&self, other: &Self) -> bool {
        self.model != other.model
            || self.model_revision != other.model_revision
            || self.hub != other.hub
            || self.device != other.device
            || self.ncpu != other.ncpu
            || self.trust_remote_code != other.trust_remote_code
            || self.vad_enabled != other.vad_enabled
            || self.vad_model != other.vad_model
            || self.vad_model_revision != other.vad_model_revision
            || self.vad_max_segment_ms != other.vad_max_segment_ms
            || self.punc_enabled != other.punc_enabled
            || self.punc_model != other.punc_model
            || self.punc_model_revision != other.punc_model_revision
            || self.speaker_enabled != other.speaker_enabled
            || self.speaker_model != other.speaker_model
            || self.speaker_model_revision != other.speaker_model_revision
            || self.speaker_mode != other.speaker_mode
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FunAsrModelProfile {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub languages: &'static str,
    pub capabilities: &'static [&'static str],
}

pub fn model_profiles() -> Vec<FunAsrModelProfile> {
    vec![
        FunAsrModelProfile {
            id: "paraformer-zh",
            name: "Paraformer Large",
            description: "Recommended for Chinese meetings; supports timestamps, hotwords, punctuation and speaker diarization.",
            languages: "Chinese / English code-switching",
            capabilities: &["vad", "punctuation", "timestamps", "hotwords", "speakers"],
        },
        FunAsrModelProfile {
            id: "iic/SenseVoiceSmall",
            name: "SenseVoice Small",
            description: "Multilingual speech recognition with emotion and audio-event tokens.",
            languages: "Chinese / Cantonese / English / Japanese / Korean",
            capabilities: &["vad", "multilingual", "emotion", "audio-events", "itn"],
        },
        FunAsrModelProfile {
            id: "FunAudioLLM/Fun-ASR-Nano-2512",
            name: "Fun-ASR Nano",
            description: "New-generation 800M model for Chinese meetings, dialects, English and Japanese; hotwords are supported.",
            languages: "Chinese / dialects / English / Japanese",
            capabilities: &["vad", "multilingual", "hotwords", "itn"],
        },
        FunAsrModelProfile {
            id: "FunAudioLLM/Fun-ASR-MLT-Nano-2512",
            name: "Fun-ASR MLT Nano",
            description: "Multilingual 800M model covering 31 languages; use the meeting pipeline for optional speaker diarization.",
            languages: "31 languages",
            capabilities: &["vad", "multilingual", "hotwords", "itn"],
        },
    ]
}

pub fn qwen3_asr_model_profiles() -> Vec<FunAsrModelProfile> {
    vec![
        FunAsrModelProfile {
            id: "Qwen/Qwen3-ASR-0.6B",
            name: "Qwen3-ASR 0.6B",
            description: "Balanced local model for multilingual transcription and Chinese dialects.",
            languages: "52 languages and dialects",
            capabilities: &["multilingual", "dialects", "offline"],
        },
        FunAsrModelProfile {
            id: "Qwen/Qwen3-ASR-1.7B",
            name: "Qwen3-ASR 1.7B",
            description: "Higher-quality local model. Requires substantially more memory and processing time.",
            languages: "52 languages and dialects",
            capabilities: &["multilingual", "dialects", "offline"],
        },
    ]
}
