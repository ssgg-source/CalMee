use anyhow::{anyhow, Context, Result};
use futures_util::TryStreamExt;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::io::ReaderStream;

pub struct RemoteFunAsrConfig {
    pub endpoint: String,
    pub token: String,
}

pub async fn load_config(pool: &sqlx::SqlitePool) -> Result<RemoteFunAsrConfig> {
    use sqlx::Row;
    let row = sqlx::query("SELECT api_key, extra_json FROM transcript_provider_credentials WHERE provider='funasr-server'")
        .fetch_optional(pool).await?.ok_or_else(|| anyhow!("FunASR server is not configured"))?;
    let extra: String = row
        .try_get::<Option<String>, _>("extra_json")?
        .unwrap_or_default();
    let value: serde_json::Value =
        serde_json::from_str(&extra).context("Invalid FunASR server configuration")?;
    let endpoint = value
        .pointer("/credentials/endpoint")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    validated_endpoint(&endpoint)?;
    Ok(RemoteFunAsrConfig {
        endpoint,
        token: row
            .try_get::<Option<String>, _>("api_key")?
            .unwrap_or_default(),
    })
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SpeakerEmbeddingModel {
    pub id: String,
    pub revision: String,
    pub dimension: usize,
    #[serde(default)]
    pub normalized: bool,
    #[serde(default)]
    pub distance: String,
}

#[derive(Debug, Clone)]
pub struct RemoteFunAsrResult {
    pub transcripts: Vec<(String, f64, f64)>,
    pub speaker_embeddings: HashMap<String, Vec<f32>>,
    pub speaker_embedding_model: Option<SpeakerEmbeddingModel>,
}

#[derive(Debug, Deserialize)]
struct RemoteSegment {
    text: String,
    start: f64,
    end: f64,
    #[serde(default)]
    speaker: Option<serde_json::Value>,
}
#[derive(Debug, Deserialize)]
struct RemoteResponse {
    #[serde(default)]
    text: String,
    #[serde(default)]
    segments: Vec<RemoteSegment>,
    #[serde(default)]
    speaker_embeddings: HashMap<String, Vec<f32>>,
    #[serde(default)]
    speaker_embedding_model: Option<SpeakerEmbeddingModel>,
}

#[derive(Debug, Deserialize)]
struct CreatedJob {
    job_id: String,
}

#[derive(Debug, Deserialize)]
struct JobStatus {
    status: String,
    #[serde(default)]
    progress: f64,
    #[serde(default)]
    error: Option<serde_json::Value>,
}

fn validated_endpoint(raw: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw.trim()).context("Invalid FunASR server URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(anyhow!("FunASR server URL must use http:// or https://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(anyhow!(
            "Put the access token in its own field, not in the URL"
        ));
    }
    if url.host_str().is_none() {
        return Err(anyhow!("FunASR server URL is missing a host"));
    }
    Ok(url)
}

fn service_url(endpoint: &str, suffix: &str) -> Result<url::Url> {
    let mut url = validated_endpoint(endpoint)?;
    let current_path = url.path().trim_end_matches('/');
    let prefix = current_path
        .split_once("/v1/audio/")
        .map(|(value, _)| value)
        .unwrap_or(current_path);
    url.set_path(&format!("{}{}", prefix.trim_end_matches('/'), suffix));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn job_url(jobs_url: &url::Url, job_id: &str, result: bool) -> Result<url::Url> {
    if job_id.is_empty()
        || job_id.len() > 160
        || !job_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(anyhow!("FunASR server returned an invalid job ID"));
    }
    let mut url = jobs_url.clone();
    let suffix = if result { "/result" } else { "" };
    url.set_path(&format!(
        "{}/{}{}",
        jobs_url.path().trim_end_matches('/'),
        job_id,
        suffix
    ));
    Ok(url)
}

pub async fn test_connection(endpoint: &str, token: &str) -> Result<serde_json::Value, String> {
    let url = service_url(endpoint, "/health").map_err(|error| error.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(url);
    if !token.is_empty() {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Connection failed: {error}"))?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err("FunASR server rejected the access token".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "FunASR server returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let health: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("Invalid FunASR health response: {error}"))?;
    if health.get("status").and_then(serde_json::Value::as_str) != Some("ok") {
        return Err("FunASR server health check did not report ready".to_string());
    }
    Ok(serde_json::json!({"status":"success"}))
}

#[derive(Debug, Clone, Copy)]
pub enum RemoteFunAsrProgress {
    Upload { uploaded: u64, total: u64 },
    Queued,
    Processing { estimate: f64 },
}

pub type RemoteProgressCallback = Arc<dyn Fn(RemoteFunAsrProgress) + Send + Sync>;
pub type CancellationCheck = Arc<dyn Fn() -> bool + Send + Sync>;

fn parse_response(
    body: &[u8],
    speaker_diarization: bool,
    timestamp_scale: f64,
) -> Result<RemoteFunAsrResult> {
    let parsed: RemoteResponse = serde_json::from_slice(body).context("Invalid FunASR response")?;
    if parsed.segments.is_empty() {
        let text = parsed.text.trim();
        return if text.is_empty() {
            Err(anyhow!("FunASR server returned an empty transcript"))
        } else {
            Ok(RemoteFunAsrResult {
                transcripts: vec![(text.to_string(), 0.0, 0.0)],
                speaker_embeddings: HashMap::new(),
                speaker_embedding_model: None,
            })
        };
    }

    let mut speaker_numbers: HashMap<String, usize> = HashMap::new();
    let mut next_speaker = 1usize;
    let transcripts = parsed
        .segments
        .into_iter()
        .filter_map(|segment| {
            let text = segment.text.trim();
            if text.is_empty() {
                return None;
            }
            let text = if speaker_diarization {
                segment
                    .speaker
                    .as_ref()
                    .map(|speaker| {
                        let key = speaker
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| speaker.to_string());
                        let number = *speaker_numbers.entry(key).or_insert_with(|| {
                            let value = next_speaker;
                            next_speaker += 1;
                            value
                        });
                        format!("[Speaker {number}] {text}")
                    })
                    .unwrap_or_else(|| text.to_string())
            } else {
                text.to_string()
            };
            Some((
                text,
                segment.start * timestamp_scale,
                segment.end * timestamp_scale,
            ))
        })
        .collect();

    let (speaker_embeddings, speaker_embedding_model) =
        if speaker_diarization && !parsed.speaker_embeddings.is_empty() {
            let model = parsed.speaker_embedding_model.ok_or_else(|| {
                anyhow!("FunASR response omitted speaker embedding model metadata")
            })?;
            if model.id.trim().is_empty()
                || model.revision.trim().is_empty()
                || model.dimension == 0
                || (!model.distance.is_empty() && model.distance != "cosine")
            {
                return Err(anyhow!(
                    "FunASR response contains invalid speaker embedding model metadata"
                ));
            }
            let mut embeddings = HashMap::new();
            for (server_speaker, mut embedding) in parsed.speaker_embeddings {
                let Some(number) = speaker_numbers.get(&server_speaker) else {
                    continue;
                };
                if embedding.len() != model.dimension
                    || embedding.iter().any(|value| !value.is_finite())
                {
                    return Err(anyhow!(
                        "FunASR response contains an invalid speaker embedding"
                    ));
                }
                let norm = embedding
                    .iter()
                    .map(|value| value * value)
                    .sum::<f32>()
                    .sqrt();
                if norm <= f32::EPSILON {
                    return Err(anyhow!(
                        "FunASR response contains an empty speaker embedding"
                    ));
                }
                for value in &mut embedding {
                    *value /= norm;
                }
                embeddings.insert(format!("Speaker {number}"), embedding);
            }
            (embeddings, Some(model))
        } else {
            (HashMap::new(), None)
        };

    Ok(RemoteFunAsrResult {
        transcripts,
        speaker_embeddings,
        speaker_embedding_model,
    })
}

pub async fn transcribe_file(
    endpoint: &str,
    token: &str,
    model: &str,
    language: Option<&str>,
    speaker_diarization: bool,
    audio_path: &Path,
    progress_callback: Option<RemoteProgressCallback>,
    cancellation_check: Option<CancellationCheck>,
) -> Result<RemoteFunAsrResult> {
    transcribe_file_with_poll_interval(
        endpoint,
        token,
        model,
        language,
        speaker_diarization,
        audio_path,
        progress_callback,
        cancellation_check,
        Duration::from_secs(3),
    )
    .await
}

async fn transcribe_file_with_poll_interval(
    endpoint: &str,
    token: &str,
    model: &str,
    language: Option<&str>,
    speaker_diarization: bool,
    audio_path: &Path,
    progress_callback: Option<RemoteProgressCallback>,
    cancellation_check: Option<CancellationCheck>,
    poll_interval: Duration,
) -> Result<RemoteFunAsrResult> {
    let jobs_url = service_url(endpoint, "/v1/audio/jobs")?;
    let audio_file = tokio::fs::File::open(audio_path)
        .await
        .context("Could not read the recording")?;
    let audio_size = audio_file
        .metadata()
        .await
        .context("Could not inspect the recording")?
        .len();
    let filename = audio_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("recording.wav");
    let mut uploaded = 0u64;
    let progress = progress_callback.clone();
    let stream = ReaderStream::new(audio_file).inspect_ok(move |chunk| {
        uploaded = uploaded.saturating_add(chunk.len() as u64).min(audio_size);
        if let Some(callback) = &progress {
            callback(RemoteFunAsrProgress::Upload {
                uploaded,
                total: audio_size,
            });
        }
    });
    if let Some(callback) = &progress_callback {
        callback(RemoteFunAsrProgress::Upload {
            uploaded: 0,
            total: audio_size,
        });
    }
    let body = reqwest::Body::wrap_stream(stream);
    let file = Part::stream_with_length(body, audio_size)
        .file_name(filename.to_string())
        .mime_str("application/octet-stream")?;
    let mut form = Form::new()
        .part("file", file)
        .text("model", model.to_string())
        .text("response_format", "verbose_json")
        .text("spk", speaker_diarization.to_string());
    if let Some(language) = language.filter(|value| *value != "auto") {
        form = form.text("language", language.to_string());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60 * 60))
        .build()?;
    let mut request = client.post(jobs_url.clone()).multipart(form);
    if !token.is_empty() {
        request = request.bearer_auth(token);
    }
    let created_response = request
        .send()
        .await
        .context("Could not reach the FunASR server")?;
    let created_status = created_response.status();
    let created_body = created_response
        .bytes()
        .await
        .context("Could not read the FunASR job response")?;
    if !created_status.is_success() {
        let detail = String::from_utf8_lossy(&created_body)
            .chars()
            .take(300)
            .collect::<String>();
        return Err(anyhow!(
            "FunASR server returned HTTP {}: {}",
            created_status.as_u16(),
            detail
        ));
    }
    let created: CreatedJob =
        serde_json::from_slice(&created_body).context("Invalid FunASR job response")?;
    let status_url = job_url(&jobs_url, &created.job_id, false)?;
    let result_url = job_url(&jobs_url, &created.job_id, true)?;
    let cancel_url = {
        let mut url = status_url.clone();
        url.set_path(&format!(
            "{}/cancel",
            status_url.path().trim_end_matches('/')
        ));
        url
    };
    if let Some(callback) = &progress_callback {
        callback(RemoteFunAsrProgress::Queued);
    }

    let started = Instant::now();
    loop {
        if cancellation_check.as_ref().is_some_and(|check| check()) {
            let mut cancel_request = client.post(cancel_url.clone());
            if !token.is_empty() {
                cancel_request = cancel_request.bearer_auth(token);
            }
            let _ = cancel_request.send().await;
            return Err(anyhow!("Retranscription cancelled"));
        }
        if started.elapsed() > Duration::from_secs(2 * 60 * 60) {
            return Err(anyhow!("FunASR server job timed out"));
        }

        let mut status_request = client.get(status_url.clone());
        if !token.is_empty() {
            status_request = status_request.bearer_auth(token);
        }
        let response = status_request
            .send()
            .await
            .context("Could not query the FunASR job")?;
        let http_status = response.status();
        let body = response
            .bytes()
            .await
            .context("Could not read the FunASR job status")?;
        if !http_status.is_success() {
            return Err(anyhow!(
                "FunASR job status returned HTTP {}",
                http_status.as_u16()
            ));
        }
        let status: JobStatus =
            serde_json::from_slice(&body).context("Invalid FunASR job status")?;
        match status.status.as_str() {
            "queued" => {
                if let Some(callback) = &progress_callback {
                    callback(RemoteFunAsrProgress::Queued);
                }
            }
            "running" | "cancelling" => {
                if let Some(callback) = &progress_callback {
                    callback(RemoteFunAsrProgress::Processing {
                        estimate: status.progress.clamp(0.0, 1.0),
                    });
                }
            }
            "succeeded" => break,
            "cancelled" => return Err(anyhow!("Retranscription cancelled")),
            "failed" => {
                let detail = status
                    .error
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown server error".to_string());
                return Err(anyhow!("FunASR server job failed: {detail}"));
            }
            other => {
                return Err(anyhow!(
                    "FunASR server returned unknown job status: {other}"
                ))
            }
        }
        tokio::time::sleep(poll_interval).await;
    }

    let mut result_request = client.get(result_url);
    if !token.is_empty() {
        result_request = result_request.bearer_auth(token);
    }
    let response = result_request
        .send()
        .await
        .context("Could not fetch the FunASR job result")?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .context("Could not read the FunASR job result")?;
    if !status.is_success() {
        return Err(anyhow!(
            "FunASR job result returned HTTP {}",
            status.as_u16()
        ));
    }
    // The v2 asynchronous result contract reports segment timestamps in
    // milliseconds, while the legacy synchronous endpoint used seconds.
    parse_response(&body, speaker_diarization, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        let mut expected = None;
        loop {
            let count = stream.read(&mut buffer).await.unwrap();
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if expected.is_none() {
                if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(str::trim)
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    expected = Some(header_end + 4 + content_length);
                }
            }
            if expected.is_some_and(|size| bytes.len() >= size) {
                break;
            }
        }
        String::from_utf8_lossy(&bytes).to_string()
    }

    async fn reply_json(stream: &mut tokio::net::TcpStream, body: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    }
    #[test]
    fn endpoint_validation_rejects_credentials_and_non_http_protocols() {
        assert!(validated_endpoint("ws://localhost:10095").is_err());
        assert!(validated_endpoint("https://token@example.com/v1/audio/transcriptions").is_err());
        assert!(validated_endpoint("http://127.0.0.1:8000/v1/audio/transcriptions").is_ok());
        assert_eq!(
            service_url(
                "http://127.0.0.1:8000/v1/audio/transcriptions",
                "/v1/audio/jobs"
            )
            .unwrap()
            .as_str(),
            "http://127.0.0.1:8000/v1/audio/jobs"
        );
    }

    /// Opt-in diagnostic for validating CalMee's real connector against a
    /// user-configured server without putting credentials or audio in source.
    #[tokio::test]
    #[ignore = "requires CALMEE_TEST_FUNASR_* environment variables"]
    async fn configured_server_returns_multiple_speakers() {
        let endpoint = std::env::var("CALMEE_TEST_FUNASR_ENDPOINT").expect("missing endpoint");
        let token = std::env::var("CALMEE_TEST_FUNASR_TOKEN").unwrap_or_default();
        let audio = std::env::var("CALMEE_TEST_FUNASR_AUDIO").expect("missing audio path");
        let result = transcribe_file(
            &endpoint,
            &token,
            "fun-asr-nano",
            Some("zh"),
            true,
            Path::new(&audio),
            None,
            None,
        )
        .await
        .expect("CalMee connector transcription failed");
        let speakers = result
            .transcripts
            .iter()
            .filter_map(|(text, _, _)| text.strip_prefix("[Speaker "))
            .filter_map(|text| text.split(']').next())
            .collect::<std::collections::BTreeSet<_>>();
        assert!(
            !result.transcripts.is_empty(),
            "server returned no transcript segments"
        );
        assert!(
            speakers.len() >= 2,
            "expected at least two speaker labels, got {}",
            speakers.len()
        );
        assert!(
            result.speaker_embeddings.len() >= 2,
            "expected an embedding for each detected speaker"
        );
        let metadata = result
            .speaker_embedding_model
            .expect("server omitted speaker embedding model metadata");
        assert!(!metadata.revision.is_empty());
        assert!(metadata.dimension > 0);
        assert!(result
            .speaker_embeddings
            .values()
            .all(|embedding| embedding.len() == metadata.dimension));
    }

    #[test]
    fn response_maps_embeddings_to_local_speaker_labels_and_normalizes_them() {
        let body = br#"{
          "text":"hello world",
          "segments":[
            {"text":"hello","start":0.0,"end":1.0,"speaker":"SPK7"},
            {"text":"world","start":1.0,"end":2.0,"speaker":"SPK2"}
          ],
          "speaker_embeddings":{"SPK7":[3.0,4.0],"SPK2":[0.0,2.0]},
          "speaker_embedding_model":{"id":"cam++","revision":"sha256:test","dimension":2,"normalized":false,"distance":"cosine"}
        }"#;
        let result = parse_response(body, true, 1000.0).unwrap();
        assert_eq!(result.transcripts[0].0, "[Speaker 1] hello");
        assert_eq!(result.transcripts[1].0, "[Speaker 2] world");
        assert_eq!(result.transcripts[1].1, 1000.0);
        assert_eq!(result.transcripts[1].2, 2000.0);
        assert_eq!(result.speaker_embeddings["Speaker 1"], vec![0.6, 0.8]);
        assert_eq!(result.speaker_embeddings["Speaker 2"], vec![0.0, 1.0]);
        assert_eq!(
            result.speaker_embedding_model.unwrap().revision,
            "sha256:test"
        );
    }

    #[test]
    fn response_rejects_embedding_dimension_mismatch() {
        let body = br#"{
          "segments":[{"text":"hello","start":0.0,"end":1.0,"speaker":"SPK0"}],
          "speaker_embeddings":{"SPK0":[1.0]},
          "speaker_embedding_model":{"id":"cam++","revision":"sha256:test","dimension":2,"normalized":true,"distance":"cosine"}
        }"#;
        assert!(parse_response(body, true, 1.0).is_err());
    }

    #[test]
    fn asynchronous_results_keep_millisecond_timestamps() {
        let body = br#"{
          "segments":[{"text":"hello","start":1250,"end":5000,"speaker":"SPK0"}]
        }"#;
        let result = parse_response(body, true, 1.0).unwrap();
        assert_eq!(result.transcripts[0].1, 1250.0);
        assert_eq!(result.transcripts[0].2, 5000.0);
    }

    #[tokio::test]
    async fn asynchronous_job_flow_reports_queue_and_estimated_progress() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for step in 0..5 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut stream).await;
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-token"));
                match step {
                    0 => {
                        assert!(request.starts_with("POST /v1/audio/jobs "));
                        reply_json(
                            &mut stream,
                            r#"{"job_id":"job_test","status":"queued","progress":0.0}"#,
                        )
                        .await;
                    }
                    1 => {
                        assert!(request.starts_with("GET /v1/audio/jobs/job_test "));
                        reply_json(&mut stream, r#"{"status":"queued","progress":0.0}"#).await;
                    }
                    2 => {
                        assert!(request.starts_with("GET /v1/audio/jobs/job_test "));
                        reply_json(&mut stream, r#"{"status":"running","progress":0.4}"#).await;
                    }
                    3 => {
                        assert!(request.starts_with("GET /v1/audio/jobs/job_test "));
                        reply_json(&mut stream, r#"{"status":"succeeded","progress":1.0}"#).await;
                    }
                    _ => {
                        assert!(request.starts_with("GET /v1/audio/jobs/job_test/result "));
                        reply_json(&mut stream, r#"{"segments":[{"text":"hello","start":1250,"end":5000,"speaker":"SPK0"}],"speaker_embeddings":{"SPK0":[3.0,4.0]},"speaker_embedding_model":{"id":"cam++","revision":"sha256:v1","dimension":2,"normalized":false,"distance":"cosine"}}"#).await;
                    }
                }
            }
        });
        let audio = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(audio.path(), b"synthetic audio fixture").unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let callback: RemoteProgressCallback = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        });
        let result = transcribe_file_with_poll_interval(
            &format!("http://{address}/v1/audio/transcriptions"),
            "test-token",
            "fun-asr-nano",
            Some("zh"),
            true,
            audio.path(),
            Some(callback),
            None,
            Duration::from_millis(1),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(result.transcripts[0].1, 1250.0);
        assert_eq!(result.transcripts[0].2, 5000.0);
        assert_eq!(result.speaker_embeddings["Speaker 1"], vec![0.6, 0.8]);
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|event| matches!(event, RemoteFunAsrProgress::Queued)));
        assert!(events.iter().any(|event| matches!(event, RemoteFunAsrProgress::Processing { estimate } if (*estimate - 0.4).abs() < f64::EPSILON)));
        assert!(events.iter().any(|event| matches!(event, RemoteFunAsrProgress::Upload { uploaded, total } if uploaded == total)));
    }

    #[tokio::test]
    async fn cancellation_requests_server_job_cancellation() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut create_stream, _) = listener.accept().await.unwrap();
            let create_request = read_http_request(&mut create_stream).await;
            assert!(create_request.starts_with("POST /v1/audio/jobs "));
            reply_json(
                &mut create_stream,
                r#"{"job_id":"job_cancel","status":"queued","progress":0.0}"#,
            )
            .await;

            let (mut cancel_stream, _) = listener.accept().await.unwrap();
            let cancel_request = read_http_request(&mut cancel_stream).await;
            assert!(cancel_request.starts_with("POST /v1/audio/jobs/job_cancel/cancel "));
            reply_json(
                &mut cancel_stream,
                r#"{"job_id":"job_cancel","status":"cancelling","progress":0.0}"#,
            )
            .await;
        });
        let audio = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(audio.path(), b"synthetic audio fixture").unwrap();
        let cancellation: CancellationCheck = Arc::new(|| true);
        let error = transcribe_file_with_poll_interval(
            &format!("http://{address}/v1/audio/transcriptions"),
            "test-token",
            "fun-asr-nano",
            Some("zh"),
            true,
            audio.path(),
            None,
            Some(cancellation),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        server.await.unwrap();
        assert!(error.to_string().contains("cancelled"));
    }
}
