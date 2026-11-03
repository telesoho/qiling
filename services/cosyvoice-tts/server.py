#!/usr/bin/env python3
"""Local Fun-CosyVoice3-0.5B HTTP service for 器灵.

Start it yourself. 器灵 does not spawn this process. It only talks to
127.0.0.1 (default http://127.0.0.1:8765). The reference clip and its
transcript stay here, via the app-data directory or QILING_COSYVOICE_PROMPT_*.
QILING_* wins; the older SIJU_COSYVOICE_* names still work.
Requests carry the Chinese line to speak, never a board FEN.

One model, many voices. `child-girl-zero-shot` is the builtin default and
keeps its existing prompt resolution. Additional voices live under
`<appdata>/cosyvoice/voices/<voice_id>/` (meta.json + prompt.wav) and are
registered into CosyVoice at startup. POST /v1/voices uploads a new reference
clip once; synthesis then picks a preset with `voice` (or `voice_id`), and an
unknown id is 404 voice_not_found instead of silently using the default.

    python services/cosyvoice-tts/server.py --self-check
    <venv>/python services/cosyvoice-tts/server.py

Then open http://127.0.0.1:8765/docs for Swagger, or /redoc.

GET /health and GET /v1/health return 200 once the model is loaded.
POST /v1/audio/speech accepts JSON `input` or `text`, optional `voice`, and
returns audio/wav (or PCM frames when `stream` is true).
POST /v1/audio/cancel drops an in-flight line. The app can also discard
the response. Request ids belong to one client process and start over when
that process restarts, so a cancel only ever reaches a line that is still
running; it is never remembered against later ids.

The model is loaded before the process listens. A rejected prompt or a
failed load exits without serving, so /health is 200 only when synthesis
can run.

Synthesis uses fp16 autocast on CUDA and a short warmup line before the
first request, so the pet's first sentence does not pay kernel and
allocation costs. A line is cut at punctuation before it reaches the model
(UTTERANCE_CHARS), which keeps the autoregressive prefix and the vocoder
window bounded and lets the first audio frame leave early. Set
QILING_COSYVOICE_FP16=0 to force fp32, QILING_COSYVOICE_WARMUP=0 to skip
the warmup, and QILING_COSYVOICE_UTTERANCE_CHARS to change the cut.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback
import uuid
import wave
from collections.abc import Iterator
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from typing import Any, Mapping

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

import audio_io
import voice_store
from prompt_check import (
    ADULT_DEMO,
    assess,
    cosyvoice3_prompt,
    self_check as check_prompt,
    spoken_body,
    wav_duration_secs,
)

ENGINE = "cosyvoice3-0.5b"
MODEL_NAME = "Fun-CosyVoice3-0.5B-2512"
# The builtin preset. Health keeps `voice` for old clients; its value is now
# the default voice id, which may be a user preset.
VOICE = voice_store.BUILTIN_ID
# Registered from the reference clip; never sent by the caller.
CHILD_SPK_ID = voice_store.BUILTIN_ID
DEFAULT_PORT = 8765
MAX_SPEECH_BODY = 16_000
# Registration uploads one clip; this is the body cap, not the audio cap. The
# audio itself is capped at 10 MB by audio_io, and multipart framing rides on
# top of that.
MAX_UPLOAD_BODY = audio_io.MAX_BYTES + 1_000_000
# One model call per this many characters. The pet's lines are short; a long
# line would grow the autoregressive prefix and the vocoder window with it, and
# the first audio frame would wait for the whole paragraph.
UTTERANCE_CHARS = 48
WARMUP_LINE = "你好呀，我在。"
SENTENCE_ENDS = "。！？!?…\n"
CLAUSE_ENDS = "，,、：:；;"
MODEL_FILES = (
    "cosyvoice3.yaml",
    "llm.pt",
    "flow.pt",
    "hift.pt",
    "campplus.onnx",
    "speech_tokenizer_v3.onnx",
)


class EpochGate:
    """Drop synthesis that is still running when a cancel for it arrives.

    Cancel state is scoped to requests in flight, never to a watermark that
    outlives them. Ids come from one client process and start over at 1 when
    that process restarts, so a remembered watermark would answer 409 to every
    line the restarted app asked for, for good.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._infer = threading.Lock()
        self._running: dict[str, int] = {}
        self._cancelled: set[str] = set()

    @contextlib.contextmanager
    def running(self, request_id: int | str) -> Iterator[bool]:
        """Mark one request in flight, then forget it. Yields False if cancelled."""
        key = str(request_id)
        with self._lock:
            self._running[key] = self._running.get(key, 0) + 1
            live = key not in self._cancelled
        try:
            yield live
        finally:
            with self._lock:
                left = self._running.get(key, 0) - 1
                if left > 0:
                    self._running[key] = left
                else:
                    self._running.pop(key, None)
                    self._cancelled.discard(key)

    def cancel_before(self, epoch: int) -> None:
        with self._lock:
            self._cancelled.update(
                key for key in self._running if key.isdigit() and int(key) < epoch
            )

    def cancel_id(self, request_id: str) -> None:
        with self._lock:
            if request_id in self._running:
                self._cancelled.add(request_id)

    def allowed(self, request_id: int | str) -> bool:
        with self._lock:
            return str(request_id) not in self._cancelled

    def infer_lock(self) -> threading.Lock:
        return self._infer


class ServicePaths:
    def __init__(
        self,
        repo: Path,
        model: Path,
        prompt_wav: Path,
        prompt_text_inline: str | None,
        prompt_text_file: Path,
        device: str,
        voices: Path,
    ) -> None:
        self.repo = repo
        self.model = model
        self.prompt_wav = prompt_wav
        self.prompt_text_inline = prompt_text_inline
        self.prompt_text_file = prompt_text_file
        self.device = device
        self.voices = voices


class HealthBody(BaseModel):
    ok: bool = Field(description="模型已经加载，可以合成。")
    engine: str = Field(description="引擎标识。识局认 cosyvoice3-0.5b。", examples=["cosyvoice3-0.5b"])
    model: str = Field(description="权重名。", examples=["Fun-CosyVoice3-0.5B-2512"])
    voice: str = Field(
        description="默认音色。为兼容旧客户端保留；值等于 defaultVoice。",
        examples=["child-girl-zero-shot"],
    )
    defaultVoice: str = Field(
        description="默认音色 id。合成请求不传 voice 时用它。",
        examples=["child-girl-zero-shot"],
    )
    voiceCount: int = Field(description="可用音色数量，含内置音色。", examples=[1])
    sampleRate: int = Field(description="WAV 采样率。")
    device: str = Field(description="cpu 或 cuda。")
    precision: str = Field(description="fp16 或 fp32。CUDA 上默认 fp16 autocast。")
    promptSeconds: float = Field(description="默认音色的参考录音秒数。")


class ErrorBody(BaseModel):
    error: str = Field(
        description=(
            "empty、too_long、cancelled、synthesize_failed、voice_not_found、"
            "bad_audio、prompt_text_empty、voice_exists、builtin_voice 等。"
        )
    )


class SpeechRequest(BaseModel):
    """要念的一句中文。参考音不在这个请求里。"""

    model_config = ConfigDict(
        extra="ignore",
        json_schema_extra={
            "examples": [
                {"input": "红方略优。诗琚首选「炮二平五」。", "request_id": 1},
                {"input": "红方略优。", "voice": "pet-a", "request_id": 2, "stream": True},
            ]
        },
    )
    input: str | None = Field(
        default=None,
        description="要念的中文。和 text 二选一；两者都有时用 input。不要写局面 FEN。",
        examples=["红方略优。"],
    )
    text: str | None = Field(
        default=None,
        description="要念的中文。input 缺省时使用。",
        examples=["黑方均势。"],
    )
    voice: str | None = Field(
        default=None,
        description="音色 id。缺省用默认音色；找不到时返回 404 voice_not_found。",
        examples=["pet-a"],
    )
    voice_id: str | None = Field(default=None, description="voice 的别名。")
    request_id: int | str | None = Field(
        default=None,
        description="这一句的编号。取消时带同一个编号，或用 before 丢掉更早的编号。",
    )
    id: int | str | None = Field(default=None, description="request_id 的别名。")
    epoch: int | str | None = Field(default=None, description="旧协议里的序号，等同 request_id。")
    stream: bool = Field(
        default=False,
        description=(
            "为 true 时不等整句结束：200、Transfer-Encoding: chunked、"
            "Content-Type: application/octet-stream，响应头 X-Sample-Rate 和 X-Voice-Id。"
            "每一块是 0x01 + u32le 长度 + s16le 单声道 PCM；结束是 0x00；"
            "中途失败是 0x02 加 cancelled 或 failed。缺省仍返回整段 audio/wav。"
        ),
    )


class CancelOk(BaseModel):
    ok: bool = Field(description="已经记下取消。正在算的那一句会在下一块停掉。")


class CancelRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
        json_schema_extra={"examples": [{"before": 2}, {"request_id": "drop-me"}]},
    )
    before: int | None = Field(
        default=None,
        description="丢掉编号小于这个值、且编号是数字的合成。识局每次打断都会把序号加一。",
    )
    request_id: int | str | None = Field(default=None, description="丢掉这一条还在算的请求。")
    id: int | str | None = Field(default=None, description="request_id 的别名。")


class VoiceView(BaseModel):
    id: str = Field(description="音色 id，也是合成请求里的 voice。", examples=["pet-a"])
    name: str = Field(description="显示名。", examples=["宠物A"])
    description: str = Field(default="", description="说明。")
    tags: list[str] = Field(default_factory=list, description="标签。", examples=[["宠物"]])
    promptSeconds: float = Field(description="参考录音秒数。")
    sampleRate: int = Field(description="参考录音重采样后的采样率。", examples=[16000])
    createdAt: str = Field(description="注册时间，本地时区 ISO 8601。")
    builtin: bool = Field(description="是否服务自带、不可删除的默认音色。")


class VoiceBody(BaseModel):
    ok: bool = Field(description="操作成功。")
    voice: VoiceView
    warnings: list[str] = Field(default_factory=list, description="不影响成功、但值得提示的问题。")


class VoiceListBody(BaseModel):
    ok: bool = Field(description="操作成功。")
    defaultVoice: str = Field(description="默认音色 id。")
    voices: list[VoiceView] = Field(description="全部音色，内置音色在前。")


class DefaultVoiceBody(BaseModel):
    ok: bool = Field(description="操作成功。")
    defaultVoice: str = Field(description="新的默认音色 id。")


class VoicePatchRequest(BaseModel):
    """只改显示字段，不重新注册参考音。"""

    model_config = ConfigDict(extra="ignore")
    name: str | None = Field(default=None, description="显示名，最多 80 字。")
    description: str | None = Field(default=None, description="说明，最多 500 字。")
    tags: str | list[str] | None = Field(default=None, description="标签，逗号分隔或字符串数组。")


class DeleteOk(BaseModel):
    ok: bool = Field(description="已经删除。")
    deleted: str = Field(description="被删除的音色 id。")


GATE = EpochGate()
MODEL = None
VOICES: voice_store.VoiceStore | None = None
SAMPLE_RATE = 24000
DEVICE = "cpu"
PRECISION = "fp32"
PROMPT_SECONDS = 0.0
# Tests replace this. Production leaves it None and uses the loaded model.
SYNTHESIZE = None
# Streaming self-check replaces this with an iterator of PCM chunks.
STREAM_ITER = None


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def bundled_prompt_wav() -> Path:
    return repo_root() / "assets" / "qiling" / "voice-prompt-girl-child.wav"


def first_env(environ: Mapping[str, str], *names: str) -> str:
    for name in names:
        value = environ.get(name, "").strip()
        if value:
            return value
    return ""


def app_data_dir(environ: Mapping[str, str]) -> Path:
    override = first_env(environ, "QILING_APPDATA", "SIJU_APPDATA")
    if override:
        return Path(override)
    if os.name == "nt":
        base_text = environ.get("APPDATA", "").strip()
        base = Path(base_text) if base_text else Path.home() / "AppData" / "Roaming"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        xdg = environ.get("XDG_DATA_HOME", "").strip()
        base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    qiling = base / "com.qiling.pet"
    siju = base / "com.siju.app"
    if (qiling / "cosyvoice").exists():
        return qiling
    if (siju / "cosyvoice").exists():
        return siju
    return qiling


def normalize_device(value: str | None) -> str:
    token = (value or "auto").strip().lower()
    if token == "cpu":
        return "cpu"
    if token in {"cuda", "gpu"}:
        return "cuda"
    return "auto"


def precision_from(environ: Mapping[str, str]) -> str:
    """`QILING_COSYVOICE_FP16` is auto, fp16 or fp32. Auto means fp16 on CUDA."""
    token = first_env(environ, "QILING_COSYVOICE_FP16", "SIJU_COSYVOICE_FP16").lower()
    if token in {"1", "true", "yes", "on", "fp16", "half"}:
        return "fp16"
    if token in {"0", "false", "no", "off", "fp32", "full"}:
        return "fp32"
    return "auto"


def use_fp16(precision: str, cuda: bool) -> bool:
    """CPU has no half kernels; upstream resets fp16 there too."""
    if not cuda:
        return False
    return precision != "fp32"


def utterance_limit(environ: Mapping[str, str]) -> int:
    raw = first_env(environ, "QILING_COSYVOICE_UTTERANCE_CHARS", "SIJU_COSYVOICE_UTTERANCE_CHARS")
    try:
        value = int(raw)
    except ValueError:
        return UTTERANCE_CHARS
    return value if value >= 8 else UTTERANCE_CHARS


def warmup_enabled(environ: Mapping[str, str]) -> bool:
    token = first_env(environ, "QILING_COSYVOICE_WARMUP", "SIJU_COSYVOICE_WARMUP").lower()
    return token not in {"0", "false", "no", "off"}


def cut_index(line: str, limit: int) -> int:
    """Cut after the last punctuation before `limit`; a sentence end beats a comma."""
    window = line[:limit]
    for marks in (SENTENCE_ENDS, CLAUSE_ENDS):
        for index in range(len(window) - 1, 0, -1):
            if window[index] in marks:
                return index + 1
    return limit


def split_utterances(text: str, limit: int = UTTERANCE_CHARS) -> list[str]:
    """Cut a line into model calls at punctuation, no longer than `limit`.

    CosyVoice splits at punctuation itself, but a run of text without any is
    one unbounded call. Cutting here bounds the prefix each call sees, so the
    per-chunk cost does not climb and the first frame arrives sooner. A lone
    trailing punctuation mark rides with the last piece (one character over).
    """
    line = " ".join(text.split())
    if not line:
        return []
    if limit < 1:
        return [line]
    pieces: list[str] = []
    rest = line
    while len(rest) > limit:
        cut = cut_index(rest, limit)
        head = rest[:cut].strip()
        rest = rest[cut:].strip()
        if head:
            pieces.append(head)
    if rest:
        pieces.append(rest)
    # A trailing "。" on its own has nothing to say; keep it with the last words
    # so the model still hears a sentence ending.
    if len(pieces) > 1 and not any(ch.isalnum() for ch in pieces[-1]):
        pieces[-2] = pieces[-2] + pieces[-1]
        pieces.pop()
    return pieces


def parse_port(value: object | None, default: int = DEFAULT_PORT) -> int:
    if value is None:
        return default
    text = str(value).strip()
    if not text:
        return default
    port = int(text)
    if port < 1 or port > 65535:
        raise ValueError("端口要在 1 到 65535")
    return port


def require_loopback(host: str) -> str:
    if host == "localhost":
        return "127.0.0.1"
    if host != "127.0.0.1":
        raise ValueError("合成服务只监听本机")
    return host


def resolve_paths(environ: Mapping[str, str], asset_wav: Path | None = None) -> ServicePaths:
    """Reference audio stays on this process. Callers never supply the clip."""
    app = app_data_dir(environ)
    home = app / "cosyvoice"
    repo_env = first_env(environ, "QILING_COSYVOICE_ROOT", "SIJU_COSYVOICE_ROOT")
    model_env = first_env(environ, "QILING_COSYVOICE_MODEL", "SIJU_COSYVOICE_MODEL")
    repo = Path(repo_env) if repo_env else home / "CosyVoice"
    model = Path(model_env) if model_env else home / "Fun-CosyVoice3-0.5B"
    wav_env = first_env(environ, "QILING_COSYVOICE_PROMPT_WAV", "SIJU_COSYVOICE_PROMPT_WAV")
    user_wav = home / "voice-prompt-girl-child.wav"
    bundled = asset_wav if asset_wav is not None else bundled_prompt_wav()
    if wav_env:
        prompt_wav = Path(wav_env)
    elif user_wav.is_file():
        prompt_wav = user_wav
    elif bundled.is_file():
        prompt_wav = bundled
    else:
        prompt_wav = user_wav
    text_env = first_env(environ, "QILING_COSYVOICE_PROMPT_TEXT_FILE", "SIJU_COSYVOICE_PROMPT_TEXT_FILE")
    inline = first_env(environ, "QILING_COSYVOICE_PROMPT_TEXT", "SIJU_COSYVOICE_PROMPT_TEXT") or None
    prompt_text_file = Path(text_env) if text_env else prompt_wav.with_suffix(".txt")
    return ServicePaths(
        repo=repo,
        model=model,
        prompt_wav=prompt_wav,
        prompt_text_inline=inline,
        prompt_text_file=prompt_text_file,
        device=normalize_device(first_env(environ, "QILING_COSYVOICE_DEVICE", "SIJU_COSYVOICE_DEVICE") or None),
        voices=home / "voices",
    )


def read_transcript(paths: ServicePaths) -> str:
    if paths.prompt_text_inline:
        return paths.prompt_text_inline
    return paths.prompt_text_file.read_text(encoding="utf-8")


def prepare_prompt(paths: ServicePaths) -> tuple[bool, str]:
    """Return (ok, prompt or the reason it was refused)."""
    try:
        transcript = read_transcript(paths)
    except OSError as exc:
        return False, f"读参考文稿失败: {exc}"
    duration = wav_duration_secs(paths.prompt_wav)
    ok, detail, spoken = assess(transcript, duration)
    if not ok:
        return False, detail
    prompt = cosyvoice3_prompt(spoken)
    if ADULT_DEMO in prompt.split("<|endofprompt|>")[-1]:
        return False, "拒绝官方成年女声示例稿"
    return True, prompt


def model_problem(model_dir: Path) -> str | None:
    if not model_dir.is_dir():
        return (
            f"没有找到 Fun-CosyVoice3-0.5B 权重目录（{model_dir}）。"
            "运行 python scripts/setup_cosyvoice.py 下载，不要把权重提交进 git。"
        )
    missing = [name for name in MODEL_FILES if not (model_dir / name).is_file()]
    if not (model_dir / "CosyVoice-BlankEN").is_dir():
        missing.append("CosyVoice-BlankEN")
    if missing:
        return f"Fun-CosyVoice3-0.5B 权重不完整，缺少 {'、'.join(missing)}。目录：{model_dir}"
    return None


def repo_problem(repo: Path) -> str | None:
    if not (repo / "cosyvoice" / "cli" / "cosyvoice.py").is_file():
        return (
            f"没有找到 CosyVoice 源码（{repo}）。"
            "运行 python scripts/setup_cosyvoice.py 会克隆 FunAudioLLM/CosyVoice。"
        )
    if not (repo / "third_party" / "Matcha-TTS").is_dir():
        return "CosyVoice 的 third_party/Matcha-TTS 还没拉下来。在源码目录执行 git submodule update --init --recursive。"
    return None


def apply_device(device: str) -> None:
    if device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    # 8GB cards rarely run out of total memory before they run out of unfragmented
    # blocks. The next long sentence is the one that fails. Must be set before
    # torch initialises CUDA in this process.
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")


def load_model(repo: Path, model_dir: Path, fp16: bool = False):
    sys.path.insert(0, str(repo))
    sys.path.insert(0, str(repo / "third_party" / "Matcha-TTS"))
    import torch

    from cosyvoice.cli.cosyvoice import AutoModel

    torch.set_grad_enabled(False)
    if fp16:
        try:
            model = AutoModel(model_dir=str(model_dir), fp16=True)
        except TypeError as exc:
            # An older checkout has no fp16 switch. Autocast only; the weights and
            # the frontend features stay fp32, so nothing else has to change.
            sys.stderr.write(f"这个 CosyVoice checkout 不接受 fp16，回退 fp32：{exc}\n")
            model = AutoModel(model_dir=str(model_dir))
    else:
        model = AutoModel(model_dir=str(model_dir))
    name = model.__class__.__name__
    if name != "CosyVoice3":
        raise RuntimeError(f"需要 CosyVoice3，实际加载的是 {name}")
    return model


def register_child_voice(model, prompt_text: str, prompt_wav: Path) -> None:
    added = model.add_zero_shot_spk(prompt_text, str(prompt_wav), CHILD_SPK_ID)
    if added is not True:
        raise RuntimeError("零样本参考音没有注册成功")


def add_speaker(model, spk_id: str, prompt_text: str, prompt_wav: Path) -> bool:
    """Register one preset into the single loaded model. Never raises to the caller."""
    try:
        return model.add_zero_shot_spk(cosyvoice3_prompt(prompt_text), str(prompt_wav), spk_id) is True
    except Exception as exc:
        sys.stderr.write(f"qiling voice register failed id={spk_id}: {exc}\n")
        traceback.print_exc(file=sys.stderr)
        return False


def remove_speaker(model, spk_id: str) -> None:
    """Best-effort eviction. CosyVoice keeps speakers in `frontend.spk2info`."""
    for owner in (model, getattr(model, "frontend", None)):
        info = getattr(owner, "spk2info", None)
        if isinstance(info, dict):
            info.pop(spk_id, None)
            return
    for name in ("del_spk", "delete_spk", "remove_spk"):
        remover = getattr(model, name, None)
        if callable(remover):
            try:
                remover(spk_id)
            except Exception as exc:
                sys.stderr.write(f"qiling voice remove failed id={spk_id}: {exc}\n")
            return


def clean_prompt_text(raw: object) -> str:
    """The transcript the model hears, without the control prefix."""
    text = " ".join(str(raw or "").split())
    text = spoken_body(text)
    return text.strip()


def prompt_text_problem(text: str) -> str | None:
    if not text:
        return "prompt_text 不能为空。请填写参考录音里实际说的那句话。"
    if len(text) > voice_store.MAX_PROMPT_CHARS:
        return f"prompt_text 有 {len(text)} 字，上限 {voice_store.MAX_PROMPT_CHARS} 字。"
    return None


def voice_error(error: str, status: int, detail: str = "", **extra: Any) -> JSONResponse:
    payload: dict[str, Any] = {"error": error}
    if detail:
        payload["detail"] = detail
    payload.update(extra)
    return JSONResponse(payload, status_code=status)


def voice_not_found(voice_id: str) -> JSONResponse:
    # Never fall back to the default here: a wrong character voice is worse
    # than a clear error, because the app would otherwise think it is configured.
    return voice_error("voice_not_found", 404, voice=voice_id)


def requested_voice(body: SpeechRequest) -> str:
    for value in (body.voice, body.voice_id):
        if value is not None and str(value).strip():
            return str(value).strip()
    if VOICES is not None:
        return VOICES.default_id()
    return voice_store.BUILTIN_ID


def resolve_voice(voice_id: str) -> voice_store.VoicePreset | None:
    return VOICES.get(voice_id) if VOICES is not None else None


class MultipartError(ValueError):
    pass


def _disposition_param(value: str, key: str) -> str:
    match = re.search(rf"(?:^|;)\s*{re.escape(key)}\s*=\s*(?:\"([^\"]*)\"|([^;\s]+))", value, re.I)
    if match is None:
        return ""
    return match.group(1) if match.group(1) is not None else match.group(2)


def parse_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], dict[str, tuple[str, bytes]]]:
    """Parse the small multipart form used by voice registration.

    FastAPI's Form/File parsing needs `python-multipart`; the service keeps its
    dependency list at FastAPI + uvicorn, so this handles only the one shape it
    accepts: text fields plus named binary parts.
    """
    head, _, parameters = content_type.partition(";")
    if head.strip().lower() != "multipart/form-data":
        raise MultipartError("注册音色需要 multipart/form-data。")
    boundary = ""
    for parameter in parameters.split(";"):
        key, _, value = parameter.strip().partition("=")
        if key.lower() == "boundary":
            boundary = value.strip().strip('"')
    if not boundary or len(boundary) > 200:
        raise MultipartError("multipart 缺少 boundary。")
    delimiter = b"--" + boundary.encode("latin-1", "replace")
    if delimiter not in body:
        raise MultipartError("multipart body 里没有 boundary。")
    fields: dict[str, str] = {}
    files: dict[str, tuple[str, bytes]] = {}
    for part in body.split(delimiter)[1:]:
        if part.startswith(b"--"):
            break
        if part.startswith(b"\r\n"):
            part = part[2:]
        if part.endswith(b"\r\n"):
            part = part[:-2]
        header_block, separator, content = part.partition(b"\r\n\r\n")
        if not separator:
            continue
        headers: dict[str, str] = {}
        for line in header_block.split(b"\r\n"):
            name, colon, value = line.partition(b":")
            if colon:
                headers[name.strip().lower().decode("latin-1", "replace")] = value.strip().decode(
                    "latin-1", "replace"
                )
        disposition = headers.get("content-disposition", "")
        field_name = _disposition_param(disposition, "name")
        if not field_name:
            continue
        filename = _disposition_param(disposition, "filename")
        if filename:
            files[field_name] = (filename, content)
        else:
            fields[field_name] = content.decode("utf-8", "replace")
    return fields, files


async def read_body_limited(request: Request, limit: int) -> bytes | None:
    """Read at most `limit` bytes. Content-Length is prechecked by middleware."""
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            return None
        body.extend(chunk)
    return bytes(body)


def upload_audio(fields: dict[str, str], files: dict[str, tuple[str, bytes]]) -> tuple[audio_io.Clip | None, JSONResponse | None]:
    part = files.get("prompt_audio") or files.get("audio")
    if part is None:
        return None, voice_error("bad_audio", 400, "缺少 prompt_audio 文件。")
    filename, data = part
    if not data:
        return None, voice_error("bad_audio", 400, f"{filename or 'prompt_audio'} 是空文件。")
    if len(data) > audio_io.MAX_BYTES:
        return None, voice_error(
            "audio_too_large",
            413,
            f"参考音频有 {len(data) / 1024 / 1024:.1f} MB，上限 10 MB。",
        )
    try:
        return audio_io.decode(data), None
    except audio_io.AudioError as exc:
        return None, voice_error(exc.code, 413 if exc.code == "audio_too_large" else 400, exc.detail)


def upload_warnings(clip: audio_io.Clip) -> list[str]:
    if clip.seconds < 3.0:
        return ["参考音频短于 3 秒，音色可能不稳定；建议 3–10 秒。"]
    if clip.seconds > 10.0:
        return ["参考音频长于 10 秒，通常没必要；3–10 秒就够。"]
    return []


def register_upload(
    fields: dict[str, str],
    files: dict[str, tuple[str, bytes]],
) -> VoiceBody | JSONResponse:
    """Shared by POST /v1/voices and PUT /v1/voices/{id}/prompt."""
    if VOICES is None or MODEL is None:
        return voice_error("model_not_loaded", 503, "模型还没加载。")
    text = clean_prompt_text(fields.get("prompt_text", ""))
    problem = prompt_text_problem(text)
    if problem:
        code = "prompt_text_empty" if not text else "prompt_text_too_long"
        return voice_error(code, 400, problem)
    clip, failure = upload_audio(fields, files)
    if failure is not None:
        return failure
    assert clip is not None

    voice_id = str(fields.get("voice_id") or "").strip()
    if not voice_id:
        taken = {voice.id for voice in VOICES.list()}
        try:
            taken.update(path.name for path in VOICES.root.iterdir() if path.is_dir())
        except OSError:
            pass
        voice_id = voice_store.new_voice_id(taken)
    if not voice_store.valid_voice_id(voice_id):
        return voice_error(
            "bad_voice_id",
            400,
            "voice_id 只能用字母或数字开头，后面跟字母、数字、_ 或 -，最长 64。",
        )
    name = " ".join(str(fields.get("name") or "").split())[: voice_store.MAX_NAME] or voice_id
    description = " ".join(str(fields.get("description") or "").split())[: voice_store.MAX_DESCRIPTION]
    tags = voice_store.parse_tags(fields.get("tags", ""))
    meta = voice_store.VoiceMeta(
        id=voice_id,
        name=name,
        description=description,
        tags=tags,
        prompt_seconds=round(clip.seconds, 3),
        sample_rate=clip.sample_rate,
        created_at=voice_store.now_iso(),
        builtin=False,
        prompt_text=text,
    )
    prompt_wav = audio_io.wav_bytes(clip.samples, clip.sample_rate)

    with GATE.infer_lock():
        if VOICES.exists(voice_id):
            return voice_error("voice_exists", 409, f"音色 {voice_id} 已经存在。", voice=voice_id)
        try:
            preset = VOICES.stage(meta, prompt_wav)
        except voice_store.VoiceExists:
            return voice_error("voice_exists", 409, f"音色 {voice_id} 已经存在。", voice=voice_id)
        except OSError as exc:
            return voice_error("register_failed", 500, f"写入音色目录失败：{exc}")
        if not add_speaker(MODEL, preset.spk_id, preset.prompt_text, preset.prompt_wav):
            VOICES.discard(preset)
            return voice_error("register_failed", 500, "提取音色嵌入失败，参考音没有注册。")
        VOICES.activate(preset)
    sys.stderr.write(
        f"qiling voice registered id={voice_id} seconds={clip.seconds:.2f} "
        f"voices={VOICES.count()}\n"
    )
    return VoiceBody(
        ok=True,
        voice=VoiceView(**preset.meta.public()),
        warnings=upload_warnings(clip),
    )


def replace_voice_prompt(
    voice_id: str,
    fields: dict[str, str],
    files: dict[str, tuple[str, bytes]],
) -> VoiceBody | JSONResponse:
    if VOICES is None or MODEL is None:
        return voice_error("model_not_loaded", 503, "模型还没加载。")
    if not voice_store.valid_voice_id(voice_id):
        return voice_not_found(voice_id)
    text = clean_prompt_text(fields.get("prompt_text", ""))
    problem = prompt_text_problem(text)
    if problem:
        code = "prompt_text_empty" if not text else "prompt_text_too_long"
        return voice_error(code, 400, problem)
    clip, failure = upload_audio(fields, files)
    if failure is not None:
        return failure
    assert clip is not None
    prompt_wav = audio_io.wav_bytes(clip.samples, clip.sample_rate)

    with GATE.infer_lock():
        preset = VOICES.get(voice_id)
        if preset is None:
            return voice_not_found(voice_id)
        if preset.meta.builtin:
            return voice_error("builtin_voice", 400, "内置默认音色的参考音不能替换；请注册新音色。")
        temporary = VOICES.root / voice_id / ".prompt-new.wav"
        try:
            temporary.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_bytes(prompt_wav)
            if not add_speaker(MODEL, preset.spk_id, text, temporary):
                return voice_error("register_failed", 500, "提取音色嵌入失败，原参考音保持不变。")
            try:
                updated = VOICES.replace_prompt(
                    voice_id,
                    prompt_wav=prompt_wav,
                    prompt_text=text,
                    prompt_seconds=clip.seconds,
                    sample_rate=clip.sample_rate,
                )
            except Exception as exc:
                # The speaker map now has the new clip but disk still has the
                # old one. Put the old prompt back so this process matches disk.
                add_speaker(MODEL, preset.spk_id, preset.prompt_text, preset.prompt_wav)
                return voice_error("register_failed", 500, f"写入新参考音失败：{exc}")
        except OSError as exc:
            return voice_error("register_failed", 500, f"替换参考音失败：{exc}")
        finally:
            with contextlib.suppress(OSError):
                temporary.unlink()
    sys.stderr.write(f"qiling voice prompt replaced id={voice_id} seconds={clip.seconds:.2f}\n")
    return VoiceBody(
        ok=True,
        voice=VoiceView(**updated.meta.public()),
        warnings=upload_warnings(clip),
    )


def voice_view(voice: voice_store.VoicePreset) -> VoiceView:
    return VoiceView(**voice.meta.public())


def list_voices_payload() -> VoiceListBody:
    assert VOICES is not None
    return VoiceListBody(
        ok=True,
        defaultVoice=VOICES.default_id(),
        voices=[voice_view(voice) for voice in VOICES.list()],
    )


def build_builtin_preset(paths: ServicePaths, prompt: str) -> voice_store.VoicePreset:
    """The builtin keeps its existing prompt resolution; only the id is new."""
    spoken = clean_prompt_text(prompt)
    seconds = float(wav_duration_secs(paths.prompt_wav) or 0.0)
    meta = voice_store.VoiceMeta(
        id=voice_store.BUILTIN_ID,
        name=voice_store.BUILTIN_NAME,
        description="服务自带的儿童女孩零样本音色。",
        tags=("内置",),
        prompt_seconds=round(seconds, 3),
        sample_rate=audio_io.TARGET_RATE,
        created_at=voice_store.now_iso(),
        builtin=True,
        prompt_text=spoken,
    )
    return voice_store.VoicePreset(meta=meta, prompt_wav=paths.prompt_wav.resolve())


def load_voice_library(paths: ServicePaths, prompt: str) -> list[str]:
    """Scan presets and register each into the loaded model. Returns warnings."""
    global VOICES
    store = voice_store.VoiceStore(paths.voices)
    builtin = build_builtin_preset(paths, prompt)
    sidecar = store.read_meta(builtin.id)
    if sidecar is not None:
        # Display fields may be renamed; the reference clip still comes from
        # QILING_COSYVOICE_PROMPT_* / app-data, so upgrades keep the same voice.
        builtin = voice_store.VoicePreset(
            meta=replace(
                builtin.meta,
                name=sidecar.name,
                description=sidecar.description,
                tags=sidecar.tags or builtin.meta.tags,
                created_at=sidecar.created_at or builtin.meta.created_at,
            ),
            prompt_wav=builtin.prompt_wav,
        )
    store.install_builtin(builtin)
    warnings: list[str] = []
    try:
        loaded = store.scan()
    except Exception as exc:
        warnings.append(f"扫描音色目录失败：{exc}")
        loaded = []
    warnings.extend(store.warnings)
    VOICES = store
    failed: set[str] = set()
    for preset in loaded:
        if MODEL is not None and not add_speaker(MODEL, preset.spk_id, preset.prompt_text, preset.prompt_wav):
            failed.add(preset.id)
            warnings.append(f"音色 {preset.id} 启动注册失败，仍保留在列表里，可 PUT 参考音修复。")
    if failed and store.default_id() in failed:
        fallback = store.default_id()
        try:
            store.set_default(voice_store.BUILTIN_ID)
            warnings.append(f"默认音色 {fallback} 启动注册失败，已回退到内置音色。")
        except (KeyError, OSError) as exc:
            warnings.append(f"默认音色 {fallback} 启动注册失败，回退内置音色也失败：{exc}")
    return warnings


def pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    buffer = BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm)
    return buffer.getvalue()


def tensor_to_pcm(speech) -> bytes:
    import numpy as np

    audio = speech.detach().float().cpu().squeeze().clamp(-1, 1).numpy()
    return (audio * 32767.0).astype(np.int16).tobytes()


def pcm_frame(pcm: bytes) -> bytes:
    return b"\x01" + len(pcm).to_bytes(4, "little") + pcm


def fail_frame(reason: str) -> bytes:
    text = reason if reason in {"cancelled", "failed"} else "failed"
    return b"\x02" + text.encode("ascii")


def model_pcm_chunks(request_id: int | str, piece: str, spk_id: str = CHILD_SPK_ID):
    """Yield s16le PCM for one short utterance as the model produces it."""
    import torch

    generator = MODEL.inference_zero_shot(
        piece,
        "",
        "",
        zero_shot_spk_id=spk_id,
        stream=True,
        speed=1.0,
    )
    # This process only ever infers. Upstream decorates its own inference methods,
    # but the glue around them (and the per-chunk copy to CPU) is not, so keep the
    # whole chunk loop out of autograd bookkeeping.
    with torch.inference_mode():
        for item in generator:
            if not GATE.allowed(request_id):
                return
            speech = item.get("tts_speech")
            if speech is None:
                continue
            pcm = tensor_to_pcm(speech)
            if pcm:
                yield pcm


def warmup(model, fp16: bool = False, spk_id: str = CHILD_SPK_ID) -> None:
    """Spend the first-call cost (kernel autotune, allocator growth) at startup."""
    import torch

    started = time.monotonic()
    try:
        with torch.inference_mode():
            for _ in model.inference_zero_shot(
                WARMUP_LINE,
                "",
                "",
                zero_shot_spk_id=spk_id,
                stream=True,
                speed=1.0,
            ):
                pass
    except Exception as exc:
        hint = "；如果是半精度不兼容，用 --fp32 或 QILING_COSYVOICE_FP16=0 启动" if fp16 else ""
        sys.stderr.write(f"预热失败，不影响合成：{exc}{hint}\n")
        return
    sys.stderr.write(f"qiling cosyvoice3 warmup {time.monotonic() - started:.2f}s\n")


def log_utterance(chars: int, chunks: int, audio: float, wall: float, first: float, voice_id: str) -> None:
    """One line per spoken sentence: first frame and RTF are what "卡壳" looks like."""
    rtf = wall / audio if audio > 0 else 0.0
    sys.stderr.write(
        f"qiling cosyvoice3 voice={voice_id} chars={chars} chunks={chunks} audio={audio:.2f}s "
        f"wall={wall:.2f}s first={first * 1000:.0f}ms rtf={rtf:.2f}\n"
    )


def synthesize(request_id: int | str, text: str, voice_id: str) -> tuple[int, bytes, str]:
    line = " ".join(text.split())
    if not line:
        return 400, b'{"error":"empty"}', "application/json"
    if len(line) > 400:
        return 400, b'{"error":"too_long"}', "application/json"
    preset = resolve_voice(voice_id)
    if preset is None:
        return 404, b'{"error":"voice_not_found"}', "application/json"
    with GATE.running(request_id) as live:
        if not live:
            return 409, b'{"error":"cancelled"}', "application/json"
        if SYNTHESIZE is not None:
            return SYNTHESIZE(line, voice_id)
        started = time.monotonic()
        first = 0.0
        audio = 0.0
        chunks = 0
        pcm = bytearray()
        with GATE.infer_lock():
            # The registry may have changed while this request waited for the
            # inference lock; do not synthesize with a voice deleted meanwhile.
            preset = resolve_voice(voice_id)
            if preset is None:
                return 404, b'{"error":"voice_not_found"}', "application/json"
            if not GATE.allowed(request_id):
                return 409, b'{"error":"cancelled"}', "application/json"
            for piece in split_utterances(line, UTTERANCE_CHARS):
                if not GATE.allowed(request_id):
                    break
                for chunk in model_pcm_chunks(request_id, piece, preset.spk_id):
                    if chunks == 0:
                        first = time.monotonic() - started
                    chunks += 1
                    audio += len(chunk) / 2 / SAMPLE_RATE
                    pcm.extend(chunk)
        if not GATE.allowed(request_id):
            return 409, b'{"error":"cancelled"}', "application/json"
        if not pcm:
            return 500, b'{"error":"empty_audio"}', "application/json"
        log_utterance(len(line), chunks, audio, time.monotonic() - started, first, voice_id)
        return 200, pcm_to_wav(bytes(pcm), SAMPLE_RATE), "audio/wav"


def health_payload() -> HealthBody:
    if VOICES is not None:
        default = VOICES.default_id()
        count = VOICES.count()
        default_voice = VOICES.get(default)
        prompt_seconds = default_voice.meta.prompt_seconds if default_voice is not None else PROMPT_SECONDS
    else:
        default = VOICE
        count = 1
        prompt_seconds = PROMPT_SECONDS
    return HealthBody(
        ok=True,
        engine=ENGINE,
        model=MODEL_NAME,
        voice=default,
        defaultVoice=default,
        voiceCount=count,
        sampleRate=SAMPLE_RATE,
        device=DEVICE,
        precision=PRECISION,
        promptSeconds=prompt_seconds,
    )


def spoken_line(body: SpeechRequest) -> str:
    """Only the utterance. Unknown JSON fields, including any prompt, are ignored."""
    if body.input is not None:
        return body.input
    if body.text is not None:
        return body.text
    return ""


def request_id_of(body: SpeechRequest) -> str:
    for value in (body.request_id, body.id, body.epoch):
        if value is None or value == "":
            continue
        return str(value)
    return "0"


def apply_cancel(body: CancelRequest) -> None:
    if body.before is not None:
        GATE.cancel_before(int(body.before))
    for value in (body.request_id, body.id):
        if value is None or value == "":
            continue
        GATE.cancel_id(str(value))


def error_response(status: int, body: bytes) -> JSONResponse:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        payload = {"error": "synthesize_failed"}
    return JSONResponse(payload, status_code=status)


def refusal(text: str) -> JSONResponse | None:
    """JSON errors keep Content-Length. Streaming starts only after these checks."""
    line = " ".join(text.split())
    if not line:
        return JSONResponse({"error": "empty"}, status_code=400)
    if len(line) > 400:
        return JSONResponse({"error": "too_long"}, status_code=400)
    return None


def iter_model_pcm(request_id: str, line: str, spk_id: str):
    if STREAM_ITER is not None:
        yield from STREAM_ITER()
        return
    for piece in split_utterances(line, UTTERANCE_CHARS):
        if not GATE.allowed(request_id):
            return
        yield from model_pcm_chunks(request_id, piece, spk_id)


def stream_frames(request_id: str, line: str, voice_id: str):
    """One HTTP chunk per frame. The lock covers the whole utterance."""
    with GATE.running(request_id) as live:
        if not live:
            yield fail_frame("cancelled")
            return
        emitted = False
        started = time.monotonic()
        first = 0.0
        audio = 0.0
        chunks = 0
        try:
            with GATE.infer_lock():
                if not GATE.allowed(request_id):
                    yield fail_frame("cancelled")
                    return
                preset = resolve_voice(voice_id)
                if preset is None:
                    # The voice was deleted between the header check and the lock.
                    yield fail_frame("failed")
                    return
                for pcm in iter_model_pcm(request_id, line, preset.spk_id):
                    if not GATE.allowed(request_id):
                        yield fail_frame("cancelled")
                        return
                    if chunks == 0:
                        first = time.monotonic() - started
                    chunks += 1
                    audio += len(pcm) / 2 / SAMPLE_RATE
                    emitted = True
                    yield pcm_frame(pcm)
                if not GATE.allowed(request_id):
                    yield fail_frame("cancelled")
                    return
            if not emitted:
                yield fail_frame("failed")
                return
            log_utterance(len(line), chunks, audio, time.monotonic() - started, first, voice_id)
            yield b"\x00"
        except Exception as exc:
            sys.stderr.write(f"synthesize failed: {exc}\n")
            traceback.print_exc(file=sys.stderr)
            yield fail_frame("failed")


def stream_speech(body: SpeechRequest, preset: voice_store.VoicePreset) -> Response:
    request_id = request_id_of(body)
    line = spoken_line(body)
    refused = refusal(line)
    if refused is not None:
        return refused
    return StreamingResponse(
        stream_frames(request_id, " ".join(line.split()), preset.id),
        status_code=200,
        media_type="application/octet-stream",
        headers={
            "X-Sample-Rate": str(SAMPLE_RATE),
            "X-Voice-Id": preset.id,
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def speech_result(body: SpeechRequest) -> Response:
    voice_id = requested_voice(body)
    preset = resolve_voice(voice_id)
    if preset is None:
        return voice_not_found(voice_id)
    if body.stream:
        return stream_speech(body, preset)
    try:
        status, payload, content_type = synthesize(request_id_of(body), spoken_line(body), voice_id)
    except Exception as exc:  # model errors stay on this machine
        sys.stderr.write(f"synthesize failed: {exc}\n")
        traceback.print_exc(file=sys.stderr)
        return JSONResponse({"error": "synthesize_failed"}, status_code=500)
    if status == 404:
        return voice_not_found(voice_id)
    if status != 200:
        return error_response(status, payload)
    return Response(
        content=payload,
        media_type=content_type,
        headers={"X-Voice-Id": voice_id},
    )


def cancel_result(body: CancelRequest) -> JSONResponse:
    try:
        apply_cancel(body)
    except (TypeError, ValueError):
        return JSONResponse({"error": "bad_cancel"}, status_code=400)
    return JSONResponse({"ok": True})


SPEECH_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "content": {
            "audio/wav": {"schema": {"type": "string", "format": "binary"}},
            "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
        },
        "description": (
            "stream 缺省时是整段 WAV。"
            "stream 为 true 时按块返回：0x01 + u32le 长度 + s16le PCM，结束 0x00，"
            "中途失败 0x02 + cancelled 或 failed。响应头 X-Sample-Rate 和 X-Voice-Id。"
        ),
    },
    400: {"model": ErrorBody, "description": "没有可念的字，或超过 400 字。"},
    404: {"model": ErrorBody, "description": "voice 不存在。"},
    409: {"model": ErrorBody, "description": "这一句已被取消。"},
    413: {"model": ErrorBody, "description": "请求体超过 16KB。"},
    500: {"model": ErrorBody, "description": "本机合成失败。"},
}

VOICE_UPLOAD_BODY: dict[str, Any] = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["prompt_text", "prompt_audio"],
                    "properties": {
                        "voice_id": {
                            "type": "string",
                            "pattern": voice_store.VOICE_ID_PATTERN,
                            "description": "可选；缺省由服务端生成。",
                        },
                        "name": {"type": "string", "maxLength": voice_store.MAX_NAME},
                        "prompt_text": {
                            "type": "string",
                            "description": "参考音频里实际说的话，1–500 字，必须与音频严格对应。",
                        },
                        "prompt_audio": {
                            "type": "string",
                            "format": "binary",
                            "description": "wav/mp3/m4a，1–30 秒，推荐 3–10 秒，最大 10 MB。",
                        },
                        "description": {"type": "string", "maxLength": voice_store.MAX_DESCRIPTION},
                        "tags": {"type": "string", "description": "逗号分隔，例如 宠物,旁白。"},
                    },
                }
            }
        },
    }
}

VOICE_UPLOAD_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {"model": VoiceBody, "description": "注册成功。"},
    400: {"model": ErrorBody, "description": "音频、逐字稿或 voice_id 不合法。"},
    409: {"model": ErrorBody, "description": "voice_id 已存在。"},
    413: {"model": ErrorBody, "description": "音频超过 10 MB 或请求体过大。"},
    500: {"model": ErrorBody, "description": "提取音色嵌入失败。"},
}


app = FastAPI(
    title="器灵 CosyVoice",
    summary="本机 CosyVoice 3 多角色零样本语音。",
    description=(
        "器灵的本机语音服务。服务只监听 127.0.0.1。"
        "内置默认音色 child-girl-zero-shot 的参考录音和逐字稿留在服务进程里"
        "（QILING_COSYVOICE_PROMPT_* / SIJU_COSYVOICE_PROMPT_* 或应用数据目录）。"
        "其他音色用 POST /v1/voices 上传参考音注册一次，合成时用 voice 选择。"
        "请求里只放要念的中文，不要带局面 FEN，也不要带参考音路径。"
    ),
    version="1.1.0",
    docs_url=None,
    redoc_url="/redoc",
)

# ponytail: swagger-ui sets <audio src> to the POST url (swagger-ui#8378). Drop this when upstream uses the response blob.
_WAV_PLAYER = """
const wavBlobs = new Map()
const blobOwner = new Map()
function playWav(response) {
  try {
    const headers = response.headers || {}
    const type = String(headers["content-type"] || headers["Content-Type"] || "")
    if (type.indexOf("audio/") === -1 || !(response.data instanceof Blob)) return response
    const next = URL.createObjectURL(response.data)
    const prev = wavBlobs.get(response.url)
    wavBlobs.set(response.url, next)
    blobOwner.set(next, response.url)
    const drop = function () {
      rewireWav()
      if (!prev) return
      blobOwner.delete(prev)
      URL.revokeObjectURL(prev)
    }
    drop()
    setTimeout(drop, 0)
  } catch (err) {}
  return response
}
function blobFor(src) {
  if (!src) return ""
  const direct = wavBlobs.get(src)
  if (direct) return direct
  try {
    const viaAbs = wavBlobs.get(new URL(src, location.href).href)
    if (viaAbs) return viaAbs
  } catch (err) {}
  const owner = blobOwner.get(src)
  return owner ? (wavBlobs.get(owner) || "") : ""
}
function rewireWav() {
  const sources = document.querySelectorAll("audio source")
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    const blob = blobFor(source.getAttribute("src") || "") || blobFor(source.src)
    if (!blob || source.src === blob) continue
    source.src = blob
    const audio = source.parentElement
    if (audio && audio.load) audio.load()
  }
}
new MutationObserver(rewireWav).observe(document.documentElement, {childList: true, subtree: true})
"""


@app.get("/docs", include_in_schema=False)
def swagger_docs() -> HTMLResponse:
    page = get_swagger_ui_html(openapi_url="/openapi.json", title=f"{app.title} - Swagger UI")
    html = page.body.decode("utf-8")
    needle = "const ui = SwaggerUIBundle({"
    if needle not in html:
        return page
    html = html.replace(needle, _WAV_PLAYER + "\n" + needle + "\nresponseInterceptor: playWav,", 1)
    return HTMLResponse(html)


def body_limit_for(method: str, path: str) -> int:
    """Registration uploads one clip; every other body keeps the 16 KB cap."""
    route = path.rstrip("/")
    if method == "POST" and route == "/v1/voices":
        return MAX_UPLOAD_BODY
    if method == "PUT" and route.startswith("/v1/voices/") and route.endswith("/prompt"):
        return MAX_UPLOAD_BODY
    return MAX_SPEECH_BODY


@app.middleware("http")
async def limit_body(request, call_next):
    if request.method in {"POST", "PUT", "PATCH"}:
        raw = request.headers.get("content-length")
        if raw is not None:
            try:
                length = int(raw)
            except ValueError:
                length = -1
            limit = body_limit_for(request.method, request.url.path)
            if length < 0 or length > limit:
                error = "audio_too_large" if limit == MAX_UPLOAD_BODY else "too_large"
                return JSONResponse({"error": error}, status_code=413)
    return await call_next(request)


@app.get("/health", response_model=HealthBody, summary="服务是否已加载模型")
@app.get("/v1/health", response_model=HealthBody, summary="服务是否已加载模型")
def health() -> HealthBody | JSONResponse:
    # main() loads the model before listen. A bare `uvicorn` import has nothing to serve.
    if MODEL is None and SYNTHESIZE is None:
        return JSONResponse({"ok": False, "error": "model_not_loaded"}, status_code=503)
    return health_payload()


@app.post(
    "/v1/audio/speech",
    summary="把一句中文合成 WAV",
    response_class=Response,
    responses=SPEECH_RESPONSES,
)
@app.post("/synthesize", include_in_schema=False, response_class=Response)
def speech(body: SpeechRequest) -> Response:
    return speech_result(body)


@app.post(
    "/v1/audio/cancel",
    summary="丢掉还在算的一句",
    responses={
        200: {"model": CancelOk},
        400: {"model": ErrorBody, "description": "before 不是整数。"},
    },
)
@app.post("/cancel", include_in_schema=False)
def cancel(body: CancelRequest) -> JSONResponse:
    return cancel_result(body)


@app.get(
    "/v1/voices",
    response_model=VoiceListBody,
    summary="列出全部音色",
)
def list_voices() -> VoiceListBody | JSONResponse:
    if VOICES is None:
        return voice_error("model_not_loaded", 503, "模型还没加载。")
    return list_voices_payload()


@app.get(
    "/v1/voices/{voice_id}",
    response_model=VoiceBody,
    summary="查一个音色",
    responses={404: {"model": ErrorBody, "description": "voice 不存在。"}},
)
def get_voice(voice_id: str) -> VoiceBody | JSONResponse:
    preset = resolve_voice(voice_id)
    if preset is None:
        return voice_not_found(voice_id)
    return VoiceBody(ok=True, voice=voice_view(preset))


@app.post(
    "/v1/voices",
    response_model=VoiceBody,
    summary="注册音色",
    responses=VOICE_UPLOAD_RESPONSES,
    openapi_extra=VOICE_UPLOAD_BODY,
)
async def create_voice(request: Request) -> VoiceBody | JSONResponse:
    if VOICES is None:
        return voice_error("model_not_loaded", 503, "模型还没加载。")
    raw = await read_body_limited(request, MAX_UPLOAD_BODY)
    if raw is None:
        return voice_error("audio_too_large", 413, "上传内容超过 10 MB。")
    try:
        # Decoding and speaker embedding are CPU-bound; keep /health responsive.
        fields, files = await run_in_threadpool(
            parse_multipart, request.headers.get("content-type", ""), raw
        )
    except MultipartError as exc:
        return voice_error("bad_multipart", 400, str(exc))
    return await run_in_threadpool(register_upload, fields, files)


@app.patch(
    "/v1/voices/{voice_id}",
    response_model=VoiceBody,
    summary="改音色的显示名、说明或标签",
    responses={404: {"model": ErrorBody, "description": "voice 不存在。"}},
)
def patch_voice(voice_id: str, patch: VoicePatchRequest) -> VoiceBody | JSONResponse:
    if VOICES is None:
        return voice_error("model_not_loaded", 503, "模型还没加载。")
    preset = VOICES.get(voice_id)
    if preset is None:
        return voice_not_found(voice_id)
    name = None
    if patch.name is not None:
        name = " ".join(patch.name.split())
        if not name or len(name) > voice_store.MAX_NAME:
            return voice_error("bad_meta", 400, f"name 需要 1–{voice_store.MAX_NAME} 字。")
    description = None
    if patch.description is not None:
        description = " ".join(patch.description.split())
        if len(description) > voice_store.MAX_DESCRIPTION:
            return voice_error("bad_meta", 400, f"description 最多 {voice_store.MAX_DESCRIPTION} 字。")
    tags = voice_store.parse_tags(patch.tags) if patch.tags is not None else None
    try:
        updated = VOICES.update_meta(voice_id, name=name, description=description, tags=tags)
    except KeyError:
        return voice_not_found(voice_id)
    except OSError as exc:
        return voice_error("register_failed", 500, f"写入音色元数据失败：{exc}")
    return VoiceBody(ok=True, voice=voice_view(updated))


@app.put(
    "/v1/voices/{voice_id}/prompt",
    response_model=VoiceBody,
    summary="替换参考音频并重新注册",
    responses=VOICE_UPLOAD_RESPONSES,
    openapi_extra=VOICE_UPLOAD_BODY,
)
async def put_voice_prompt(voice_id: str, request: Request) -> VoiceBody | JSONResponse:
    if VOICES is None:
        return voice_error("model_not_loaded", 503, "模型还没加载。")
    raw = await read_body_limited(request, MAX_UPLOAD_BODY)
    if raw is None:
        return voice_error("audio_too_large", 413, "上传内容超过 10 MB。")
    try:
        fields, files = await run_in_threadpool(
            parse_multipart, request.headers.get("content-type", ""), raw
        )
    except MultipartError as exc:
        return voice_error("bad_multipart", 400, str(exc))
    return await run_in_threadpool(replace_voice_prompt, voice_id, fields, files)


@app.delete(
    "/v1/voices/{voice_id}",
    response_model=DeleteOk,
    summary="删除音色",
    responses={
        400: {"model": ErrorBody, "description": "内置默认音色不能删除。"},
        404: {"model": ErrorBody, "description": "voice 不存在。"},
    },
)
def delete_voice(voice_id: str) -> DeleteOk | JSONResponse:
    if VOICES is None:
        return voice_error("model_not_loaded", 503, "模型还没加载。")
    preset = VOICES.get(voice_id)
    if preset is None:
        return voice_not_found(voice_id)
    if preset.meta.builtin:
        return voice_error("builtin_voice", 400, "内置默认音色不能删除。")
    with GATE.infer_lock():
        # Re-check under the inference lock: registration and deletion both take
        # it, so a synthesis cannot be holding this preset while it disappears.
        preset = VOICES.get(voice_id)
        if preset is None:
            return voice_not_found(voice_id)
        try:
            VOICES.delete(voice_id)
        except OSError as exc:
            return voice_error("register_failed", 500, f"删除音色目录失败：{exc}")
        if MODEL is not None:
            remove_speaker(MODEL, preset.spk_id)
    sys.stderr.write(f"qiling voice deleted id={voice_id} voices={VOICES.count()}\n")
    return DeleteOk(ok=True, deleted=voice_id)


@app.post(
    "/v1/voices/{voice_id}/default",
    response_model=DefaultVoiceBody,
    summary="把音色设为默认",
    responses={404: {"model": ErrorBody, "description": "voice 不存在。"}},
)
def set_default_voice(voice_id: str) -> DefaultVoiceBody | JSONResponse:
    if VOICES is None:
        return voice_error("model_not_loaded", 503, "模型还没加载。")
    if VOICES.get(voice_id) is None:
        return voice_not_found(voice_id)
    try:
        VOICES.set_default(voice_id)
    except KeyError:
        return voice_not_found(voice_id)
    except OSError as exc:
        return voice_error("register_failed", 500, f"写入默认音色失败：{exc}")
    sys.stderr.write(f"qiling voice default id={voice_id} voices={VOICES.count()}\n")
    return DefaultVoiceBody(ok=True, defaultVoice=voice_id)


def enable_tcp_nodelay() -> None:
    """Accepted sockets should not hold the first PCM frame for Nagle."""
    import socket

    classes = []
    try:
        from uvicorn.protocols.http.h11_impl import H11Protocol

        classes.append(H11Protocol)
    except ImportError:
        pass
    try:
        from uvicorn.protocols.http.httptools_impl import HttpToolsProtocol

        classes.append(HttpToolsProtocol)
    except ImportError:
        pass

    def wrap(cls) -> None:
        if getattr(cls, "_siju_nodelay", False):
            return
        original = cls.connection_made

        def connection_made(self, transport) -> None:
            sock = transport.get_extra_info("socket")
            if sock is not None:
                try:
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except OSError:
                    pass
            original(self, transport)

        cls.connection_made = connection_made
        cls._siju_nodelay = True

    for cls in classes:
        wrap(cls)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local CosyVoice 3 multi-voice TTS for 器灵")
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--prompt-wav", type=Path)
    parser.add_argument("--prompt-text-file", type=Path)
    parser.add_argument("--prompt-text", default="")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=None)
    precision = parser.add_mutually_exclusive_group()
    precision.add_argument("--fp16", dest="precision", action="store_const", const="fp16")
    precision.add_argument("--fp32", dest="precision", action="store_const", const="fp32")
    parser.set_defaults(precision=None)
    return parser.parse_args(argv)


def pcm_silence(samples: int, sample_rate: int = 16000) -> bytes:
    return pcm_to_wav(b"\x00\x00" * samples, sample_rate)


def self_check() -> None:
    global SYNTHESIZE, MODEL, VOICES, SAMPLE_RATE, DEVICE, PRECISION, PROMPT_SECONDS

    @contextlib.contextmanager
    def scratch(prefix: str):
        # tempfile.mkdtemp uses mode 0700; that can exclude a sandboxed harness
        # token on Windows. A plainly-created folder stays writable.
        base = Path(tempfile.gettempdir()) / f"{prefix}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        base.mkdir(parents=True)
        try:
            yield base
        finally:
            shutil.rmtree(base, ignore_errors=True)

    gate = EpochGate()
    with gate.running(1) as live:
        assert live
        gate.cancel_before(2)
        assert not gate.allowed(1)
    assert gate.allowed(1)  # state dies with the request
    gate.cancel_before(1)  # an idle cancel reaches nothing
    with gate.running(1) as live:
        assert live  # a restarted client counts from 1 again and still runs
    with gate.running("later") as live:
        assert live
        gate.cancel_id("later")
        assert not gate.allowed("later")
    assert gate.allowed("later")

    assert require_loopback("127.0.0.1") == "127.0.0.1"
    assert require_loopback("localhost") == "127.0.0.1"
    for blocked in ("0.0.0.0", "192.168.1.2", ""):
        try:
            require_loopback(blocked)
        except ValueError as exc:
            assert "本机" in str(exc)
        else:
            raise AssertionError(blocked)
    assert parse_port(None) == DEFAULT_PORT
    assert parse_port("9000") == 9000
    assert parse_port("") == DEFAULT_PORT
    try:
        parse_port("0")
    except ValueError:
        pass
    else:
        raise AssertionError("port 0")

    assert precision_from({}) == "auto"
    assert precision_from({"QILING_COSYVOICE_FP16": "1"}) == "fp16"
    assert precision_from({"SIJU_COSYVOICE_FP16": "fp32"}) == "fp32"
    assert precision_from({"QILING_COSYVOICE_FP16": "whatever"}) == "auto"
    assert use_fp16("auto", True) is True
    assert use_fp16("auto", False) is False
    assert use_fp16("fp16", False) is False  # CPU has no half kernels
    assert use_fp16("fp32", True) is False
    assert utterance_limit({}) == UTTERANCE_CHARS
    assert utterance_limit({"QILING_COSYVOICE_UTTERANCE_CHARS": "60"}) == 60
    assert utterance_limit({"QILING_COSYVOICE_UTTERANCE_CHARS": "3"}) == UTTERANCE_CHARS
    assert utterance_limit({"QILING_COSYVOICE_UTTERANCE_CHARS": "x"}) == UTTERANCE_CHARS
    assert warmup_enabled({})
    assert not warmup_enabled({"QILING_COSYVOICE_WARMUP": "0"})

    assert split_utterances("   ") == []
    assert split_utterances("红方略优。") == ["红方略优。"]
    # A short line is one call: the model keeps its own prosody across it.
    short = "红方略优。诗琚首选「炮二平五」。"
    assert split_utterances(short) == [short]
    long_line = "红方略优，炮二平五以后黑方要小心。马八进七以后局面还很复杂，需要慢慢算计。" * 3
    pieces = split_utterances(long_line, 48)
    assert len(pieces) > 1
    assert all(0 < len(piece) <= 48 for piece in pieces), [len(piece) for piece in pieces]
    assert "".join(pieces).replace(" ", "") == long_line.replace(" ", "")
    assert all(piece[-1] in SENTENCE_ENDS + CLAUSE_ENDS for piece in pieces[:-1])
    # A run of text with no punctuation is still cut, so one call stays bounded.
    assert [len(piece) for piece in split_utterances("啊" * 130, 48)] == [48, 48, 34]
    # A trailing full stop rides with the last words instead of being its own call.
    assert split_utterances("啊" * 48 + "。", 48) == ["啊" * 48 + "。"]

    with scratch("qiling-prompt") as tmp_name:
        tmp = Path(tmp_name)
        user_wav = tmp / "cosyvoice" / "voice-prompt-girl-child.wav"
        user_txt = tmp / "cosyvoice" / "voice-prompt-girl-child.txt"
        user_wav.parent.mkdir(parents=True)
        user_wav.write_bytes(pcm_silence(16_000 * 4))
        user_txt.write_text("今天想先看棋盘上的这一步。", encoding="utf-8")
        paths = resolve_paths({"SIJU_APPDATA": str(tmp)}, bundled_prompt_wav())
        assert paths.prompt_wav == user_wav
        assert paths.device == "auto"
        ok, prompt = prepare_prompt(paths)
        assert ok, prompt
        assert prompt.startswith("You are a helpful assistant.<|endofprompt|>")
        assert ADULT_DEMO not in prompt

        adult = resolve_paths(
            {
                "SIJU_APPDATA": str(tmp),
                "SIJU_COSYVOICE_PROMPT_TEXT": "希望你以后能够做的比我还好呦。",
                "SIJU_COSYVOICE_DEVICE": "cpu",
            },
            bundled_prompt_wav(),
        )
        assert adult.device == "cpu"
        assert adult.prompt_wav == user_wav
        ok, detail = prepare_prompt(adult)
        assert not ok and "成年" in detail, detail

        override = tmp / "girl.wav"
        override.write_bytes(pcm_silence(16_000 * 5))
        (tmp / "girl.txt").write_text("STUB", encoding="utf-8")
        stubbed = resolve_paths(
            {"SIJU_APPDATA": str(tmp), "SIJU_COSYVOICE_PROMPT_WAV": str(override)},
            bundled_prompt_wav(),
        )
        assert stubbed.prompt_wav == override
        ok, detail = prepare_prompt(stubbed)
        assert not ok and "STUB" in detail, detail

        kept = tmp / "roaming"
        (kept / "com.siju.app" / "cosyvoice").mkdir(parents=True)
        (kept / "com.qiling.pet").mkdir()
        assert app_data_dir({"APPDATA": str(kept)}) == kept / "com.siju.app"
        (kept / "com.qiling.pet" / "cosyvoice").mkdir()
        assert app_data_dir({"APPDATA": str(kept)}) == kept / "com.qiling.pet"
        fresh = app_data_dir({"APPDATA": str(tmp / "empty-roaming")})
        assert fresh == tmp / "empty-roaming" / "com.qiling.pet"

        empty = resolve_paths({"SIJU_APPDATA": str(tmp / "missing")}, bundled_prompt_wav())
        assert empty.prompt_wav == bundled_prompt_wav()
        ok, detail = prepare_prompt(empty)
        assert not ok and ("STUB" in detail or "秒" in detail), detail

    check_prompt()
    audio_io.self_check()
    voice_store.self_check()

    assert clean_prompt_text("<|endofprompt|>你好。") == "你好。"
    assert clean_prompt_text("  你 好  ") == "你 好"
    assert prompt_text_problem("") is not None
    assert prompt_text_problem("好") is None
    boundary = b"--qiling-self-check-boundary"
    sample_form = b"".join(
        [
            boundary,
            b"\r\nContent-Disposition: form-data; name=\"prompt_text\"\r\n\r\n",
            "你好。".encode("utf-8"),
            b"\r\n",
            boundary,
            b"\r\nContent-Disposition: form-data; name=\"prompt_audio\"; filename=\"a.wav\"\r\n",
            b"Content-Type: audio/wav\r\n\r\nRIFFdata\r\n",
            boundary,
            b"--\r\n",
        ]
    )
    form_fields, form_files = parse_multipart(
        "multipart/form-data; boundary=qiling-self-check-boundary", sample_form
    )
    assert form_fields["prompt_text"] == "你好。"
    assert form_files["prompt_audio"][0] == "a.wav"
    assert form_files["prompt_audio"][1] == b"RIFFdata"
    try:
        parse_multipart("application/json", b"{}")
    except MultipartError:
        pass
    else:
        raise AssertionError("accepted a non-multipart registration body")
    assert body_limit_for("POST", "/v1/voices") == MAX_UPLOAD_BODY
    assert body_limit_for("PUT", "/v1/voices/pet-a/prompt") == MAX_UPLOAD_BODY
    assert body_limit_for("POST", "/v1/audio/speech") == MAX_SPEECH_BODY
    assert body_limit_for("PATCH", "/v1/voices/pet-a") == MAX_SPEECH_BODY

    unready = health()
    assert getattr(unready, "status_code", None) == 503
    assert b"model_not_loaded" in unready.body

    class FakeModel:
        sample_rate = 24000

        def __init__(self) -> None:
            self.spk2info: dict[str, dict[str, str]] = {}

        def add_zero_shot_spk(self, prompt_text, prompt_wav, zero_shot_spk_id) -> bool:
            path = Path(str(prompt_wav))
            if not path.is_file():
                return False
            self.spk2info[zero_shot_spk_id] = {
                "prompt_text": prompt_text,
                "prompt_wav": str(path),
            }
            return True

    voice_home = Path(tempfile.gettempdir()) / f"qiling-server-voices-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    voice_home.mkdir(parents=True)
    builtin_prompt_wav = voice_home / "builtin-prompt.wav"
    builtin_prompt_wav.write_bytes(pcm_silence(16_000 * 4))
    builtin_prompt_text = "今天想先看棋盘上的这一步。"
    MODEL = FakeModel()
    with scratch("qiling-library") as library_home:
        seed = voice_store.VoiceStore(library_home / "voices")
        seed_builtin = voice_store.VoicePreset(
            meta=voice_store.VoiceMeta(
                id=voice_store.BUILTIN_ID,
                name=voice_store.BUILTIN_NAME,
                description="",
                tags=("内置",),
                prompt_seconds=4.0,
                sample_rate=16000,
                created_at="2026-01-01T00:00:00+08:00",
                builtin=True,
                prompt_text=builtin_prompt_text,
            ),
            prompt_wav=builtin_prompt_wav,
        )
        seed.install_builtin(seed_builtin)
        seed.update_meta(voice_store.BUILTIN_ID, name="诗琚·改")
        seed_preset = seed.stage(
            voice_store.VoiceMeta(
                id="pet-a",
                name="宠物A",
                description="",
                tags=("宠物",),
                prompt_seconds=3.0,
                sample_rate=16000,
                created_at="2026-01-02T00:00:00+08:00",
                prompt_text="这是启动时扫描到的参考音。",
            ),
            audio_io.tone_wav(3.0),
        )
        seed.activate(seed_preset)
        seed.set_default("pet-a")
        library_paths = ServicePaths(
            repo=Path("."),
            model=Path("."),
            prompt_wav=builtin_prompt_wav,
            prompt_text_inline=builtin_prompt_text,
            prompt_text_file=Path("unused.txt"),
            device="cpu",
            voices=library_home / "voices",
        )
        warnings = load_voice_library(library_paths, cosyvoice3_prompt(builtin_prompt_text))
        assert warnings == [], warnings
        assert VOICES is not None
        assert VOICES.default_id() == "pet-a"
        assert VOICES.count() == 2
        assert VOICES.get(voice_store.BUILTIN_ID).meta.name == "诗琚·改"
        assert VOICES.get("pet-a").meta.prompt_seconds == 3.0
        assert "pet-a" in MODEL.spk2info
        assert VOICES.get("pet-a").prompt_text == "这是启动时扫描到的参考音。"
    VOICES = None
    MODEL = FakeModel()

    VOICES = voice_store.VoiceStore(voice_home / "voices")
    VOICES.install_builtin(
        voice_store.VoicePreset(
            meta=voice_store.VoiceMeta(
                id=voice_store.BUILTIN_ID,
                name=voice_store.BUILTIN_NAME,
                description="服务自带的儿童女孩零样本音色。",
                tags=("内置",),
                prompt_seconds=4.0,
                sample_rate=16000,
                created_at="2026-01-01T00:00:00+08:00",
                builtin=True,
                prompt_text=builtin_prompt_text,
            ),
            prompt_wav=builtin_prompt_wav,
        )
    )

    seen: list[tuple[str, str]] = []

    def fake(line: str, voice_id: str) -> tuple[int, bytes, str]:
        seen.append((line, voice_id))
        return 200, pcm_silence(240, 24000), "audio/wav"

    SYNTHESIZE = fake
    SAMPLE_RATE = 24000
    DEVICE = "cpu"
    PRECISION = "fp32"
    PROMPT_SECONDS = 4.0

    import socket
    import time

    import uvicorn

    enable_tcp_nodelay()

    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = int(probe.getsockname()[1])
    probe.close()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 5
    while not server.started:
        if time.time() > deadline:
            raise AssertionError("uvicorn 没有在本机端口起来")
        time.sleep(0.05)
    try:
        base = f"http://127.0.0.1:{port}"

        def call(method: str, path: str, payload: dict | None = None) -> tuple[int, str, bytes]:
            import urllib.error
            import urllib.request

            data = None if payload is None else json.dumps(payload).encode("utf-8")
            headers = {"Content-Type": "application/json"} if data is not None else {}
            request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(request, timeout=3) as response:
                    return response.status, response.headers.get("Content-Type", ""), response.read()
            except urllib.error.HTTPError as exc:
                return exc.code, exc.headers.get("Content-Type", ""), exc.read()

        status, content_type, body = call("GET", "/health")
        assert status == 200, body
        assert "json" in content_type
        health_json = json.loads(body)
        assert health_json["ok"] is True
        assert health_json["engine"] == ENGINE
        assert health_json["voice"] == voice_store.BUILTIN_ID
        assert health_json["defaultVoice"] == voice_store.BUILTIN_ID
        assert health_json["voiceCount"] == 1
        assert health_json["promptSeconds"] == 4.0
        assert health_json["model"] == MODEL_NAME
        assert health_json["precision"] in {"fp16", "fp32"}
        status, _, other = call("GET", "/v1/health")
        assert status == 200 and json.loads(other)["engine"] == ENGINE

        status, content_type, page = call("GET", "/docs")
        assert status == 200, page[:200]
        assert b"swagger" in page.lower()
        assert b"responseInterceptor: playWav" in page
        assert b"createObjectURL" in page
        status, _, redoc = call("GET", "/redoc")
        assert status == 200 and b"redoc" in redoc.lower()
        status, _, spec_bytes = call("GET", "/openapi.json")
        assert status == 200
        spec = json.loads(spec_bytes)
        assert {
            "/health",
            "/v1/health",
            "/v1/audio/speech",
            "/v1/audio/cancel",
            "/v1/voices",
            "/v1/voices/{voice_id}",
            "/v1/voices/{voice_id}/prompt",
            "/v1/voices/{voice_id}/default",
        } <= set(spec["paths"])
        speech_spec = spec["paths"]["/v1/audio/speech"]["post"]
        assert "audio/wav" in speech_spec["responses"]["200"]["content"]
        schema_name = speech_spec["requestBody"]["content"]["application/json"]["schema"]["$ref"].rsplit("/", 1)[-1]
        props = spec["components"]["schemas"][schema_name]["properties"]
        assert "input" in props and "text" in props and "request_id" in props
        assert "voice" in props and "voice_id" in props
        assert "fen" not in props
        assert "prompt_wav" not in props
        assert "prompt_text" not in props
        register_spec = spec["paths"]["/v1/voices"]["post"]
        assert "multipart/form-data" in register_spec["requestBody"]["content"]

        status, content_type, audio = call(
            "POST",
            "/v1/audio/speech",
            {
                "input": "红方略优。",
                "request_id": 1,
                "prompt_text": "希望你以后能够做的比我还好呦。",
                "prompt_wav": "/tmp/not-the-child.wav",
            },
        )
        assert status == 200, audio
        assert content_type.startswith("audio/wav")
        assert audio.startswith(b"RIFF") and len(audio) >= 44
        assert seen == [("红方略优。", voice_store.BUILTIN_ID)]

        status, _, _audio = call("POST", "/v1/audio/speech", {"text": "黑方均势。", "request_id": 2})
        assert status == 200
        assert seen[-1] == ("黑方均势。", voice_store.BUILTIN_ID)

        status, _, error = call("POST", "/v1/audio/speech", {"input": "  "})
        assert status == 400 and b"empty" in error
        status, _, error = call("POST", "/v1/audio/speech", {"input": "啊" * 401})
        assert status == 400 and b"too_long" in error

        # A restarted app counts its request ids from 1 again. A cancel for a line
        # that is no longer running must not reject the new session.
        status, _, _ = call("POST", "/v1/audio/cancel", {"before": 4})
        assert status == 200
        status, _, error = call("POST", "/v1/audio/speech", {"input": "还在算", "request_id": 3})
        assert status == 200, error
        assert seen[-1] == ("还在算", voice_store.BUILTIN_ID)
        status, _, _audio = call("POST", "/v1/audio/speech", {"input": "下一句", "request_id": 4})
        assert status == 200
        assert seen[-1] == ("下一句", voice_store.BUILTIN_ID)

        status, _, _ = call("POST", "/v1/audio/cancel", {"request_id": "drop-me"})
        assert status == 200
        status, _, error = call("POST", "/synthesize", {"input": "新的一句", "request_id": "drop-me"})
        assert status == 200, error  # cancelling an idle id is a no-op, not a ban

        status, _, error = call("GET", "/nope")
        assert status == 404
        status, _, error = call("POST", "/v1/nope", {"input": "不"})
        assert status == 404
        status, _, error = call("POST", "/v1/audio/speech", {"input": "太大了" * 4000})
        assert status == 413 and b"too_large" in error

        # ---------------------------------------------------------- voices
        import http.client

        def multipart_form(fields: dict[str, str], audio: bytes, filename: str = "clip.wav") -> tuple[bytes, str]:
            marker = "----qiling-self-check"
            chunks = []
            for key, value in fields.items():
                chunks.append(
                    f"--{marker}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n".encode()
                    + value.encode("utf-8")
                    + b"\r\n"
                )
            chunks.append(
                f"--{marker}\r\nContent-Disposition: form-data; name=\"prompt_audio\"; "
                f"filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n".encode()
                + audio
                + b"\r\n"
            )
            chunks.append(f"--{marker}--\r\n".encode())
            return b"".join(chunks), f"multipart/form-data; boundary={marker}"

        def upload(method: str, path: str, fields: dict[str, str], audio: bytes) -> tuple[int, dict[str, str], bytes]:
            body, content_type = multipart_form(fields, audio)
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            connection.request(
                method,
                path,
                body=body,
                headers={"Content-Type": content_type, "Content-Length": str(len(body))},
            )
            response = connection.getresponse()
            data = response.read()
            headers = {name.lower(): value for name, value in response.getheaders()}
            connection.close()
            return response.status, headers, data

        def call_with_headers(method: str, path: str, payload: dict | None = None) -> tuple[int, dict[str, str], bytes]:
            import urllib.error
            import urllib.request

            data = None if payload is None else json.dumps(payload).encode("utf-8")
            headers = {"Content-Type": "application/json"} if data is not None else {}
            request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(request, timeout=3) as response:
                    return response.status, {name.lower(): value for name, value in response.headers.items()}, response.read()
            except urllib.error.HTTPError as exc:
                return exc.code, {name.lower(): value for name, value in exc.headers.items()}, exc.read()

        status, _, data = call("GET", "/v1/voices")
        assert status == 200, data
        listed = json.loads(data)
        assert listed["ok"] is True
        assert listed["defaultVoice"] == voice_store.BUILTIN_ID
        assert len(listed["voices"]) == 1
        assert listed["voices"][0]["builtin"] is True

        clip = audio_io.tone_wav(3.0)
        status, _, data = upload(
            "POST",
            "/v1/voices",
            {
                "voice_id": "pet-a",
                "name": "宠物A",
                "prompt_text": "这是宠物A的参考音。",
                "description": "红方旁白",
                "tags": "宠物,红方",
            },
            clip,
        )
        assert status == 200, data
        created = json.loads(data)
        assert created["ok"] is True
        assert created["voice"]["id"] == "pet-a"
        assert created["voice"]["name"] == "宠物A"
        assert created["voice"]["tags"] == ["宠物", "红方"]
        assert created["voice"]["builtin"] is False
        assert abs(created["voice"]["promptSeconds"] - 3.0) < 0.02
        assert "pet-a" in MODEL.spk2info
        assert "这是宠物A的参考音" in MODEL.spk2info["pet-a"]["prompt_text"]

        status, _, data = upload(
            "POST",
            "/v1/voices",
            {"voice_id": "pet-a", "prompt_text": "重复。"},
            clip,
        )
        assert status == 409 and b"voice_exists" in data

        status, _, data = upload(
            "POST",
            "/v1/voices",
            {"voice_id": "../pet", "prompt_text": "穿越。"},
            clip,
        )
        assert status == 400 and b"bad_voice_id" in data

        status, _, data = upload("POST", "/v1/voices", {"voice_id": "empty", "prompt_text": "  "}, clip)
        assert status == 400 and b"prompt_text_empty" in data

        status, _, data = upload(
            "POST",
            "/v1/voices",
            {"voice_id": "long-text", "prompt_text": "啊" * 501},
            clip,
        )
        assert status == 400 and b"prompt_text_too_long" in data

        status, _, data = upload(
            "POST",
            "/v1/voices",
            {"voice_id": "noisy", "prompt_text": "不是音频。"},
            b"this is not audio",
        )
        assert status == 400 and b"bad_audio" in data

        status, _, data = upload(
            "POST",
            "/v1/voices",
            {"voice_id": "short", "prompt_text": "太短。"},
            audio_io.tone_wav(0.5),
        )
        assert status == 400 and b"bad_audio" in data

        status, _, data = call("POST", "/v1/voices", {"voice_id": "json", "prompt_text": "不是表单。"})
        assert status == 400 and b"bad_multipart" in data

        status, _, data = call("GET", "/v1/voices/pet-a")
        assert status == 200 and json.loads(data)["voice"]["id"] == "pet-a"
        status, _, data = call("GET", "/v1/voices/nope")
        assert status == 404 and b"voice_not_found" in data

        status, _, data = call(
            "PATCH",
            "/v1/voices/pet-a",
            {"name": "宠物A·改", "description": "新的说明", "tags": "宠物,测试"},
        )
        assert status == 200, data
        patched = json.loads(data)["voice"]
        assert patched["name"] == "宠物A·改"
        assert patched["tags"] == ["宠物", "测试"]
        status, _, data = call("PATCH", "/v1/voices/pet-a", {"name": "   "})
        assert status == 400 and b"bad_meta" in data

        status, _, data = call("PATCH", f"/v1/voices/{voice_store.BUILTIN_ID}", {"name": "诗琚"})
        assert status == 200 and json.loads(data)["voice"]["name"] == "诗琚"
        assert (VOICES.root / voice_store.BUILTIN_ID / voice_store.META_FILE).is_file()

        seen_before = len(seen)
        status, headers, audio = call_with_headers(
            "POST",
            "/v1/audio/speech",
            {"input": "红方略优。", "voice": "pet-a", "request_id": 20},
        )
        assert status == 200, audio
        assert headers.get("x-voice-id") == "pet-a"
        assert seen[-1] == ("红方略优。", "pet-a")
        assert len(seen) == seen_before + 1

        status, _, data = call(
            "POST",
            "/v1/audio/speech",
            {"input": "没有这个角色。", "voice": "missing-voice"},
        )
        assert status == 404 and b"voice_not_found" in data
        assert len(seen) == seen_before + 1  # unknown voice never reached synthesis
        status, headers, data = call_with_headers(
            "POST",
            "/v1/audio/speech",
            {"input": "流式也不能静默回落。", "voice": "missing-voice", "stream": True},
        )
        assert status == 404 and b"voice_not_found" in data
        assert headers.get("content-length")
        assert len(seen) == seen_before + 1

        status, headers, audio = call_with_headers(
            "POST",
            "/v1/audio/speech",
            {"input": "别名也行。", "voice_id": "pet-a", "request_id": 21},
        )
        assert status == 200 and headers.get("x-voice-id") == "pet-a"
        assert seen[-1] == ("别名也行。", "pet-a")

        status, _, data = call("POST", "/v1/voices/pet-a/default")
        assert status == 200 and json.loads(data)["defaultVoice"] == "pet-a"
        status, _, data = call("GET", "/health")
        health_json = json.loads(data)
        assert health_json["voice"] == "pet-a"
        assert health_json["defaultVoice"] == "pet-a"
        assert health_json["voiceCount"] == 2
        assert abs(health_json["promptSeconds"] - 3.0) < 0.02

        status, _, audio = call("POST", "/v1/audio/speech", {"input": "走默认音色。"})
        assert status == 200
        assert seen[-1] == ("走默认音色。", "pet-a")

        status, _, data = upload(
            "PUT",
            "/v1/voices/pet-a/prompt",
            {"prompt_text": "这是替换后的参考音。"},
            audio_io.tone_wav(4.0),
        )
        assert status == 200, data
        replaced = json.loads(data)["voice"]
        assert replaced["id"] == "pet-a"
        assert abs(replaced["promptSeconds"] - 4.0) < 0.02
        assert "这是替换后的参考音" in MODEL.spk2info["pet-a"]["prompt_text"]
        status, _, data = upload(
            "PUT",
            f"/v1/voices/{voice_store.BUILTIN_ID}/prompt",
            {"prompt_text": "内置不能换。"},
            clip,
        )
        assert status == 400 and b"builtin_voice" in data

        import http.client as _http_client

        def post_raw(payload: dict) -> _http_client.HTTPResponse:
            conn = _http_client.HTTPConnection("127.0.0.1", port, timeout=3)
            raw = json.dumps(payload).encode("utf-8")
            conn.request(
                "POST",
                "/v1/audio/speech",
                body=raw,
                headers={"Content-Type": "application/json"},
            )
            response = conn.getresponse()
            response._siju_conn = conn  # closed by the caller
            return response

        def read_exact(response: http.client.HTTPResponse, size: int) -> bytes:
            data = b""
            while len(data) < size:
                piece = response.read(size - len(data))
                if not piece:
                    break
                data += piece
            return data

        refused = post_raw({"input": " ", "stream": True})
        try:
            assert refused.status == 400
            assert refused.getheader("Content-Length")
            assert "json" in (refused.getheader("Content-Type") or "")
            assert b"empty" in refused.read()
        finally:
            refused._siju_conn.close()

        release = threading.Event()
        first = b"\x01\x00" * 16
        second = b"\x02\x00" * 16

        def stalling_pcm():
            yield first
            if not release.wait(3):
                raise RuntimeError("客户端还没读到第一帧，服务却要发第二帧")
            yield second

        global STREAM_ITER
        STREAM_ITER = stalling_pcm
        try:
            streamed = post_raw({"input": "先出第一声", "stream": True, "request_id": 10})
            try:
                assert streamed.status == 200, streamed.read()
                assert (streamed.getheader("Content-Type") or "").startswith("application/octet-stream")
                assert streamed.getheader("X-Sample-Rate") == str(SAMPLE_RATE)
                assert streamed.getheader("X-Voice-Id") == "pet-a"
                assert streamed.chunked or (streamed.getheader("Transfer-Encoding") or "").lower().find("chunked") >= 0
                header = read_exact(streamed, 5)
                assert header[:1] == b"\x01", header
                length = int.from_bytes(header[1:5], "little")
                assert length == len(first)
                assert read_exact(streamed, length) == first
                assert not release.is_set()
                release.set()
                rest = streamed.read()
                assert rest.startswith(b"\x01" + len(second).to_bytes(4, "little") + second)
                assert rest.endswith(b"\x00")
            finally:
                streamed._siju_conn.close()
        finally:
            STREAM_ITER = None
            release.set()

        # A cancel while the line is still being synthesized stops it mid-frame.
        cancel_release = threading.Event()
        cancel_first = b"\x01\x00" * 8
        cancel_second = b"\x02\x00" * 8

        def stalling_cancelled_pcm():
            yield cancel_first
            if not cancel_release.wait(3):
                raise RuntimeError("客户端还没读到第一帧，服务却要发第二帧")
            yield cancel_second

        STREAM_ITER = stalling_cancelled_pcm
        try:
            held = post_raw({"input": "说到一半", "stream": True, "request_id": 11})
            try:
                assert held.status == 200
                header = read_exact(held, 5)
                assert header[:1] == b"\x01", header
                assert read_exact(held, int.from_bytes(header[1:5], "little")) == cancel_first
                status, _, _ = call("POST", "/v1/audio/cancel", {"before": 12})
                assert status == 200
                cancel_release.set()
                assert held.read() == b"\x02cancelled", "正在算的那一句没有停下"
            finally:
                held._siju_conn.close()
        finally:
            STREAM_ITER = None
            cancel_release.set()

        # A client that resets after a successful cancel must not dump a traceback.
        import io
        import struct

        captured = io.StringIO()
        previous = sys.stderr
        sys.stderr = captured
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=3)
            sock.sendall(
                b"POST /v1/audio/cancel HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: 2\r\n"
                b"Connection: close\r\n"
                b"\r\n"
                b"{}"
            )
            assert b"200" in sock.recv(4096)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            sock.close()
            time.sleep(0.3)
        finally:
            sys.stderr = previous
        logged = captured.getvalue()
        assert "Exception occurred" not in logged
        assert "Traceback" not in logged

        # Deleting the active default falls back to the builtin; the builtin
        # itself is the one voice that cannot be deleted.
        status, _, data = call("DELETE", f"/v1/voices/{voice_store.BUILTIN_ID}")
        assert status == 400 and b"builtin_voice" in data
        status, _, data = call("DELETE", "/v1/voices/pet-a")
        assert status == 200, data
        assert json.loads(data)["deleted"] == "pet-a"
        assert "pet-a" not in MODEL.spk2info
        assert not (VOICES.root / "pet-a").exists()
        status, _, data = call("GET", "/health")
        health_json = json.loads(data)
        assert health_json["defaultVoice"] == voice_store.BUILTIN_ID
        assert health_json["voice"] == voice_store.BUILTIN_ID
        assert health_json["voiceCount"] == 1
        status, _, audio = call("POST", "/v1/audio/speech", {"input": "回到默认。"})
        assert status == 200 and seen[-1] == ("回到默认。", voice_store.BUILTIN_ID)
        status, _, data = call("DELETE", "/v1/voices/pet-a")
        assert status == 404 and b"voice_not_found" in data
    finally:
        SYNTHESIZE = None
        MODEL = None
        VOICES = None
        server.should_exit = True
        thread.join(timeout=5)
        shutil.rmtree(voice_home, ignore_errors=True)
    print("server self-check ok")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.self_check:
        self_check()
        return 0
    try:
        host = require_loopback(args.host)
        port = parse_port(
            args.port
            if args.port is not None
            else first_env(os.environ, "QILING_COSYVOICE_PORT", "SIJU_COSYVOICE_PORT") or None
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    paths = resolve_paths(os.environ)
    if args.repo:
        paths.repo = args.repo
    if args.model:
        paths.model = args.model
    if args.prompt_wav:
        paths.prompt_wav = args.prompt_wav
        if not args.prompt_text_file and not args.prompt_text:
            paths.prompt_text_file = args.prompt_wav.with_suffix(".txt")
    if args.prompt_text:
        paths.prompt_text_inline = args.prompt_text
    if args.prompt_text_file:
        paths.prompt_text_file = args.prompt_text_file
    ok, prompt = prepare_prompt(paths)
    if not ok:
        print(prompt, file=sys.stderr)
        return 2
    problem = repo_problem(paths.repo) or model_problem(paths.model)
    if problem:
        print(problem, file=sys.stderr)
        return 2

    global MODEL, VOICES, SAMPLE_RATE, DEVICE, PRECISION, PROMPT_SECONDS, UTTERANCE_CHARS
    duration = wav_duration_secs(paths.prompt_wav)
    PROMPT_SECONDS = float(duration or 0)
    UTTERANCE_CHARS = utterance_limit(os.environ)
    apply_device(paths.device)
    try:
        import torch

        cuda = paths.device != "cpu" and torch.cuda.is_available()
    except Exception:
        cuda = False
    DEVICE = "cuda" if cuda else "cpu"
    fp16 = use_fp16(args.precision or precision_from(os.environ), cuda)
    PRECISION = "fp16" if fp16 else "fp32"
    print(
        "正在加载 Fun-CosyVoice3-0.5B"
        f"（多角色零样本，device={DEVICE} precision={PRECISION}）",
        file=sys.stderr,
        flush=True,
    )
    try:
        MODEL = load_model(paths.repo, paths.model, fp16)
        register_child_voice(MODEL, prompt, paths.prompt_wav.resolve())
    except Exception as exc:
        print(f"加载 Fun-CosyVoice3-0.5B 失败: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1
    SAMPLE_RATE = int(getattr(MODEL, "sample_rate", 24000) or 24000)
    try:
        for warning in load_voice_library(paths, prompt):
            print(f"qiling voice: {warning}", file=sys.stderr)
    except Exception as exc:
        # A broken voices/ folder must not take the builtin voice down.
        print(f"读取音色库失败，只用内置音色: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        VOICES = voice_store.VoiceStore(paths.voices)
        VOICES.install_builtin(build_builtin_preset(paths, prompt))
    assert VOICES is not None
    default_voice = VOICES.default_voice()
    PROMPT_SECONDS = default_voice.meta.prompt_seconds if default_voice is not None else PROMPT_SECONDS
    # The first call pays cuDNN/cuBLAS autotune and allocator growth. Do that
    # before the pet's first line, not on it.
    if cuda and warmup_enabled(os.environ):
        warmup(MODEL, fp16)
    print(
        f"siju cosyvoice3 ready voice={VOICES.default_id()} default_voice={VOICES.default_id()} "
        f"voices={VOICES.count()} device={DEVICE} precision={PRECISION} "
        f"sample_rate={SAMPLE_RATE} utterance_chars={UTTERANCE_CHARS}",
        file=sys.stderr,
        flush=True,
    )
    print(f"qiling cosyvoice3 listening http://{host}:{port}", flush=True)
    print(f"qiling cosyvoice3 docs http://{host}:{port}/docs", flush=True)
    import uvicorn

    enable_tcp_nodelay()

    try:
        uvicorn.run(app, host=host, port=port, log_level="info")
    except OSError as exc:
        print(f"无法监听 {host}:{port}：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
