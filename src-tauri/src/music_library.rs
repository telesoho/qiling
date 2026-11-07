//! 器灵曲库：本机持久化的本地歌曲引用与网络歌曲缓存索引。
//!
//! 曲库只保存"引用"：
//!   - `local` 保存用户选择的绝对路径，不复制文件；
//!   - `remote` 保存 http(s) 音频直链，首次播放时由 `local_music` 下载到
//!     `%APPDATA%/com.qiling.pet/music-cache`，这里只负责索引与展示统计。
//!
//! JSON 写在应用配置目录的 `music-library.json`。解析失败时把原文件备份为
//! `music-library.broken-<时间戳>.json` 再从空曲库启动，避免一次手改坏文件
//! 就让整个音乐功能不可用。

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use data_encoding::HEXLOWER;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

/// 单个音频文件上限。与前端"解码后 10 分钟"一起控制内存峰值。
pub const MAX_AUDIO_BYTES: u64 = 64 * 1024 * 1024;
/// 曲库最多容纳的歌曲数，避免设置页/曲库页一次渲染过多条目。
pub const MAX_TRACKS: usize = 1000;
pub const MAX_NAME_CHARS: usize = 120;
pub const MAX_URL_CHARS: usize = 2048;

pub const SUPPORTED_AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus",
];

/// 文件对话框用的扩展名列表（不带点）。
pub fn supported_extensions() -> &'static [&'static str] {
    SUPPORTED_AUDIO_EXTENSIONS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MusicKind {
    Local,
    Remote,
}

impl MusicKind {
    fn key(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrack {
    pub id: String,
    pub kind: MusicKind,
    pub name: String,
    /// 本地为绝对路径，网络为规范化后的 http(s) URL。
    pub location: String,
    #[serde(default)]
    pub added_at: u64,
    /// 网络歌曲在下载后回填，本地歌曲在添加时按扩展名写入。
    #[serde(default)]
    pub mime: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrackView {
    pub id: String,
    pub kind: MusicKind,
    pub name: String,
    pub location: String,
    pub added_at: u64,
    pub mime: Option<String>,
    /// 本地文件还在；或网络歌曲已有缓存。
    pub available: bool,
    /// 网络歌曲是否已下载到本机缓存。
    pub cached: bool,
    pub cache_bytes: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicLibraryView {
    pub tracks: Vec<MusicTrackView>,
    pub cache: CacheStats,
    /// 曲库 JSON 所在目录，供界面显示"曲库保存在本机"。
    pub storage_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedTrack {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLocalResult {
    pub library: MusicLibraryView,
    pub added_ids: Vec<String>,
    pub rejected: Vec<RejectedTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedLibrary {
    #[serde(default = "library_version")]
    version: u32,
    #[serde(default)]
    tracks: Vec<MusicTrack>,
}

fn library_version() -> u32 {
    1
}

pub struct MusicLibraryStore {
    path: PathBuf,
    cache_dir: PathBuf,
    inner: Mutex<Vec<MusicTrack>>,
}

impl MusicLibraryStore {
    pub fn load(path: PathBuf, cache_dir: PathBuf) -> Self {
        let mut tracks = Vec::new();
        if let Ok(contents) = fs::read_to_string(&path) {
            match serde_json::from_str::<PersistedLibrary>(&contents) {
                Ok(stored) => {
                    let mut seen = HashSet::new();
                    for track in stored.tracks {
                        let Some(track) = sanitize_track(track) else {
                            continue;
                        };
                        let key = track_key(track.kind, &track.location);
                        if seen.insert(key) && tracks.len() < MAX_TRACKS {
                            tracks.push(track);
                        }
                    }
                }
                Err(_) => backup_broken(&path),
            }
        }
        let _ = fs::create_dir_all(&cache_dir);
        Self {
            path,
            cache_dir,
            inner: Mutex::new(tracks),
        }
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    pub fn view(&self) -> MusicLibraryView {
        let tracks = self
            .inner
            .lock()
            .map(|data| data.clone())
            .unwrap_or_default();
        self.view_of(&tracks)
    }

    pub fn track(&self, id: &str) -> Option<MusicTrack> {
        self.inner
            .lock()
            .ok()
            .and_then(|data| data.iter().find(|track| track.id == id).cloned())
    }

    pub fn add_local(&self, paths: Vec<String>) -> Result<AddLocalResult, String> {
        let mut data = self
            .inner
            .lock()
            .map_err(|_| "music_library_unavailable".to_string())?;
        let mut added_ids = Vec::new();
        let mut rejected = Vec::new();
        for raw in paths {
            let raw = raw.trim().to_string();
            if raw.is_empty() {
                continue;
            }
            let path = PathBuf::from(&raw);
            if let Err(reason) = validate_local_audio(&raw) {
                rejected.push(RejectedTrack {
                    name: display_local_name(&raw),
                    reason,
                });
                continue;
            }
            let identity = raw.to_lowercase();
            if data.iter().any(|track| {
                track.kind == MusicKind::Local && track.location.to_lowercase() == identity
            }) {
                continue;
            }
            if data.len() >= MAX_TRACKS {
                rejected.push(RejectedTrack {
                    name: display_local_name(&raw),
                    reason: "music_library_full".to_string(),
                });
                continue;
            }
            let track = MusicTrack {
                id: id_for(MusicKind::Local, &identity),
                kind: MusicKind::Local,
                name: display_local_name(&raw),
                location: raw,
                added_at: now_ms(),
                mime: mime_for_path(&path),
            };
            added_ids.push(track.id.clone());
            data.push(track);
        }
        save_locked(&self.path, &data)?;
        let view = self.view_of(&data);
        Ok(AddLocalResult {
            library: view,
            added_ids,
            rejected,
        })
    }

    pub fn add_remote(&self, name: String, url: String) -> Result<MusicLibraryView, String> {
        let (location, parsed) = normalize_remote_url(&url)?;
        let mut data = self
            .inner
            .lock()
            .map_err(|_| "music_library_unavailable".to_string())?;
        if data
            .iter()
            .any(|track| track.kind == MusicKind::Remote && track.location == location)
        {
            return Ok(self.view_of(&data));
        }
        if data.len() >= MAX_TRACKS {
            return Err("music_library_full".to_string());
        }
        let track = MusicTrack {
            id: id_for(MusicKind::Remote, &location),
            kind: MusicKind::Remote,
            name: remote_display_name(&name, &parsed),
            location,
            added_at: now_ms(),
            mime: None,
        };
        data.push(track);
        save_locked(&self.path, &data)?;
        Ok(self.view_of(&data))
    }

    pub fn remove(&self, id: &str) -> Result<MusicLibraryView, String> {
        let mut data = self
            .inner
            .lock()
            .map_err(|_| "music_library_unavailable".to_string())?;
        let removed = data
            .iter()
            .find(|track| track.id == id)
            .cloned();
        data.retain(|track| track.id != id);
        if let Some(track) = removed {
            if track.kind == MusicKind::Remote {
                let _ = fs::remove_file(cache_path(&self.cache_dir, &track.location));
                let _ = fs::remove_file(cache_part_path(&self.cache_dir, &track.location));
            }
        }
        save_locked(&self.path, &data)?;
        Ok(self.view_of(&data))
    }

    pub fn clear(&self) -> Result<MusicLibraryView, String> {
        let mut data = self
            .inner
            .lock()
            .map_err(|_| "music_library_unavailable".to_string())?;
        data.clear();
        save_locked(&self.path, &data)?;
        let _ = remove_cache_files(&self.cache_dir);
        Ok(self.view_of(&data))
    }

    /// 只删网络缓存，不动曲目；下次播放会重新下载。
    pub fn clear_cache(&self) -> Result<CacheStats, String> {
        let stats = cache_stats(&self.cache_dir);
        remove_cache_files(&self.cache_dir)?;
        Ok(stats)
    }

    /// 网络下载完成后回填 MIME，避免前端只能靠扩展名猜。
    pub fn set_mime(&self, id: &str, mime: &str) -> Result<(), String> {
        let mut data = self
            .inner
            .lock()
            .map_err(|_| "music_library_unavailable".to_string())?;
        let Some(track) = data.iter_mut().find(|track| track.id == id) else {
            return Err("music_track_missing".to_string());
        };
        if track.mime.as_deref() == Some(mime) {
            return Ok(());
        }
        track.mime = Some(mime.to_string());
        save_locked(&self.path, &data)
    }

    fn view_of(&self, data: &[MusicTrack]) -> MusicLibraryView {
        let tracks = data
            .iter()
            .map(|track| {
                let path = Path::new(&track.location);
                let (available, cached, cache_bytes) = match track.kind {
                    MusicKind::Local => (path.is_file(), false, 0),
                    MusicKind::Remote => {
                        let cache = cache_path(&self.cache_dir, &track.location);
                        match fs::metadata(&cache) {
                            Ok(meta) if meta.is_file() && meta.len() > 0 => {
                                (true, true, meta.len())
                            }
                            _ => (false, false, 0),
                        }
                    }
                };
                let mime = track.mime.clone().or_else(|| {
                    if track.kind == MusicKind::Local {
                        mime_for_path(path)
                    } else {
                        None
                    }
                });
                MusicTrackView {
                    id: track.id.clone(),
                    kind: track.kind,
                    name: track.name.clone(),
                    location: track.location.clone(),
                    added_at: track.added_at,
                    mime,
                    available,
                    cached,
                    cache_bytes,
                }
            })
            .collect();
        MusicLibraryView {
            tracks,
            cache: cache_stats(&self.cache_dir),
            storage_dir: self
                .path
                .parent()
                .map(|dir| dir.to_string_lossy().to_string())
                .unwrap_or_default(),
        }
    }
}

fn sanitize_track(mut track: MusicTrack) -> Option<MusicTrack> {
    track.name = truncate_chars(track.name.trim(), MAX_NAME_CHARS);
    if track.name.is_empty() {
        track.name = "未命名".to_string();
    }
    match track.kind {
        MusicKind::Local => {
            if track.location.trim().is_empty() {
                return None;
            }
            track.location = track.location.trim().to_string();
            track.id = id_for(MusicKind::Local, &track.location.to_lowercase());
        }
        MusicKind::Remote => {
            let (location, _) = normalize_remote_url(&track.location).ok()?;
            track.location = location;
            track.id = id_for(MusicKind::Remote, &track.location);
        }
    }
    if let Some(mime) = track.mime.take() {
        let mime = mime.trim();
        if !mime.is_empty() && mime.len() <= 64 {
            track.mime = Some(mime.to_string());
        }
    }
    Some(track)
}

pub fn track_key(kind: MusicKind, location: &str) -> String {
    format!("{}:{}", kind.key(), location.to_lowercase())
}

fn id_for(kind: MusicKind, location: &str) -> String {
    let digest = Sha256::digest(track_key(kind, location).as_bytes());
    HEXLOWER.encode(&digest)[..16].to_string()
}

fn save_locked(path: &Path, tracks: &[MusicTrack]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "music_library_unavailable".to_string())?;
    }
    let persisted = PersistedLibrary {
        version: 1,
        tracks: tracks.to_vec(),
    };
    let contents =
        serde_json::to_vec(&persisted).map_err(|_| "music_library_unavailable".to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents).map_err(|_| "music_library_unavailable".to_string())?;
    if fs::rename(&tmp, path).is_err() {
        // Windows 上 rename 不能覆盖已存在的文件。
        let _ = fs::remove_file(path);
        fs::rename(&tmp, path).map_err(|_| "music_library_unavailable".to_string())?;
    }
    Ok(())
}

fn backup_broken(path: &Path) {
    let stamp = now_ms();
    let backup = path.with_file_name(format!("music-library.broken-{stamp}.json"));
    let _ = fs::rename(path, backup);
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

pub fn is_supported_audio_extension(extension: &str) -> bool {
    SUPPORTED_AUDIO_EXTENSIONS
        .iter()
        .any(|supported| supported.eq_ignore_ascii_case(extension))
}

pub fn mime_for_path(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?;
    mime_for_extension(extension)
}

pub fn mime_for_extension(extension: &str) -> Option<String> {
    let extension = extension.to_ascii_lowercase();
    let mime = match extension.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        _ => return None,
    };
    Some(mime.to_string())
}

/// 本地曲目校验：扩展名、文件存在、大小上限。读取前还会再调一次。
pub fn validate_local_audio(location: &str) -> Result<(), String> {
    let path = Path::new(location);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "music_format_unsupported".to_string())?;
    if !is_supported_audio_extension(extension) {
        return Err("music_format_unsupported".to_string());
    }
    let meta = fs::metadata(path).map_err(|_| "music_file_missing".to_string())?;
    if !meta.is_file() {
        return Err("music_file_missing".to_string());
    }
    if meta.len() > MAX_AUDIO_BYTES {
        return Err("music_file_too_large".to_string());
    }
    Ok(())
}

pub fn display_local_name(location: &str) -> String {
    let path = Path::new(location);
    let name = path
        .file_stem()
        .or_else(|| path.file_name())
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = name.trim();
    if name.is_empty() {
        "本地音乐".to_string()
    } else {
        truncate_chars(name, MAX_NAME_CHARS)
    }
}

/// 只接受 http(s) 直链；返回规范化后的 URL 字符串与原 URL。
pub fn normalize_remote_url(raw: &str) -> Result<(String, Url), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_URL_CHARS {
        return Err("music_remote_url_invalid".to_string());
    }
    let url = Url::parse(trimmed).map_err(|_| "music_remote_url_invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("music_remote_url_invalid".to_string());
    }
    Ok((url.to_string(), url))
}

pub fn remote_display_name(name: &str, url: &Url) -> String {
    let trimmed = truncate_chars(name.trim(), MAX_NAME_CHARS);
    if !trimmed.is_empty() {
        return trimmed;
    }
    let last_segment = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or("");
    let stem = last_segment.split('.').next().unwrap_or("");
    if !stem.is_empty() {
        return truncate_chars(stem, MAX_NAME_CHARS);
    }
    let host = url.host_str().unwrap_or("网络歌曲");
    truncate_chars(host, MAX_NAME_CHARS)
}

pub fn cache_file_name(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    format!("{}.audio", &HEXLOWER.encode(&digest)[..32])
}

pub fn cache_path(cache_dir: &Path, url: &str) -> PathBuf {
    cache_dir.join(cache_file_name(url))
}

pub fn cache_part_path(cache_dir: &Path, url: &str) -> PathBuf {
    cache_dir.join(format!("{}.part", cache_file_name(url)))
}

pub fn cache_stats(cache_dir: &Path) -> CacheStats {
    let mut stats = CacheStats { files: 0, bytes: 0 };
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return stats;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_file() {
            stats.files += 1;
            stats.bytes += meta.len();
        }
    }
    stats
}

fn remove_cache_files(cache_dir: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(cache_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("music_library_unavailable".to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let root = std::env::var("CARGO_TARGET_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("target")
                    .join("tmp")
            });
        let dir = root.join(format!("qiling-music-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store(dir: &Path) -> MusicLibraryStore {
        MusicLibraryStore::load(dir.join("music-library.json"), dir.join("music-cache"))
    }

    fn fake_track(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        fs::write(&path, b"ID3demo").unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    fn adds_local_tracks_once_and_rejects_bad_files() {
        let dir = temp_dir("add-local");
        let store = store(&dir);
        let song = fake_track(&dir, "song.mp3");
        let result = store
            .add_local(vec![song.clone(), song, "C:/nope/missing.mp3".into(), "C:/nope/a.txt".into()])
            .unwrap();
        assert_eq!(result.added_ids.len(), 1);
        assert_eq!(result.library.tracks.len(), 1);
        assert_eq!(result.rejected.len(), 2);
        assert_eq!(result.library.tracks[0].name, "song");
        assert_eq!(result.library.tracks[0].mime.as_deref(), Some("audio/mpeg"));
        assert!(result.library.tracks[0].available);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn persists_and_reloads_the_library() {
        let dir = temp_dir("persist");
        let song = fake_track(&dir, "persist.flac");
        let library_path = dir.join("music-library.json");
        let cache_dir = dir.join("music-cache");
        {
            let store = MusicLibraryStore::load(library_path.clone(), cache_dir.clone());
            store.add_local(vec![song]).unwrap();
        }
        let reloaded = MusicLibraryStore::load(library_path, cache_dir);
        let view = reloaded.view();
        assert_eq!(view.tracks.len(), 1);
        assert_eq!(view.tracks[0].name, "persist");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_bad_remote_urls_and_dedupes_good_ones() {
        let dir = temp_dir("remote");
        let store = store(&dir);
        assert!(store.add_remote(String::new(), "file:///a.mp3".into()).is_err());
        assert!(store.add_remote(String::new(), "https://".into()).is_err());
        let view = store
            .add_remote("我的歌".into(), "https://example.com/a.mp3".into())
            .unwrap();
        assert_eq!(view.tracks.len(), 1);
        assert_eq!(view.tracks[0].name, "我的歌");
        let view = store
            .add_remote(String::new(), "https://example.com/a.mp3".into())
            .unwrap();
        assert_eq!(view.tracks.len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn derives_remote_name_from_url() {
        let dir = temp_dir("remote-name");
        let store = store(&dir);
        let view = store
            .add_remote(String::new(), "https://example.com/audio/hello.mp3?token=1".into())
            .unwrap();
        assert_eq!(view.tracks[0].name, "hello");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn starts_empty_when_the_library_json_is_broken() {
        let dir = temp_dir("broken");
        let library_path = dir.join("music-library.json");
        fs::write(&library_path, b"{not json").unwrap();
        let store = MusicLibraryStore::load(library_path.clone(), dir.join("music-cache"));
        assert!(store.view().tracks.is_empty());
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains("broken-"))
            .collect();
        assert_eq!(backups.len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reports_cache_usage_and_clears_it() {
        let dir = temp_dir("cache");
        let cache_dir = dir.join("music-cache");
        fs::create_dir_all(&cache_dir).unwrap();
        let store = store(&dir);
        let url = "https://example.com/cache.mp3";
        let cache = cache_path(&cache_dir, url);
        fs::write(&cache, b"12345678").unwrap();
        store.add_remote(String::new(), url.into()).unwrap();
        let view = store.view();
        assert_eq!(view.cache.files, 1);
        assert_eq!(view.cache.bytes, 8);
        assert!(view.tracks[0].cached);
        assert_eq!(view.tracks[0].cache_bytes, 8);
        let stats = store.clear_cache().unwrap();
        assert_eq!(stats.files, 1);
        assert_eq!(store.view().cache.files, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn removes_remote_track_and_its_cache() {
        let dir = temp_dir("remove");
        let cache_dir = dir.join("music-cache");
        fs::create_dir_all(&cache_dir).unwrap();
        let store = store(&dir);
        let url = "https://example.com/remove.mp3";
        let view = store.add_remote(String::new(), url.into()).unwrap();
        let id = view.tracks[0].id.clone();
        let cache = cache_path(&cache_dir, url);
        fs::write(&cache, b"1234").unwrap();
        let view = store.remove(&id).unwrap();
        assert!(view.tracks.is_empty());
        assert!(!cache.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn validate_local_audio_checks_extension_size_and_existence() {
        assert_eq!(
            validate_local_audio("C:/nope/a.txt"),
            Err("music_format_unsupported".to_string())
        );
        assert_eq!(
            validate_local_audio("C:/nope/missing.mp3"),
            Err("music_file_missing".to_string())
        );
    }
}