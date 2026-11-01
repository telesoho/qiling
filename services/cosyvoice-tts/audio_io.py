"""Turn an uploaded reference clip into 16 kHz mono PCM.

Registration accepts wav/mp3/m4a, but CosyVoice's zero-shot reference and
the on-disk prompt are always one shape: ordinary 16-bit mono PCM WAV at
16 kHz. WAV decoding is stdlib-only so the service can check itself without
the model environment; mp3/m4a use whichever decoder the CosyVoice venv
already has (soundfile, torchaudio or librosa).

The magic bytes, not the filename, decide the format. A clip also has to be
long enough to clone and short enough to stay a prompt, not a recording.
"""

from __future__ import annotations

import io
import math
import struct
import sys
import wave
from array import array
from dataclasses import dataclass

TARGET_RATE = 16_000
MIN_SECONDS = 1.0
MAX_SECONDS = 30.0
MAX_BYTES = 10 * 1024 * 1024
# -60 dBFS. A silent take gives CosyVoice no speaker to clone; refuse it at
# registration instead of failing later inside add_zero_shot_spk.
MIN_PEAK = 16


class AudioError(ValueError):
    """`code` is the HTTP error name; `detail` is for the person uploading."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Clip:
    """Mono 16 kHz s16le samples, ready to be written as prompt.wav."""

    samples: array
    sample_rate: int
    seconds: float
    source_rate: int


def sniff(data: bytes) -> str:
    """Return wav, mp3, m4a, or an empty string. Extension is never trusted."""
    if len(data) < 12:
        return ""
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[:3] == b"ID3":
        return "mp3"
    if data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return "mp3"
    if data[4:8] == b"ftyp":
        return "m4a"
    return ""


def decode(data: bytes, max_bytes: int = MAX_BYTES) -> Clip:
    """Decode, validate and resample. Raises AudioError with an HTTP code."""
    if not data:
        raise AudioError("bad_audio", "prompt_audio 是空的。")
    if len(data) > max_bytes:
        raise AudioError(
            "audio_too_large",
            f"参考音频有 {len(data) / 1024 / 1024:.1f} MB，上限 {max_bytes // 1024 // 1024} MB。",
        )
    kind = sniff(data)
    if not kind:
        raise AudioError("bad_audio", "音频格式不支持。请上传 wav、mp3 或 m4a。")
    if kind == "wav":
        samples, rate = _decode_wav(data)
    else:
        samples, rate = _decode_compressed(data)
    if rate <= 0:
        raise AudioError("bad_audio", "音频采样率无效。")
    seconds = len(samples) / float(rate)
    _check_seconds(seconds)
    if max(samples, default=0) < MIN_PEAK and min(samples, default=0) > -MIN_PEAK:
        raise AudioError("bad_audio", "这段录音几乎是静音的。请上传有人声的参考录音。")
    resampled = resample(samples, rate, TARGET_RATE)
    return Clip(
        samples=resampled,
        sample_rate=TARGET_RATE,
        seconds=len(resampled) / float(TARGET_RATE),
        source_rate=rate,
    )


def wav_bytes(samples: array, sample_rate: int = TARGET_RATE) -> bytes:
    """Ordinary PCM WAV: the only thing that goes into prompt.wav."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(samples.tobytes())
    return buffer.getvalue()


def _check_seconds(seconds: float) -> None:
    if seconds < MIN_SECONDS:
        raise AudioError(
            "bad_audio",
            f"参考音频只有 {seconds:.1f} 秒，太短了。请录 1–30 秒，推荐 3–10 秒。",
        )
    if seconds > MAX_SECONDS:
        raise AudioError(
            "bad_audio",
            f"参考音频有 {seconds:.1f} 秒，太长了。CosyVoice 3 只接受 1–30 秒，推荐 3–10 秒。",
        )


def _decode_wav(data: bytes) -> tuple[array, int]:
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.getnframes()
            if channels < 1 or width not in (1, 2, 3, 4) or rate <= 0 or frames <= 0:
                raise AudioError("bad_audio", "WAV 参数不对（声道、位深或采样率无效）。")
            _check_seconds(frames / float(rate))
            raw = handle.readframes(frames)
    except AudioError:
        raise
    except (wave.Error, EOFError, OSError, struct.error) as exc:
        raise AudioError(
            "bad_audio",
            f"WAV 无法解码（{exc}）。请导出普通 PCM WAV；浮点 WAV 请先转成 16-bit PCM。",
        ) from exc
    return _mono_channels(_pcm_to_s16(raw, width), channels), rate


def _pcm_to_s16(raw: bytes, width: int) -> array:
    if width == 1:
        # WAV 8-bit is unsigned, centred at 128.
        return array("h", ((value - 128) << 8 for value in raw))
    if width == 2:
        samples = array("h")
        samples.frombytes(raw[: len(raw) - (len(raw) % 2)])
        if sys.byteorder != "little":
            samples.byteswap()
        return samples
    if width == 3:
        samples = array("h")
        for index in range(0, len(raw) - 2, 3):
            value = raw[index] | (raw[index + 1] << 8) | (raw[index + 2] << 16)
            if value & 0x800000:
                value -= 1 << 24
            samples.append(value >> 8)
        return samples
    samples32 = array("i")
    samples32.frombytes(raw[: len(raw) - (len(raw) % 4)])
    if sys.byteorder != "little":
        samples32.byteswap()
    return array("h", (value >> 16 for value in samples32))


def _mono_channels(samples: array, channels: int) -> array:
    if channels <= 1:
        return samples
    frames = len(samples) // channels
    out = array("h", [0]) * frames
    for frame in range(frames):
        base = frame * channels
        total = 0
        for channel in range(channels):
            total += samples[base + channel]
        out[frame] = int(total / channels)
    return out


def _decode_compressed(data: bytes) -> tuple[array, int]:
    """mp3/m4a need a real decoder; try the ones CosyVoice already installs."""
    problems: list[str] = []
    decoders = (
        ("soundfile", _decode_soundfile),
        ("torchaudio", _decode_torchaudio),
        ("librosa", _decode_librosa),
    )
    for name, decoder in decoders:
        try:
            return decoder(data)
        except AudioError:
            raise
        except ImportError:
            continue
        except Exception as exc:  # decoder-specific, often backend related
            problems.append(f"{name}: {type(exc).__name__}")
            continue
    hint = f"（{'；'.join(problems)}）" if problems else ""
    raise AudioError(
        "bad_audio",
        "这段 mp3/m4a 解不开。请换成 wav，或在 CosyVoice 的 Python 环境里装上 "
        f"soundfile/torchaudio 后重试。{hint}",
    )


def _decode_soundfile(data: bytes) -> tuple[array, int]:
    import soundfile  # type: ignore[import-not-found]

    info = soundfile.info(io.BytesIO(data))
    _check_seconds(info.duration)
    audio, rate = soundfile.read(io.BytesIO(data), dtype="float32", always_2d=True)
    channels = audio.shape[1]
    if channels > 1:
        audio = audio.mean(axis=1)
    else:
        audio = audio[:, 0]
    return _float_to_s16(audio), int(rate)


def _decode_torchaudio(data: bytes) -> tuple[array, int]:
    import torchaudio  # type: ignore[import-not-found]

    waveform, rate = torchaudio.load(io.BytesIO(data))
    _check_seconds(waveform.shape[-1] / float(rate))
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0)
    else:
        waveform = waveform[0]
    return _float_to_s16(waveform.numpy()), int(rate)


def _decode_librosa(data: bytes) -> tuple[array, int]:
    import librosa  # type: ignore[import-not-found]

    audio, rate = librosa.load(io.BytesIO(data), sr=None, mono=True)
    _check_seconds(len(audio) / float(rate))
    return _float_to_s16(audio), int(rate)


def _float_to_s16(values) -> array:
    out = array("h")
    for value in values:
        number = float(value)
        if number > 1.0:
            number = 1.0
        elif number < -1.0:
            number = -1.0
        out.append(int(round(number * 32767.0)))
    return out


def resample(samples: array, source_rate: int, target_rate: int = TARGET_RATE) -> array:
    """Linear interpolation. Prompt clips are short; this avoids a numpy need."""
    if source_rate == target_rate or not samples:
        return samples
    if source_rate <= 0 or target_rate <= 0:
        raise AudioError("bad_audio", "音频采样率无效。")
    length = len(samples)
    out_length = max(1, int(round(length * target_rate / float(source_rate))))
    out = array("h", [0]) * out_length
    step = source_rate / float(target_rate)
    last = length - 1
    for index in range(out_length):
        position = index * step
        base = int(position)
        if base >= last:
            out[index] = samples[last]
            continue
        fraction = position - base
        left = samples[base]
        right = samples[base + 1]
        out[index] = int(left + (right - left) * fraction)
    return out


def tone_wav(seconds: float, sample_rate: int = TARGET_RATE, freq: float = 440.0) -> bytes:
    """A quiet test tone. Registration rejects digital silence on purpose."""
    frames = max(1, int(seconds * sample_rate))
    samples = array(
        "h",
        (
            int(0.2 * 32767 * math.sin(2 * math.pi * freq * index / sample_rate))
            for index in range(frames)
        ),
    )
    return wav_bytes(samples, sample_rate)


def self_check() -> None:
    tone = tone_wav(2.0)
    clip = decode(tone)
    assert clip.sample_rate == TARGET_RATE
    assert abs(clip.seconds - 2.0) < 0.01, clip.seconds
    assert clip.source_rate == 16000
    assert max(clip.samples) > 1000

    # Stereo 48 kHz: duration survives, channels collapse, rate lands on 16k.
    mono48 = array("h", (int(0.2 * 32767 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(48000 * 2)))
    stereo48 = array("h", [0]) * (len(mono48) * 2)
    for index, value in enumerate(mono48):
        stereo48[index * 2] = value
        stereo48[index * 2 + 1] = value
    # wav_bytes writes mono; build a real stereo header through wave directly.
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        handle.writeframes(stereo48.tobytes())
    stereo_clip = decode(buffer.getvalue())
    assert abs(stereo_clip.seconds - 2.0) < 0.02, stereo_clip.seconds
    assert stereo_clip.source_rate == 48000
    assert abs(len(stereo_clip.samples) - 32000) <= 2, len(stereo_clip.samples)

    for bad, needle in (
        (tone_wav(0.5), "太短"),
        (tone_wav(31.0), "太长"),
        (b"not audio at all", "格式"),
        (b"RIFFxxxxWAVE", "WAV"),
    ):
        try:
            decode(bad)
        except AudioError as exc:
            assert needle in exc.detail, (needle, exc.detail)
        else:
            raise AssertionError(f"accepted bad audio: {bad[:12]!r}")

    # Digital silence is not a cloneable reference.
    silence = wav_bytes(array("h", [0]) * 16000, 16000)
    try:
        decode(silence)
    except AudioError as exc:
        assert "静音" in exc.detail, exc.detail
    else:
        raise AssertionError("accepted silence")

    try:
        decode(tone, max_bytes=10)
    except AudioError as exc:
        assert exc.code == "audio_too_large", exc.code
    else:
        raise AssertionError("accepted oversized upload")

    assert sniff(tone) == "wav"
    assert sniff(b"ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00") == "mp3"
    assert sniff(b"\xff\xfb\x90\x64" + b"\x00" * 8) == "mp3"
    assert sniff(b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 8) == "m4a"
    assert sniff(b"OggS" + b"\x00" * 20) == ""

    resampled = resample(array("h", [0, 1000, -1000, 0]), 8000, 16000)
    assert len(resampled) == 8
    assert resampled[0] == 0 and resampled[-1] == 0


if __name__ == "__main__":
    self_check()
    print("audio_io ok")
