import io
import os
import re
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import setup_voice_assistant
from setup_voice_assistant import ensure_model


class FakeResponse:
    def __init__(self, chunks: list[bytes | Exception], headers: dict[str, str], status: int) -> None:
        self.chunks = iter(chunks)
        self.headers = headers
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def read(self, _size: int) -> bytes:
        chunk = next(self.chunks, b"")
        if isinstance(chunk, Exception):
            raise chunk
        return chunk


class VoiceSetupTests(unittest.TestCase):
    def test_voice_requirements_install_sherpa_cli_dependencies(self) -> None:
        requirements = (
            Path(setup_voice_assistant.__file__).with_name("requirements-voice.txt")
            .read_text(encoding="utf-8")
            .splitlines()
        )

        normalized = {re.split(r"[<=>!~]", line, maxsplit=1)[0].lower() for line in requirements}
        self.assertTrue({"click", "numpy", "sentencepiece", "pypinyin"}.issubset(normalized))

    def test_resumes_download_after_read_timeout(self) -> None:
        contents = b"model archive"
        first = FakeResponse(
            [contents[:5], TimeoutError("read timed out")],
            {"Content-Length": str(len(contents))},
            200,
        )
        resumed = FakeResponse(
            [contents[5:]],
            {
                "Content-Length": str(len(contents) - 5),
                "Content-Range": f"bytes 5-{len(contents) - 1}/{len(contents)}",
            },
            206,
        )
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model.tar.bz2"
            with (
                patch.object(
                    setup_voice_assistant.urllib.request,
                    "urlopen",
                    side_effect=[first, resumed],
                ) as open_url,
                patch.object(setup_voice_assistant.time, "sleep"),
            ):
                setup_voice_assistant.download_archive("https://example.test/model", target)

            self.assertEqual(target.read_bytes(), contents)
            self.assertEqual(open_url.call_count, 2)
            self.assertEqual(open_url.call_args_list[1].args[0].get_header("Range"), "bytes=5-")

    def test_voice_runtime_data_uses_qiling_app_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app_data = Path(directory)
            (app_data / "com.siju.app" / "cosyvoice").mkdir(parents=True)
            with patch.dict(os.environ, {"APPDATA": directory}, clear=False):
                root = setup_voice_assistant.voice_data_dir()

            self.assertEqual(root, app_data / "com.qiling.pet")

    def test_extracts_model_into_runtime_expected_directory(self) -> None:
        name = "test-model"
        with tempfile.TemporaryDirectory() as directory:
            models_root = Path(directory)
            archive_path = models_root / "downloads" / f"{name}.tar.bz2"
            archive_path.parent.mkdir(parents=True)
            with tarfile.open(archive_path, "w:bz2") as archive:
                content = b"tokens"
                member = tarfile.TarInfo(f"{name}/tokens.txt")
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))

            model_dir = ensure_model("unused", name, models_root, ("tokens.txt",))

            self.assertEqual(model_dir, models_root / name)
            self.assertEqual((model_dir / "tokens.txt").read_bytes(), b"tokens")


if __name__ == "__main__":
    unittest.main()
