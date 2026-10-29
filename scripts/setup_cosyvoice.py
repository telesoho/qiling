#!/usr/bin/env python3
"""Download Fun-CosyVoice3-0.5B and a matching CosyVoice checkout for 识局.

Weights stay in the app-data directory. They are not committed. This does
not download an Alibaba Cloud voice. 诗琚's speaker is a local child-girl
reference clip; see assets/qiling/README.md.

Upstream pins Python 3.10 or 3.11, torch 2.3.1, and a CUDA 12.1 package
index. A GPU is preferred. CPU works and is slow. The virtualenv is large
because this installs CosyVoice's own requirements.txt.

PyPI and download.pytorch.org are slow from China. Packages come from the
Tsinghua PyPI mirror. CUDA wheels come from the SJTU mirror, whose index
links to files on that mirror. NJU's copy links back to download.pytorch.org,
so it does not help. Override with SIJU_PIP_INDEX_URL and SIJU_TORCH_INDEX_URL.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Relative wheel links, served from China. The official cu121 index points at
# files.pythonhosted.org / download.pytorch.org, which is what makes pip crawl.
DEFAULT_PIP_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple"
DEFAULT_TORCH_INDEX = "https://mirror.sjtu.edu.cn/pytorch-wheels/cu121"

REPO_URL = "https://github.com/FunAudioLLM/CosyVoice.git"
# main on 2026-05-25. Fun-CosyVoice3-0.5B inference lives in this tree.
COSYVOICE_COMMIT = "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
MODEL_ID = "FunAudioLLM/Fun-CosyVoice3-0.5B-2512"
# Inference loads llm.pt, not the RL checkpoint or the TensorRT onnx.
IGNORE_WEIGHTS = [
    "llm.rl.pt",
    "speech_tokenizer_v3.batch.onnx",
    "flow.decoder.estimator.fp32.onnx",
]
MODEL_FILES = [
    "cosyvoice3.yaml",
    "llm.pt",
    "flow.pt",
    "hift.pt",
    "campplus.onnx",
    "speech_tokenizer_v3.onnx",
]


def app_data_dir() -> Path:
    override = os.environ.get("QILING_APPDATA", "").strip() or os.environ.get("SIJU_APPDATA", "").strip()
    if override:
        return Path(override)
    if os.name == "nt":
        base_text = os.environ.get("APPDATA", "").strip()
        base = Path(base_text) if base_text else Path.home() / "AppData" / "Roaming"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        xdg = os.environ.get("XDG_DATA_HOME", "").strip()
        base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    qiling = base / "com.qiling.pet"
    siju = base / "com.siju.app"
    if (qiling / "cosyvoice").exists():
        return qiling
    if (siju / "cosyvoice").exists():
        return siju
    return qiling


def cosyvoice_home(root: Path) -> Path:
    return root / "cosyvoice"


def venv_python(repo: Path) -> Path:
    if os.name == "nt":
        return repo / ".venv" / "Scripts" / "python.exe"
    return repo / ".venv" / "bin" / "python"


def python_version(cmd: list[str]) -> tuple[int, int] | None:
    try:
        out = subprocess.check_output(
            cmd + ["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    parts = out.split()
    if len(parts) != 2:
        return None
    return int(parts[0]), int(parts[1])


def candidate_pythons(explicit: str | None) -> list[list[str]]:
    if explicit:
        return [explicit.split()]
    found: list[list[str]] = []
    if os.name == "nt":
        found.append(["py", "-3.10"])
        found.append(["py", "-3.11"])
    for name in ("python3.10", "python3.11", "python3", "python"):
        path = shutil.which(name)
        if path:
            found.append([path])
    return found


def find_python(explicit: str | None) -> list[str]:
    for cmd in candidate_pythons(explicit):
        version = python_version(cmd)
        if version in {(3, 10), (3, 11)}:
            return cmd
    raise SystemExit(
        "需要 Python 3.10 或 3.11 来安装上游 CosyVoice（torch 2.3.1）。"
        "可以用 --python 指向那个解释器。当前解释器是 "
        f"{sys.version.split()[0]}。"
    )


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.check_call(cmd, cwd=str(cwd) if cwd else None)


def clone_repo(repo: Path) -> None:
    repo.parent.mkdir(parents=True, exist_ok=True)
    if not (repo / ".git").is_dir():
        run(["git", "clone", REPO_URL, str(repo)])
    run(["git", "fetch", "--depth", "1", "origin", COSYVOICE_COMMIT], cwd=repo)
    run(["git", "checkout", "--detach", COSYVOICE_COMMIT], cwd=repo)
    run(["git", "submodule", "update", "--init", "--recursive"], cwd=repo)
    marker = repo / "third_party" / "Matcha-TTS"
    if not marker.is_dir():
        raise SystemExit(f"子模块没拉下来：{marker}")


def pip_index() -> str:
    return os.environ.get("SIJU_PIP_INDEX_URL", "").strip() or DEFAULT_PIP_INDEX


def torch_index() -> str:
    return os.environ.get("SIJU_TORCH_INDEX_URL", "").strip() or DEFAULT_TORCH_INDEX


def requirements_for_pip(repo: Path) -> Path:
    """Rewrite upstream index lines so pip does not fetch wheels from abroad."""
    text = (repo / "requirements.txt").read_text(encoding="utf-8")
    lines: list[str] = []
    for line in text.splitlines():
        code = line.split("#", 1)[0].strip()
        if code.startswith("--extra-index-url"):
            parts = code.split()
            url = parts[1] if len(parts) > 1 else ""
            if "pytorch.org" in url:
                lines.append(f"--extra-index-url {torch_index()}")
                continue
            # onnxruntime-gpu's CUDA feed. Windows installs the CPU package.
            if os.name == "nt" and "pkgs.visualstudio.com" in url:
                continue
        lines.append(line)
    dest = repo / ".venv" / "requirements.mirrored.txt"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return dest


def create_venv(python: list[str], repo: Path) -> Path:
    venv_py = venv_python(repo)
    index = pip_index()
    if not venv_py.is_file():
        run(python + ["-m", "venv", str(repo / ".venv")])
    # setuptools 82 dropped pkg_resources. openai-whisper==20231117 still imports it
    # while pip builds the sdist, including inside the isolated build env.
    run(
        [
            str(venv_py),
            "-m",
            "pip",
            "install",
            "-i",
            index,
            "--timeout",
            "60",
            "-U",
            "pip",
            "wheel",
            "setuptools<82",
        ]
    )
    constraint = repo / ".venv" / "setuptools-lt82.txt"
    constraint.write_text("setuptools<82\n", encoding="utf-8")
    req = requirements_for_pip(repo)
    print(f"PyPI 镜像：{index}")
    print(f"PyTorch 镜像：{torch_index()}")
    run(
        [
            str(venv_py),
            "-m",
            "pip",
            "install",
            "-i",
            index,
            "--timeout",
            "120",
            "--retries",
            "15",
            "--build-constraint",
            str(constraint),
            "-r",
            str(req),
        ]
    )
    install_api_deps(venv_py)
    return venv_py


def install_api_deps(venv_py: Path) -> None:
    """FastAPI serves /docs. It is not part of upstream CosyVoice."""
    req = Path(__file__).resolve().parents[1] / "services" / "cosyvoice-tts" / "requirements.txt"
    run(
        [
            str(venv_py),
            "-m",
            "pip",
            "install",
            "-i",
            pip_index(),
            "--timeout",
            "60",
            "-r",
            str(req),
        ]
    )


def download_model(venv_py: Path, model_dir: Path, source: str) -> None:
    model_dir.mkdir(parents=True, exist_ok=True)
    ignore = json.dumps(IGNORE_WEIGHTS)
    code = r"""
import json, sys
from pathlib import Path
dest = Path(sys.argv[1])
source = sys.argv[2]
ignore = json.loads(sys.argv[3])
model_id = sys.argv[4]
dest.mkdir(parents=True, exist_ok=True)
if source == "modelscope":
    from modelscope import snapshot_download
    try:
        snapshot_download(model_id, local_dir=str(dest), ignore_file_pattern=ignore)
    except TypeError:
        snapshot_download(model_id, local_dir=str(dest))
else:
    from huggingface_hub import snapshot_download
    snapshot_download(model_id, local_dir=str(dest), ignore_patterns=ignore)
print(dest)
"""
    run([str(venv_py), "-c", code, str(model_dir), source, ignore, MODEL_ID])


def missing_model_files(model_dir: Path) -> list[str]:
    missing = [name for name in MODEL_FILES if not (model_dir / name).is_file()]
    if not (model_dir / "CosyVoice-BlankEN").is_dir():
        missing.append("CosyVoice-BlankEN")
    return missing


def prompt_paths(root: Path) -> tuple[Path, Path]:
    home = cosyvoice_home(root)
    return (
        home / "voice-prompt-girl-child.wav",
        home / "voice-prompt-girl-child.txt",
    )


def check(root: Path) -> dict[str, object]:
    repo = cosyvoice_home(root) / "CosyVoice"
    model = cosyvoice_home(root) / "Fun-CosyVoice3-0.5B"
    wav, text = prompt_paths(root)
    return {
        "appData": str(root),
        "repo": str(repo),
        "repoReady": (repo / "cosyvoice" / "cli" / "cosyvoice.py").is_file()
        and (repo / "third_party" / "Matcha-TTS").is_dir(),
        "python": str(venv_python(repo)),
        "pythonReady": venv_python(repo).is_file(),
        "model": str(model),
        "modelReady": not missing_model_files(model),
        "missingModelFiles": missing_model_files(model),
        "promptWav": str(wav),
        "promptText": str(text),
        "promptWavPresent": wav.is_file(),
        "service": "services/cosyvoice-tts/server.py",
        "listen": "http://127.0.0.1:8765",
        "note": "仓库里的 assets/qiling/voice-prompt-girl-child.wav 是静音占位，不是儿童音色。把 3–10 秒儿童女孩干声和逐字稿放到上面的 promptWav / promptText。不要用官方成年女声示例。放好后运行 python scripts/start_cosyvoice.py。器灵不会自己拉起 Python。",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="安装本地 Fun-CosyVoice3-0.5B（诗琚儿童女孩零样本）")
    parser.add_argument("--check", action="store_true", help="只打印路径和文件是否齐全")
    parser.add_argument("--source", choices=("huggingface", "modelscope"), default="huggingface")
    parser.add_argument("--python", help="Python 3.10 或 3.11 的路径")
    parser.add_argument("--skip-pip", action="store_true")
    parser.add_argument("--skip-download", action="store_true")
    args = parser.parse_args()
    root = app_data_dir()
    if args.check:
        print(json.dumps(check(root), ensure_ascii=False, indent=2))
        return 0

    if not shutil.which("git"):
        raise SystemExit("需要 git 来克隆 FunAudioLLM/CosyVoice。")
    python = find_python(args.python)
    repo = cosyvoice_home(root) / "CosyVoice"
    model = cosyvoice_home(root) / "Fun-CosyVoice3-0.5B"
    print(f"应用数据目录：{root}")
    print(f"源码：{repo}")
    print(f"权重：{model}")
    print("这一步会下载数 GB 的 PyTorch 和约 5GB 权重。有 NVIDIA GPU 时用 CUDA，否则是 CPU，短句也会比较慢。")
    clone_repo(repo)
    venv_py = venv_python(repo)
    if not args.skip_pip:
        venv_py = create_venv(python, repo)
    elif not venv_py.is_file():
        raise SystemExit(f"--skip-pip 但虚拟环境不存在：{venv_py}")
    else:
        install_api_deps(venv_py)
    if not args.skip_download:
        download_model(venv_py, model, args.source)
    missing = missing_model_files(model)
    if missing:
        raise SystemExit("权重不完整，缺少：" + "、".join(missing))
    wav, text = prompt_paths(root)
    print()
    print("模型文件已在本机。器灵不会把它们打进安装包。")
    print("音色不是模型自带的。请把儿童女孩参考音放到：")
    print(f"  录音  {wav}")
    print(f"  文稿  {text}")
    print("录音大约 3–10 秒，单人，没有背景音乐，wav。文稿必须是录音里的原句。")
    print("不要使用 CosyVoice 官方示例「希望你以后能够做的比我还好呦。」那是成年女声。")
    print("放好参考音之后，在仓库根目录启动服务。器灵不会自己拉起 Python。")
    print("  python scripts/start_cosyvoice.py")
    print("默认监听 http://127.0.0.1:8765 。浏览器打开 http://127.0.0.1:8765/docs 看 Swagger。")
    print("器灵用 QILING_COSYVOICE_URL 连接，没有就看 SIJU_COSYVOICE_URL。服务没开就用系统语音。")
    print("环境变量 QILING_COSYVOICE_PROMPT_WAV / QILING_COSYVOICE_PROMPT_TEXT 可以改参考音。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
