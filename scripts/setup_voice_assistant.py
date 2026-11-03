#!/usr/bin/env python3
"""Install the optional, local-only wake-word and Chinese ASR runtime."""

from __future__ import annotations

import argparse
import http.client
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

KWS_ARCHIVE = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/"
    "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2"
)
ASR_ARCHIVE = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2"
)
KWS_NAME = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"
ASR_NAME = "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"
DOWNLOAD_TIMEOUT_SECONDS = 120
DOWNLOAD_ATTEMPTS = 5


def voice_data_dir() -> Path:
    if os.name == "nt":
        base_text = os.environ.get("APPDATA", "").strip()
        base = Path(base_text) if base_text else Path.home() / "AppData" / "Roaming"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        xdg = os.environ.get("XDG_DATA_HOME", "").strip()
        base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "com.qiling.pet"


def voice_home(root: Path) -> Path:
    return root / "voice-assistant"


def python_version(command: list[str]) -> tuple[int, int] | None:
    try:
        output = subprocess.check_output(
            command + ["-c", "import struct,sys; print(sys.version_info[0],sys.version_info[1],struct.calcsize('P'))"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    parts = output.split()
    if len(parts) != 3 or parts[2] != "8":
        return None
    return int(parts[0]), int(parts[1])


def find_python(explicit: str | None) -> list[str]:
    candidates: list[list[str]] = []
    if explicit:
        candidates.append([explicit])
    elif os.name == "nt" and shutil.which("py"):
        candidates.append(["py", "-3.12"])
    for name in ("python3.12", "python3", "python"):
        executable = shutil.which(name)
        if executable:
            candidates.append([executable])
    for candidate in candidates:
        if python_version(candidate) == (3, 12):
            return candidate
    raise SystemExit(
        "需要 64 位 Python 3.12。可使用 --python 指向 python.exe；"
        f"当前解释器是 {sys.version.split()[0]}。"
    )


def run(command: list[str]) -> None:
    print("+", subprocess.list2cmdline(command), flush=True)
    subprocess.check_call(command)


def safe_extract(archive_path: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:bz2") as archive:
        members = archive.getmembers()
        root = destination.resolve()
        for member in members:
            target = (destination / member.name).resolve()
            if not target.is_relative_to(root):
                raise RuntimeError(f"拒绝越界的模型归档路径：{member.name}")
        archive.extractall(destination, members=members, filter="data")


def download_archive(url: str, target: Path) -> None:
    if target.is_file():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".download")
    print(f"下载公开模型：{url}")
    last_error: Exception | None = None

    for attempt in range(DOWNLOAD_ATTEMPTS):
        offset = partial.stat().st_size if partial.exists() else 0
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        request = urllib.request.Request(url, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS)
        except urllib.error.HTTPError as error:
            if error.code != 429 and not 500 <= error.code < 600:
                raise
            last_error = error
        except (TimeoutError, ConnectionError, urllib.error.URLError) as error:
            last_error = error
        else:
            with response:
                status = getattr(response, "status", 200)
                response_headers = response.headers
                if offset and status == 206:
                    content_range = re.fullmatch(
                        r"bytes (\d+)-(\d+)/(\d+|\*)",
                        response_headers.get("Content-Range", ""),
                    )
                    if not content_range or int(content_range.group(1)) != offset:
                        raise RuntimeError("模型续传响应的 Content-Range 无效。")
                    total_text = content_range.group(3)
                    total = int(total_text) if total_text != "*" else None
                    mode = "ab"
                elif status == 200:
                    offset = 0
                    total_text = response_headers.get("Content-Length", "")
                    total = int(total_text) if total_text.isdigit() else None
                    mode = "wb"
                else:
                    raise RuntimeError(f"模型服务器返回了不支持的 HTTP 状态：{status}")

                try:
                    with partial.open(mode) as output:
                        progress_size = offset
                        while True:
                            try:
                                chunk = response.read(1024 * 1024)
                            except http.client.IncompleteRead as error:
                                if error.partial:
                                    output.write(error.partial)
                                last_error = error
                                break
                            except (TimeoutError, ConnectionError, urllib.error.URLError) as error:
                                last_error = error
                                break
                            if not chunk:
                                break
                            output.write(chunk)
                            progress_size += len(chunk)
                            if total:
                                print(
                                    f"\r{progress_size * 100 // total}%",
                                    end="",
                                    flush=True,
                                )
                except OSError:
                    raise

            received = partial.stat().st_size
            if total is None or received == total:
                partial.replace(target)
                print()
                return
            if received > total:
                raise RuntimeError("模型归档下载超出预期大小。")
            last_error = RuntimeError("模型归档下载未完成，将尝试续传。")

        if attempt + 1 < DOWNLOAD_ATTEMPTS:
            delay = min(2**attempt, 15)
            print(
                f"\n模型下载中断（{last_error}），{delay} 秒后从已下载位置续传"
                f"（{attempt + 1}/{DOWNLOAD_ATTEMPTS}）。",
                flush=True,
            )
            time.sleep(delay)

    raise RuntimeError(
        f"模型下载在 {DOWNLOAD_ATTEMPTS} 次尝试后仍未完成；"
        f"已下载部分保留在 {partial}，请重试。最后错误：{last_error}"
    ) from last_error


def ensure_model(url: str, name: str, root: Path, required: tuple[str, ...]) -> Path:
    destination = root / name
    if destination.is_dir() and all((destination / filename).is_file() for filename in required):
        return destination
    archive_path = root / "downloads" / f"{name}.tar.bz2"
    download_archive(url, archive_path)
    safe_extract(archive_path, root)
    if not destination.is_dir():
        raise RuntimeError(f"模型归档中没有预期目录：{name}")
    missing = [filename for filename in required if not (destination / filename).is_file()]
    if missing:
        raise RuntimeError(f"模型文件不完整：{', '.join(missing)}")
    return destination


def build_keywords(python: Path, kws_dir: Path, destination: Path) -> None:
    raw = destination.with_suffix(".raw.txt")
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text("器灵 @器灵\n", encoding="utf-8")
    command = [
        str(python.parent / "sherpa-onnx-cli.exe"),
        "text2token",
        "--tokens",
        str(kws_dir / "tokens.txt"),
        "--tokens-type",
        "ppinyin",
        str(raw),
        str(destination),
    ]
    try:
        run(command)
    finally:
        raw.unlink(missing_ok=True)
    if not destination.is_file() or not destination.read_text(encoding="utf-8").strip():
        raise RuntimeError("没有生成唤醒词模型文件。")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", help="64-bit Python 3.12 executable")
    args = parser.parse_args(argv)
    root = voice_home(voice_data_dir())
    venv = root / ".venv"
    if os.name == "nt":
        python = venv / "Scripts" / "python.exe"
    else:
        python = venv / "bin" / "python"

    if not python.is_file():
        root.mkdir(parents=True, exist_ok=True)
        run(find_python(args.python) + ["-m", "venv", str(venv)])
    run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "-r",
            str(Path(__file__).with_name("requirements-voice.txt")),
        ]
    )
    run(
        [
            str(python),
            "-c",
            "import click,numpy,pypinyin,sentencepiece,sherpa_onnx,sounddevice; "
            "print('语音运行时依赖可用')",
        ]
    )

    models_root = root / "models"
    kws_dir = ensure_model(
        KWS_ARCHIVE,
        KWS_NAME,
        models_root,
        (
            "tokens.txt",
            "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
            "decoder-epoch-13-avg-2-chunk-16-left-64.onnx",
            "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
        ),
    )
    asr_dir = ensure_model(
        ASR_ARCHIVE,
        ASR_NAME,
        models_root,
        ("tokens.txt", "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx"),
    )
    keywords = root / "keywords.txt"
    build_keywords(python, kws_dir, keywords)

    print(f"语音运行时已准备：{root}")
    print("模型来自 sherpa-onnx 官方发布；启用前请先审阅对应模型/训练数据许可。")
    print("安装不会打开麦克风。请在器灵设置中手动启用唤醒词监听。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
