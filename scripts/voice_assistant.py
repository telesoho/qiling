#!/usr/bin/env python3
"""Local wake-word and Chinese speech-recognition loop for Qiling."""

from __future__ import annotations

import argparse
import importlib
import json
import logging
from logging.handlers import RotatingFileHandler
import queue
import sys
import threading
import time
import unicodedata
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
# Barge-in is decided from the streaming partial transcript, not from the
# endpoint. Endpointing waits 1–2 s of trailing silence, which is the single
# biggest reason the pet used to feel deaf while it spoke. One check per audio
# frame keeps the decision as fresh as the hypothesis itself.
BARGE_CHECK_SECONDS = 0.1
# Non-echo characters that mean the user is talking over the pet. A couple of
# characters only duck the voice; this many commit the interruption right away.
BARGE_HINT_CHARS = 2
BARGE_COMMIT_CHARS = 4
# A hint is not an interruption yet. The user only overrides the speakers when
# the real words keep growing over a few consecutive checks; a one-off two-char
# reading is far more often the speaker bleeding into the microphone, a cough, or
# the recognizer mishearing the pet's own voice.
BARGE_HINT_EVIDENCE_FRAMES = 3
# While the hint keeps being heard, keep refreshing the duck so a slow speaker
# does not get the voice back before they finish the first words.
BARGE_HINT_REFRESH_SECONDS = 0.8
# The first words of an explicit correction are enough to stop immediately, even
# before the sentence is complete ("不对…", "等一下…").
BARGE_COMMAND_PREFIXES = (
    "停",
    "打住",
    "别",
    "先别",
    "别说了",
    "打断",
    "等等",
    "等一下",
    "等下",
    "不对",
    "不是",
    "不要",
    "错了",
)
# "嗯" / "对" while the pet talks is backchannel, not a request for the floor.
BACKCHANNEL_SYLLABLES = frozenset("嗯啊哦噢对是好行呃唉哎额呀")
BACKCHANNEL_MAX_CHARS = 3
# A lone backchannel syllable is usually the speaker or a cough misheard, not the
# user. Two of them ("对对", "是啊") is intentional.
BACKCHANNEL_CONFIRMED_CHARS = 2
# Once the voice has already been stopped, this much real content is needed
# before the utterance becomes the next question instead of a bare "stop".
BARGE_CONTINUE_CHARS = 4
# Mirrors WAKE_ACKNOWLEDGMENT in src/lib/voice-assistant.ts. The speaker tail of
# this line is sometimes picked up right after playback and must not become a question.
ACKNOWLEDGMENT = "我在请说"
ACK_ECHO_WINDOW_SECONDS = 3.0
# A short question said over a line the pet narrates for another client. The pet
# never woke the user, so "explain what…" must reach the model without repeating
# the wake word; a longer monologue is not given that treatment.
NARRATION_QUESTION_CHARS = 12
# Words that make a short utterance a question worth answering rather than noise.
NARRATION_QUESTION_MARKERS = (
    "吗",
    "呢",
    "什么",
    "怎么",
    "为什么",
    "哪",
    "谁",
    "多少",
    "几",
    "如何",
    "是不是",
    "能不能",
    "可不可以",
    "解释",
    "讲讲",
    "说说",
    "告诉我",
    "帮我",
    "请问",
)
# Said while the pet is talking: accept even when ASR returns only one character.
INTERRUPT_PHRASES = (
    "停",
    "停下",
    "停一下",
    "等一下",
    "等等",
    "别说了",
    "别讲了",
    "打断",
)
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


def non_echo_text(transcript: str, played: str) -> str:
    """Return transcript characters that do not align with the spoken line."""
    heard = spoken_text(transcript)
    spoken = spoken_text(played)
    if not heard or not spoken:
        return heard

    rows = [[0] * (len(spoken) + 1) for _ in range(len(heard) + 1)]
    for left_index, left_char in enumerate(heard, start=1):
        for right_index, right_char in enumerate(spoken, start=1):
            if left_char == right_char:
                rows[left_index][right_index] = rows[left_index - 1][right_index - 1] + 1
            else:
                rows[left_index][right_index] = max(
                    rows[left_index - 1][right_index],
                    rows[left_index][right_index - 1],
                )

    unmatched = set()
    left_index = len(heard)
    right_index = len(spoken)
    while left_index and right_index:
        if heard[left_index - 1] == spoken[right_index - 1]:
            left_index -= 1
            right_index -= 1
        elif rows[left_index - 1][right_index] >= rows[left_index][right_index - 1]:
            left_index -= 1
            unmatched.add(left_index)
        else:
            right_index -= 1
    unmatched.update(range(left_index))
    return "".join(char for index, char in enumerate(heard) if index in unmatched)


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


def is_backchannel(text: str) -> bool:
    """True for "对对" / "是啊" style listening noises, which never take the floor."""
    heard = spoken_text(text)
    return (
        len(heard) >= BACKCHANNEL_CONFIRMED_CHARS
        and len(heard) <= BACKCHANNEL_MAX_CHARS
        and all(char in BACKCHANNEL_SYLLABLES for char in heard)
    )


def barge_evidence(transcript: str, played: str) -> str:
    """The words the microphone heard that the pet is not saying right now.

    The reading only counts as evidence when nothing in it overlaps the line
    being spoken. Subtracting by longest common subsequence below that point
    invents characters — a misheard syllable can match several of the pet's
    characters and leave the rest looking like the user talking, which is how a
    false duck used to happen.
    """
    heard = spoken_text(transcript)
    spoken = spoken_text(played)
    if not heard or not spoken:
        return heard if not spoken else ""
    if common_subsequence_length(heard, spoken) > 0:
        return ""
    return heard


def starts_with_command(text: str) -> bool:
    return spoken_text(text).startswith(BARGE_COMMAND_PREFIXES)


def strip_interrupt_phrases(text: str) -> str:
    """Whatever is left after removing every "stop" phrase, longest first."""
    remaining = spoken_text(text)
    for phrase in sorted(INTERRUPT_PHRASES, key=len, reverse=True):
        remaining = remaining.replace(phrase, "")
    return remaining


def is_narration_question(text: str) -> bool:
    """A short question said over a line the pet narrates for another client."""
    heard = strip_interrupt_phrases(text)
    if not heard or len(heard) > NARRATION_QUESTION_CHARS:
        return False
    return any(marker in heard for marker in NARRATION_QUESTION_MARKERS)


def narration_continuation(transcript: str, played: str) -> str | None:
    """The answer to give when the user interrupts a narration with a question.

    The narration belongs to another client, so the pet answers with a short
    spoken aside instead of the transcript: a full model answer would talk over
    whatever the VS Code request is still doing, and could loop the pet back
    into requesting the same explanation from VS Code.
    """
    heard = strip_interrupt_phrases(transcript)
    if barge_evidence(heard, played) != heard:
        return None
    if not is_narration_question(heard):
        return None
    return heard


def barge_cue(transcript: str, played: str) -> str | None:
    """Arbitrate one partial transcript heard while the pet is speaking.

    `user` means the reading is words the pet is not saying; `echo` means it is
    the pet's own voice coming back through the microphone.
    """
    heard = spoken_text(transcript)
    if not heard:
        return None
    return "user" if barge_evidence(heard, played) else "echo"


def is_acknowledgment_echo(text: str) -> bool:
    heard = spoken_text(text)
    return bool(heard) and heard in ACKNOWLEDGMENT


def is_valid_wake_word(wake_word: str) -> bool:
    return (
        2 <= len(wake_word) <= 8
        and all("\u4e00" <= char <= "\u9fff" for char in wake_word)
    )


# --- Wake-word phonetics -----------------------------------------------------
# sherpa-onnx KWS matches the *token* sequence exactly, and Chinese keywords are
# encoded as pinyin initials + finals (ppinyin). Two consequences shape the
# matching below:
#  * characters that share pinyin and tone are one and the same to the spotter,
#    so the keyword file never needs homophone characters;
#  * a near-homophone (零/麟, 落实/罗石, 见/剑 …) is a different token sequence and
#    can only ever hit when its pronunciation is written into keywords.txt.
# Layer 1 writes those near-homophone pronunciations next to the wake word; the
# ASR fallback compares pinyin instead of characters, so a tone slip (七/欺/其)
# still wakes the pet even though the KWS token sequence differs.
INITIALS = (
    "zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k",
    "h", "j", "q", "x", "r", "z", "c", "s", "y", "w",
)
# Pairs the acoustic model actually confuses; checked in both directions.
NEAR_INITIALS = (
    ("zh", "z"), ("ch", "c"), ("sh", "s"), ("n", "l"), ("r", "l"), ("f", "h"),
    ("b", "p"), ("d", "t"), ("g", "k"), ("j", "q"), ("z", "c"), ("zh", "ch"),
)
NEAR_FINALS = (
    ("ing", "in"), ("eng", "en"), ("ang", "an"), ("iang", "ian"), ("uan", "uang"),
)
TONE_MARKS = {"\u0304": "1", "\u0301": "2", "\u030c": "3", "\u0300": "4"}
# How close a whole transcript must be to the wake word before it wakes the pet,
# and how close every single syllable must be. Tones weigh least because the
# acoustic model mishears them most often.
WAKE_SIMILARITY_THRESHOLD = 0.75
MIN_SYLLABLE_SIMILARITY = 0.35
INITIAL_WEIGHT = 0.35
FINAL_WEIGHT = 0.45
TONE_WEIGHT = 0.2
NEAR_INITIAL_SCORE = 0.5
NEAR_FINAL_SCORE = 0.6
# Keyword lines are cheap to match but each one widens what counts as the wake
# word, so the generated set stays small and single-substitution only.
MAX_KEYWORD_VARIANTS = 24
_PYPINYIN = None
_PYPINYIN_LOADED = False


def load_pypinyin():
    """Import pypinyin on demand; the fallback stays exact-match without it."""
    global _PYPINYIN, _PYPINYIN_LOADED
    if not _PYPINYIN_LOADED:
        _PYPINYIN_LOADED = True
        try:
            _PYPINYIN = importlib.import_module("pypinyin")
        except ImportError:
            LOGGER.info("pypinyin 不可用；唤醒词兜底退回逐字精确匹配。")
            _PYPINYIN = None
    return _PYPINYIN


def split_final_token(token: str) -> tuple[str, str]:
    """Split a ppinyin final such as `uì` into (sound, tone). Tone 5 = no mark."""
    tone = "5"
    letters = []
    for char in unicodedata.normalize("NFD", token):
        if char in TONE_MARKS:
            tone = TONE_MARKS[char]
        else:
            letters.append(char)
    sound = unicodedata.normalize("NFC", "".join(letters)).lower().replace("v", "ü")
    return sound, tone


def tone3_parts(syllable: str) -> tuple[str, str, str]:
    """Split a TONE3 syllable such as `ling2` into (initial, sound, tone)."""
    tone = "5"
    if syllable and syllable[-1] in "12345":
        tone = syllable[-1]
        syllable = syllable[:-1]
    sound = syllable.lower().replace("v", "ü").replace("u:", "ü")
    for initial in INITIALS:
        if sound.startswith(initial) and len(sound) > len(initial):
            return initial, sound[len(initial) :], tone
    return "", sound, tone


def pinyin_parts(text: str) -> tuple[tuple[str, str, str], ...] | None:
    """Pinyin syllables of `text`, or None when pypinyin is unavailable."""
    pypinyin = load_pypinyin()
    if pypinyin is None or not text:
        return None
    syllables = pypinyin.lazy_pinyin(text, style=pypinyin.Style.TONE3)
    if not syllables:
        return None
    return tuple(tone3_parts(syllable) for syllable in syllables)


def near_pair(left: str, right: str, pairs) -> bool:
    return (left, right) in pairs or (right, left) in pairs


def competing_side(value: str, pairs) -> str | None:
    """The confusable counterpart of `value` in one of `pairs`, if any."""
    for left, right in pairs:
        if value == left:
            return right
        if value == right:
            return left
    return None


def syllable_similarity(
    heard: tuple[str, str, str], wanted: tuple[str, str, str]
) -> float:
    """How much two pinyin syllables have in common, 0.0–1.0."""
    heard_initial, heard_sound, heard_tone = heard
    wanted_initial, wanted_sound, wanted_tone = wanted
    if heard_initial == wanted_initial:
        initial = 1.0
    elif near_pair(heard_initial, wanted_initial, NEAR_INITIALS):
        initial = NEAR_INITIAL_SCORE
    else:
        initial = 0.0
    if heard_sound == wanted_sound:
        final = 1.0
    elif near_pair(heard_sound, wanted_sound, NEAR_FINALS):
        final = NEAR_FINAL_SCORE
    else:
        final = 0.0
    if initial == 0.0 and final == 0.0:
        # Sharing a tone alone is no evidence of the same syllable.
        return 0.0
    tone = 1.0 if heard_tone == wanted_tone else 0.0
    return INITIAL_WEIGHT * initial + FINAL_WEIGHT * final + TONE_WEIGHT * tone


def wake_word_similarity(text: str, wake_word: str) -> float | None:
    """Pinyin similarity of a transcript to the wake word, or None if not comparable.

    Only whole utterances are compared, so a wake word buried inside a longer
    sentence stays a question rather than a wake-up.
    """
    heard = pinyin_parts(text)
    wanted = pinyin_parts(wake_word)
    if heard is None or wanted is None or len(heard) != len(wanted):
        return None
    scores = [
        syllable_similarity(heard_syllable, wanted_syllable)
        for heard_syllable, wanted_syllable in zip(heard, wanted)
    ]
    if min(scores) < MIN_SYLLABLE_SIMILARITY:
        return None
    return sum(scores) / len(scores)


def is_wake_word_transcript(text: str, wake_word: str) -> bool:
    spoken = text.strip().strip(" \t\r\n，。！？!?、,.；;:：")
    if spoken == wake_word:
        return True
    similarity = wake_word_similarity(spoken, wake_word)
    if similarity is None:
        return False
    LOGGER.debug("Wake-word pinyin similarity %.2f for transcript: %s", similarity, spoken)
    return similarity >= WAKE_SIMILARITY_THRESHOLD


def encode_wake_word(
    wake_word: str, tokens_path: str | Path, encoder=None
) -> list[str]:
    if not is_valid_wake_word(wake_word):
        raise ValueError("wake_word_invalid")
    if encoder is None:
        from sherpa_onnx import text2token

        encoder = text2token
    encoded = encoder([wake_word], tokens=str(tokens_path), tokens_type="ppinyin")
    if not encoded or not encoded[0]:
        raise ValueError("wake_word_encoding_failed")
    return list(encoded[0])


def load_keyword_vocabulary(
    tokens_path: Path,
) -> tuple[frozenset[str], dict[str, tuple[str, str]]]:
    """Initials and (sound, tone) of every pinyin token in the KWS token table."""
    initials: set[str] = set()
    finals: dict[str, tuple[str, str]] = {}
    for line in Path(tokens_path).read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) != 2 or not parts[1].isdigit():
            continue
        token = parts[0]
        if token in INITIALS:
            initials.add(token)
        elif token.isalpha():
            # English tokens (AA0) and special tokens (<blk>) cannot be pinyin.
            finals[token] = split_final_token(token)
    return frozenset(initials), finals


def split_keyword_syllables(
    tokens: list[str], initials: frozenset[str], finals: dict[str, tuple[str, str]]
) -> list[tuple[str, str]] | None:
    """Group a keyword's tokens as (initial, final) pairs, or None if unknown."""
    syllables: list[tuple[str, str]] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in initials:
            if index + 1 >= len(tokens) or tokens[index + 1] not in finals:
                return None
            syllables.append((token, tokens[index + 1]))
            index += 2
        elif token in finals:
            syllables.append(("", token))
            index += 1
        else:
            return None
    return syllables


def keyword_variants(
    tokens: list[str], tokens_path: Path, limit: int = MAX_KEYWORD_VARIANTS
) -> list[tuple[str, ...]]:
    """Near-homophone pronunciations of the wake word for keywords.txt.

    Each variant swaps exactly one syllable's initial or final for a sound the
    model confuses, so one misheard syllable still lands on a keyword line.
    """
    try:
        initials, finals = load_keyword_vocabulary(tokens_path)
    except OSError:
        return []
    syllables = split_keyword_syllables(tokens, initials, finals)
    if syllables is None:
        return []
    by_sound = {(sound, tone): token for token, (sound, tone) in finals.items()}
    base = tuple(tokens)
    variants: list[tuple[str, ...]] = []
    for position, (initial, final) in enumerate(syllables):
        sound, tone = finals[final]
        replacements: list[tuple[str, str]] = []
        near_initial = competing_side(initial, NEAR_INITIALS)
        if near_initial is not None:
            replacements.append((near_initial, final))
        near_final = competing_side(sound, NEAR_FINALS)
        if near_final is not None:
            # Keep the tone: a tone slip is the ASR fallback's job, not the KWS's.
            alternative = by_sound.get((near_final, tone))
            if alternative is not None:
                replacements.append((initial, alternative))
        for new_initial, new_final in replacements:
            modified = list(syllables)
            modified[position] = (new_initial, new_final)
            flat: list[str] = []
            for part_initial, part_final in modified:
                if part_initial:
                    flat.append(part_initial)
                flat.append(part_final)
            variant = tuple(flat)
            if variant != base and variant not in variants:
                variants.append(variant)
                if len(variants) >= limit:
                    return variants
    return variants


def build_keyword_line(wake_word: str, tokens_path: str, encoder=None) -> str:
    tokens = encode_wake_word(wake_word, tokens_path, encoder)
    return f"{' '.join(tokens)} @{wake_word}"


def build_keyword_lines(
    wake_word: str,
    tokens_path: str | Path,
    encoder=None,
    limit: int = MAX_KEYWORD_VARIANTS,
) -> list[str]:
    """The wake word plus its near-homophone variants, one keyword line each."""
    tokens = encode_wake_word(wake_word, tokens_path, encoder)
    lines = [f"{' '.join(tokens)} @{wake_word}"]
    variants = keyword_variants(tokens, Path(tokens_path), limit)
    for index, variant in enumerate(variants, start=1):
        lines.append(f"{' '.join(variant)} @{wake_word}#{index}")
    return lines


def write_keyword_file(
    wake_word: str, tokens_path: Path, destination: Path, encoder=None
) -> None:
    lines = build_keyword_lines(wake_word, tokens_path, encoder)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")


def keyword_from_result(result) -> str:
    """The matched keyword label of a spotter result.

    sherpa-onnx returns a plain string here (2.x); older builds handed back an
    object with a `keyword` field, and both shapes must keep working.
    """
    if isinstance(result, str):
        return result.strip()
    return str(getattr(result, "keyword", "")).strip()


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
        self.barge_hinted = False
        self.barge_hint_at = 0.0
        self.barge_committed = False
        self.barge_checked_at = 0.0
        self.barge_evidence = 0
        self.barge_evidence_frames = 0
        self.user_speech = False
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
            self._feed_listening(samples, current_time)
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
            if self.playing_text:
                # The user spoke over a narration from another client. It is an
                # interruption: stop the line, and answer an actual question
                # without making the user repeat the wake word.
                LOGGER.info("Spoke over a narration: %s", text)
                self.emit({"type": "stop_playback", "reason": "narration"})
                continuation = narration_continuation(text, self.playing_text)
                self._settle(now)
                if continuation:
                    self.utterance_id += 1
                    self.emit(
                        {
                            "type": "transcript",
                            "id": self.utterance_id,
                            "text": continuation,
                            "barge_in": True,
                        }
                    )
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

    def _feed_listening(self, samples, current_time: float) -> None:
        """Wake-word listening. It stays a full-duplex listener while a line from
        another client is playing, so the user can always talk over it."""
        self.debug_stream.accept_waveform(SAMPLE_RATE, samples)
        while self.recognizer.is_ready(self.debug_stream):
            self.recognizer.decode_stream(self.debug_stream)
        if self.recognizer.is_endpoint(self.debug_stream):
            text = self.recognizer.get_result(self.debug_stream).strip()
            self.recognizer.reset(self.debug_stream)
            if text:
                wake_match = is_wake_word_transcript(text, self.wake_word)
                LOGGER.info(
                    "ASR wake-listening transcript: %s; wake_match=%s",
                    text,
                    wake_match,
                )
                self.emit({"type": "debug_transcript", "text": text})
                if wake_match:
                    self._begin_wake_acknowledgment(current_time)
                    return
                if self.playing_text and self._wants_narration_barge_in(text):
                    continuation = narration_continuation(text, self.playing_text)
                    LOGGER.info("Spoke over a narration: %s", text)
                    self.emit({"type": "stop_playback", "reason": "narration"})
                    self._settle(current_time)
                    if continuation:
                        self.utterance_id += 1
                        self._extend_awake(current_time)
                        self.emit(
                            {
                                "type": "transcript",
                                "id": self.utterance_id,
                                "text": continuation,
                                "barge_in": True,
                            }
                        )
                    return

        self.keyword_stream.accept_waveform(SAMPLE_RATE, samples)
        while self.keyword_spotter.is_ready(self.keyword_stream):
            self.keyword_spotter.decode_stream(self.keyword_stream)
            keyword = keyword_from_result(
                self.keyword_spotter.get_result(self.keyword_stream)
            )
            if keyword:
                LOGGER.info("KWS matched wake phrase: %s", keyword)
                self.emit({"type": "debug_keyword", "text": keyword})
                self._begin_wake_acknowledgment(current_time)
                return

    def _wants_narration_barge_in(self, text: str) -> bool:
        """Decide whether speech heard over a narration should stop it."""
        if barge_evidence(text, self.playing_text) != strip_interrupt_phrases(text):
            return False
        if is_interrupt_phrase(text):
            return True
        if is_narration_question(text):
            return True
        # Speech that grows while the narrator is still talking is the user, not
        # a misreading of the line; a few characters are not worth stopping for.
        enough = len(spoken_text(strip_interrupt_phrases(text))) >= BARGE_COMMIT_CHARS
        if not enough:
            return False
        if len(spoken_text(text)) > len(self.user_speech):
            self.user_speech = spoken_text(text)
            return False
        return True

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
            self.barge_hinted = False
            self.barge_hint_at = 0.0
            self.barge_committed = False
            self.barge_checked_at = 0.0
            self._forget_hint()
            partial = ""
            if self.barge_stream is not None:
                partial = self.recognizer.get_result(self.barge_stream).strip()
            if self.barge_stream is None:
                self.barge_stream = self.recognizer.create_stream()
            elif not partial:
                self.recognizer.reset(self.barge_stream)
            # A live partial means the user started talking into the window
            # before the answer became audible. Keep it: resetting here would
            # throw away the beginning of the question they are still saying.
            return
        if self.state in {"listening", "recognizing", "settle", "conversing"}:
            # A line from another client (a narration, a spirit event). The user
            # did not ask for this one, so keep listening and let them talk over
            # it; whatever ends is settled as usual.
            self.user_speech = False
            if self.state == "listening":
                self.keyword_spotter.reset_stream(self.keyword_stream)

    def spoken(self, now: float | None = None) -> None:
        """The app finished (or interrupted) the line it was playing."""
        self.playing_text = ""
        self.paused_for_playback = False
        self.pause_deadline = 0.0
        if self.state == "recognizing":
            self.barge_stream = None
            self.recognition_guard_until = (
                now if now is not None else time.monotonic()
            ) + SETTLE_SECONDS
        elif self.state == "responding":
            if self.awaiting_new_answer:
                self.barge_stream = None
            elif self.barge_committed:
                # The user talked over the pet: the playback stopped, but the
                # barge stream stays open so the rest of the question still lands.
                self.barge_hinted = False
            else:
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
            if self.barge_committed:
                # The page saw the playback stop because the user cut it off, not
                # because the answer finished. The same stream is still listening
                # for the rest of that question.
                return
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

    def _clear_barge(self) -> None:
        """Forget everything about the interruption of the line that just ended."""
        self.barge_stream = None
        self.playing_text = ""
        self.barge_hinted = False
        self.barge_hint_at = 0.0
        self.barge_committed = False
        self.barge_checked_at = 0.0
        self._forget_hint()

    def _listen(self) -> None:
        if self.recognition_stream is not None:
            self.recognizer.reset(self.recognition_stream)
            self.recognition_stream = None
        self._clear_barge()
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
        self._clear_barge()
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
        self._clear_barge()
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
        self._clear_barge()
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
        if current_time >= self.responding_deadline:
            self._settle(now)
            return
        if self.barge_stream is None:
            # Nothing is audible yet: the answer is still being generated or
            # synthesized. Keep listening so the user can take the turn back
            # instead of talking into a closed microphone for the whole wait.
            self.barge_stream = self.recognizer.create_stream()
            self.barge_checked_at = 0.0
        self.barge_stream.accept_waveform(SAMPLE_RATE, samples)
        while self.recognizer.is_ready(self.barge_stream):
            self.recognizer.decode_stream(self.barge_stream)
        self._check_barge_partial(current_time)
        if not self.recognizer.is_endpoint(self.barge_stream):
            return
        text = self.recognizer.get_result(self.barge_stream).strip()
        self.recognizer.reset(self.barge_stream)
        self._finish_barge(text, current_time)

    def _check_barge_partial(self, current_time: float) -> None:
        """Duck, then stop from the partial hypothesis instead of the endpoint.

        Waiting for `is_endpoint` means waiting for trailing silence; a partial
        arrives a few hundred milliseconds after the user starts talking. A duck
        is only sent after the user's words actually grew over several checks.
        """
        if self.barge_committed:
            return
        if current_time - self.barge_checked_at < BARGE_CHECK_SECONDS:
            return
        self.barge_checked_at = current_time
        partial = self.recognizer.get_result(self.barge_stream).strip()
        if not partial:
            self._forget_hint()
            return
        evidence = spoken_text(barge_evidence(partial, self.playing_text))
        if not evidence:
            self._forget_hint()
            return
        if starts_with_command(evidence):
            self._commit_barge(current_time, evidence, "command")
            return
        if is_interrupt_phrase(evidence) and len(evidence) <= 6:
            self._commit_barge(current_time, evidence, "interrupt phrase")
            return
        if is_backchannel(evidence):
            self._forget_hint()
            return
        if len(evidence) >= BARGE_COMMIT_CHARS:
            self._commit_barge(current_time, evidence, "partial transcript")
            return
        if len(evidence) < BARGE_HINT_CHARS:
            self._forget_hint()
            return
        if len(evidence) > self.barge_evidence:
            # The reading is still growing, so it is live speech rather than a
            # one-off misreading of the pet's own voice.
            self.barge_evidence = len(evidence)
            self.barge_evidence_frames = 1
            return
        self.barge_evidence_frames += 1
        if self.barge_evidence_frames < BARGE_HINT_EVIDENCE_FRAMES:
            return
        self._duck(current_time, evidence)

    def _forget_hint(self) -> None:
        self.barge_evidence = 0
        self.barge_evidence_frames = 0

    def _duck(self, current_time: float, evidence: str) -> None:
        if not self.playing_text:
            return
        if (
            self.barge_hinted
            and current_time - self.barge_hint_at < BARGE_HINT_REFRESH_SECONDS
        ):
            return
        self.barge_hinted = True
        self.barge_hint_at = current_time
        LOGGER.info("Ducking the voice while the user starts talking: %s", evidence)
        self.emit({"type": "duck"})

    def _commit_barge(self, current_time: float, evidence: str, reason: str) -> None:
        if self.barge_committed:
            return
        self.barge_committed = True
        self._extend_awake(current_time)
        LOGGER.info("Stopping playback from the %s: %s", reason, evidence)
        self.emit({"type": "stop_playback"})

    def _finish_barge(self, text: str, current_time: float) -> None:
        """Endpoint of a barge-in utterance: keep it the question, or let go."""
        text = text.strip()
        if not text:
            if self.barge_committed:
                # A bare "嗯" that was mistaken for a hint. The user is not
                # asking anything, so never stop the answer for it.
                self.emit({"type": "resume_playback"})
                self._settle(current_time)
            return
        separated_from_echo = False
        if self.playing_text and is_echo_of(text, self.playing_text):
            text = non_echo_text(text, self.playing_text)
            if not text:
                LOGGER.info("Ignoring the pet's own voice while it speaks.")
                if self.barge_committed:
                    self.emit({"type": "resume_playback"})
                    self._settle(current_time)
                return
            separated_from_echo = True
            LOGGER.info("Separated speech from playback echo: %s", text)
        if is_wake_word_transcript(text, self.wake_word):
            LOGGER.info("Wake word heard while the pet speaks: %s", text)
            self._begin_wake_acknowledgment(current_time)
            return
        if is_backchannel(text) and not self.barge_committed:
            # "嗯" / "对对": the user is following along, not taking the floor.
            LOGGER.info("Backchannel while the pet speaks: %s", text)
            return
        if is_interrupt_phrase(text) and separated_from_echo:
            # Mixed with the pet's own voice: stop, but do not guess a question
            # out of a transcript the speaker contaminated.
            self._stop_playback(current_time, text)
            self._settle(current_time)
            return
        if is_interrupt_phrase(text) and len(spoken_text(text)) <= 6:
            self._stop_playback(current_time, text)
            if len(spoken_text(strip_interrupt_phrases(text))) < BARGE_CONTINUE_CHARS:
                self._settle(current_time)
                return
            # "等一下，那明天呢？" carries a new question after the stop phrase.
        elif self.barge_committed and len(spoken_text(text)) < BARGE_CONTINUE_CHARS:
            # The voice already stopped; a few stray characters are not a question.
            self._settle(current_time)
            return
        if len(spoken_text(text)) < MIN_BARGE_IN_CHARS:
            LOGGER.info("Ignoring a too-short barge-in candidate: %s", text)
            return
        self._accept_barge(text, current_time)

    def _stop_playback(self, current_time: float, heard: str) -> None:
        """Stop the voice once per line, however the interruption was detected."""
        if self.barge_committed:
            return
        self.barge_committed = True
        self._extend_awake(current_time)
        LOGGER.info("Interrupt phrase heard while the pet speaks: %s", heard)
        self.emit({"type": "stop_playback"})

    def _accept_barge(self, text: str, current_time: float) -> None:
        """The user took the turn: keep listening for the reply, drop the old one."""
        LOGGER.info("Barge-in accepted while the pet speaks: %s", text)
        self.utterance_id += 1
        self._extend_awake(current_time)
        self._clear_barge()
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
        self._clear_barge()
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
        keyword_lines = args.keywords.read_text(encoding="utf-8").splitlines()
        LOGGER.info(
            "Generated %s KWS keyword rule(s) for %s: %s",
            len(keyword_lines),
            args.wake_word,
            " | ".join(keyword_lines),
        )
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
