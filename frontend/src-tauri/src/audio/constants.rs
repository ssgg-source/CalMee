/// Supported audio file extensions for import and retranscription.
///
/// Includes the common audio/video containers accepted by the import flow.
/// Less common formats are normalized through the bundled FFmpeg sidecar.
pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp4", "m4a", "wav", "mp3", "flac", "ogg", "aac", "mkv", "webm", "wma", "opus", "mov", "aiff",
    "aif", "caf", "m4b", "mpeg", "mpg", "avi", "3gp", "amr", "ac3", "ape",
];
