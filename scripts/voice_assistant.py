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
# Speaker tails need time to die down. Feed nothing for this long after playback
# ends, then re-arm the wake word / question recognizer.
SETTLE_SECONDS = 0.4
# Once woken, keep accepting follow-up questions without the wake word. Every
# accepted question refreshes this window; after this much user silence the pet
# goes back to listening for the wake word only.
CONVERSATION_TIMEOUT_SECONDS = 5 * 60
# Share of the recognized characters that must also be in the line being spoken
# before a transcript is treated as the pet hearing itself.
ECHO_OVERLAP_RATIO = 0.6
MIN_BARGE_IN_CHARS = 2
# Mirrors WAKE_ACKNOWLEDGMENT in src/lib/voice-assistant.ts. The speaker tail of
# this line is sometimes picked up right after playback and must not become a question.
ACKNOWLEDGMENT = "我在请说"
ACK_ECHO_WINDOW_SECONDS = 3.0
# Said while the pet is talking: accept even when ASR returns only one character.
INTERRUPT_PHRASES = ("停", "停下", "停一下", "等一下", "等等", "别说了", "打断")
LOGGER = logging.getLogger("qiling.voice_assistant")


def spoken_text(text: str) -> str:
    """Drop punctuation and whitespace so ASR punctuation cannot change a match."""
    return "".join(
        char for char in text if char.isalnum() or "\u4e00" <= char <= "\u9fff"
    )


def common_subsequence_length(left: str, right: str) -> int:
    """Longest common subsequence length, small inputs only (two short sentences)."""
    if not left or not right:
        return 0
    previous = [0] * (len(right) + 1)
    for left_char in left:
        current = [0]
        for index, right_char in enumerate(right, start=1):
            if left_char == right_char:
                current.append(previous[index - 1] + 1)
            else:
                current.append(max(previous[index], current[index - 1]))
        previous = current
    return previous[-1]


def is_echo_of(transcript: str, played: str) -> bool:
    """True when the microphone mostly picked up the line the pet is speaking."""
    heard = spoken_text(transcript)
    spoken = spoken_text(played)
    if not heard:
        return True
    if not spoken:
        return False
    if heard in spoken or spoken in heard:
        return True
    overlap = common_subsequence_length(heard, spoken) / len(heard)
    return overlap >= ECHO_OVERLAP_RATIO


def is_interrupt_phrase(text: str) -> bool:
    heard = spoken_text(text)
    return any(phrase in heard for phrase in INTERRUPT_PHRASES)


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
        self.barge_stream = None
        self.state = "stopped"
        self.recognition_deadline = 0.0
        self.recognition_started_at = 0.0
        self.recognition_guard_until = 0.0
        self.responding_deadline = 0.0
        self.settle_deadline = 0.0
        self.playing_text = ""
        self.paused_for_playback = False
        self.pause_deadline = 0.0
        self.awaiting_new_answer = False
        self.awake_until = 0.0
        self.utterance_id = 0

    def start(self) -> None:
        if self.state != "stopped":
            return
        self.awake_until = 0.0
        self.state = "listening"
        self.emit({"type": "state", "state": self.state})

    def feed(self, samples, now: float | None = None) -> None:
        current_time = now if now is not None else time.monotonic()
        if (
            self.paused_for_playback
            and self.pause_deadline
            and current_time >= self.pause_deadline
        ):
            # Playback never reported its end; never leave the microphone stuck.
            LOGGER.info("Playback did not report its end; reopening the microphone.")
            self.paused_for_playback = False
            self.pause_deadline = 0.0

        if self.state == "listening":
            if self.paused_for_playback:
                return
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
                        self._begin_wake_acknowledgment(current_time)
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
                    self._begin_wake_acknowledgment(current_time)
                    return
            return

        if self.state == "wake_acknowledgment":
            # Mic stays closed while the app plays "我在，请说。"; the app calls
            # listen() once it was heard, and recognition starts after a short guard.
            return

        if self.state == "settle":
            self._feed_settle(now)
            return

        if self.state == "responding":
            self._feed_responding(samples, now)
            return

        if self.state == "conversing":
            self._feed_conversing(samples, now)
            return

        if self.state != "recognizing":
            return

        current_time = now if now is not None else time.monotonic()
        if current_time >= self.recognition_deadline:
            self._resume(now)
            return
        if current_time < self.recognition_guard_until or self.paused_for_playback:
            return

        self.recognition_stream.accept_waveform(SAMPLE_RATE, samples)
        while self.recognizer.is_ready(self.recognition_stream):
            self.recognizer.decode_stream(self.recognition_stream)

        if self.recognizer.is_endpoint(self.recognition_stream):
            text = self.recognizer.get_result(self.recognition_stream).strip()
            if not text:
                self._resume(now)
                return
            if (
                is_acknowledgment_echo(text)
                and current_time - self.recognition_started_at <= ACK_ECHO_WINDOW_SECONDS
            ):
                LOGGER.info("Ignoring the wake acknowledgment heard back: %s", text)
                self._resume(now)
                return
            self._extend_awake(current_time)
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
        current_time = now if now is not None else time.monotonic()
        if current_time >= self.awake_until:
            self._listen()
            return
        self.recognition_stream = self.recognizer.create_stream()
        self.recognition_started_at = current_time
        self.recognition_guard_until = current_time + SETTLE_SECONDS
        self.recognition_deadline = current_time + UTTERANCE_TIMEOUT_SECONDS
        self.state = "recognizing"
        self.emit({"type": "state", "state": self.state})

    def speak(self, text: str, now: float | None = None) -> None:
        """The app started playing `text`. Keep the echo out of the question stream."""
        line = text.strip()
        if not line:
            return
        self.playing_text = line
        if self.state == "responding":
            self.awaiting_new_answer = False
            self.paused_for_playback = False
            self.pause_deadline = 0.0
            if self.barge_stream is None:
                self.barge_stream = self.recognizer.create_stream()
            else:
                self.recognizer.reset(self.barge_stream)
            return
        if self.state in {"listening", "recognizing", "settle", "conversing"}:
            # Half duplex for lines that come from other clients too: no ASR input
            # while the speaker is busy.
            self.paused_for_playback = True
            self.pause_deadline = (
                now if now is not None else time.monotonic()
            ) + RESPONSE_TIMEOUT_SECONDS
            if self.state == "listening":
                self.keyword_spotter.reset_stream(self.keyword_stream)

    def spoken(self, now: float | None = None) -> None:
        """The app finished (or interrupted) the line it was playing."""
        self.playing_text = ""
        self.barge_stream = None
        self.paused_for_playback = False
        self.pause_deadline = 0.0
        if self.state == "recognizing":
            self.recognition_guard_until = (
                now if now is not None else time.monotonic()
            ) + SETTLE_SECONDS
        elif self.state == "responding":
            if not self.awaiting_new_answer:
                self._settle(now)
        elif self.state in {"listening", "settle", "conversing"}:
            # A line from another client ended; keep the tail out of the microphone.
            self._settle(now)
        # wake_acknowledgment: the app calls listen() once the reply was heard.

    def listen(self, now: float | None = None) -> None:
        """The app asks for audio again: start the question, or re-arm the wake word."""
        if self.state == "wake_acknowledgment":
            self.begin_recognition(now)
        elif self.state == "responding" and not self.awaiting_new_answer:
            self._settle(now)

    def cancel(self) -> None:
        if self.state in {
            "recognizing",
            "wake_acknowledgment",
            "responding",
            "settle",
            "conversing",
        }:
            self._listen()

    def stop(self) -> None:
        if self.state == "stopped":
            return
        self.state = "stopped"
        self.awake_until = 0.0
        self.emit({"type": "state", "state": self.state})

    def _listen(self) -> None:
        if self.recognition_stream is not None:
            self.recognizer.reset(self.recognition_stream)
            self.recognition_stream = None
        self.barge_stream = None
        self.playing_text = ""
        self.paused_for_playback = False
        self.pause_deadline = 0.0
        self.awaiting_new_answer = False
        self.awake_until = 0.0
        self.debug_stream = self.recognizer.create_stream()
        self.state = "listening"
        self.emit({"type": "state", "state": self.state})

    def _responding(self, now: float | None = None) -> None:
        if self.recognition_stream is not None:
            self.recognizer.reset(self.recognition_stream)
            self.recognition_stream = None
        self.barge_stream = None
        self.playing_text = ""
        self.paused_for_playback = False
        self.pause_deadline = 0.0
        self.awaiting_new_answer = False
        self.responding_deadline = (
            now if now is not None else time.monotonic()
        ) + RESPONSE_TIMEOUT_SECONDS
        self.state = "responding"
        self.emit({"type": "state", "state": self.state})

    def _settle(self, now: float | None = None) -> None:
        """Keep the microphone closed briefly so the speaker tail cannot be heard."""
        if self.recognition_stream is not None:
            self.recognizer.reset(self.recognition_stream)
            self.recognition_stream = None
        self.barge_stream = None
        self.playing_text = ""
        self.paused_for_playback = False
        self.pause_deadline = 0.0
        self.awaiting_new_answer = False
        self.settle_deadline = (
            now if now is not None else time.monotonic()
        ) + SETTLE_SECONDS
        if self.state != "settle":
            self.state = "settle"
            self.emit({"type": "state", "state": self.state})

    def _feed_settle(self, now: float | None = None) -> None:
        if self.paused_for_playback:
            # A new line started while the tail was still settling.
            return
        if (now if now is not None else time.monotonic()) >= self.settle_deadline:
            self._resume(now)

    def _extend_awake(self, now: float | None = None) -> None:
        """Refresh the conversation window because the user just spoke."""
        self.awake_until = (
            now if now is not None else time.monotonic()
        ) + CONVERSATION_TIMEOUT_SECONDS

    def _resume(self, now: float | None = None) -> None:
        """Return the microphone to the conversation, or to wake-word only."""
        if (now if now is not None else time.monotonic()) < self.awake_until:
            self._converse(now)
        else:
            LOGGER.info(
                "No question for %s seconds; back to wake-word listening.",
                CONVERSATION_TIMEOUT_SECONDS,
            )
            self._listen()

    def _converse(self, now: float | None = None) -> None:
        """Stay awake and listen for the next question without the wake word."""
        current_time = now if now is not None else time.monotonic()
        if current_time >= self.awake_until:
            self._resume(now)
            return
        if self.recognition_stream is not None:
            self.recognizer.reset(self.recognition_stream)
        self.recognition_stream = self.recognizer.create_stream()
        self.recognition_started_at = current_time
        # The reply already settled before this stream opened; no extra guard.
        self.recognition_guard_until = current_time
        self.recognition_deadline = self.awake_until
        self.barge_stream = None
        self.playing_text = ""
        self.paused_for_playback = False
        self.pause_deadline = 0.0
        self.awaiting_new_answer = False
        if self.state != "conversing":
            self.state = "conversing"
            self.emit({"type": "state", "state": self.state})

    def _feed_conversing(self, samples, now: float | None = None) -> None:
        current_time = now if now is not None else time.monotonic()
        if self.paused_for_playback:
            return
        if current_time >= self.awake_until:
            self._resume(now)
            return
        if self.recognition_stream is None or current_time >= self.recognition_deadline:
            self._converse(now)
            return
        self.recognition_stream.accept_waveform(SAMPLE_RATE, samples)
        while self.recognizer.is_ready(self.recognition_stream):
            self.recognizer.decode_stream(self.recognition_stream)
        if not self.recognizer.is_endpoint(self.recognition_stream):
            return
        text = self.recognizer.get_result(self.recognition_stream).strip()
        if not text:
            # The stream ended on silence; keep waiting inside the same conversation.
            self._converse(now)
            return
        if is_acknowledgment_echo(text):
            LOGGER.info(
                "Ignoring a stray wake acknowledgment in conversation: %s", text
            )
            self._converse(now)
            return
        if is_wake_word_transcript(text, self.wake_word):
            LOGGER.info("Wake word repeated during the conversation: %s", text)
            self._begin_wake_acknowledgment(current_time)
            return
        self._extend_awake(current_time)
        self.utterance_id += 1
        self._responding(now)
        self.emit(
            {
                "type": "transcript",
                "id": self.utterance_id,
                "text": text,
            }
        )

    def _feed_responding(self, samples, now: float | None = None) -> None:
        current_time = now if now is not None else time.monotonic()
        if self.barge_stream is None:
            if current_time >= self.responding_deadline:
                self._settle(now)
            return
        if current_time >= self.responding_deadline:
            self._settle(now)
            return
        self.barge_stream.accept_waveform(SAMPLE_RATE, samples)
        while self.recognizer.is_ready(self.barge_stream):
            self.recognizer.decode_stream(self.barge_stream)
        if not self.recognizer.is_endpoint(self.barge_stream):
            return
        text = self.recognizer.get_result(self.barge_stream).strip()
        self.recognizer.reset(self.barge_stream)
        if not text:
            return
        if is_echo_of(text, self.playing_text):
            LOGGER.info("Ignoring the pet's own voice while it speaks: %s", text)
            return
        if is_wake_word_transcript(text, self.wake_word):
            LOGGER.info("Wake word heard while the pet speaks: %s", text)
            self._begin_wake_acknowledgment(current_time)
            return
        if is_interrupt_phrase(text) and len(spoken_text(text)) <= 6:
            LOGGER.info("Interrupt phrase heard while the pet speaks: %s", text)
            self._extend_awake(current_time)
            self.emit({"type": "stop_playback"})
            self._settle(now)
            return
        if len(spoken_text(text)) < MIN_BARGE_IN_CHARS:
            LOGGER.info("Ignoring a too-short barge-in candidate: %s", text)
            return
        LOGGER.info("Barge-in accepted while the pet speaks: %s", text)
        self.utterance_id += 1
        self._extend_awake(current_time)
        self.barge_stream = None
        self.playing_text = ""
        self.awaiting_new_answer = True
        self.responding_deadline = current_time + RESPONSE_TIMEOUT_SECONDS
        self.emit(
            {
                "type": "transcript",
                "id": self.utterance_id,
                "text": text,
                "barge_in": True,
            }
        )

    def _begin_wake_acknowledgment(self, now: float | None = None) -> None:
        self.keyword_spotter.reset_stream(self.keyword_stream)
        self.recognizer.reset(self.debug_stream)
        if self.recognition_stream is not None:
            self.recognizer.reset(self.recognition_stream)
            self.recognition_stream = None
        self.barge_stream = None
        self.playing_text = ""
        self.paused_for_playback = False
        self.pause_deadline = 0.0
        self.awaiting_new_answer = False
        self._extend_awake(now)
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


def parse_command(line: str) -> tuple[str, dict] | None:
    """Commands are plain words or a JSON object, e.g. `{"cmd":"speak","text":"…"}`."""
    line = line.strip()
    if not line:
        return None
    if line.startswith("{"):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            return None
        if isinstance(payload, dict) and isinstance(payload.get("cmd"), str):
            return payload["cmd"], payload
        return None
    if line in {"cancel", "listen", "spoken"}:
        return line, {}
    return None


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
            command = parse_command(line)
            if command is not None:
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
                name, payload = item[1]
                if name == "cancel":
                    flow.cancel()
                elif name == "speak":
                    flow.speak(str(payload.get("text", "")))
                elif name == "spoken":
                    flow.spoken()
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
