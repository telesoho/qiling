#!/usr/bin/env python3
"""Local wake-word and Chinese speech-recognition loop for Qiling."""

from __future__ import annotations

import argparse
import json
import logging
from logging.handlers import RotatingFileHandler
import queue
import sys
import threading
import time
from pathlib import Path
from typing import Callable

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 1_600
UTTERANCE_TIMEOUT_SECONDS = 12
# The microphone stays off until the app says the reply finished playing. This is
# only the safety net for a reply that never reports back.
RESPONSE_TIMEOUT_SECONDS = 60
# Mirrors WAKE_ACKNOWLEDGMENT in src/lib/voice-assistant.ts. The speaker tail of
# this line is sometimes picked up right after playback and must not become a question.
ACKNOWLEDGMENT = "我在请说"
ACK_ECHO_WINDOW_SECONDS = 3.0
LOGGER = logging.getLogger("qiling.voice_assistant")


def spoken_text(text: str) -> str:
    """Drop punctuation and whitespace so ASR punctuation cannot change a match."""
    return "".join(
        char for char in text if char.isalnum() or "\u4e00" <= char <= "\u9fff"
    )


def is_acknowledgment_echo(text: str) -> bool:
    heard = spoken_text(text)
    return bool(heard) and heard in ACKNOWLEDGMENT


def is_valid_wake_word(wake_word: str) -> bool:
    return (
        2 <= len(wake_word) <= 8
        and all("\u4e00" <= char <= "\u9fff" for char in wake_word)
    )


def build_keyword_line(wake_word: str, tokens_path: str, encoder=None) -> str:
    if not is_valid_wake_word(wake_word):
        raise ValueError("wake_word_invalid")
    if encoder is None:
        from sherpa_onnx import text2token

        encoder = text2token
    encoded = encoder([wake_word], tokens=tokens_path, tokens_type="ppinyin")
    if not encoded or not encoded[0]:
        raise ValueError("wake_word_encoding_failed")
    return f"{' '.join(encoded[0])} @{wake_word}"


def is_wake_word_transcript(text: str, wake_word: str) -> bool:
    return text.strip().strip(" \t\r\n，。！？!?、,.；;:：") == wake_word


def write_keyword_file(wake_word: str, tokens_path: Path, destination: Path) -> None:
    line = build_keyword_line(wake_word, str(tokens_path))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(f"{line}\n", encoding="utf-8")


class VoiceFlow:
    def __init__(
        self,
        keyword_spotter,
        recognizer,
        emit: Callable[[dict], None],
        wake_word: str,
    ) -> None:
        self.keyword_spotter = keyword_spotter
        self.recognizer = recognizer
        self.emit = emit
        self.wake_word = wake_word
        self.keyword_stream = keyword_spotter.create_stream()
        self.debug_stream = recognizer.create_stream()
        self.recognition_stream = None
        self.state = "stopped"
        self.recognition_deadline = 0.0
        self.recognition_started_at = 0.0
        self.responding_deadline = 0.0
        self.utterance_id = 0

    def start(self) -> None:
        if self.state != "stopped":
            return
        self.state = "listening"
        self.emit({"type": "state", "state": self.state})

    def feed(self, samples, now: float | None = None) -> None:
        if self.state == "listening":
            self.debug_stream.accept_waveform(SAMPLE_RATE, samples)
            while self.recognizer.is_ready(self.debug_stream):
                self.recognizer.decode_stream(self.debug_stream)
            if self.recognizer.is_endpoint(self.debug_stream):
                text = self.recognizer.get_result(self.debug_stream).strip()
                if text:
                    exact_wake_match = is_wake_word_transcript(text, self.wake_word)
                    LOGGER.info(
                        "ASR wake-listening transcript: %s; exact_wake_match=%s",
                        text,
                        exact_wake_match,
                    )
                    self.emit({"type": "debug_transcript", "text": text})
                    if exact_wake_match:
                        self._begin_wake_acknowledgment()
                        return
                self.recognizer.reset(self.debug_stream)

            self.keyword_stream.accept_waveform(SAMPLE_RATE, samples)
            while self.keyword_spotter.is_ready(self.keyword_stream):
                self.keyword_spotter.decode_stream(self.keyword_stream)
                result = self.keyword_spotter.get_result(self.keyword_stream)
                keyword = getattr(result, "keyword", "")
                if keyword:
                    LOGGER.info("KWS matched wake phrase: %s", keyword)
                    self.emit({"type": "debug_keyword", "text": keyword})
                    self._begin_wake_acknowledgment()
                    return
            return

        if self.state == "wake_acknowledgment":
            return

        if self.state == "responding":
            current_time = now if now is not None else time.monotonic()
            if current_time >= self.responding_deadline:
                self._listen()
            return

        if self.state != "recognizing":
            return

        current_time = now if now is not None else time.monotonic()
        if current_time >= self.recognition_deadline:
            self._listen()
            return

        self.recognition_stream.accept_waveform(SAMPLE_RATE, samples)
        while self.recognizer.is_ready(self.recognition_stream):
            self.recognizer.decode_stream(self.recognition_stream)

        if self.recognizer.is_endpoint(self.recognition_stream):
            text = self.recognizer.get_result(self.recognition_stream).strip()
            if not text:
                self._listen()
                return
            if (
                is_acknowledgment_echo(text)
                and current_time - self.recognition_started_at <= ACK_ECHO_WINDOW_SECONDS
            ):
                LOGGER.info("Ignoring the wake acknowledgment heard back: %s", text)
                self._listen()
                return
            self.utterance_id += 1
            # Hold the microphone until the app says the reply finished, so the
            # pet's own answer can never be heard as the next question.
            self._responding(now)
            self.emit(
                {
                    "type": "transcript",
                    "id": self.utterance_id,
                    "text": text,
                }
            )

    def begin_recognition(self, now: float | None = None) -> None:
        if self.state != "wake_acknowledgment":
            return
        self.recognition_stream = self.recognizer.create_stream()
        self.recognition_started_at = now if now is not None else time.monotonic()
        self.recognition_deadline = (
            self.recognition_started_at + UTTERANCE_TIMEOUT_SECONDS
        )
        self.state = "recognizing"
        self.emit({"type": "state", "state": self.state})

    def listen(self, now: float | None = None) -> None:
        """The app asks for audio again: start the question, or re-arm the wake word."""
        if self.state == "wake_acknowledgment":
            self.begin_recognition(now)
        elif self.state == "responding":
            self._listen()

    def cancel(self) -> None:
        if self.state in {"recognizing", "wake_acknowledgment", "responding"}:
            self._listen()

    def stop(self) -> None:
        if self.state == "stopped":
            return
        self.state = "stopped"
        self.emit({"type": "state", "state": self.state})

    def _listen(self) -> None:
        if self.recognition_stream is not None:
            self.recognizer.reset(self.recognition_stream)
            self.recognition_stream = None
        self.debug_stream = self.recognizer.create_stream()
        self.state = "listening"
        self.emit({"type": "state", "state": self.state})

    def _responding(self, now: float | None = None) -> None:
        if self.recognition_stream is not None:
            self.recognizer.reset(self.recognition_stream)
            self.recognition_stream = None
        self.responding_deadline = (
            now if now is not None else time.monotonic()
        ) + RESPONSE_TIMEOUT_SECONDS
        self.state = "responding"
        self.emit({"type": "state", "state": self.state})

    def _begin_wake_acknowledgment(self) -> None:
        self.keyword_spotter.reset_stream(self.keyword_stream)
        self.recognizer.reset(self.debug_stream)
        self.state = "wake_acknowledgment"
        self.emit({"type": "state", "state": self.state})


def emit(event: dict) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def configure_logging(log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        log_path,
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[handler],
        force=True,
    )


def create_engines(kws_dir: Path, asr_dir: Path, keywords: Path):
    import sherpa_onnx

    spotter = sherpa_onnx.KeywordSpotter(
        tokens=str(kws_dir / "tokens.txt"),
        encoder=str(kws_dir / "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"),
        decoder=str(kws_dir / "decoder-epoch-13-avg-2-chunk-16-left-64.onnx"),
        joiner=str(kws_dir / "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx"),
        num_threads=1,
        keywords_file=str(keywords),
        keywords_score=1.0,
        keywords_threshold=0.35,
        provider="cpu",
    )
    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(asr_dir / "tokens.txt"),
        encoder=str(asr_dir / "encoder.int8.onnx"),
        decoder=str(asr_dir / "decoder.onnx"),
        joiner=str(asr_dir / "joiner.int8.onnx"),
        num_threads=2,
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.0,
        rule2_min_trailing_silence=1.0,
        rule3_min_utterance_length=300,
        provider="cpu",
    )
    return spotter, recognizer


def run_microphone(flow: VoiceFlow) -> None:
    import numpy
    import sounddevice as sd

    frames: queue.Queue = queue.Queue(maxsize=8)

    def on_audio(indata, _frame_count, _time_info, status) -> None:
        if status:
            emit({"type": "warning", "code": "microphone_overflow"})
        samples = indata[:, 0].copy()
        try:
            frames.put_nowait(samples)
        except queue.Full:
            try:
                frames.get_nowait()
            except queue.Empty:
                pass
            try:
                frames.put_nowait(samples)
            except queue.Full:
                pass

    def read_commands() -> None:
        for line in sys.stdin:
            command = line.strip()
            if command in {"cancel", "listen"}:
                frames.put(("command", command))

    threading.Thread(target=read_commands, daemon=True).start()
    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        blocksize=FRAME_SAMPLES,
        callback=on_audio,
    )
    with stream:
        flow.start()
        while flow.state != "stopped":
            item = frames.get()
            if isinstance(item, tuple) and item[0] == "command":
                if item[1] == "cancel":
                    flow.cancel()
                else:
                    flow.listen()
                continue
            flow.feed(numpy.asarray(item, dtype=numpy.float32).reshape(-1))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kws-dir", required=True, type=Path)
    parser.add_argument("--asr-dir", required=True, type=Path)
    parser.add_argument("--keywords", required=True, type=Path)
    parser.add_argument("--wake-word", required=True)
    parser.add_argument("--log-file", type=Path)
    args = parser.parse_args(argv)

    try:
        configure_logging(args.log_file or args.keywords.parent / "voice-assistant.log")
        LOGGER.info("Starting local voice runtime for wake phrase: %s", args.wake_word)
        required = [
            args.kws_dir / "tokens.txt",
            args.kws_dir / "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
            args.kws_dir / "decoder-epoch-13-avg-2-chunk-16-left-64.onnx",
            args.kws_dir / "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
            args.asr_dir / "tokens.txt",
            args.asr_dir / "encoder.int8.onnx",
            args.asr_dir / "decoder.onnx",
            args.asr_dir / "joiner.int8.onnx",
        ]
        missing = [str(path) for path in required if not path.is_file()]
        if missing:
            emit({"type": "error", "code": "voice_model_missing"})
            return 2
        if not is_valid_wake_word(args.wake_word):
            emit({"type": "error", "code": "wake_word_invalid"})
            return 2
        write_keyword_file(args.wake_word, args.kws_dir / "tokens.txt", args.keywords)
        LOGGER.info("Generated KWS keyword rule: %s", args.keywords.read_text(encoding="utf-8").strip())
        spotter, recognizer = create_engines(args.kws_dir, args.asr_dir, args.keywords)
        run_microphone(VoiceFlow(spotter, recognizer, emit, args.wake_word))
        return 0
    except KeyboardInterrupt:
        emit({"type": "state", "state": "stopped"})
        return 0
    except Exception as error:
        LOGGER.exception("Local voice runtime failed")
        message = str(error)
        code = (
            message
            if message in {"wake_word_invalid", "wake_word_encoding_failed"}
            else "microphone_unavailable"
            if "sounddevice" in str(type(error)).lower()
            else "voice_engine_failed"
        )
        emit({"type": "error", "code": code})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
