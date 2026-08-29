use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener as StdTcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const MAX_REQUEST_HEADER_BYTES: usize = 16 * 1024;

pub struct MediaServerState {
    port: u16,
    files: Arc<RwLock<HashMap<String, PathBuf>>>,
}

impl MediaServerState {
    pub fn start() -> io::Result<Self> {
        let listener = StdTcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let files = Arc::new(RwLock::new(HashMap::new()));
        let server_files = files.clone();

        tauri::async_runtime::spawn(async move {
            let listener = match TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    log::error!("Could not start the local media server: {error}");
                    return;
                }
            };
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let files = server_files.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = serve_connection(stream, files).await {
                                log::warn!("Local media stream request failed: {error}");
                            }
                        });
                    }
                    Err(error) => {
                        log::error!("Local media server stopped: {error}");
                        break;
                    }
                }
            }
        });

        log::info!("Local media server listening on 127.0.0.1:{port}");
        Ok(Self { port, files })
    }

    pub fn register(&self, path: PathBuf) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.files
            .write()
            .expect("local media registry lock poisoned")
            .insert(token.clone(), path);
        format!("http://127.0.0.1:{}/media/{}", self.port, token)
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    files: Arc<RwLock<HashMap<String, PathBuf>>>,
) -> io::Result<()> {
    let mut request = Vec::with_capacity(2048);
    let mut buffer = [0_u8; 2048];
    while request.len() < MAX_REQUEST_HEADER_BYTES {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok(());
        }
        request.extend_from_slice(&buffer[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    if request.len() >= MAX_REQUEST_HEADER_BYTES {
        return write_empty_response(&mut stream, "431 Request Header Fields Too Large").await;
    }

    let request = String::from_utf8_lossy(&request);
    let mut lines = request.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default();
    let route = request_line.next().unwrap_or_default();
    if method != "GET" && method != "HEAD" {
        return write_empty_response(&mut stream, "405 Method Not Allowed").await;
    }
    let Some(token) = route.strip_prefix("/media/") else {
        return write_empty_response(&mut stream, "404 Not Found").await;
    };
    if token.is_empty() || token.contains('/') || token.contains('?') {
        return write_empty_response(&mut stream, "404 Not Found").await;
    }
    let range_header = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("range")
            .then(|| value.trim().to_string())
    });

    let Some(path) = files
        .read()
        .expect("local media registry lock poisoned")
        .get(token)
        .cloned()
    else {
        return write_empty_response(&mut stream, "404 Not Found").await;
    };
    let length = tokio::fs::metadata(&path).await?.len();
    if length == 0 {
        return write_empty_response(&mut stream, "404 Not Found").await;
    }
    let requested_range = match range_header.as_deref() {
        Some(value) => match parse_range(value, length) {
            Some(range) => Some(range),
            None => {
                let response = format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{length}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                stream.write_all(response.as_bytes()).await?;
                return stream.shutdown().await;
            }
        },
        None => None,
    };
    let (start, end, status) = requested_range
        .map(|(start, end)| (start, end, "206 Partial Content"))
        .unwrap_or((0, length - 1, "200 OK"));
    let response_length = end - start + 1;
    let content_type = content_type(&path);
    let content_range = requested_range
        .map(|_| format!("Content-Range: bytes {start}-{end}/{length}\r\n"))
        .unwrap_or_default();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nAccept-Ranges: bytes\r\n{content_range}Content-Length: {response_length}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(response.as_bytes()).await?;

    if method == "GET" {
        let mut file = File::open(path).await?;
        file.seek(std::io::SeekFrom::Start(start)).await?;
        let mut remaining = response_length;
        let mut chunk = vec![0_u8; 64 * 1024];
        while remaining > 0 {
            let wanted = remaining.min(chunk.len() as u64) as usize;
            let read = file.read(&mut chunk[..wanted]).await?;
            if read == 0 {
                break;
            }
            stream.write_all(&chunk[..read]).await?;
            remaining -= read as u64;
        }
    }
    stream.shutdown().await
}

fn parse_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') || length == 0 {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(length);
        return (suffix > 0).then_some((length - suffix, length - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= length {
        return None;
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().ok()?.min(length - 1)
    };
    (end >= start).then_some((start, end))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("m4a" | "mp4" | "m4b") => "audio/mp4",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("ogg" | "opus") => "audio/ogg",
        Some("webm") => "audio/webm",
        _ => "application/octet-stream",
    }
}

async fn write_empty_response(stream: &mut TcpStream, status: &str) -> io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn parses_webkit_byte_ranges() {
        assert_eq!(parse_range("bytes=0-1", 100), Some((0, 1)));
        assert_eq!(parse_range("bytes=20-", 100), Some((20, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 100), None);
    }
}
