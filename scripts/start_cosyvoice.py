#!/usr/bin/env python3
"""Start 器灵's local CosyVoice with the venv from setup_cosyvoice.py.

器灵 does not spawn this process. Extra arguments go to the server:

    python scripts/start_cosyvoice.py
    python scripts/start_cosyvoice.py --self-check
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from setup_cosyvoice import app_data_dir, cosyvoice_home, venv_python


def server_script() -> Path:
    return Path(__file__).resolve().parents[1] / "services" / "cosyvoice-tts" / "server.py"


def service_python() -> Path:
    return venv_python(cosyvoice_home(app_data_dir()) / "CosyVoice")


def launch_cmd(python: Path, server: Path, extra: list[str]) -> list[str]:
    return [str(python), str(server), *extra]


def main(argv: list[str] | None = None) -> int:
    extra = list(sys.argv[1:] if argv is None else argv)
    python = service_python()
    if not python.is_file():
        print(
            f"虚拟环境不存在：{python}\n先运行 python scripts/setup_cosyvoice.py",
            file=sys.stderr,
        )
        return 2
    return subprocess.call(launch_cmd(python, server_script(), extra))


def _demo() -> None:
    cmd = launch_cmd(Path("python.exe"), Path("server.py"), ["--port", "9000"])
    assert cmd == ["python.exe", "server.py", "--port", "9000"]
    assert server_script().name == "server.py"


if __name__ == "__main__":
    _demo()
    raise SystemExit(main())
