#!/usr/bin/env python3
"""Local Fun-CosyVoice3-0.5B HTTP service for 器灵.

Start it yourself. 器灵 does not spawn this process. It only talks to
127.0.0.1 (default http://127.0.0.1:8765). The reference clip and its
transcript stay here, via the app-data directory or QILING_COSYVOICE_PROMPT_*.
QILING_* wins; the older SIJU_COSYVOICE_* names still work.
Requests carry the Chinese line to speak, never a board FEN.

    python services/cosyvoice-tts/server.py --self-check
    <venv>/python services/cosyvoice-tts/server.py

Then open http://127.0.0.1:8765/docs for Swagger, or /redoc.

GET /health and GET /v1/health return 200 once the model is loaded.
POST /v1/audio/speech accepts JSON `input` or `text` and returns audio/wav.
POST /v1/audio/cancel drops an in-flight line. The app can also discard
the response.

The model is loaded before the process listens. A rejected prompt or a
failed load exits without serving, so /health is 200 only when synthesis
can run.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import traceback
import wave
from io import BytesIO
from pathlib import Path
from typing import Any, Mapping

from fastapi import FastAPI
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from prompt_check import ADULT_DEMO, assess, cosyvoice3_prompt, self_check as check_prompt, wav_duration_secs

ENGINE = "cosyvoice3-0.5b"
MODEL_NAME = "Fun-CosyVoice3-0.5B-2512"
VOICE = "child-girl-zero-shot"
DEFAULT_PORT = 8765
MAX_BODY = 16_000
MODEL_FILES = (
    "cosyvoice3.yaml",
    "llm.pt",
    "flow.pt",
    "hift.pt",
    "campplus.onnx",
    "speech_tokenizer_v3.onnx",
)


class EpochGate:
    """Drop a synthesize call cancelled by id, or older than the latest epoch."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._infer = threading.Lock()
        self.dropped_before = 0
        self.dropped_ids: set[str] = set()

    def cancel_before(self, epoch: int) -> None:
        with self._lock:
            if epoch > self.dropped_before:
                self.dropped_before = epoch

    def cancel_id(self, request_id: str) -> None:
        if not request_id:
            return
        with self._lock:
            self.dropped_ids.add(request_id)

    def allowed(self, request_id: int | str) -> bool:
        key = str(request_id)
        with self._lock:
            if key in self.dropped_ids:
                return False
            if key.isdigit():
                return int(key) >= self.dropped_before
            return True

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
    ) -> None:
        self.repo = repo
        self.model = model
        self.prompt_wav = prompt_wav
        self.prompt_text_inline = prompt_text_inline
        self.prompt_text_file = prompt_text_file
        self.device = device


class HealthBody(BaseModel):
    ok: bool = Field(description="模型已经加载，可以合成。")
    engine: str = Field(description="引擎标识。识局认 cosyvoice3-0.5b。", examples=["cosyvoice3-0.5b"])
    model: str = Field(description="权重名。", examples=["Fun-CosyVoice3-0.5B-2512"])
    voice: str = Field(description="音色。诗琚只用儿童女孩零样本。", examples=["child-girl-zero-shot"])
    sampleRate: int = Field(description="WAV 采样率。")
    device: str = Field(description="cpu 或 cuda。")
    promptSeconds: float = Field(description="服务侧参考录音的秒数。")


class ErrorBody(BaseModel):
    error: str = Field(description="empty、too_long、cancelled、synthesize_failed 之一。")


class SpeechRequest(BaseModel):
    """要念的一句中文。参考音不在这个请求里。"""

    model_config = ConfigDict(
        extra="ignore",
        json_schema_extra={"examples": [{"input": "红方略优。诗琚首选「炮二平五」。", "request_id": 1}]},
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
            "Content-Type: application/octet-stream，响应头 X-Sample-Rate。"
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


GATE = EpochGate()
MODEL = None
SAMPLE_RATE = 24000
DEVICE = "cpu"
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


def load_model(repo: Path, model_dir: Path):
    sys.path.insert(0, str(repo))
    sys.path.insert(0, str(repo / "third_party" / "Matcha-TTS"))
    from cosyvoice.cli.cosyvoice import AutoModel

    model = AutoModel(model_dir=str(model_dir))
    name = model.__class__.__name__
    if name != "CosyVoice3":
        raise RuntimeError(f"需要 CosyVoice3，实际加载的是 {name}")
    return model


def register_child_voice(model, prompt_text: str, prompt_wav: Path) -> None:
    added = model.add_zero_shot_spk(prompt_text, str(prompt_wav), "shiju-girl")
    if added is not True:
        raise RuntimeError("零样本参考音没有注册成功")


def chunks_to_wav(chunks, sample_rate: int) -> bytes:
    import numpy as np
    import torch

    audio = torch.cat([chunk.detach().float().cpu() for chunk in chunks], dim=-1).squeeze()
    audio = audio.clamp(-1, 1).numpy()
    pcm = (audio * 32767.0).astype(np.int16)
    return pcm_to_wav(pcm.tobytes(), sample_rate)


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


def synthesize(request_id: int | str, text: str) -> tuple[int, bytes, str]:
    line = " ".join(text.split())
    if not line:
        return 400, b'{"error":"empty"}', "application/json"
    if len(line) > 400:
        return 400, b'{"error":"too_long"}', "application/json"
    if not GATE.allowed(request_id):
        return 409, b'{"error":"cancelled"}', "application/json"
    if SYNTHESIZE is not None:
        return SYNTHESIZE(line)
    pieces = []
    with GATE.infer_lock():
        if not GATE.allowed(request_id):
            return 409, b'{"error":"cancelled"}', "application/json"
        generator = MODEL.inference_zero_shot(
            line,
            "",
            "",
            zero_shot_spk_id="shiju-girl",
            stream=True,
            speed=1.0,
        )
        for item in generator:
            if not GATE.allowed(request_id):
                return 409, b'{"error":"cancelled"}', "application/json"
            speech = item.get("tts_speech")
            if speech is None:
                continue
            pieces.append(speech)
    if not GATE.allowed(request_id):
        return 409, b'{"error":"cancelled"}', "application/json"
    if not pieces:
        return 500, b'{"error":"empty_audio"}', "application/json"
    return 200, chunks_to_wav(pieces, SAMPLE_RATE), "audio/wav"


def health_payload() -> HealthBody:
    return HealthBody(
        ok=True,
        engine=ENGINE,
        model=MODEL_NAME,
        voice=VOICE,
        sampleRate=SAMPLE_RATE,
        device=DEVICE,
        promptSeconds=PROMPT_SECONDS,
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


def refusal(request_id: str, text: str) -> JSONResponse | None:
    """JSON errors keep Content-Length. Streaming starts only after these checks."""
    line = " ".join(text.split())
    if not line:
        return JSONResponse({"error": "empty"}, status_code=400)
    if len(line) > 400:
        return JSONResponse({"error": "too_long"}, status_code=400)
    if not GATE.allowed(request_id):
        return JSONResponse({"error": "cancelled"}, status_code=409)
    return None


def iter_model_pcm(request_id: str, line: str):
    if STREAM_ITER is not None:
        yield from STREAM_ITER()
        return
    generator = MODEL.inference_zero_shot(
        line,
        "",
        "",
        zero_shot_spk_id="shiju-girl",
        stream=True,
        speed=1.0,
    )
    for item in generator:
        if not GATE.allowed(request_id):
            return
        speech = item.get("tts_speech")
        if speech is None:
            continue
        pcm = tensor_to_pcm(speech)
        if pcm:
            yield pcm


def stream_frames(request_id: str, line: str):
    """One HTTP chunk per frame. The lock covers the whole utterance."""
    emitted = False
    try:
        with GATE.infer_lock():
            if not GATE.allowed(request_id):
                yield fail_frame("cancelled")
                return
            for pcm in iter_model_pcm(request_id, line):
                if not GATE.allowed(request_id):
                    yield fail_frame("cancelled")
                    return
                emitted = True
                yield pcm_frame(pcm)
            if not GATE.allowed(request_id):
                yield fail_frame("cancelled")
                return
        if not emitted:
            yield fail_frame("failed")
            return
        yield b"\x00"
    except Exception as exc:
        sys.stderr.write(f"synthesize failed: {exc}\n")
        traceback.print_exc(file=sys.stderr)
        yield fail_frame("failed")


def stream_speech(body: SpeechRequest) -> Response:
    request_id = request_id_of(body)
    line = spoken_line(body)
    refused = refusal(request_id, line)
    if refused is not None:
        return refused
    return StreamingResponse(
        stream_frames(request_id, " ".join(line.split())),
        status_code=200,
        media_type="application/octet-stream",
        headers={
            "X-Sample-Rate": str(SAMPLE_RATE),
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def speech_result(body: SpeechRequest) -> Response:
    if body.stream:
        return stream_speech(body)
    try:
        status, payload, content_type = synthesize(request_id_of(body), spoken_line(body))
    except Exception as exc:  # model errors stay on this machine
        sys.stderr.write(f"synthesize failed: {exc}\n")
        traceback.print_exc(file=sys.stderr)
        return JSONResponse({"error": "synthesize_failed"}, status_code=500)
    if status != 200:
        return error_response(status, payload)
    return Response(content=payload, media_type=content_type)


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
            "中途失败 0x02 + cancelled 或 failed。响应头 X-Sample-Rate。"
        ),
    },
    400: {"model": ErrorBody, "description": "没有可念的字，或超过 400 字。"},
    409: {"model": ErrorBody, "description": "这一句已被取消。"},
    413: {"model": ErrorBody, "description": "请求体超过 16KB。"},
    500: {"model": ErrorBody, "description": "本机合成失败。"},
}


app = FastAPI(
    title="识局 CosyVoice",
    summary="本机儿童女孩零样本语音。",
    description=(
        "诗琚的本机音色。服务只监听 127.0.0.1。"
        "参考录音和逐字稿留在服务进程里（SIJU_COSYVOICE_PROMPT_* 或应用数据目录）。"
        "请求里只放要念的中文，不要带局面 FEN，也不要带参考音路径。"
    ),
    version="1.0.0",
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


@app.middleware("http")
async def limit_body(request, call_next):
    if request.method == "POST":
        raw = request.headers.get("content-length")
        if raw is not None:
            try:
                length = int(raw)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                return JSONResponse({"error": "too_large"}, status_code=413)
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
    parser = argparse.ArgumentParser(description="Local CosyVoice 3 child-girl TTS for 识局")
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--prompt-wav", type=Path)
    parser.add_argument("--prompt-text-file", type=Path)
    parser.add_argument("--prompt-text", default="")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=None)
    return parser.parse_args(argv)


def pcm_silence(samples: int, sample_rate: int = 16000) -> bytes:
    return pcm_to_wav(b"\x00\x00" * samples, sample_rate)


def self_check() -> None:
    global SYNTHESIZE, SAMPLE_RATE, DEVICE, PROMPT_SECONDS
    gate = EpochGate()
    assert gate.allowed(1)
    gate.cancel_before(2)
    assert not gate.allowed(1)
    assert gate.allowed(2)
    gate.cancel_before(1)
    assert gate.allowed(2)
    gate.cancel_id("later")
    assert not gate.allowed("later")
    assert gate.allowed(2)

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

    import tempfile

    with tempfile.TemporaryDirectory() as tmp_name:
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

    unready = health()
    assert getattr(unready, "status_code", None) == 503
    assert b"model_not_loaded" in unready.body

    seen: list[str] = []

    def fake(line: str) -> tuple[int, bytes, str]:
        seen.append(line)
        return 200, pcm_silence(240, 24000), "audio/wav"

    SYNTHESIZE = fake
    SAMPLE_RATE = 24000
    DEVICE = "cpu"
    PROMPT_SECONDS = 4.0
    GATE.dropped_before = 0
    GATE.dropped_ids.clear()

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
        assert health_json["voice"] == VOICE
        assert health_json["model"] == MODEL_NAME
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
        assert {"/health", "/v1/health", "/v1/audio/speech", "/v1/audio/cancel"} <= set(spec["paths"])
        speech_spec = spec["paths"]["/v1/audio/speech"]["post"]
        assert "audio/wav" in speech_spec["responses"]["200"]["content"]
        schema_name = speech_spec["requestBody"]["content"]["application/json"]["schema"]["$ref"].rsplit("/", 1)[-1]
        props = spec["components"]["schemas"][schema_name]["properties"]
        assert "input" in props and "text" in props and "request_id" in props
        assert "fen" not in props
        assert "prompt_wav" not in props
        assert "prompt_text" not in props

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
        assert seen == ["红方略优。"]

        status, _, _audio = call("POST", "/v1/audio/speech", {"text": "黑方均势。", "request_id": 2})
        assert status == 200
        assert seen[-1] == "黑方均势。"

        status, _, error = call("POST", "/v1/audio/speech", {"input": "  "})
        assert status == 400 and b"empty" in error
        status, _, error = call("POST", "/v1/audio/speech", {"input": "啊" * 401})
        assert status == 400 and b"too_long" in error

        status, _, _ = call("POST", "/v1/audio/cancel", {"before": 4})
        status, _, error = call("POST", "/v1/audio/speech", {"input": "还在算", "request_id": 3})
        assert status == 409 and b"cancelled" in error
        status, _, _audio = call("POST", "/v1/audio/speech", {"input": "下一句", "request_id": 4})
        assert status == 200
        assert seen[-1] == "下一句"

        status, _, error = call("POST", "/v1/audio/cancel", {"request_id": "drop-me"})
        assert status == 200
        status, _, error = call("POST", "/synthesize", {"input": "丢掉", "request_id": "drop-me"})
        assert status == 409 and b"cancelled" in error

        status, _, error = call("GET", "/nope")
        assert status == 404
        status, _, error = call("POST", "/v1/nope", {"input": "不"})
        assert status == 404
        status, _, error = call("POST", "/v1/audio/speech", {"input": "太大了" * 4000})
        assert status == 413 and b"too_large" in error

        import http.client

        def post_raw(payload: dict) -> http.client.HTTPResponse:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
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

        GATE.cancel_before(9)
        cancelled = post_raw({"input": "还没开始", "stream": True, "request_id": 1})
        try:
            assert cancelled.status == 409
            assert cancelled.getheader("Content-Length")
            assert b"cancelled" in cancelled.read()
        finally:
            cancelled._siju_conn.close()
        GATE.dropped_before = 0
        GATE.dropped_ids.clear()

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
    finally:
        SYNTHESIZE = None
        server.should_exit = True
        thread.join(timeout=5)
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

    global MODEL, SAMPLE_RATE, DEVICE, PROMPT_SECONDS
    duration = wav_duration_secs(paths.prompt_wav)
    PROMPT_SECONDS = float(duration or 0)
    apply_device(paths.device)
    print("正在加载 Fun-CosyVoice3-0.5B（儿童女孩零样本）", file=sys.stderr, flush=True)
    try:
        MODEL = load_model(paths.repo, paths.model)
        register_child_voice(MODEL, prompt, paths.prompt_wav.resolve())
    except Exception as exc:
        print(f"加载 Fun-CosyVoice3-0.5B 失败: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1
    SAMPLE_RATE = int(getattr(MODEL, "sample_rate", 24000) or 24000)
    try:
        import torch

        DEVICE = "cuda" if paths.device != "cpu" and torch.cuda.is_available() else "cpu"
    except Exception:
        DEVICE = "cpu"
    print(
        f"siju cosyvoice3 ready voice={VOICE} device={DEVICE} sample_rate={SAMPLE_RATE}",
        file=sys.stderr,
        flush=True,
    )
    print(f"siju cosyvoice3 listening http://{host}:{port}", flush=True)
    print(f"siju cosyvoice3 docs http://{host}:{port}/docs", flush=True)
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
