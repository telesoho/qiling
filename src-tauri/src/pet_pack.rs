//! 角色资源包（.qilingpet）安装、注册与运行时读取。
//!
//! 资源包是自包含 ZIP：根目录 `pet.json`，动画在 `tracks/<action>/`。
//! 安装时按 `docs/multi-character-animation-spec.md` 的约定编译运行时条目：
//!   id   = `<characterId>-<action>`
//!   tags = [action, characterId]（姿势动作再加 "pose"）
//! 运行时按“当前角色 ∩ 动作”取轨。
//!
//! 内置角色有两位：灵泡（`lingpao`，SVG 骨架，默认）与诗琚（`shiju`，位图轨，
//! 走 bake 产物）。资源包可以安装第二、第三位角色，但不能占用内置 id。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::http::{header, Request, Response, StatusCode};
use uuid::Uuid;
use zip::ZipArchive;

pub const DEFAULT_BUILTIN_ID: &str = "lingpao";
pub const SHIJU_ID: &str = "shiju";
const STATE_FILE: &str = "state.json";
const SCHEMA_VERSION: u32 = 1;
/// 内置角色默认值的版本。旧版本只有诗琚，`lingpao` 上线后迁移一次。
const DEFAULTS_VERSION: u32 = 2;

/// 角色用哪种渲染器。资源包与诗琚都是烘焙好的 WebP 轨；灵泡是内联 SVG。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CharacterRenderer {
    Svg,
    Webp,
}

#[derive(Debug, Clone, Copy)]
pub struct BuiltinCharacter {
    pub id: &'static str,
    pub name: &'static str,
    pub renderer: CharacterRenderer,
    pub thumbnail: &'static str,
}

/// 内置角色表。顺序即资源包页的排列顺序，第一位是默认角色。
pub const BUILTINS: [BuiltinCharacter; 2] = [
    BuiltinCharacter {
        id: DEFAULT_BUILTIN_ID,
        name: "灵泡",
        renderer: CharacterRenderer::Svg,
        thumbnail: "/pet/lingpao/thumb.svg",
    },
    BuiltinCharacter {
        id: SHIJU_ID,
        name: "诗琚",
        renderer: CharacterRenderer::Webp,
        thumbnail: "/pet/idle.webp",
    },
];
const MAX_ARCHIVE_BYTES: u64 = 96 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FRAMES_PER_TRACK: u64 = 2_000;
const MAX_PHASES: usize = 16;
const MAX_TRACKS: usize = 32;
const MAX_IDLE_BEATS: usize = 4;
const CORE_ACTIONS: [&str; 5] = ["idle", "think", "explain", "advantage", "disadvantage"];
const POSE_ACTIONS: [&str; 4] = ["think", "explain", "advantage", "disadvantage"];
const RESERVED_ACTIONS: [&str; 2] = ["pose", "breath"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PickupMode {
    Animated,
    WindowOnly,
}

impl Default for PickupMode {
    fn default() -> Self {
        Self::Animated
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPackManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub pickup: PickupMode,
    #[serde(default)]
    pub idle_beats: Vec<IdleBeatDecl>,
    #[serde(default)]
    pub tracks: Vec<TrackDecl>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleBeatDecl {
    pub action: String,
    pub line: String,
    #[serde(default)]
    pub ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackDecl {
    pub action: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone)]
struct CompiledTrack {
    id: String,
    display_name: String,
    tags: Vec<String>,
    path: String,
}

#[derive(Debug, Clone)]
struct InstalledPack {
    manifest: PetPackManifest,
    dir: PathBuf,
    installed_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackState {
    #[serde(default = "state_schema_version")]
    schema_version: u32,
    #[serde(default = "default_active_id")]
    active: String,
    /// 内置角色默认值的迁移标记；缺失时为 0，按旧版本处理一次。
    #[serde(default)]
    defaults_version: u32,
    #[serde(default)]
    installed_at: BTreeMap<String, u64>,
}

impl Default for PackState {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            active: DEFAULT_BUILTIN_ID.to_string(),
            defaults_version: DEFAULTS_VERSION,
            installed_at: BTreeMap::new(),
        }
    }
}

fn state_schema_version() -> u32 {
    SCHEMA_VERSION
}

fn default_active_id() -> String {
    DEFAULT_BUILTIN_ID.to_string()
}

fn builtin_character(id: &str) -> &'static BuiltinCharacter {
    BUILTINS
        .iter()
        .find(|item| item.id == id)
        .unwrap_or(&BUILTINS[0])
}

fn is_builtin_id(id: &str) -> bool {
    BUILTINS.iter().any(|item| item.id == id)
}

/// 旧版本只有诗琚一位内置角色。升级时把默认选择迁到灵泡一次；
/// 迁移标记落盘后，用户显式选回诗琚就不会再被覆盖。
fn migrate_defaults(state: &mut PackState) {
    if state.defaults_version >= DEFAULTS_VERSION {
        return;
    }
    if state.active == SHIJU_ID {
        state.active = DEFAULT_BUILTIN_ID.to_string();
    }
    state.defaults_version = DEFAULTS_VERSION;
}

struct Inner {
    packs: BTreeMap<String, InstalledPack>,
    state: PackState,
}

pub struct PetPackRegistry {
    root: PathBuf,
    inner: RwLock<Inner>,
    install_lock: Mutex<()>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveCharacter {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    pub renderer: CharacterRenderer,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSummary {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    pub active: bool,
    pub renderer: CharacterRenderer,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pickup_mode: Option<PickupMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacksView {
    pub active_id: String,
    pub storage_dir: String,
    pub characters: Vec<CharacterSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackTrackEntry {
    pub id: String,
    pub display_name: Option<String>,
    pub tags: Vec<String>,
    pub path: String,
    #[serde(rename = "struct")]
    pub structure: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRuntime {
    pub character: ActiveCharacter,
    pub asset_base: String,
    pub tracks: Vec<PackTrackEntry>,
    pub idle_beats: Vec<IdleBeatDecl>,
}

impl PetPackRegistry {
    pub fn load(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|_| "pack_io_failed".to_string())?;
        let staging = root.join(".staging");
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::create_dir_all(&staging);
        // 上次卸载/替换留下的目录：删除失败就留着，下次启动再试。
        let _ = fs::remove_dir_all(root.join(".trash"));

        let mut state = read_state(&root);
        let mut packs = BTreeMap::new();
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let dir = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if !dir.is_dir() || name.starts_with('.') {
                    continue;
                }
                let Ok(bytes) = fs::read(dir.join("pet.json")) else {
                    continue;
                };
                let Ok(manifest) = serde_json::from_slice::<PetPackManifest>(&bytes) else {
                    continue;
                };
                if manifest.id != name || validate_manifest(&manifest).is_err() {
                    continue;
                }
                let installed_at = state.installed_at.get(&manifest.id).copied();
                packs.insert(
                    manifest.id.clone(),
                    InstalledPack {
                        manifest,
                        dir,
                        installed_at,
                    },
                );
            }
        }
        if !is_builtin_id(&state.active) && !packs.contains_key(&state.active) {
            state.active = DEFAULT_BUILTIN_ID.to_string();
        }
        state.installed_at.retain(|id, _| packs.contains_key(id));
        let registry = Self {
            root,
            inner: RwLock::new(Inner { packs, state }),
            install_lock: Mutex::new(()),
        };
        registry.persist()?;
        Ok(registry)
    }

    pub fn active_character(&self) -> ActiveCharacter {
        let inner = match self.inner.read() {
            Ok(inner) => inner,
            Err(_) => return builtin_active(DEFAULT_BUILTIN_ID),
        };
        active_from_inner(&inner)
    }

    pub fn packs_view(&self) -> PacksView {
        let inner = match self.inner.read() {
            Ok(inner) => inner,
            Err(_) => {
                return PacksView {
                    active_id: DEFAULT_BUILTIN_ID.to_string(),
                    storage_dir: self.root.to_string_lossy().to_string(),
                    characters: BUILTINS
                        .iter()
                        .map(|builtin| builtin_summary(builtin, builtin.id == DEFAULT_BUILTIN_ID))
                        .collect(),
                }
            }
        };
        let mut characters: Vec<CharacterSummary> = BUILTINS
            .iter()
            .map(|builtin| builtin_summary(builtin, inner.state.active == builtin.id))
            .collect();
        for pack in inner.packs.values() {
            characters.push(summary_for(pack, &inner.state));
        }
        PacksView {
            active_id: inner.state.active.clone(),
            storage_dir: self.root.to_string_lossy().to_string(),
            characters,
        }
    }

    pub fn install(&self, archive: &Path, replace: bool) -> Result<CharacterSummary, String> {
        let _guard = self
            .install_lock
            .lock()
            .map_err(|_| "pack_busy".to_string())?;
        let meta = fs::metadata(archive).map_err(|_| "pack_file_unreadable".to_string())?;
        if !meta.is_file() {
            return Err("pack_file_unreadable".into());
        }
        if meta.len() > MAX_ARCHIVE_BYTES {
            return Err("pack_too_large".into());
        }
        let staging_parent = self.root.join(".staging");
        fs::create_dir_all(&staging_parent).map_err(|_| "pack_io_failed".to_string())?;
        let staging = staging_parent.join(Uuid::new_v4().to_string());
        fs::create_dir_all(&staging).map_err(|_| "pack_io_failed".to_string())?;

        let prepared = (|| -> Result<PetPackManifest, String> {
            let manifest = extract_pack(archive, &staging)?;
            validate_manifest(&manifest)?;
            validate_pack_contents(&staging, &manifest)?;
            Ok(manifest)
        })();
        let manifest = match prepared {
            Ok(manifest) => manifest,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
        };

        let pack_id = manifest.id.clone();
        let final_dir = self.root.join(&pack_id);
        let mut inner = self
            .inner
            .write()
            .map_err(|_| "pack_io_failed".to_string())?;
        if final_dir.exists() && !replace {
            let _ = fs::remove_dir_all(&staging);
            return Err("pack_exists".into());
        }
        let trash = self.root.join(".trash").join(Uuid::new_v4().to_string());
        if final_dir.exists() {
            let _ = fs::create_dir_all(self.root.join(".trash"));
            if fs::rename(&final_dir, &trash).is_err() && fs::remove_dir_all(&final_dir).is_err() {
                let _ = fs::remove_dir_all(&staging);
                return Err("pack_in_use".into());
            }
        }
        if fs::rename(&staging, &final_dir).is_err() {
            let _ = fs::remove_dir_all(&staging);
            if trash.exists() {
                let _ = fs::rename(&trash, &final_dir);
            }
            return Err("pack_io_failed".into());
        }

        let installed_at = now_secs();
        inner.packs.insert(
            pack_id.clone(),
            InstalledPack {
                manifest,
                dir: final_dir,
                installed_at: Some(installed_at),
            },
        );
        inner
            .state
            .installed_at
            .insert(pack_id.clone(), installed_at);
        let summary = inner
            .packs
            .get(&pack_id)
            .map(|pack| summary_for(pack, &inner.state))
            .ok_or_else(|| "pack_io_failed".to_string())?;
        let persisted = persist_state(&self.root, &inner.state);
        drop(inner);
        let _ = fs::remove_dir_all(&trash);
        persisted?;
        Ok(summary)
    }

    pub fn uninstall(&self, pack_id: &str) -> Result<ActiveCharacter, String> {
        if is_builtin_id(pack_id) {
            return Err("pack_builtin_protected".into());
        }
        let _guard = self
            .install_lock
            .lock()
            .map_err(|_| "pack_busy".to_string())?;
        let mut inner = self
            .inner
            .write()
            .map_err(|_| "pack_io_failed".to_string())?;
        let pack = inner
            .packs
            .get(pack_id)
            .cloned()
            .ok_or_else(|| "pack_not_found".to_string())?;
        let trash = self.root.join(".trash").join(Uuid::new_v4().to_string());
        let _ = fs::create_dir_all(self.root.join(".trash"));
        // 先把目录挪出安装位置；日后再删。这样即使 WebView 还开着图片，
        // 也不会在重启后被重新扫描成“已安装”。
        if fs::rename(&pack.dir, &trash).is_err() && fs::remove_dir_all(&pack.dir).is_err() {
            return Err("pack_in_use".into());
        }
        inner.packs.remove(pack_id);
        inner.state.installed_at.remove(pack_id);
        if inner.state.active == pack_id {
            inner.state.active = DEFAULT_BUILTIN_ID.to_string();
        }
        let active = active_from_inner(&inner);
        let persisted = persist_state(&self.root, &inner.state);
        drop(inner);
        let _ = fs::remove_dir_all(&trash);
        persisted?;
        Ok(active)
    }

    pub fn set_active(&self, pack_id: &str) -> Result<ActiveCharacter, String> {
        // 先按运行时读取一遍，避免把一个图片被删/改坏的包设为当前角色。
        if !is_builtin_id(pack_id) {
            self.load_runtime(pack_id)?;
        }
        let mut inner = self
            .inner
            .write()
            .map_err(|_| "pack_io_failed".to_string())?;
        if !is_builtin_id(pack_id) && !inner.packs.contains_key(pack_id) {
            return Err("pack_not_found".into());
        }
        inner.state.active = pack_id.to_string();
        let active = active_from_inner(&inner);
        persist_state(&self.root, &inner.state)?;
        Ok(active)
    }

    pub fn load_runtime(&self, pack_id: &str) -> Result<PackRuntime, String> {
        if is_builtin_id(pack_id) {
            return Err("pack_not_found".into());
        }
        let pack = {
            let inner = self
                .inner
                .read()
                .map_err(|_| "pack_io_failed".to_string())?;
            inner
                .packs
                .get(pack_id)
                .cloned()
                .ok_or_else(|| "pack_not_found".to_string())?
        };
        let compiled = compile_tracks(&pack.manifest);
        let mut tracks = Vec::with_capacity(compiled.len());
        for track in compiled {
            let struct_path = pack.dir.join(&track.path);
            let bytes = fs::read(&struct_path).map_err(|_| "pack_asset_missing".to_string())?;
            let mut value: Value =
                serde_json::from_slice(&bytes).map_err(|_| "pack_track_invalid".to_string())?;
            let object = value
                .as_object_mut()
                .ok_or_else(|| "pack_track_invalid".to_string())?;
            object.insert("id".into(), json!(track.id));
            object.insert("displayName".into(), json!(track.display_name));
            if let Some(struct_dir) = struct_path.parent() {
                enrich_durations(&pack.dir, struct_dir, object);
            }
            tracks.push(PackTrackEntry {
                id: track.id,
                display_name: Some(track.display_name),
                tags: track.tags,
                path: track.path,
                structure: value,
            });
        }
        Ok(PackRuntime {
            character: ActiveCharacter {
                id: pack.manifest.id.clone(),
                name: pack.manifest.name.clone(),
                builtin: false,
                renderer: CharacterRenderer::Webp,
            },
            asset_base: asset_base(pack_id),
            tracks,
            idle_beats: pack.manifest.idle_beats.clone(),
        })
    }

    pub fn asset_response(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let Some(path) = request.uri().path().strip_prefix('/') else {
            return not_found();
        };
        let mut segments = path.split('/');
        let Some(pack_id) = segments.next() else {
            return not_found();
        };
        if !is_valid_pack_id(pack_id) || is_builtin_id(pack_id) {
            return not_found();
        }
        let dir = {
            let inner = match self.inner.read() {
                Ok(inner) => inner,
                Err(_) => return not_found(),
            };
            match inner.packs.get(pack_id) {
                Some(pack) => pack.dir.clone(),
                None => return not_found(),
            }
        };
        let mut target = dir.clone();
        let mut count = 0;
        for segment in segments {
            if !is_safe_segment(segment) {
                return not_found();
            }
            target.push(segment);
            count += 1;
        }
        if count == 0 {
            return not_found();
        }
        let ext = target
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "webp" && ext != "png" {
            return not_found();
        }
        let (Ok(root), Ok(file)) = (dir.canonicalize(), target.canonicalize()) else {
            return not_found();
        };
        if !file.starts_with(&root) || !file.is_file() {
            return not_found();
        }
        let Ok(bytes) = fs::read(&file) else {
            return not_found();
        };
        let content_type = if ext == "png" {
            "image/png"
        } else {
            "image/webp"
        };
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes)
            .unwrap_or_else(|_| not_found())
    }

    fn persist(&self) -> Result<(), String> {
        let inner = self
            .inner
            .read()
            .map_err(|_| "pack_io_failed".to_string())?;
        persist_state(&self.root, &inner.state)
    }
}

fn builtin_active(id: &str) -> ActiveCharacter {
    let builtin = builtin_character(id);
    ActiveCharacter {
        id: builtin.id.to_string(),
        name: builtin.name.to_string(),
        builtin: true,
        renderer: builtin.renderer,
    }
}

fn active_from_inner(inner: &Inner) -> ActiveCharacter {
    if is_builtin_id(&inner.state.active) {
        return builtin_active(&inner.state.active);
    }
    match inner.packs.get(&inner.state.active) {
        Some(pack) => ActiveCharacter {
            id: pack.manifest.id.clone(),
            name: pack.manifest.name.clone(),
            builtin: false,
            renderer: CharacterRenderer::Webp,
        },
        None => builtin_active(DEFAULT_BUILTIN_ID),
    }
}

fn builtin_summary(builtin: &BuiltinCharacter, active: bool) -> CharacterSummary {
    CharacterSummary {
        id: builtin.id.to_string(),
        name: builtin.name.to_string(),
        builtin: true,
        active,
        renderer: builtin.renderer,
        version: None,
        author: None,
        description: None,
        thumbnail_url: Some(builtin.thumbnail.to_string()),
        track_count: None,
        pickup_mode: None,
        installed_at: None,
    }
}

fn summary_for(pack: &InstalledPack, state: &PackState) -> CharacterSummary {
    let manifest = &pack.manifest;
    CharacterSummary {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        builtin: false,
        active: state.active == manifest.id,
        renderer: CharacterRenderer::Webp,
        version: Some(manifest.version.clone()),
        author: manifest.author.clone(),
        description: manifest.description.clone(),
        thumbnail_url: manifest
            .thumbnail
            .as_ref()
            .map(|thumb| format!("{}{}", asset_base(&manifest.id), thumb)),
        track_count: Some(manifest.tracks.len()),
        pickup_mode: Some(manifest.pickup),
        installed_at: pack.installed_at,
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn read_state(root: &Path) -> PackState {
    let Ok(bytes) = fs::read(root.join(STATE_FILE)) else {
        return PackState::default();
    };
    let mut state = serde_json::from_slice::<PackState>(&bytes).unwrap_or_default();
    if state.schema_version != SCHEMA_VERSION {
        return PackState::default();
    }
    if state.active.is_empty() {
        state.active = DEFAULT_BUILTIN_ID.to_string();
    }
    migrate_defaults(&mut state);
    state
}

fn persist_state(root: &Path, state: &PackState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|_| "pack_io_failed".to_string())?;
    let tmp = root.join(format!(".state-{}.tmp", Uuid::new_v4()));
    fs::write(&tmp, bytes).map_err(|_| "pack_io_failed".to_string())?;
    let path = root.join(STATE_FILE);
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&tmp, &path).map_err(|_| "pack_io_failed".to_string())
}

fn asset_base(pack_id: &str) -> String {
    #[cfg(windows)]
    let base = "http://qilingpet.localhost/";
    #[cfg(not(windows))]
    let base = "qilingpet://localhost/";
    format!("{base}{pack_id}/")
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(b"not found".to_vec())
        .unwrap_or_else(|_| Response::new(b"not found".to_vec()))
}

fn extract_pack(archive: &Path, staging: &Path) -> Result<PetPackManifest, String> {
    let file = fs::File::open(archive).map_err(|_| "pack_file_unreadable".to_string())?;
    let mut zip = ZipArchive::new(file).map_err(|_| "pack_zip_invalid".to_string())?;
    if zip.len() > MAX_ENTRIES {
        return Err("pack_too_large".into());
    }
    let mut seen = HashSet::new();
    let mut total: u64 = 0;
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|_| "pack_zip_invalid".to_string())?;
        if entry.is_dir() {
            continue;
        }
        if entry.is_symlink() || entry.encrypted() {
            return Err("pack_entry_unsupported".into());
        }
        let name = entry.name().to_string();
        let relative = normalized_entry_name(&name)?;
        if !allowed_entry(&relative) {
            return Err("pack_entry_unsupported".into());
        }
        if !seen.insert(relative.clone()) {
            return Err("pack_entry_unsupported".into());
        }
        let declared = entry.size();
        if declared > MAX_FILE_BYTES {
            return Err("pack_too_large".into());
        }
        total = total.saturating_add(declared);
        if total > MAX_EXTRACTED_BYTES {
            return Err("pack_too_large".into());
        }
        let target = staging.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "pack_io_failed".to_string())?;
        }
        let mut output = fs::File::create(&target).map_err(|_| "pack_io_failed".to_string())?;
        let mut limited = entry.take(MAX_FILE_BYTES + 1);
        let written = std::io::copy(&mut limited, &mut output)
            .map_err(|_| "pack_extract_failed".to_string())?;
        if written > MAX_FILE_BYTES {
            return Err("pack_too_large".into());
        }
        total = total.saturating_add(written.saturating_sub(declared));
        if total > MAX_EXTRACTED_BYTES {
            return Err("pack_too_large".into());
        }
    }
    let manifest_path = staging.join("pet.json");
    let bytes = fs::read(&manifest_path).map_err(|_| "pack_manifest_missing".to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("pack_manifest_invalid".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "pack_manifest_invalid".to_string())
}

fn normalized_entry_name(name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || !name.is_ascii()
        || name.starts_with('/')
        || name.contains('\\')
        || name.contains(':')
        || name.contains('%')
    {
        return Err("pack_path_invalid".into());
    }
    let mut path = PathBuf::new();
    for segment in name.split('/') {
        if !is_safe_segment(segment) {
            return Err("pack_path_invalid".into());
        }
        path.push(segment);
    }
    if path.as_os_str().is_empty() {
        return Err("pack_path_invalid".into());
    }
    Ok(path)
}

fn allowed_entry(relative: &Path) -> bool {
    let mut parts = relative.components();
    let Some(first) = parts.next() else {
        return false;
    };
    let first = first.as_os_str().to_string_lossy().to_ascii_lowercase();
    if first == "pet.json" {
        return true;
    }
    if first == "tracks" {
        return matches!(
            relative
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase())
                .as_deref(),
            Some("webp") | Some("png") | Some("json")
        );
    }
    if relative
        .parent()
        .map(|p| p.as_os_str().is_empty())
        .unwrap_or(false)
    {
        return matches!(
            relative
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase())
                .as_deref(),
            Some("webp") | Some("png")
        );
    }
    false
}

fn is_valid_pack_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 2 || bytes.len() > 32 {
        return false;
    }
    if !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !id.ends_with('-')
}

fn is_valid_action(action: &str) -> bool {
    let bytes = action.as_bytes();
    if bytes.is_empty() || bytes.len() > 24 {
        return false;
    }
    // 首字符必须是字母；后续允许小写字母、数字与下划线。
    // 连字符不放开：它会让 `<characterId>-<action>` 的边界产生歧义。
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
        && !RESERVED_ACTIONS.contains(&action)
}

fn is_safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn validate_manifest(manifest: &PetPackManifest) -> Result<(), String> {
    if manifest.schema_version != SCHEMA_VERSION {
        return Err("pack_schema_unsupported".into());
    }
    if !is_valid_pack_id(&manifest.id) || is_builtin_id(&manifest.id) {
        return Err("pack_id_invalid".into());
    }
    let name = manifest.name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("pack_manifest_invalid".into());
    }
    let version = manifest.version.trim();
    if version.is_empty()
        || version.chars().count() > 32
        || !version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '+' | '-'))
        || !version
            .chars()
            .next()
            .map(|ch| ch.is_ascii_alphanumeric())
            .unwrap_or(false)
    {
        return Err("pack_manifest_invalid".into());
    }
    if manifest
        .author
        .as_deref()
        .map(|text| text.chars().count() > 80)
        .unwrap_or(false)
    {
        return Err("pack_manifest_invalid".into());
    }
    if manifest
        .description
        .as_deref()
        .map(|text| text.chars().count() > 500)
        .unwrap_or(false)
    {
        return Err("pack_manifest_invalid".into());
    }
    if let Some(thumbnail) = &manifest.thumbnail {
        if thumbnail.contains('/')
            || thumbnail.contains('\\')
            || thumbnail.contains(':')
            || thumbnail.contains('%')
            || !thumbnail.is_ascii()
            || !matches!(
                Path::new(thumbnail)
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.to_ascii_lowercase())
                    .as_deref(),
                Some("webp") | Some("png")
            )
        {
            return Err("pack_manifest_invalid".into());
        }
    }
    if manifest.tracks.is_empty() || manifest.tracks.len() > MAX_TRACKS {
        return Err("pack_manifest_invalid".into());
    }
    let mut actions = HashSet::new();
    for track in &manifest.tracks {
        if !is_valid_action(&track.action) || !actions.insert(track.action.clone()) {
            return Err("pack_manifest_invalid".into());
        }
        if track
            .display_name
            .as_deref()
            .map(|text| text.chars().count() > 80)
            .unwrap_or(false)
        {
            return Err("pack_manifest_invalid".into());
        }
    }
    let mut missing: Vec<&str> = CORE_ACTIONS
        .iter()
        .copied()
        .filter(|action| !actions.contains(*action))
        .collect();
    if manifest.pickup == PickupMode::Animated && !actions.contains("pickup") {
        missing.push("pickup");
    }
    if !missing.is_empty() {
        return Err(format!("pack_mvp_tracks_missing:{}", missing.join(",")));
    }
    if manifest.idle_beats.len() > MAX_IDLE_BEATS {
        return Err("pack_idle_beats_invalid".into());
    }
    let mut beat_actions = HashSet::new();
    for beat in &manifest.idle_beats {
        if !is_valid_action(&beat.action)
            || CORE_ACTIONS.contains(&beat.action.as_str())
            || beat.action == "pickup"
            || !actions.contains(&beat.action)
            || !beat_actions.insert(beat.action.clone())
        {
            return Err("pack_idle_beats_invalid".into());
        }
        if beat.line.trim().is_empty() || beat.line.chars().count() > 40 {
            return Err("pack_idle_beats_invalid".into());
        }
        if let Some(ms) = beat.ms {
            if !(500..=60_000).contains(&ms) {
                return Err("pack_idle_beats_invalid".into());
            }
        }
    }
    Ok(())
}

fn validate_pack_contents(root: &Path, manifest: &PetPackManifest) -> Result<(), String> {
    if let Some(thumbnail) = &manifest.thumbnail {
        let path = resolve_inside(root, root, thumbnail)?;
        let size = fs::metadata(&path)
            .map_err(|_| "pack_asset_missing".to_string())?
            .len();
        if size > MAX_THUMBNAIL_BYTES {
            return Err("pack_too_large".into());
        }
    }
    let declared_beats: HashSet<&str> = manifest
        .idle_beats
        .iter()
        .map(|beat| beat.action.as_str())
        .collect();
    for track in &manifest.tracks {
        let relative = format!("tracks/{}/track_struct.json", track.action);
        let struct_path = resolve_inside(root, root, &relative)?;
        let bytes = fs::read(&struct_path).map_err(|_| "pack_asset_missing".to_string())?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "pack_track_invalid".to_string())?;
        let struct_dir = struct_path
            .parent()
            .ok_or_else(|| "pack_path_invalid".to_string())?;
        validate_track_struct(
            root,
            struct_dir,
            &value,
            &track.action,
            manifest.pickup,
            declared_beats.contains(track.action.as_str()),
        )?;
    }
    Ok(())
}

fn validate_track_struct(
    root: &Path,
    struct_dir: &Path,
    value: &Value,
    action: &str,
    pickup: PickupMode,
    declared_beat: bool,
) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "pack_track_invalid".to_string())?;
    if let Some(fps) = object.get("fps") {
        let fps = fps
            .as_u64()
            .ok_or_else(|| "pack_track_invalid".to_string())?;
        if !(1..=60).contains(&fps) {
            return Err("pack_track_invalid".into());
        }
    }
    if let Some(size) = object.get("frameSize") {
        let size = size
            .as_object()
            .ok_or_else(|| "pack_track_invalid".to_string())?;
        for key in ["width", "height"] {
            let value = size
                .get(key)
                .and_then(Value::as_u64)
                .ok_or_else(|| "pack_track_invalid".to_string())?;
            if !(1..=2048).contains(&value) {
                return Err("pack_track_invalid".into());
            }
        }
    }
    let phases = object
        .get("phases")
        .and_then(Value::as_object)
        .ok_or_else(|| "pack_track_invalid".to_string())?;
    if phases.is_empty() || phases.len() > MAX_PHASES {
        return Err("pack_track_invalid".into());
    }
    for (phase_name, phase) in phases {
        let phase = phase
            .as_object()
            .ok_or_else(|| "pack_track_invalid".to_string())?;
        if let Some(playback) = phase.get("playback") {
            let playback = playback
                .as_str()
                .ok_or_else(|| "pack_track_invalid".to_string())?;
            if playback != "loop" && playback != "once" {
                return Err("pack_track_invalid".into());
            }
        }
        let asset = phase
            .get("asset")
            .and_then(Value::as_object)
            .ok_or_else(|| "pack_track_invalid".to_string())?;
        validate_asset(root, struct_dir, asset, phase_name)?;
    }

    let needs_idle_image = matches!(
        action,
        "idle" | "think" | "explain" | "advantage" | "disadvantage" | "butterfly" | "angry"
    ) || declared_beat;
    if needs_idle_image {
        let idle_asset = phases
            .get("idle")
            .and_then(|phase| phase.get("asset"))
            .and_then(Value::as_object)
            .ok_or_else(|| "pack_track_invalid".to_string())?;
        if idle_asset.get("type").and_then(Value::as_str) != Some("animatedWebp") {
            return Err("pack_track_invalid".into());
        }
    }

    if action == "pickup" && pickup == PickupMode::Animated {
        for (name, expect_loop) in [("lift", false), ("hover", true), ("drop", false)] {
            let phase = phases
                .get(name)
                .and_then(Value::as_object)
                .ok_or_else(|| "pack_pickup_invalid".to_string())?;
            let playback = phase
                .get("playback")
                .and_then(Value::as_str)
                .unwrap_or("once");
            if (expect_loop && playback != "loop") || (!expect_loop && playback != "once") {
                return Err("pack_pickup_invalid".into());
            }
            let asset = phase
                .get("asset")
                .and_then(Value::as_object)
                .ok_or_else(|| "pack_pickup_invalid".to_string())?;
            if asset.get("type").and_then(Value::as_str) != Some("frameSequence") {
                return Err("pack_pickup_invalid".into());
            }
        }
    }
    Ok(())
}

fn validate_asset(
    root: &Path,
    struct_dir: &Path,
    asset: &Map<String, Value>,
    phase_name: &str,
) -> Result<(), String> {
    match asset.get("type").and_then(Value::as_str) {
        Some("animatedWebp") => {
            let src = asset
                .get("src")
                .and_then(Value::as_str)
                .ok_or_else(|| "pack_track_invalid".to_string())?;
            let path = resolve_inside(root, struct_dir, src)?;
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("webp"))
                != Some(true)
            {
                return Err("pack_asset_missing".into());
            }
            let size = fs::metadata(&path)
                .map_err(|_| "pack_asset_missing".to_string())?
                .len();
            if size > MAX_FILE_BYTES {
                return Err("pack_too_large".into());
            }
        }
        Some("frameSequence") => {
            let dir = asset.get("dir").and_then(Value::as_str).unwrap_or("tracks");
            let dir_path = normalized_entry_name(dir)?;
            let from = asset
                .get("from")
                .and_then(Value::as_u64)
                .ok_or_else(|| "pack_track_invalid".to_string())?;
            let to = asset
                .get("to")
                .and_then(Value::as_u64)
                .ok_or_else(|| "pack_track_invalid".to_string())?;
            if from < 1 || to < from || to - from + 1 > MAX_FRAMES_PER_TRACK {
                return Err("pack_track_invalid".into());
            }
            let pattern = asset
                .get("pattern")
                .and_then(Value::as_str)
                .unwrap_or("frame{NNN}.webp");
            if !pattern.contains("{NNN}") || !pattern.is_ascii() {
                return Err("pack_track_invalid".into());
            }
            let zero_pad = asset.get("zeroPad").and_then(Value::as_u64).unwrap_or(3);
            if !(1..=6).contains(&zero_pad) {
                return Err("pack_track_invalid".into());
            }
            for frame in from..=to {
                let name = pattern.replace(
                    "{NNN}",
                    &format!("{:0width$}", frame, width = zero_pad as usize),
                );
                let path = resolve_inside(root, &struct_dir.join(&dir_path), &name)?;
                if path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("webp"))
                    != Some(true)
                {
                    return Err("pack_asset_missing".into());
                }
                let size = fs::metadata(&path)
                    .map_err(|_| "pack_asset_missing".to_string())?
                    .len();
                if size > MAX_FILE_BYTES {
                    return Err("pack_too_large".into());
                }
            }
            let _ = phase_name;
        }
        _ => return Err("pack_track_invalid".into()),
    }
    Ok(())
}

fn resolve_inside(root: &Path, base: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = normalized_entry_name(relative)?;
    let root = root
        .canonicalize()
        .map_err(|_| "pack_io_failed".to_string())?;
    let candidate = base.join(normalized);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "pack_asset_missing".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("pack_path_invalid".into());
    }
    Ok(canonical)
}

fn compile_tracks(manifest: &PetPackManifest) -> Vec<CompiledTrack> {
    manifest
        .tracks
        .iter()
        .map(|track| {
            let action = track.action.clone();
            let id = format!("{}-{}", manifest.id, action);
            let mut tags = vec![action.clone(), manifest.id.clone()];
            if POSE_ACTIONS.contains(&action.as_str()) {
                tags.insert(0, "pose".to_string());
            }
            let display_name = track
                .display_name
                .clone()
                .unwrap_or_else(|| format!("{}·{}", manifest.name, action_label(&action)));
            CompiledTrack {
                path: format!("tracks/{action}/track_struct.json"),
                id,
                display_name,
                tags,
            }
        })
        .collect()
}

fn action_label(action: &str) -> &str {
    match action {
        "idle" => "待机",
        "think" => "思考",
        "explain" => "讲解",
        "advantage" => "优势",
        "disadvantage" => "劣势",
        "pickup" => "吊起",
        other => other,
    }
}

fn enrich_durations(root: &Path, struct_dir: &Path, object: &mut Map<String, Value>) {
    let Some(phases) = object.get_mut("phases").and_then(Value::as_object_mut) else {
        return;
    };
    for phase in phases.values_mut() {
        let Some(asset) = phase.get_mut("asset").and_then(Value::as_object_mut) else {
            continue;
        };
        if asset.contains_key("durationMs")
            || asset.get("type").and_then(Value::as_str) != Some("animatedWebp")
        {
            continue;
        }
        let Some(src) = asset.get("src").and_then(Value::as_str) else {
            continue;
        };
        let Ok(path) = resolve_inside(root, struct_dir, src) else {
            continue;
        };
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        if let Some(ms) = webp_duration_ms(&bytes) {
            asset.insert("durationMs".into(), json!(ms));
        }
    }
}

fn webp_duration_ms(bytes: &[u8]) -> Option<u64> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let mut offset = 12usize;
    let mut total = 0u64;
    let mut frames = 0u64;
    while offset + 8 <= bytes.len() {
        let kind = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let data = offset + 8;
        if data > bytes.len() {
            break;
        }
        if kind == b"ANMF" && data + 16 <= bytes.len() {
            total += (bytes[data + 12] as u64)
                | ((bytes[data + 13] as u64) << 8)
                | ((bytes[data + 14] as u64) << 16);
            frames += 1;
        }
        offset = data + size + (size & 1);
        if offset <= data {
            break;
        }
    }
    if frames > 0 {
        Some(total)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    fn temp_dir(name: &str) -> PathBuf {
        // 测试进程在受限环境里可能写不了系统 %TEMP%，统一放到 src-tauri/target/ 下。
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("pet-pack-tests");
        fs::create_dir_all(&base).unwrap();
        let path = base.join(format!("{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn manifest_value(id: &str, pickup: &str, actions: &[&str]) -> Value {
        json!({
            "schemaVersion": 1,
            "id": id,
            "name": "测试角色",
            "version": "1.0.0",
            "pickup": pickup,
            "tracks": actions
                .iter()
                .map(|action| json!({ "action": action }))
                .collect::<Vec<_>>()
        })
    }

    fn idle_struct() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "fps": 24,
            "frameSize": { "width": 180, "height": 240 },
            "phases": {
                "idle": {
                    "playback": "loop",
                    "asset": { "type": "animatedWebp", "src": "idle.webp" }
                }
            }
        }))
        .unwrap()
    }

    fn pickup_struct() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "fps": 24,
            "frameSize": { "width": 180, "height": 260 },
            "phases": {
                "lift": { "playback": "once", "asset": { "type": "frameSequence", "dir": "frames", "from": 1, "to": 2 } },
                "hover": { "playback": "loop", "asset": { "type": "frameSequence", "dir": "frames", "from": 3, "to": 4 } },
                "drop": { "playback": "once", "asset": { "type": "frameSequence", "dir": "frames", "from": 5, "to": 6 } }
            }
        }))
        .unwrap()
    }

    fn add(zip: &mut ZipWriter<Cursor<Vec<u8>>>, name: &str, bytes: &[u8]) {
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file(name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }

    fn build_zip(manifest: &Value, image: &[u8]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        add(&mut zip, "pet.json", &serde_json::to_vec(manifest).unwrap());
        let actions = manifest["tracks"].as_array().unwrap();
        for track in actions {
            let action = track["action"].as_str().unwrap();
            if action == "pickup" && manifest["pickup"] == "animated" {
                add(
                    &mut zip,
                    "tracks/pickup/track_struct.json",
                    &pickup_struct(),
                );
                for frame in 1..=6 {
                    add(
                        &mut zip,
                        &format!("tracks/pickup/frames/frame{frame:03}.webp"),
                        image,
                    );
                }
            } else {
                add(
                    &mut zip,
                    &format!("tracks/{action}/track_struct.json"),
                    &idle_struct(),
                );
                add(&mut zip, &format!("tracks/{action}/idle.webp"), image);
            }
        }
        zip.finish().unwrap().into_inner()
    }

    fn write_pack(root: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = root.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn six_actions() -> Vec<&'static str> {
        vec![
            "idle",
            "think",
            "explain",
            "advantage",
            "disadvantage",
            "pickup",
        ]
    }

    fn install_demo(registry: &PetPackRegistry, root: &Path, id: &str) -> PathBuf {
        let manifest = manifest_value(id, "animated", &six_actions());
        let bytes = build_zip(&manifest, b"fake-webp");
        let path = write_pack(root, &format!("{id}.qilingpet"), &bytes);
        registry.install(&path, false).unwrap();
        path
    }

    #[test]
    fn installs_compiles_and_persists() {
        let root = temp_dir("install");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        install_demo(&registry, &root, "demo");
        let view = registry.packs_view();
        assert_eq!(view.active_id, "lingpao");
        assert_eq!(
            view.characters
                .iter()
                .filter(|item| item.builtin)
                .map(|item| (item.id.as_str(), item.renderer))
                .collect::<Vec<_>>(),
            vec![
                ("lingpao", CharacterRenderer::Svg),
                ("shiju", CharacterRenderer::Webp)
            ]
        );
        assert!(view.characters.iter().any(|item| item.id == "demo"));

        let runtime = registry.load_runtime("demo").unwrap();
        assert!(runtime.asset_base.ends_with("/demo/"));
        let idle = runtime
            .tracks
            .iter()
            .find(|track| track.tags.iter().any(|tag| tag == "idle"))
            .unwrap();
        assert_eq!(idle.id, "demo-idle");
        assert_eq!(idle.tags, vec!["idle", "demo"]);
        assert_eq!(idle.path, "tracks/idle/track_struct.json");
        let think = runtime
            .tracks
            .iter()
            .find(|track| track.tags.iter().any(|tag| tag == "think"))
            .unwrap();
        assert_eq!(think.id, "demo-think");
        assert_eq!(think.tags, vec!["pose", "think", "demo"]);
        let pickup = runtime
            .tracks
            .iter()
            .find(|track| track.tags.iter().any(|tag| tag == "pickup"))
            .unwrap();
        assert_eq!(pickup.id, "demo-pickup");
        assert_eq!(pickup.tags, vec!["pickup", "demo"]);

        registry.set_active("demo").unwrap();
        drop(registry);
        let reloaded = PetPackRegistry::load(root.join("pets")).unwrap();
        assert_eq!(reloaded.active_character().id, "demo");
    }

    #[test]
    fn window_only_pack_can_omit_pickup() {
        let root = temp_dir("window-only");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        let manifest = manifest_value(
            "demo",
            "window-only",
            &["idle", "think", "explain", "advantage", "disadvantage"],
        );
        let bytes = build_zip(&manifest, b"fake-webp");
        let path = write_pack(&root, "demo.qilingpet", &bytes);
        assert!(registry.install(&path, false).is_ok());
    }

    #[test]
    fn rejects_missing_mvp_tracks() {
        let root = temp_dir("missing");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        let manifest = manifest_value("demo", "animated", &["idle"]);
        let bytes = build_zip(&manifest, b"fake-webp");
        let path = write_pack(&root, "demo.qilingpet", &bytes);
        let error = registry.install(&path, false).unwrap_err();
        assert!(error.starts_with("pack_mvp_tracks_missing"), "{error}");
    }

    #[test]
    fn rejects_animated_pickup_without_segments() {
        let root = temp_dir("pickup");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        let manifest = manifest_value("demo", "animated", &six_actions());
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        add(
            &mut zip,
            "pet.json",
            &serde_json::to_vec(&manifest).unwrap(),
        );
        for action in ["idle", "think", "explain", "advantage", "disadvantage"] {
            add(
                &mut zip,
                &format!("tracks/{action}/track_struct.json"),
                &idle_struct(),
            );
            add(&mut zip, &format!("tracks/{action}/idle.webp"), b"webp");
        }
        add(
            &mut zip,
            "tracks/pickup/track_struct.json",
            &serde_json::to_vec(&json!({
                "phases": { "idle": { "asset": { "type": "animatedWebp", "src": "idle.webp" } } }
            }))
            .unwrap(),
        );
        add(&mut zip, "tracks/pickup/idle.webp", b"webp");
        let bytes = zip.finish().unwrap().into_inner();
        let path = write_pack(&root, "demo.qilingpet", &bytes);
        let error = registry.install(&path, false).unwrap_err();
        assert_eq!(error, "pack_pickup_invalid");
    }

    #[test]
    fn rejects_path_escape_in_assets() {
        let root = temp_dir("escape");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        let manifest = manifest_value(
            "demo",
            "window-only",
            &["idle", "think", "explain", "advantage", "disadvantage"],
        );
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        add(
            &mut zip,
            "pet.json",
            &serde_json::to_vec(&manifest).unwrap(),
        );
        for action in ["think", "explain", "advantage", "disadvantage"] {
            add(
                &mut zip,
                &format!("tracks/{action}/track_struct.json"),
                &idle_struct(),
            );
            add(&mut zip, &format!("tracks/{action}/idle.webp"), b"webp");
        }
        let escaped = serde_json::to_vec(&json!({
            "phases": {
                "idle": { "asset": { "type": "animatedWebp", "src": "../../evil.webp" } }
            }
        }))
        .unwrap();
        add(&mut zip, "tracks/idle/track_struct.json", &escaped);
        add(&mut zip, "tracks/idle/idle.webp", b"webp");
        let bytes = zip.finish().unwrap().into_inner();
        let path = write_pack(&root, "demo.qilingpet", &bytes);
        let error = registry.install(&path, false).unwrap_err();
        assert_eq!(error, "pack_path_invalid");
    }

    #[test]
    fn replace_requires_flag_and_uninstall_falls_back() {
        let root = temp_dir("replace");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        let path = install_demo(&registry, &root, "demo");
        assert_eq!(registry.install(&path, false).unwrap_err(), "pack_exists");
        assert!(registry.install(&path, true).is_ok());
        registry.set_active("demo").unwrap();
        let active = registry.uninstall("demo").unwrap();
        assert!(active.builtin);
        assert_eq!(active.id, "lingpao");
        assert_eq!(active.renderer, CharacterRenderer::Svg);
        assert!(!registry
            .packs_view()
            .characters
            .iter()
            .any(|item| item.id == "demo"));
        for builtin in ["lingpao", "shiju"] {
            assert_eq!(
                registry.uninstall(builtin).unwrap_err(),
                "pack_builtin_protected"
            );
        }
    }

    #[test]
    fn serves_only_installed_webp_assets() {
        let root = temp_dir("serve");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        install_demo(&registry, &root, "demo");
        let ok = registry.asset_response(
            &Request::builder()
                .uri("http://qilingpet.localhost/demo/tracks/idle/idle.webp")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/webp");
        let json = registry.asset_response(
            &Request::builder()
                .uri("http://qilingpet.localhost/demo/tracks/idle/track_struct.json")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(json.status(), StatusCode::NOT_FOUND);
        let unknown = registry.asset_response(
            &Request::builder()
                .uri("http://qilingpet.localhost/none/tracks/idle/idle.webp")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        let traversal = registry.asset_response(
            &Request::builder()
                .uri("http://qilingpet.localhost/demo/../pet.json")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(traversal.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn fills_duration_ms_for_animated_webp() {
        let root = temp_dir("duration");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        let manifest = manifest_value(
            "demo",
            "window-only",
            &["idle", "think", "explain", "advantage", "disadvantage"],
        );
        let mut webp = Vec::new();
        webp.extend_from_slice(b"RIFF");
        webp.extend_from_slice(&28u32.to_le_bytes());
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(b"ANMF");
        webp.extend_from_slice(&16u32.to_le_bytes());
        let mut data = [0u8; 16];
        data[12] = 40;
        webp.extend_from_slice(&data);
        let bytes = build_zip(&manifest, &webp);
        let path = write_pack(&root, "demo.qilingpet", &bytes);
        registry.install(&path, false).unwrap();
        let runtime = registry.load_runtime("demo").unwrap();
        let idle = runtime
            .tracks
            .iter()
            .find(|track| track.tags.iter().any(|tag| tag == "idle"))
            .unwrap();
        assert_eq!(idle.structure["phases"]["idle"]["asset"]["durationMs"], 40);
    }

    #[test]
    fn accepts_a_pack_built_from_real_public_webp() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let assets = workspace.join("public").join("pet");
        let root = temp_dir("real");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        let actions = ["idle", "think", "explain", "advantage", "disadvantage"];
        let manifest = manifest_value("demo", "window-only", &actions);
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        add(
            &mut zip,
            "pet.json",
            &serde_json::to_vec(&manifest).unwrap(),
        );
        for action in actions {
            let source = if action == "idle" {
                assets.join("idle.webp")
            } else {
                assets.join(format!("{action}.webp"))
            };
            let bytes = fs::read(&source).expect("public webp exists");
            add(
                &mut zip,
                &format!("tracks/{action}/track_struct.json"),
                &idle_struct(),
            );
            add(&mut zip, &format!("tracks/{action}/idle.webp"), &bytes);
        }
        let bytes = zip.finish().unwrap().into_inner();
        let path = write_pack(&root, "demo.qilingpet", &bytes);
        registry.install(&path, false).unwrap();
        let runtime = registry.load_runtime("demo").unwrap();
        let idle = runtime
            .tracks
            .iter()
            .find(|track| track.tags.iter().any(|tag| tag == "idle"))
            .unwrap();
        let duration = idle.structure["phases"]["idle"]["asset"]["durationMs"]
            .as_u64()
            .unwrap_or(0);
        assert!(duration > 0);
    }

    #[test]
    fn validates_idle_beats_and_ids() {
        let root = temp_dir("beats");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        let mut manifest = manifest_value(
            "demo",
            "window-only",
            &[
                "idle",
                "think",
                "explain",
                "advantage",
                "disadvantage",
                "water_splash",
            ],
        );
        manifest["idleBeats"] = json!([{ "action": "water_splash", "line": "扑通" }]);
        let bytes = build_zip(&manifest, b"webp");
        let path = write_pack(&root, "demo.qilingpet", &bytes);
        assert!(registry.install(&path, false).is_ok());
        let runtime = registry.load_runtime("demo").unwrap();
        assert!(runtime
            .tracks
            .iter()
            .any(|track| track.id == "demo-water_splash"));

        let mut hyphen = manifest.clone();
        hyphen["tracks"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "action": "tail-wag" }));
        let hyphen_bytes = build_zip(&hyphen, b"webp");
        let hyphen_path = write_pack(&root, "hyphen.qilingpet", &hyphen_bytes);
        assert_eq!(
            registry.install(&hyphen_path, false).unwrap_err(),
            "pack_manifest_invalid"
        );

        let mut bad = manifest.clone();
        bad["idleBeats"] = json!([{ "action": "idle", "line": "x" }]);
        let bad_bytes = build_zip(&bad, b"webp");
        let bad_path = write_pack(&root, "bad.qilingpet", &bad_bytes);
        assert_eq!(
            registry.install(&bad_path, false).unwrap_err(),
            "pack_idle_beats_invalid"
        );

        for (index, reserved_id) in ["shiju", "lingpao"].iter().enumerate() {
            let reserved = manifest_value(
                reserved_id,
                "window-only",
                &["idle", "think", "explain", "advantage", "disadvantage"],
            );
            let reserved_bytes = build_zip(&reserved, b"webp");
            let reserved_path = write_pack(
                &root,
                &format!("reserved-{index}.qilingpet"),
                &reserved_bytes,
            );
            assert_eq!(
                registry.install(&reserved_path, false).unwrap_err(),
                "pack_id_invalid"
            );
        }
    }

    #[test]
    fn switches_between_builtin_characters() {
        let root = temp_dir("builtin-switch");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        assert_eq!(registry.active_character().id, "lingpao");

        let shiju = registry.set_active("shiju").unwrap();
        assert!(shiju.builtin);
        assert_eq!(shiju.id, "shiju");
        assert_eq!(shiju.renderer, CharacterRenderer::Webp);
        let view = registry.packs_view();
        assert_eq!(view.active_id, "shiju");
        assert!(view
            .characters
            .iter()
            .find(|item| item.id == "lingpao")
            .map(|item| !item.active)
            .unwrap_or(false));

        let lingpao = registry.set_active("lingpao").unwrap();
        assert_eq!(lingpao.id, "lingpao");
        assert_eq!(lingpao.renderer, CharacterRenderer::Svg);
    }

    #[test]
    fn migrates_the_old_default_once_without_overriding_a_choice() {
        let root = temp_dir("migrate");
        let pets = root.join("pets");
        fs::create_dir_all(&pets).unwrap();
        fs::write(
            pets.join(STATE_FILE),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "active": "shiju",
                "installedAt": {}
            }))
            .unwrap(),
        )
        .unwrap();
        let registry = PetPackRegistry::load(pets.clone()).unwrap();
        assert_eq!(registry.active_character().id, "lingpao");
        let migrated: Value =
            serde_json::from_slice(&fs::read(pets.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(migrated["defaultsVersion"], json!(DEFAULTS_VERSION));

        // 用户之后显式选择诗琚：重启后保持，不会被再次迁移。
        registry.set_active("shiju").unwrap();
        drop(registry);
        let reloaded = PetPackRegistry::load(pets).unwrap();
        assert_eq!(reloaded.active_character().id, "shiju");
    }

    #[test]
    fn builtin_runtime_is_not_a_pack() {
        let root = temp_dir("builtin-runtime");
        let registry = PetPackRegistry::load(root.join("pets")).unwrap();
        for builtin in ["lingpao", "shiju"] {
            assert_eq!(
                registry.load_runtime(builtin).unwrap_err(),
                "pack_not_found"
            );
        }
    }
}
