"""Reference-clip checks for 诗琚's CosyVoice 3 child-girl voice.

The open model has no Alibaba Cloud preset such as longhuhu_v3. Speaker
identity comes only from a local zero-shot reference. The adult demo line
shipped with CosyVoice must not be used as that reference.
"""

from __future__ import annotations

import wave
from pathlib import Path

PROMPT_PREFIX = "You are a helpful assistant.<|endofprompt|>"
ADULT_DEMO = "希望你以后能够做的比我还好"
MIN_PROMPT_SECS = 2.5
MAX_PROMPT_SECS = 30.0


def content_lines(raw: str) -> list[str]:
    lines = []
    for line in raw.splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        lines.append(text)
    return lines


def is_stub_marker(line: str) -> bool:
    marker = line.strip().strip("\"'`")
    return marker.upper() in {"STUB", "PLACEHOLDER"}


def spoken_body(text: str) -> str:
    return text.split("<|endofprompt|>")[-1].strip()


def is_adult_demo(spoken: str) -> bool:
    compact = "".join(ch for ch in spoken if not ch.isspace())
    compact = compact.strip("。！!.呀呦哟")
    return ADULT_DEMO in compact


def cosyvoice3_prompt(spoken: str) -> str:
    if "<|endofprompt|>" in spoken:
        return spoken
    return f"{PROMPT_PREFIX}{spoken}"


def wav_duration_secs(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            frames = handle.getnframes()
    except (wave.Error, EOFError, FileNotFoundError):
        return None
    if rate <= 0:
        return None
    return frames / float(rate)


def assess(transcript: str | None, duration: float | None) -> tuple[bool, str, str]:
    """Return (ok, detail, spoken body). Spoken body excludes the control prefix."""
    if transcript is None:
        return False, "没有找到参考文稿。请在录音旁边放同名 txt，内容是录音里说的原句。", ""
    lines = content_lines(transcript)
    if not lines:
        return False, "参考文稿是空的。请写成这句录音里实际说的话。", ""
    if any(is_stub_marker(line) for line in lines):
        return False, "参考文稿仍是占位 STUB。换成儿童女孩录音的逐字稿后再克隆。", ""
    spoken = spoken_body("".join(lines))
    if len(spoken) < 2:
        return False, "参考文稿太短。请写成录音里实际说的那句话。", ""
    if is_adult_demo(spoken):
        return (
            False,
            "这是 CosyVoice 官方成年女声示例稿，诗琚不用。请换成儿童女孩录音，以及和录音一致的另一句文稿。",
            "",
        )
    if duration is None:
        return False, "参考录音不是可用的 PCM WAV。请另存为普通 wav。", ""
    if duration < MIN_PROMPT_SECS:
        return (
            False,
            f"参考录音只有 {duration:.1f} 秒，还不能当儿童女孩音色。请换成大约 3–10 秒、单人、没有背景音乐的干声。",
            "",
        )
    if duration > MAX_PROMPT_SECS:
        return (
            False,
            f"参考录音有 {duration:.1f} 秒，CosyVoice 3 不接受超过 30 秒的参考音。请裁到 3–10 秒。",
            "",
        )
    return True, "CosyVoice 3 0.5B 本机零样本，儿童女孩参考音", spoken


def self_check(asset_dir: Path | None = None) -> None:
    ok, detail, spoken = assess("今天想先看棋盘上的这一步。", 4.0)
    assert ok, detail
    assert spoken == "今天想先看棋盘上的这一步。"
    assert ADULT_DEMO not in cosyvoice3_prompt(spoken)
    assert cosyvoice3_prompt(spoken).startswith(PROMPT_PREFIX)

    ok, detail, _spoken = assess("STUB", 4.0)
    assert not ok and "STUB" in detail

    ok, detail, _spoken = assess(f"{PROMPT_PREFIX}希望你以后能够做的比我还好呦。", 4.0)
    assert not ok and "成年" in detail

    ok, detail, _spoken = assess("今天想先看棋盘上的这一步。", 0.25)
    assert not ok and "秒" in detail

    if asset_dir is None:
        asset_dir = Path(__file__).resolve().parents[2] / "assets" / "qiling"
    stub_txt = (asset_dir / "voice-prompt-girl-child.txt").read_text(encoding="utf-8")
    duration = wav_duration_secs(asset_dir / "voice-prompt-girl-child.wav")
    ok, detail, _spoken = assess(stub_txt, duration)
    assert not ok, detail
    assert "STUB" in detail or "秒" in detail


if __name__ == "__main__":
    self_check()
    print("prompt_check ok")
