//! 曲库曲目的音频读取与网络歌曲下载缓存。
//!
//! - 本地曲目：校验扩展名/存在/大小后直接读文件；
//! - 网络曲目：命中 `music-cache/<sha256(url)>.audio` 就直接读，否则用 `ureq`
//!   下载到临时文件再改名，并通过 `qiling-music-download` 上报进度。
//!
//! 所有网络歌曲都是用户主动添加的 http(s) 直链；这里只负责把音频取回本机，
//! 不上传任何内容。

use std::{
    fs,
    io::Read,
    path::Path,
    time::{Duration, Instant},
};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::music_library::{
    cache_part_path, cache_path, validate_local_audio, MusicKind, MusicLibraryStore, MAX_AUDIO_BYTES,
};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// 读一首曲目的原始字节。网络曲目首次读取时会下载并缓存。
pub fn read_track_audio(
    app: &AppHandle,
    store: &MusicLibraryStore,
    id: &str,
) -> Result<Vec<u8>, String> {
    read_track_audio_with(store, id, |received, total, done| {
        emit_download(app, id, received, total, done)
    })
}

/// 与 `read_track_audio` 相同，但进度通过回调上报，便于单测不依赖 Tauri。
pub fn read_track_audio_with<F>(
    store: &MusicLibraryStore,
    id: &str,
    mut progress: F,
) -> Result<Vec<u8>, String>
where
    F: FnMut(u64, u64, bool),
{
    let track = store
        .track(id)
        .ok_or_else(|| "music_track_missing".to_string())?;
    match track.kind {
        MusicKind::Local => {
            validate_local_audio(&track.location)?;
            fs::read(&track.location).map_err(|_| "music_file_missing".to_string())
        }
        MusicKind::Remote => {
            let cached = cache_path(store.cache_dir(), &track.location);
            if let Ok(bytes) = fs::read(&cached) {
                if !bytes.is_empty() {
                    return Ok(bytes);
                }
            }
            let (bytes, mime) = fetch_remote_with(&track.location, store.cache_dir(), |received, total, done| {
                progress(received, total, done)
            })?;
            if let Some(mime) = mime {
                let _ = store.set_mime(id, &mime);
            }
            Ok(bytes)
        }
    }
}

fn fetch_remote_with<F>(
    url: &str,
    cache_dir: &Path,
    mut progress: F,
) -> Result<(Vec<u8>, Option<String>), String>
where
    F: FnMut(u64, u64, bool),
{
    fs::create_dir_all(cache_dir).map_err(|_| "music_library_unavailable".to_string())?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .timeout(DOWNLOAD_TIMEOUT)
        .redirects(5)
        .user_agent("qiling/0.1 (local desktop pet)")
        .build();
    let response = agent
        .get(url)
        .call()
        .map_err(|error| fetch_error(&error))?;
    let content_type = response
        .header("content-type")
        .map(|value| value.to_string());
    if let Some(value) = content_type.as_deref() {
        if !content_type_acceptable(value) {
            return Err("music_remote_not_audio".to_string());
        }
    }
    let total = response
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    if total > MAX_AUDIO_BYTES {
        return Err("music_download_too_large".to_string());
    }

    progress(0, total, false);
    let mut reader = response.into_reader();
    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    let mut buffer = [0u8; 64 * 1024];
    let mut last_emit = Instant::now();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "music_download_failed".to_string())?;
        if read == 0 {
            break;
        }
        if bytes.len() as u64 + read as u64 > MAX_AUDIO_BYTES {
            return Err("music_download_too_large".to_string());
        }
        bytes.extend_from_slice(&buffer[..read]);
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            progress(bytes.len() as u64, total, false);
        }
    }
    if bytes.is_empty() {
        return Err("music_download_failed".to_string());
    }

    let declared = content_type
        .as_deref()
        .and_then(normalize_content_type)
        .filter(|mime| mime.starts_with("audio/") || mime == "video/mp4");
    let mime = declared.or_else(|| sniff_mime(&bytes).map(str::to_string));
    let Some(mime) = mime else {
        return Err("music_remote_not_audio".to_string());
    };

    let part = cache_part_path(cache_dir, url);
    fs::write(&part, &bytes).map_err(|_| "music_library_unavailable".to_string())?;
    let cache = cache_path(cache_dir, url);
    if fs::rename(&part, &cache).is_err() {
        let _ = fs::remove_file(&cache);
        fs::rename(&part, &cache).map_err(|_| "music_library_unavailable".to_string())?;
    }
    progress(bytes.len() as u64, total, true);
    Ok((bytes, Some(mime)))
}

fn emit_download(app: &AppHandle, track_id: &str, received: u64, total: u64, done: bool) {
    let _ = app.emit(
        "qiling-music-download",
        json!({
            "trackId": track_id,
            "received": received,
            "total": total,
            "done": done,
        }),
    );
}

fn fetch_error(error: &ureq::Error) -> String {
    match error {
        ureq::Error::Status(_, _) => "music_download_failed".to_string(),
        ureq::Error::Transport(transport) => {
            let text = transport.to_string().to_ascii_lowercase();
            if text.contains("timed out") || text.contains("timeout") {
                "music_download_timeout".to_string()
            } else {
                "music_download_failed".to_string()
            }
        }
    }
}

pub fn normalize_content_type(value: &str) -> Option<String> {
    let mime = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if mime.is_empty() {
        None
    } else {
        Some(mime)
    }
}

pub fn content_type_acceptable(value: &str) -> bool {
    let Some(mime) = normalize_content_type(value) else {
        return true;
    };
    mime.starts_with("audio/")
        || mime == "application/octet-stream"
        || mime == "binary/octet-stream"
        || mime == "video/mp4"
}

/// 看文件头判断常见音频格式；服务器不给 content-type 时作为兜底。
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 3 && &bytes[..3] == b"ID3" {
        return Some("audio/mpeg");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return Some("audio/wav");
    }
    if bytes.len() >= 4 && &bytes[..4] == b"fLaC" {
        return Some("audio/flac");
    }
    if bytes.len() >= 4 && &bytes[..4] == b"OggS" {
        return Some("audio/ogg");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some("audio/mp4");
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xF6) == 0xF0 {
        return Some("audio/aac");
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0 {
        return Some("audio/mpeg");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::music_library::MusicLibraryStore;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        path::PathBuf,
        thread,
    };

    fn temp_dir(tag: &str) -> PathBuf {
        let root = std::env::var("CARGO_TARGET_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("target")
                    .join("tmp")
            });
        let dir = root.join(format!("qiling-local-music-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store(dir: &Path) -> MusicLibraryStore {
        MusicLibraryStore::load(dir.join("library.json"), dir.join("cache"))
    }

    /// 起一个只服务一次请求的本机 HTTP 服务器，返回 URL。
    fn serve_once(body: Vec<u8>, content_type: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let content_type = content_type.to_string();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            }
        });
        format!("http://{address}/song.wav")
    }

    const WAV_BODY: &[u8] = b"RIFF....WAVEfmt ";

    #[test]
    fn downloads_remote_tracks_and_reuses_the_cache() {
        let dir = temp_dir("download");
        let store = store(&dir);
        let url = serve_once(WAV_BODY.to_vec(), "audio/wav");
        let view = store.add_remote(String::new(), url).unwrap();
        let id = view.tracks[0].id.clone();
        let mut progress_calls = 0;
        let bytes = read_track_audio_with(&store, &id, |_, _, _| progress_calls += 1).unwrap();
        assert_eq!(bytes, WAV_BODY);
        assert!(progress_calls >= 1);

        let view = store.view();
        assert!(view.tracks[0].cached);
        assert_eq!(view.tracks[0].mime.as_deref(), Some("audio/wav"));

        // 服务器已经退出：第二次读取必须命中缓存，而不是再联网。
        let again = read_track_audio_with(&store, &id, |_, _, _| {}).unwrap();
        assert_eq!(again, WAV_BODY);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_non_audio_responses() {
        let dir = temp_dir("html");
        let store = store(&dir);
        let url = serve_once(b"<html>nope</html>".to_vec(), "text/html");
        let view = store.add_remote(String::new(), url).unwrap();
        let id = view.tracks[0].id.clone();
        let result = read_track_audio_with(&store, &id, |_, _, _| {});
        assert_eq!(result, Err("music_remote_not_audio".to_string()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sniffs_audio_when_the_server_sends_octet_stream() {
        let dir = temp_dir("octet");
        let store = store(&dir);
        let url = serve_once(WAV_BODY.to_vec(), "application/octet-stream");
        let view = store.add_remote(String::new(), url).unwrap();
        let id = view.tracks[0].id.clone();
        let bytes = read_track_audio_with(&store, &id, |_, _, _| {}).unwrap();
        assert_eq!(bytes, WAV_BODY);
        assert_eq!(
            store.view().tracks[0].mime.as_deref(),
            Some("audio/wav")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn accepts_audio_and_generic_content_types() {
        assert!(content_type_acceptable("audio/mpeg"));
        assert!(content_type_acceptable("audio/mpeg; charset=binary"));
        assert!(content_type_acceptable("application/octet-stream"));
        assert!(content_type_acceptable("video/mp4"));
        assert!(content_type_acceptable(""));
        assert!(!content_type_acceptable("text/html"));
        assert!(!content_type_acceptable("application/json"));
    }

    #[test]
    fn sniffs_common_audio_magic() {
        assert_eq!(sniff_mime(b"ID3xxxx"), Some("audio/mpeg"));
        assert_eq!(sniff_mime(b"RIFF....WAVEfmt "), Some("audio/wav"));
        assert_eq!(sniff_mime(b"fLaCxxxx"), Some("audio/flac"));
        assert_eq!(sniff_mime(b"OggSxxxx"), Some("audio/ogg"));
        assert_eq!(sniff_mime(b"....ftypM4A "), Some("audio/mp4"));
        assert_eq!(sniff_mime(b"\xFF\xF1\x50\x80"), Some("audio/aac"));
        assert_eq!(sniff_mime(b"\xFF\xFB\x90\x00"), Some("audio/mpeg"));
        assert_eq!(sniff_mime(b"<html>"), None);
    }

    #[test]
    fn normalizes_content_type_with_parameters() {
        assert_eq!(
            normalize_content_type(" Audio/MPEG ; charset=utf-8 "),
            Some("audio/mpeg".to_string())
        );
        assert_eq!(normalize_content_type("  "), None);
    }
}