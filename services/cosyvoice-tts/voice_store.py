"""On-disk library of addressable CosyVoice speaker presets.

A voice is a folder with `meta.json` and `prompt.wav`. The folder name is the
voice id; that id is also the CosyVoice spk id, so synthesis never re-sends
the reference clip. Times and rates are what the clip became after
`audio_io.decode`, not what the user uploaded.

The builtin 诗琚 voice is not stored here: its answer comes from the existing
`QILING_COSYVOICE_PROMPT_*` / app-data resolution. A sidecar `meta.json` may
hold renamed display fields for it. User presets are scanned at startup.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import threading
import uuid
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path

BUILTIN_ID = "child-girl-zero-shot"
BUILTIN_NAME = "诗琚（默认）"
VOICE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
VOICE_ID_RE = re.compile(VOICE_ID_PATTERN)
MAX_NAME = 80
MAX_DESCRIPTION = 500
MAX_TAGS = 24
MAX_TAG_LENGTH = 32
MAX_PROMPT_CHARS = 500
PROMPT_RATE = 16_000
DEFAULT_FILE = "default.json"
META_FILE = "meta.json"
PROMPT_FILE = "prompt.wav"


class VoiceExists(Exception):
    """The id is already used by a preset in the library (or being staged)."""


class VoiceStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._lock = threading.RLock()
        self._voices: dict[str, VoicePreset] = {}
        self._staged: set[str] = set()
        self._default = BUILTIN_ID
        self.warnings: list[str] = []

    # ---------------------------------------------------------------- lookups

    def get(self, voice_id: str) -> VoicePreset | None:
        with self._lock:
            return self._voices.get(voice_id)

    def exists(self, voice_id: str) -> bool:
        with self._lock:
            return voice_id in self._voices or voice_id in self._staged

    def list(self) -> list[VoicePreset]:
        with self._lock:
            voices = list(self._voices.values())
        # Builtin first, then the oldest preset. The list is small; this keeps
        # the page the user sees stable between restarts.
        return sorted(voices, key=lambda voice: (0 if voice.meta.builtin else 1, voice.meta.created_at, voice.id))

    def user_presets(self) -> list[VoicePreset]:
        return [voice for voice in self.list() if not voice.meta.builtin]

    def default_id(self) -> str:
        with self._lock:
            return self._default

    def default_voice(self) -> VoicePreset | None:
        with self._lock:
            return self._voices.get(self._default)

    def count(self) -> int:
        with self._lock:
            return len(self._voices)

    # ------------------------------------------------------------ load/save

    def install_builtin(self, preset: VoicePreset) -> None:
        if preset.id != BUILTIN_ID:
            raise ValueError("内置音色 id 必须是 child-girl-zero-shot")
        with self._lock:
            self._voices[BUILTIN_ID] = preset
            self._default = self._load_default_locked()

    def scan(self) -> list[VoicePreset]:
        """Load every usable preset folder. Broken folders are reported, not fatal."""
        loaded: list[VoicePreset] = []
        warnings: list[str] = []
        if not self.root.is_dir():
            with self._lock:
                self._default = self._load_default_locked()
                self.warnings = []
            return loaded
        try:
            entries = sorted(self.root.iterdir(), key=lambda path: path.name)
        except OSError as exc:
            warnings.append(f"读取音色目录失败：{exc}")
            entries = []
        for entry in entries:
            if not entry.is_dir() or entry.name == BUILTIN_ID:
                continue
            if not valid_voice_id(entry.name):
                warnings.append(f"跳过音色目录 {entry.name!r}：id 不合法")
                continue
            try:
                preset = self._read_preset(entry, entry.name)
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                warnings.append(f"跳过音色 {entry.name}：{exc}")
                continue
            if preset is None:
                warnings.append(f"跳过音色 {entry.name}：缺少 meta.json 或 prompt.wav")
                continue
            with self._lock:
                self._voices[entry.name] = preset
            loaded.append(preset)
        with self._lock:
            self._default = self._load_default_locked()
            self.warnings = warnings
        return loaded

    def read_meta(self, voice_id: str) -> VoiceMeta | None:
        """Read a meta.json directly, for the builtin display sidecar."""
        if not valid_voice_id(voice_id):
            return None
        path = self.root / voice_id / META_FILE
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            return None
        try:
            return VoiceMeta.from_stored(payload, fallback_id=voice_id, builtin=voice_id == BUILTIN_ID)
        except (TypeError, ValueError):
            return None

    def stage(self, meta: VoiceMeta, prompt_wav: bytes) -> VoicePreset:
        """Write the preset files without publishing the id yet."""
        if not valid_voice_id(meta.id):
            raise ValueError("voice_id 不合法")
        folder = self.root / meta.id
        with self._lock:
            if meta.id in self._voices or meta.id in self._staged or folder.exists():
                raise VoiceExists(meta.id)
            self._staged.add(meta.id)
        try:
            folder.mkdir(parents=True, exist_ok=False)
            _write_atomic(folder / PROMPT_FILE, prompt_wav)
            _write_atomic(folder / META_FILE, _meta_json(meta))
        except Exception:
            with self._lock:
                self._staged.discard(meta.id)
            shutil.rmtree(folder, ignore_errors=True)
            raise
        return VoicePreset(meta=meta, prompt_wav=folder / PROMPT_FILE)

    def activate(self, preset: VoicePreset) -> None:
        with self._lock:
            self._staged.discard(preset.id)
            self._voices[preset.id] = preset

    def discard(self, preset: VoicePreset) -> None:
        with self._lock:
            self._staged.discard(preset.id)
        _remove_voice_dir(self.root, preset.id)

    def update_meta(
        self,
        voice_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        tags: tuple[str, ...] | None = None,
    ) -> VoicePreset:
        with self._lock:
            preset = self._voices.get(voice_id)
            if preset is None:
                raise KeyError(voice_id)
            meta = preset.meta
            if name is not None:
                meta = replace(meta, name=name[:MAX_NAME] or preset.id)
            if description is not None:
                meta = replace(meta, description=description[:MAX_DESCRIPTION])
            if tags is not None:
                meta = replace(meta, tags=tuple(tags)[:MAX_TAGS])
            _write_atomic(self.root / voice_id / META_FILE, _meta_json(meta))
            updated = VoicePreset(meta=meta, prompt_wav=preset.prompt_wav)
            self._voices[voice_id] = updated
            return updated

    def replace_prompt(
        self,
        voice_id: str,
        *,
        prompt_wav: bytes,
        prompt_text: str,
        prompt_seconds: float,
        sample_rate: int = PROMPT_RATE,
    ) -> VoicePreset:
        with self._lock:
            preset = self._voices.get(voice_id)
            if preset is None:
                raise KeyError(voice_id)
            if preset.meta.builtin:
                raise ValueError("内置音色不能替换参考音")
            meta = replace(
                preset.meta,
                prompt_text=prompt_text,
                prompt_seconds=round(float(prompt_seconds), 3),
                sample_rate=int(sample_rate),
            )
            try:
                previous = preset.prompt_wav.read_bytes()
            except OSError:
                previous = None
            _write_atomic(self.root / voice_id / PROMPT_FILE, prompt_wav)
            try:
                _write_atomic(self.root / voice_id / META_FILE, _meta_json(meta))
            except Exception:
                # Keep prompt.wav and meta.json describing the same clip.
                if previous is not None:
                    _write_atomic(self.root / voice_id / PROMPT_FILE, previous)
                raise
            updated = VoicePreset(meta=meta, prompt_wav=preset.prompt_wav)
            self._voices[voice_id] = updated
            return updated

    def delete(self, voice_id: str) -> VoicePreset:
        with self._lock:
            preset = self._voices.get(voice_id)
            if preset is None:
                raise KeyError(voice_id)
            if preset.meta.builtin:
                raise ValueError("内置音色不能删除")
            _remove_voice_dir(self.root, voice_id, ignore_errors=False)
            del self._voices[voice_id]
            if self._default == voice_id:
                self._default = BUILTIN_ID
                self._write_default_locked()
        return preset

    def set_default(self, voice_id: str) -> None:
        with self._lock:
            if voice_id not in self._voices:
                raise KeyError(voice_id)
            self._default = voice_id
            self._write_default_locked()

    # --------------------------------------------------------------- internals

    def _read_preset(self, folder: Path, voice_id: str) -> VoicePreset | None:
        meta_path = folder / META_FILE
        prompt_path = folder / PROMPT_FILE
        if not meta_path.is_file() or not prompt_path.is_file():
            return None
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
        meta = VoiceMeta.from_stored(payload, fallback_id=voice_id, builtin=False)
        if meta.id != voice_id:
            raise ValueError(f"meta.json 的 id {meta.id!r} 与目录名不一致")
        if not meta.prompt_text:
            raise ValueError("meta.json 缺少 promptText")
        return VoicePreset(meta=meta, prompt_wav=prompt_path)

    def _load_default_locked(self) -> str:
        try:
            payload = json.loads((self.root / DEFAULT_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            return BUILTIN_ID
        value = payload.get("defaultVoice") if isinstance(payload, dict) else None
        if isinstance(value, str) and value in self._voices:
            return value
        return BUILTIN_ID

    def _write_default_locked(self) -> None:
        _write_atomic(
            self.root / DEFAULT_FILE,
            json.dumps({"defaultVoice": self._default}, ensure_ascii=False, indent=2).encode("utf-8"),
        )


@dataclass(frozen=True)
class VoiceMeta:
    id: str
    name: str
    description: str
    tags: tuple[str, ...]
    prompt_seconds: float
    sample_rate: int
    created_at: str
    builtin: bool = False
    prompt_text: str = ""

    def public(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "tags": list(self.tags),
            "promptSeconds": round(float(self.prompt_seconds), 2),
            "sampleRate": int(self.sample_rate),
            "createdAt": self.created_at,
            "builtin": bool(self.builtin),
        }

    def stored(self) -> dict:
        payload = self.public()
        payload["promptText"] = self.prompt_text
        return payload

    @classmethod
    def from_stored(cls, payload: object, *, fallback_id: str, builtin: bool = False) -> VoiceMeta:
        if not isinstance(payload, dict):
            raise ValueError("meta.json 不是对象")
        voice_id = str(payload.get("id") or fallback_id).strip()
        if not valid_voice_id(voice_id):
            raise ValueError("meta.json 的 id 不合法")
        name = str(payload.get("name") or voice_id).strip()[:MAX_NAME] or voice_id
        description = str(payload.get("description") or "").strip()[:MAX_DESCRIPTION]
        tags = parse_tags(payload.get("tags", ()))
        try:
            seconds = float(payload.get("promptSeconds") or 0.0)
        except (TypeError, ValueError):
            seconds = 0.0
        if not math.isfinite(seconds):
            seconds = 0.0
        seconds = min(max(0.0, seconds), 3600.0)
        try:
            sample_rate = int(payload.get("sampleRate") or PROMPT_RATE)
        except (TypeError, ValueError):
            sample_rate = PROMPT_RATE
        if sample_rate <= 0:
            sample_rate = PROMPT_RATE
        created_at = str(payload.get("createdAt") or "").strip() or now_iso()
        prompt_text = str(payload.get("promptText") or "").strip()[:MAX_PROMPT_CHARS]
        return cls(
            id=voice_id,
            name=name,
            description=description,
            tags=tags,
            prompt_seconds=seconds,
            sample_rate=sample_rate,
            created_at=created_at,
            builtin=builtin,
            prompt_text=prompt_text,
        )


@dataclass(frozen=True)
class VoicePreset:
    meta: VoiceMeta
    prompt_wav: Path

    @property
    def id(self) -> str:
        return self.meta.id

    @property
    def prompt_text(self) -> str:
        return self.meta.prompt_text

    @property
    def spk_id(self) -> str:
        # The registry id is the CosyVoice speaker id; one model, many presets.
        return self.meta.id


def valid_voice_id(value: object) -> bool:
    return isinstance(value, str) and VOICE_ID_RE.match(value) is not None


def parse_tags(raw: object) -> tuple[str, ...]:
    if isinstance(raw, (list, tuple)):
        items = [str(item) for item in raw]
    else:
        items = re.split(r"[,，]", str(raw or ""))
    tags: list[str] = []
    for item in items:
        tag = item.strip()[:MAX_TAG_LENGTH]
        if tag and tag not in tags:
            tags.append(tag)
        if len(tags) >= MAX_TAGS:
            break
    return tuple(tags)


def new_voice_id(taken: set[str] | None = None) -> str:
    taken = taken or set()
    while True:
        candidate = f"voice-{uuid.uuid4().hex[:10]}"
        if candidate not in taken:
            return candidate


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _meta_json(meta: VoiceMeta) -> bytes:
    return json.dumps(meta.stored(), ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def _remove_voice_dir(root: Path, voice_id: str, *, ignore_errors: bool = True) -> None:
    if not valid_voice_id(voice_id) or voice_id == BUILTIN_ID:
        return
    folder = root / voice_id
    try:
        folder.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return
    if ignore_errors:
        shutil.rmtree(folder, ignore_errors=True)
    elif folder.exists():
        shutil.rmtree(folder)


def self_check() -> None:
    import contextlib
    import tempfile

    @contextlib.contextmanager
    def scratch():
        # tempfile.mkdtemp uses mode 0700; that can exclude a sandboxed
        # harness token on Windows. A plainly-created folder stays writable.
        base = Path(tempfile.gettempdir()) / f"qiling-voices-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        base.mkdir(parents=True)
        try:
            yield base
        finally:
            shutil.rmtree(base, ignore_errors=True)

    assert valid_voice_id("pet-a")
    assert valid_voice_id("A_1")
    assert not valid_voice_id("../pet")
    assert not valid_voice_id("pet/a")
    assert not valid_voice_id("-pet")
    assert not valid_voice_id("")
    assert not valid_voice_id("x" * 65)
    assert parse_tags("宠物, 旁白，宠物") == ("宠物", "旁白")
    assert parse_tags("") == ()

    with scratch() as tmp_name:
        root = Path(tmp_name) / "voices"
        builtin_meta = VoiceMeta(
            id=BUILTIN_ID,
            name=BUILTIN_NAME,
            description="",
            tags=("内置",),
            prompt_seconds=4.0,
            sample_rate=PROMPT_RATE,
            created_at=now_iso(),
            builtin=True,
            prompt_text="今天想先看棋盘上的这一步。",
        )
        builtin_wav = Path(tmp_name) / "builtin-prompt.wav"
        builtin_wav.write_bytes(b"RIFF")
        store = VoiceStore(root)
        store.install_builtin(VoicePreset(meta=builtin_meta, prompt_wav=builtin_wav))
        assert store.default_id() == BUILTIN_ID
        assert store.count() == 1
        assert store.scan() == []
        assert store.list()[0].meta.builtin

        def create(voice_id: str, seconds: float = 3.0) -> VoicePreset:
            meta = VoiceMeta(
                id=voice_id,
                name=voice_id,
                description="",
                tags=("宠物",),
                prompt_seconds=seconds,
                sample_rate=PROMPT_RATE,
                created_at=now_iso(),
                prompt_text="这是参考音里的原句。",
            )
            staged = store.stage(meta, b"RIFF" + voice_id.encode("ascii"))
            store.activate(staged)
            return staged

        first = create("pet-a")
        create("pet-b", 4.0)
        assert store.count() == 3
        assert [voice.id for voice in store.list()] == [BUILTIN_ID, "pet-a", "pet-b"]
        assert store.get("pet-a") == first
        assert store.get("../pet") is None

        try:
            create("pet-a")
        except VoiceExists:
            pass
        else:
            raise AssertionError("duplicate id accepted")

        store.set_default("pet-a")
        assert store.default_id() == "pet-a"
        assert json.loads((root / DEFAULT_FILE).read_text(encoding="utf-8"))["defaultVoice"] == "pet-a"

        updated = store.update_meta("pet-a", name="宠物A", description="象棋旁白", tags=("宠物", "红方"))
        assert updated.meta.name == "宠物A"
        assert updated.meta.tags == ("宠物", "红方")
        assert store.read_meta("pet-a").name == "宠物A"

        # The builtin can be renamed, but its prompt is never stored as a user folder.
        store.update_meta(BUILTIN_ID, name="诗琚", description="自带音色")
        assert store.read_meta(BUILTIN_ID).name == "诗琚"
        assert not (root / BUILTIN_ID / PROMPT_FILE).exists()
        try:
            store.delete(BUILTIN_ID)
        except ValueError:
            pass
        else:
            raise AssertionError("builtin deleted")

        # Restart: user voices and the chosen default come back from disk.
        restarted = VoiceStore(root)
        restarted.install_builtin(VoicePreset(meta=builtin_meta, prompt_wav=builtin_wav))
        loaded = restarted.scan()
        assert {voice.id for voice in loaded} == {"pet-a", "pet-b"}
        assert restarted.default_id() == "pet-a"
        assert restarted.get("pet-a").meta.name == "宠物A"

        # Deleting the default falls back to the builtin and persists that.
        restarted.delete("pet-a")
        assert restarted.default_id() == BUILTIN_ID
        assert json.loads((root / DEFAULT_FILE).read_text(encoding="utf-8"))["defaultVoice"] == BUILTIN_ID
        assert not (root / "pet-a").exists()

        # A corrupt preset folder is skipped without taking the service down.
        broken = root / "broken"
        broken.mkdir()
        (broken / META_FILE).write_text("{not json", encoding="utf-8")
        (broken / PROMPT_FILE).write_bytes(b"RIFF")
        again = VoiceStore(root)
        again.install_builtin(VoicePreset(meta=builtin_meta, prompt_wav=builtin_wav))
        again.scan()
        assert again.get("broken") is None
        assert any("broken" in warning for warning in again.warnings)


if __name__ == "__main__":
    self_check()
    print("voice_store self-check ok")
