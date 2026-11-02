import logging
import tempfile
import unittest
from pathlib import Path

from voice_assistant import (
    MAX_KEYWORD_VARIANTS,
    VoiceFlow,
    barge_evidence,
    build_keyword_line,
    build_keyword_lines,
    configure_logging,
    is_acknowledgment_echo,
    is_backchannel,
    is_echo_of,
    is_echo_risky,
    is_interrupt_phrase,
    is_narration_question,
    is_wake_word_transcript,
    keyword_from_result,
    load_pypinyin,
    parse_command,
    split_final_token,
    starts_with_command,
    strip_interrupt_phrases,
    syllable_similarity,
    tone3_parts,
    wake_word_similarity,
    write_keyword_file,
)

PYPINYIN_AVAILABLE = load_pypinyin() is not None

# A miniature pinyin token table: enough initials/finals to build variants.
FAKE_TOKENS = "\n".join(
    [
        "<blk> 0",
        "<sos/eos> 1",
        "AA0 2",
        "q 3",
        "j 4",
        "l 5",
        "n 6",
        "ī 7",
        "íng 8",
        "ín 9",
        "ǚ 10",
        "ér 11",
    ]
)


class FakeKeywordStream:
    def __init__(self) -> None:
        self.samples = []
        self.ready = False
        self.endpoint = False

    def accept_waveform(self, sample_rate, samples) -> None:
        self.samples.append((sample_rate, samples))
        self.ready = True


class FakeKeywordSpotter:
    def __init__(self) -> None:
        self.stream = FakeKeywordStream()
        self.detect = False

    def create_stream(self):
        return self.stream

    def is_ready(self, stream) -> bool:
        return stream.ready

    def decode_stream(self, stream) -> None:
        stream.ready = False

    def get_result(self, _stream):
        if self.detect:
            self.detect = False
            return type("Result", (), {"keyword": "器灵"})()
        return type("Result", (), {"keyword": ""})()

    def reset_stream(self, _stream) -> None:
        pass


class FakeRecognizer:
    """One voice recognizer, many streams: each stream carries its own endpoint.

    `partials` are returned one per `get_result` call before `result`, which is
    how the streaming hypothesis looks before the utterance endpoints.
    """

    def __init__(self, result="帮我解释一下什么是闭包", partials=None) -> None:
        self.streams = []
        self.result = result
        self.partials = list(partials or [])

    def create_stream(self):
        stream = FakeKeywordStream()
        self.streams.append(stream)
        return stream

    def is_ready(self, stream) -> bool:
        return stream.ready

    def decode_stream(self, stream) -> None:
        stream.ready = False

    def is_endpoint(self, stream) -> bool:
        return stream.endpoint

    def get_result(self, _stream) -> str:
        if self.partials:
            return self.partials.pop(0)
        return self.result

    def reset(self, stream) -> None:
        stream.endpoint = False

    @property
    def endpoint(self) -> bool:
        return any(stream.endpoint for stream in self.streams)

    @endpoint.setter
    def endpoint(self, value: bool) -> None:
        for stream in self.streams:
            stream.endpoint = value


class VoiceFlowTests(unittest.TestCase):
    def test_builds_keyword_tokens_for_a_custom_wake_phrase(self):
        calls = []

        def encode(phrases, **options):
            calls.append((phrases, options))
            return [["x", "iǎo", "zh", "ù", "sh", "ǒu"]]

        line = build_keyword_line("小助手", "tokens.txt", encode)

        self.assertEqual(line, "x iǎo zh ù sh ǒu @小助手")
        self.assertEqual(
            calls,
            [(["小助手"], {"tokens": "tokens.txt", "tokens_type": "ppinyin"})],
        )

    def test_rejects_unsupported_custom_wake_phrase(self):
        with self.assertRaisesRegex(ValueError, "wake_word_invalid"):
            build_keyword_line("小助手123", "tokens.txt", lambda *_args, **_kwargs: [])

    def test_speech_is_exposed_for_debugging_before_the_wake_word(self):
        events = []
        kws = FakeKeywordSpotter()
        asr = FakeRecognizer()
        flow = VoiceFlow(kws, asr, events.append, "器灵")

        flow.start()
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=1.0)

        self.assertEqual(
            events,
            [
                {"type": "state", "state": "listening"},
                {"type": "debug_transcript", "text": "帮我解释一下什么是闭包"},
            ],
        )
        self.assertEqual(flow.state, "listening")

    def test_exact_local_transcript_of_wake_word_triggers_acknowledgment(self):
        events = []
        kws = FakeKeywordSpotter()
        asr = FakeRecognizer(" 七零七零。 ")
        flow = VoiceFlow(kws, asr, events.append, "七零七零")

        flow.start()
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=1.0)

        self.assertEqual(flow.state, "wake_acknowledgment")
        self.assertEqual(events[-1], {"type": "state", "state": "wake_acknowledgment"})

    def test_wake_word_inside_a_longer_transcript_does_not_trigger(self):
        events = []
        kws = FakeKeywordSpotter()
        asr = FakeRecognizer("我刚才说了七零七零")
        flow = VoiceFlow(kws, asr, events.append, "七零七零")

        flow.start()
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=1.0)

        self.assertEqual(flow.state, "listening")

    def test_wake_requires_acknowledgment_before_recognizing_the_request(self):
        events = []
        kws = FakeKeywordSpotter()
        asr = FakeRecognizer()
        flow = VoiceFlow(kws, asr, events.append, "器灵")

        flow.start()
        kws.detect = True
        flow.feed([0.1] * 1600, now=1.0)
        asr.endpoint = True
        flow.feed([0.2] * 1600, now=2.0)

        self.assertEqual(flow.state, "wake_acknowledgment")
        self.assertEqual(
            events,
            [
                {"type": "state", "state": "listening"},
                {"type": "debug_keyword", "text": "器灵"},
                {"type": "state", "state": "wake_acknowledgment"},
            ],
        )

        flow.begin_recognition(now=3.0)
        asr.endpoint = True
        flow.feed([0.3] * 1600, now=4.0)

        self.assertEqual(
            [event["type"] for event in events],
            ["state", "debug_keyword", "state", "state", "state", "transcript"],
        )
        self.assertEqual(events[0], {"type": "state", "state": "listening"})
        self.assertEqual(events[1], {"type": "debug_keyword", "text": "器灵"})
        self.assertEqual(events[2], {"type": "state", "state": "wake_acknowledgment"})
        self.assertEqual(events[3], {"type": "state", "state": "recognizing"})
        self.assertEqual(events[4], {"type": "state", "state": "responding"})
        self.assertEqual(events[5]["text"], "帮我解释一下什么是闭包")
        self.assertTrue(
            all("audio" not in event and "samples" not in event for event in events)
        )

    def test_a_new_question_can_take_the_turn_before_the_answer_is_audible(self):
        events = []
        kws = FakeKeywordSpotter()
        asr = FakeRecognizer()
        flow = VoiceFlow(kws, asr, events.append, "器灵")

        flow.start()
        kws.detect = True
        flow.feed([0.1] * 1600, now=1.0)
        flow.begin_recognition(now=2.0)
        asr.endpoint = True
        flow.feed([0.2] * 1600, now=3.0)
        self.assertEqual(flow.state, "responding")

        # The answer is still being generated or synthesized, so nothing is
        # playing yet. Talking into that window must take the turn back instead
        # of hitting a closed microphone.
        events.clear()
        asr.result = "那明天天气呢"
        asr.endpoint = False
        flow.feed([0.3] * 1600, now=4.0)
        asr.endpoint = True
        flow.feed([0.3] * 1600, now=4.3)

        self.assertIn({"type": "stop_playback"}, events)
        barge = [event for event in events if event.get("barge_in")]
        self.assertEqual(len(barge), 1)
        self.assertEqual(barge[0]["text"], "那明天天气呢")
        self.assertEqual(flow.state, "responding")
        self.assertTrue(flow.awaiting_new_answer)

    def test_the_wake_acknowledgment_heard_back_is_not_a_question(self):
        events = []
        kws = FakeKeywordSpotter()
        asr = FakeRecognizer("我在，请说。")
        flow = VoiceFlow(kws, asr, events.append, "器灵")

        flow.start()
        kws.detect = True
        flow.feed([0.1] * 1600, now=1.0)
        flow.begin_recognition(now=2.0)
        asr.endpoint = True
        flow.feed([0.2] * 1600, now=2.4)

        self.assertEqual(flow.state, "conversing")
        self.assertTrue(all(event["type"] != "transcript" for event in events))

    def test_acknowledgment_echo_matching_ignores_punctuation(self):
        self.assertTrue(is_acknowledgment_echo("说。"))
        self.assertTrue(is_acknowledgment_echo(" 我在，请说！"))
        self.assertFalse(is_acknowledgment_echo("今天天气怎么样"))
        self.assertFalse(is_acknowledgment_echo("，"))

    def test_the_conversation_resumes_only_after_the_speaker_tail_settles(self):
        events = []
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment(now=1.0)
        flow.begin_recognition(now=1.2)
        flow.recognizer.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        self.assertEqual(flow.state, "responding")

        flow.listen(now=3.0)
        self.assertEqual(flow.state, "settle")
        flow.feed([0.1] * 1600, now=3.2)
        self.assertEqual(flow.state, "settle")

        flow.feed([0.1] * 1600, now=3.5)
        self.assertEqual(flow.state, "conversing")
        self.assertEqual(events[-1], {"type": "state", "state": "conversing"})

    def test_listen_starts_the_question_after_the_wake_acknowledgment(self):
        events = []
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.speak("我在，请说。")
        flow.spoken(now=2.0)
        self.assertEqual(flow.state, "wake_acknowledgment")

        flow.listen(now=2.5)
        self.assertEqual(flow.state, "recognizing")
        self.assertGreater(flow.recognition_guard_until, 2.5)

    def test_the_user_can_talk_over_another_client_line_while_listening(self):
        events = []
        kws = FakeKeywordSpotter()
        # The user's first words are not the wake word, so KWS stays silent.
        asr = FakeRecognizer("识局送来的一句解说")  # only the pet's own voice
        flow = VoiceFlow(kws, asr, events.append, "七零七零")

        flow.start()
        flow.speak("识局送来的一句解说。")
        # The recognizer first hears a reading of the pet's own line, then the
        # user's question. The listener resets its stream after every reading.
        asr.endpoint = True
        asr.partials = ["识局送来的一句解说"]
        flow.feed([0.1] * 1600, now=1.0)
        self.assertEqual(flow.state, "listening")
        asr.partials = ["你能给我讲个故事吗"]
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=1.1)
        recent = [event for event in events if event["type"] != "debug_transcript"]
        self.assertIn({"type": "stop_playback", "reason": "narration"}, recent)
        self.assertEqual(
            recent[-1],
            {"type": "transcript", "id": 1, "text": "你能给我讲个故事吗", "barge_in": True},
        )
        # The pet owes an answer now, and that answer must stay interruptible.
        self.assertEqual(flow.state, "responding")
        self.assertTrue(flow.awaiting_new_answer)

        # Once that answer has played, the conversation window keeps the mic open
        # so the user can follow up without repeating the wake word.
        flow.speak("好的，我来讲讲。")
        flow.spoken(now=2.9)
        flow.feed([0.1] * 1600, now=3.4)
        self.assertEqual(flow.state, "conversing")

    def test_a_wake_word_still_wins_over_a_narrated_line(self):
        events = []
        kws = FakeKeywordSpotter()
        asr = FakeRecognizer()
        flow = VoiceFlow(kws, asr, events.append, "器灵")

        flow.start()
        flow.speak("识局送来的一句解说。")
        asr.result = "器灵"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=1.0)

        self.assertEqual(flow.state, "wake_acknowledgment")
        self.assertIn({"type": "stop_playback"}, events)
        self.assertNotIn({"type": "stop_playback", "reason": "narration"}, events)

    def test_small_talk_over_a_narration_does_not_stop_it(self):
        events = []
        asr = FakeRecognizer("我觉得这个")
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow.speak("识局送来的一句解说。")
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=1.0)

        self.assertEqual(flow.state, "listening")
        self.assertEqual([event for event in events if event["type"] == "stop_playback"], [])

    def test_a_code_heavy_narration_only_obeys_an_explicit_command(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow.speak("useState 是 React 的 Hook，setCount 每次返回新的函数。")

        # A misread echo that happens to look like a question must not stop it.
        asr.result = "什么"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=1.0)
        self.assertEqual(flow.state, "listening")
        self.assertEqual([event for event in events if event["type"] == "stop_playback"], [])

        asr.result = "停下，这个函数做什么"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=1.4)
        self.assertIn({"type": "stop_playback", "reason": "narration"}, events)
        self.assertEqual(flow.state, "settle")

    def test_a_plain_narration_can_still_be_interrupted_by_a_question(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow.speak("这一段先解释闭包和捕获变量的关系。")
        asr.result = "这个函数做什么"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=1.0)

        self.assertIn({"type": "stop_playback", "reason": "narration"}, events)
        self.assertEqual(flow.state, "responding")

    def test_a_narration_cannot_wake_the_pet_by_mentioning_the_wake_word(self):
        events = []
        kws = FakeKeywordSpotter()
        flow = VoiceFlow(kws, FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow.speak("器灵这个名字来自一句诗。")
        kws.detect = True
        flow.feed([0.1] * 1600, now=1.0)

        # The keyword spotter matches anywhere in the stream, so feeding it the
        # narration would wake the pet on its own line.
        self.assertEqual(flow.state, "listening")
        self.assertEqual(len(events), 1, events)

        flow.spoken(now=1.5)
        flow.feed([0.1] * 1600, now=2.0)
        flow.feed([0.1] * 1600, now=2.1)
        self.assertEqual(flow.state, "wake_acknowledgment")

    def test_the_wake_word_still_works_over_a_narration_that_does_not_say_it(self):
        events = []
        kws = FakeKeywordSpotter()
        flow = VoiceFlow(kws, FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow.speak("这一段先解释闭包和捕获变量的关系。")
        kws.detect = True
        flow.feed([0.1] * 1600, now=1.0)

        self.assertEqual(flow.state, "wake_acknowledgment")
        self.assertIn({"type": "stop_playback"}, events)

    def test_a_question_during_a_spoken_answer_interrupts_without_the_echo(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        flow.speak("今天天气不错，适合出门散步。")

        asr.result = "你能给我讲个故事吗"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)

        # The endpoint transcript becomes the next question; the page stops the
        # audio when it receives it, so no separate stop event is needed here.
        barge = [event for event in events if event.get("barge_in")]
        self.assertEqual(len(barge), 1)
        self.assertEqual(barge[0]["text"], "你能给我讲个故事吗")
        self.assertEqual(flow.state, "responding")
        self.assertTrue(flow.awaiting_new_answer)

    def test_the_pet_own_answer_is_ignored_while_it_speaks(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        self.assertEqual(flow.state, "responding")

        flow.speak("今天天气不错，适合出门散步。")
        asr.result = "今天天气不错适合出门散步"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)

        self.assertEqual(flow.state, "responding")
        self.assertEqual(
            [event for event in events if event.get("barge_in")],
            [],
        )

    def test_the_user_can_barge_in_while_the_pet_speaks(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        flow.speak("今天天气不错，适合出门散步。")

        asr.result = "等一下我想问别的"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)

        barge = [event for event in events if event.get("barge_in")]
        self.assertEqual(len(barge), 1)
        self.assertEqual(barge[0]["text"], "等一下我想问别的")
        self.assertEqual(flow.state, "responding")
        self.assertTrue(flow.awaiting_new_answer)

        # Interrupting playback must not re-arm the wake word: a new answer follows.
        flow.spoken(now=3.2)
        self.assertEqual(flow.state, "responding")

        flow.speak("好的，你想问什么？")
        asr.result = "好的你想问什么"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.5)
        self.assertEqual(flow.state, "responding")

        flow.spoken(now=4.0)
        self.assertEqual(flow.state, "settle")

    def test_the_wake_word_interrupts_speaking_and_restarts_the_acknowledgment(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        flow.speak("今天天气不错。")

        asr.result = "器灵"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)

        self.assertEqual(flow.state, "wake_acknowledgment")
        self.assertEqual(events[-1], {"type": "state", "state": "wake_acknowledgment"})

    def test_an_interrupt_phrase_stops_playback_without_asking_the_model(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        flow.speak("今天天气不错。")

        asr.result = "停下"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)

        self.assertIn({"type": "stop_playback"}, events)
        self.assertEqual(flow.state, "settle")
        self.assertEqual([event for event in events if event.get("barge_in")], [])

    def test_interrupt_phrase_mixed_with_the_pet_voice_still_stops_playback(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        flow.speak("一只小兔它一直寻找回家的路它遇到了萤火虫。")

        asr.result = "一只小兔可以停了别讲了它一直寻找回家的路它遇到了你别讲了萤火虫"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)

        self.assertIn({"type": "stop_playback"}, events)
        self.assertEqual(flow.state, "settle")

    def test_question_mixed_with_the_pet_voice_is_forwarded_without_the_echo(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        flow.speak("有一天一只小兔子在森林里寻找回家的路它遇到了萤火虫。")

        asr.result = "有一天一只小兔子你能不能给我讲个故事在森林里寻找回家的路它遇到了萤火虫"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)

        barge = [event for event in events if event.get("barge_in")]
        self.assertEqual(len(barge), 1)
        self.assertEqual(barge[0]["text"], "你能不能给我讲个故事")

    def _speaking_flow(
        self,
        result="你能给我讲个故事吗",
        partials=None,
        barge="",
        line="今天天气不错，适合出门散步。",
    ):
        events = []

        class ScriptedRecognizer(FakeRecognizer):
            """A streaming recognizer for barge-in tests.

            Each decode returns the next reading from `queue` on whichever stream
            the flow asks, the way the real recognizer would report whatever is
            in the barge stream right now. `result` is only ever returned as a
            final transcript at an endpoint, and endpoints stay off unless the
            test turns them on.
            """

            def decode_stream(self, stream):
                stream.ready = False

            def get_result(self, stream):
                if stream.endpoint:
                    return self.result
                if self.queue:
                    return self.queue.pop(0)
                return ""

            def reset(self, stream):
                stream.endpoint = False

        asr = ScriptedRecognizer(result)
        asr.queue = []
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")
        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        # The silence guard before a question means the recognizer does not
        # decode the very first frame of the request.
        asr.endpoint = True
        asr.queue = [result]
        flow.feed([0.1] * 1600, now=2.0)
        self.assertEqual(flow.state, "responding")
        # From here on nothing is final; only the streaming readings arrive.
        asr.endpoint = False
        asr.queue = []
        flow.speak(line)
        asr.queue = ([barge] if barge else []) + list(partials or [])
        return flow, asr, events

    def _stop_signals(self, events):
        return [event for event in events if event["type"] in {"duck", "stop_playback"}]

    def test_echo_risk_follows_code_in_the_line(self):
        self.assertTrue(is_echo_risky("useState 是 React 的 Hook。"))
        self.assertTrue(is_echo_risky("调用 setCount 之后组件会重新渲染。"))
        # Even a short English term is enough to make its echo untrustworthy.
        self.assertTrue(is_echo_risky("这是 VS Code 的选区。"))
        self.assertFalse(is_echo_risky("今天天气不错，适合出门散步。"))
        self.assertFalse(is_echo_risky("这一步走的是马后炮，红方略优。"))

    def test_a_code_heavy_line_is_not_stopped_by_its_own_playback(self):
        # Reading "useState / React / setCount" out loud makes the Chinese
        # recognizer produce characters that are not in the line at all, so its
        # own echo looks like a person talking.
        flow, asr, events = self._speaking_flow(
            line="useState 是 React 的 Hook，setCount 每次返回新的函数。",
            partials=["尤塞特是瑞克特的胡克", "尤塞特是瑞克特的胡克", "尤塞特是瑞克特的胡克"],
        )

        for now in (2.1, 2.3, 2.5):
            flow.feed([0.1] * 1600, now=now)

        self.assertEqual(self._stop_signals(events), [])
        self.assertEqual(flow.state, "responding")

        # An explicit command still takes the floor.
        asr.queue = ["停"]
        flow.feed([0.1] * 1600, now=2.7)
        self.assertIn({"type": "stop_playback"}, events)

    def test_a_code_heavy_line_ignores_a_reading_at_the_endpoint(self):
        line = "useState 是 React 的 Hook，setCount 每次返回新的函数。"
        flow, asr, events = self._speaking_flow(line=line)

        flow._finish_barge("这个函数到底是做什么的", 2.5)
        self.assertEqual([event for event in events if event.get("barge_in")], [])
        self.assertEqual([event for event in events if event["type"] == "stop_playback"], [])
        self.assertEqual(flow.state, "responding")

        flow._finish_barge("停下", 2.6)
        self.assertIn({"type": "stop_playback"}, events)
        self.assertEqual(flow.state, "settle")

    def test_a_two_character_reading_is_not_a_question_while_the_pet_speaks(self):
        flow, asr, events = self._speaking_flow()

        flow._finish_barge("这样", 2.5)
        self.assertEqual([event for event in events if event.get("barge_in")], [])
        self.assertEqual(flow.state, "responding")

        # Four characters are enough to become the next question.
        flow._finish_barge("这个函数做什么", 2.6)
        barge = [event for event in events if event.get("barge_in")]
        self.assertEqual(len(barge), 1)
        self.assertEqual(barge[0]["text"], "这个函数做什么")

    def test_a_partial_transcript_stops_playback_before_the_endpoint(self):
        flow, asr, events = self._speaking_flow(
            partials=["你能", "你能给", "你能给我", "你能给我讲", "你能给我讲个"]
        )

        # A reading that stays four characters long across two checks takes the
        # floor without waiting for silence.
        for now in (2.1, 2.2, 2.3, 2.4, 2.5):
            flow.feed([0.1] * 1600, now=now)
        self.assertIn({"type": "stop_playback"}, events)
        self.assertTrue(flow.barge_committed)
        self.assertFalse(asr.endpoint)
        self.assertEqual([event for event in events if event.get("barge_in")], [])

    def test_a_stable_short_reading_only_ducks_the_voice(self):
        # The same two characters for several checks: quiet the voice, keep
        # listening. One check alone is never enough.
        flow, asr, events = self._speaking_flow(partials=["你能", "你能", "你能"])

        flow.feed([0.1] * 1600, now=2.1)
        self.assertNotIn({"type": "duck"}, events)
        flow.feed([0.1] * 1600, now=2.3)
        self.assertNotIn({"type": "duck"}, events)
        flow.feed([0.1] * 1600, now=2.5)

        self.assertEqual(events[-1], {"type": "duck"})
        self.assertFalse(flow.barge_committed)

    def test_a_hint_that_never_grows_backs_off_after_one_duck(self):
        flow, asr, events = self._speaking_flow(
            partials=["你能", "你能", "你能", "你能", "你能", "你能"]
        )

        for now in (2.1, 2.3, 2.5, 2.7, 2.9, 3.1):
            flow.feed([0.1] * 1600, now=now)

        self.assertEqual(len([event for event in events if event["type"] == "duck"]), 1)
        self.assertEqual(flow.state, "responding")
        self.assertEqual(
            [event for event in events if event["type"] == "stop_playback"], []
        )

    def test_a_bare_backchannel_never_stops_the_answer(self):
        flow, asr, events = self._speaking_flow(result="嗯", partials=["嗯"])

        flow.feed([0.1] * 1600, now=2.1)
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=2.5)

        self.assertEqual(self._stop_signals(events), [])
        self.assertEqual(flow.state, "responding")

    def test_backchannel_does_not_take_the_floor(self):
        flow, asr, events = self._speaking_flow(partials=["嗯", "对对", "对对对"])

        for now in (2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7):
            flow.feed([0.1] * 1600, now=now)

        self.assertFalse(flow.barge_committed)
        # A lone "嗯" that was ducked is not backchannel on its own, but the
        # longer listening noises that follow must never stop the answer.
        self.assertNotIn({"type": "stop_playback"}, events)
        self.assertEqual(flow.state, "responding")

    def test_playback_echo_is_not_an_interruption_from_a_partial(self):
        flow, asr, events = self._speaking_flow(partials=["今天天气不错"])
        emitted = len(events)

        flow.feed([0.1] * 1600, now=2.1)

        self.assertEqual(len(events), emitted)
        self.assertFalse(flow.barge_committed)

    def test_the_duck_is_refreshed_while_the_user_keeps_talking(self):
        flow, asr, events = self._speaking_flow(
            partials=["你能", "你能", "你能", "你能", "你能", "你能", "你能"]
        )

        for now in (2.1, 2.2, 2.3, 2.4, 3.3, 3.4):
            flow.feed([0.1] * 1600, now=now)

        ducks = [event for event in events if event["type"] == "duck"]
        self.assertGreaterEqual(len(ducks), 2)
        self.assertNotIn({"type": "stop_playback"}, events)

    def test_the_committed_interruption_waits_for_the_rest_of_the_question(self):
        flow, asr, events = self._speaking_flow(partials=["你能给我讲", "你能给我讲个"])

        flow.feed([0.1] * 1600, now=2.5)
        flow.feed([0.1] * 1600, now=2.7)
        self.assertIn({"type": "stop_playback"}, events)

        # The app stopped the audio: the stream must survive so the words the
        # user is still saying are not thrown away.
        flow.spoken(now=2.6)
        self.assertEqual(flow.state, "responding")
        self.assertIsNotNone(flow.barge_stream)
        self.assertEqual([event for event in events if event.get("barge_in")], [])

        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.5)

        barge = [event for event in events if event.get("barge_in")]
        self.assertEqual(len(barge), 1)
        self.assertEqual(barge[0]["text"], "你能给我讲个故事吗")
        self.assertEqual(flow.state, "responding")
        self.assertTrue(flow.awaiting_new_answer)

    def test_the_listen_request_does_not_drop_a_pending_interruption(self):
        flow, asr, events = self._speaking_flow(partials=["你能给我讲", "你能给我讲个"])

        flow.feed([0.1] * 1600, now=2.5)
        flow.feed([0.1] * 1600, now=2.7)
        self.assertIn({"type": "stop_playback"}, events)

        # The page notices the audio stopped and asks for the microphone back.
        flow.listen(now=2.7)
        self.assertEqual(flow.state, "responding")
        self.assertIsNotNone(flow.barge_stream)

        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.5)

        barge = [event for event in events if event.get("barge_in")]
        self.assertEqual(len(barge), 1)
        self.assertEqual(barge[0]["text"], "你能给我讲个故事吗")

    def test_an_intent_prefix_stops_on_the_first_words_and_keeps_the_question(self):
        flow, asr, events = self._speaking_flow(
            result="等一下那明天天气怎么样", partials=["等一下我"]
        )

        flow.feed([0.1] * 1600, now=2.1)
        self.assertIn({"type": "stop_playback"}, events)
        self.assertTrue(flow.barge_committed)

        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.5)

        barge = [event for event in events if event.get("barge_in")]
        self.assertEqual(len(barge), 1)
        self.assertEqual(barge[0]["text"], "等一下那明天天气怎么样")

    def test_a_bare_stop_command_settles_instead_of_asking_the_model(self):
        flow, asr, events = self._speaking_flow(result="停")

        # "停" is committed from the partial, then the final transcript is the
        # same words: one stop, not two.
        asr.queue = ["停"]
        flow.feed([0.1] * 1600, now=2.1)
        self.assertIn({"type": "stop_playback"}, events)

        asr.queue = []
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.5)

        self.assertEqual(
            [event for event in events if event["type"] == "stop_playback"],
            [{"type": "stop_playback"}],
        )
        self.assertEqual(flow.state, "settle")
        self.assertEqual([event for event in events if event.get("barge_in")], [])

    def test_barge_evidence_ignores_readings_of_the_pet_own_voice(self):
        played = "今天天气不错，适合出门散步。"

        # A reading of the line is echo: what is left after removing it is too
        # short to be a hint, so a misread syllable cannot duck the voice.
        self.assertEqual(barge_evidence("今天天气不错", played), "")
        self.assertNotEqual(barge_evidence("今天气天", played), "今天气天")
        self.assertLess(len(barge_evidence("今天气天", played)), 2)
        # Live speech is not stripped just because one character coincides.
        self.assertEqual(barge_evidence("你能", played), "你能")
        self.assertEqual(barge_evidence("你能", ""), "你能")
        self.assertTrue(is_backchannel("嗯嗯"))
        self.assertTrue(is_backchannel("是啊"))
        self.assertFalse(is_backchannel("嗯"))
        self.assertFalse(is_backchannel("嗯我想问"))
        self.assertFalse(is_backchannel("我想"))
        self.assertTrue(starts_with_command("别说了"))
        self.assertFalse(starts_with_command("我觉得"))
        # A line that starts with "别忘了" must not stop itself.
        self.assertFalse(starts_with_command("别忘了这段还在跑"))
        self.assertEqual(strip_interrupt_phrases("等一下，那明天呢"), "那明天呢")
        self.assertTrue(is_narration_question("这个函数为什么这样写"))
        self.assertTrue(is_narration_question("停一下，它做什么"))
        self.assertFalse(is_narration_question("我觉得是这样的吧"))
        self.assertFalse(is_narration_question("这是一句很长很长很长的问题吗"))

    def test_a_new_line_during_settle_keeps_the_microphone_on(self):
        events = []
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow.speak("第一句。")
        flow.spoken(now=1.0)
        self.assertEqual(flow.state, "settle")

        # A line from another client must not close a microphone that the user
        # may need to talk over it.
        flow.speak("第二句。")
        flow.feed([0.1] * 1600, now=2.0)
        self.assertEqual(flow.state, "listening")

        flow.spoken(now=2.5)
        flow.feed([0.1] * 1600, now=3.0)
        self.assertEqual(flow.state, "listening")

    def test_a_missing_playback_end_does_not_leave_the_microphone_off(self):
        events = []
        kws = FakeKeywordSpotter()
        flow = VoiceFlow(kws, FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow.speak("一句解说。", now=1.0)
        flow.feed([0.1] * 1600, now=2.0)
        self.assertEqual(flow.state, "listening")

        kws.detect = True
        flow.feed([0.1] * 1600, now=62.0)

        self.assertEqual(flow.state, "wake_acknowledgment")

    def test_echo_and_interrupt_helpers(self):
        self.assertTrue(
            is_echo_of(
                "我是麒麟现在听到的是播报声音视听",
                "你好，我是器灵。现在听到的是播报声音试听。",
            )
        )
        self.assertFalse(is_echo_of("等一下我想问别的", "今天天气不错，适合出门散步。"))
        self.assertTrue(is_interrupt_phrase("停一下"))
        self.assertTrue(is_interrupt_phrase("别讲了"))
        self.assertFalse(is_interrupt_phrase("今天天气不错"))

    def test_parses_json_and_plain_commands(self):
        self.assertEqual(
            parse_command('{"cmd":"speak","text":"你好"}'),
            ("speak", {"cmd": "speak", "text": "你好"}),
        )
        self.assertEqual(parse_command("spoken"), ("spoken", {}))
        self.assertIsNone(parse_command("bogus"))
        self.assertIsNone(parse_command(""))

    def test_listen_still_starts_recognition_after_the_wake_word(self):
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), lambda _event: None, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.listen(now=5.0)

        self.assertEqual(flow.state, "recognizing")

    def test_a_reply_that_never_reports_back_returns_to_the_conversation(self):
        events = []
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment(now=1.0)
        flow.begin_recognition(now=1.2)
        flow.recognizer.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        self.assertEqual(flow.state, "responding")

        flow.feed([0.1] * 1600, now=2.0 + 61.0)
        self.assertEqual(flow.state, "settle")
        flow.feed([0.1] * 1600, now=63.5)

        self.assertEqual(flow.state, "conversing")
        self.assertEqual(events[-1], {"type": "state", "state": "conversing"})

    def test_a_follow_up_question_needs_no_wake_word(self):
        events = []
        kws = FakeKeywordSpotter()
        asr = FakeRecognizer()
        flow = VoiceFlow(kws, asr, events.append, "器灵")

        flow.start()
        kws.detect = True
        flow.feed([0.1] * 1600, now=1.0)
        flow.begin_recognition(now=2.0)
        asr.endpoint = True
        flow.feed([0.2] * 1600, now=3.0)
        self.assertEqual(flow.state, "responding")

        flow.spoken(now=3.2)
        flow.feed([0.2] * 1600, now=3.7)
        self.assertEqual(flow.state, "conversing")

        # No keyword detector hit is needed for the next question.
        asr.result = "那闭包有什么用"
        asr.endpoint = True
        flow.feed([0.3] * 1600, now=4.0)

        self.assertEqual(flow.state, "responding")
        self.assertEqual(
            events[-1],
            {"type": "transcript", "id": 2, "text": "那闭包有什么用"},
        )

    def test_waiting_after_the_wake_word_stays_awake_until_the_timeout(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment(now=1.0)
        flow.begin_recognition(now=2.0)

        # Starting to speak too late only restarts the question, not the whole wake.
        flow.feed([0.1] * 1600, now=14.1)
        self.assertEqual(flow.state, "conversing")

        flow.feed([0.1] * 1600, now=301.0)
        self.assertEqual(flow.state, "listening")
        self.assertEqual(events[-1], {"type": "state", "state": "listening"})

        # Back to non-awake: a new question needs the wake word again.
        asr.result = "继续问"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=302.0)
        self.assertEqual(flow.state, "listening")
        self.assertTrue(all(event["type"] != "transcript" for event in events))

    def test_a_follow_up_question_refreshes_the_five_minute_window(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment(now=1.0)
        flow.begin_recognition(now=2.0)
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)
        flow.spoken(now=3.2)
        flow.feed([0.1] * 1600, now=3.7)
        self.assertEqual(flow.state, "conversing")

        asr.result = "第二个问题"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=290.0)
        self.assertEqual(flow.state, "responding")

        flow.spoken(now=290.5)
        flow.feed([0.1] * 1600, now=291.0)
        self.assertEqual(flow.state, "conversing")

        # The last question moved the deadline from 303 s to 590 s.
        flow.feed([0.1] * 1600, now=589.0)
        self.assertEqual(flow.state, "conversing")
        flow.feed([0.1] * 1600, now=590.0)
        self.assertEqual(flow.state, "listening")

    def test_cancel_while_conversing_returns_to_wake_listening(self):
        flow = VoiceFlow(
            FakeKeywordSpotter(), FakeRecognizer(), lambda _event: None, "器灵"
        )

        flow.start()
        flow._begin_wake_acknowledgment(now=1.0)
        flow.begin_recognition(now=2.0)
        flow.recognizer.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)
        flow.spoken(now=3.2)
        flow.feed([0.1] * 1600, now=3.7)
        self.assertEqual(flow.state, "conversing")

        flow.cancel()

        self.assertEqual(flow.state, "listening")
        self.assertEqual(flow.awake_until, 0)

    def test_another_client_line_does_not_end_the_conversation(self):
        events = []
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment(now=1.0)
        flow.begin_recognition(now=2.0)
        flow.recognizer.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)
        flow.spoken(now=3.2)
        flow.feed([0.1] * 1600, now=3.7)
        self.assertEqual(flow.state, "conversing")

        flow.speak("识局送来的一句解说。", now=4.0)
        flow.feed([0.1] * 1600, now=5.0)
        self.assertEqual(flow.state, "conversing")
        flow.spoken(now=5.5)
        self.assertEqual(flow.state, "settle")
        flow.feed([0.1] * 1600, now=6.0)
        self.assertEqual(flow.state, "conversing")

    def test_repeating_the_wake_word_during_a_conversation_asks_again(self):
        events = []
        asr = FakeRecognizer()
        flow = VoiceFlow(FakeKeywordSpotter(), asr, events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment(now=1.0)
        flow.begin_recognition(now=2.0)
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=3.0)
        flow.spoken(now=3.2)
        flow.feed([0.1] * 1600, now=3.7)
        self.assertEqual(flow.state, "conversing")

        asr.result = "器灵"
        asr.endpoint = True
        flow.feed([0.1] * 1600, now=4.0)

        self.assertEqual(flow.state, "wake_acknowledgment")
        self.assertEqual(events[-1], {"type": "state", "state": "wake_acknowledgment"})

    def test_cancel_during_a_reply_returns_to_wake_listening(self):
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), lambda _event: None, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        flow.recognizer.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)

        flow.cancel()

        self.assertEqual(flow.state, "listening")

    def test_detector_match_is_written_to_local_diagnostics(self):
        events = []
        kws = FakeKeywordSpotter()
        asr = FakeRecognizer()
        flow = VoiceFlow(kws, asr, events.append, "器灵")

        flow.start()
        kws.detect = True
        with self.assertLogs("qiling.voice_assistant", level="INFO") as logs:
            flow.feed([0.1] * 1600, now=1.0)

        self.assertTrue(any("KWS matched wake phrase: 器灵" in line for line in logs.output))
        self.assertIn({"type": "debug_keyword", "text": "器灵"}, events)

    def test_keyword_result_accepts_str_and_object_results(self):
        self.assertEqual(keyword_from_result("七零七零#3"), "七零七零#3")
        self.assertEqual(
            keyword_from_result(type("Result", (), {"keyword": "器灵"})()), "器灵"
        )
        self.assertEqual(keyword_from_result(""), "")
        self.assertEqual(keyword_from_result(None), "")

    def test_a_string_keyword_result_wakes_the_pet(self):
        # sherpa-onnx 2.x reports a plain string here; objects must not be required.
        class StringKeywordSpotter(FakeKeywordSpotter):
            def get_result(self, _stream):
                if self.detect:
                    self.detect = False
                    return "七零七零#2"
                return ""

        events = []
        kws = StringKeywordSpotter()
        flow = VoiceFlow(kws, FakeRecognizer(), events.append, "七零七零")

        flow.start()
        kws.detect = True
        flow.feed([0.1] * 1600, now=1.0)

        self.assertEqual(flow.state, "wake_acknowledgment")
        self.assertIn({"type": "debug_keyword", "text": "七零七零#2"}, events)

    def test_voice_diagnostics_are_written_to_the_configured_file(self):
        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "voice-assistant.log"
            configure_logging(log_path)
            try:
                logging.getLogger("qiling.voice_assistant").info(
                    "KWS matched wake phrase: 器灵"
                )
                for handler in logging.getLogger().handlers:
                    handler.flush()
                self.assertIn("KWS matched wake phrase: 器灵", log_path.read_text(encoding="utf-8"))
            finally:
                for handler in logging.getLogger().handlers:
                    handler.close()
                logging.getLogger().handlers.clear()

    def test_cancel_during_wake_acknowledgment_returns_to_wake_listening(self):
        events = []
        kws = FakeKeywordSpotter()
        flow = VoiceFlow(kws, FakeRecognizer(), events.append, "器灵")

        flow.start()
        kws.detect = True
        flow.feed([0.1] * 1600, now=1.0)
        flow.cancel()

        self.assertEqual(flow.state, "listening")
        self.assertEqual(events[-1], {"type": "state", "state": "listening"})

    def test_cancel_returns_to_wake_listening_without_publishing_audio(self):
        events = []
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow.cancel()

        self.assertEqual(events[-1], {"type": "state", "state": "listening"})
        self.assertTrue(all(event["type"] != "transcript" for event in events))


class WakeWordPhoneticsTests(unittest.TestCase):
    """Layer 1 (keyword expansion) and layer 3 (pinyin fallback) of the plan."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.tokens_path = Path(self.temporary.name) / "tokens.txt"
        self.tokens_path.write_text(FAKE_TOKENS, encoding="utf-8")

    @staticmethod
    def encode(token_list):
        def encoder(_phrases, **_options):
            return [list(token_list)]

        return encoder

    def test_splits_pinyin_tokens_into_sound_and_tone(self):
        self.assertEqual(split_final_token("uì"), ("ui", "4"))
        self.assertEqual(split_final_token("íng"), ("ing", "2"))
        self.assertEqual(split_final_token("ǚ"), ("ü", "3"))
        self.assertEqual(split_final_token("ér"), ("er", "2"))
        self.assertEqual(split_final_token("de"), ("de", "5"))

    def test_splits_tone3_syllables_into_initial_sound_and_tone(self):
        self.assertEqual(tone3_parts("ling2"), ("l", "ing", "2"))
        self.assertEqual(tone3_parts("nv3"), ("n", "ü", "3"))
        self.assertEqual(tone3_parts("er2"), ("", "er", "2"))
        self.assertEqual(tone3_parts("zhi1"), ("zh", "i", "1"))
        self.assertEqual(tone3_parts("hui4"), ("h", "ui", "4"))

    def test_keyword_variants_are_single_syllable_near_homophones(self):
        # Same tone, one confused initial (q/j) or final (ing/in) per line.
        lines = build_keyword_lines("七零", self.tokens_path, self.encode(["q", "ī", "l", "íng"]))

        self.assertEqual(
            lines,
            [
                "q ī l íng @七零",
                "j ī l íng @七零#1",
                "q ī n íng @七零#2",
                "q ī l ín @七零#3",
            ],
        )

    def test_keywords_stay_unchanged_when_a_token_is_not_pinyin(self):
        # English or unknown tokens cannot be split; keep the plain rule.
        lines = build_keyword_lines("七零", self.tokens_path, self.encode(["L", "AY1"]))

        self.assertEqual(lines, ["L AY1 @七零"])

    def test_unknown_token_table_only_writes_the_wake_word(self):
        lines = build_keyword_lines(
            "七零", Path(self.temporary.name) / "missing.txt", self.encode(["q", "ī"])
        )

        self.assertEqual(lines, ["q ī @七零"])

    def test_keyword_variants_are_deduplicated_and_capped(self):
        lines = build_keyword_lines("七零", self.tokens_path, self.encode(["q", "ī", "q", "ī"]))

        self.assertLessEqual(len(lines), MAX_KEYWORD_VARIANTS + 1)
        token_lines = [line.split(" @")[0] for line in lines]
        self.assertEqual(len(token_lines), len(set(token_lines)))

        capped = build_keyword_lines(
            "七零", self.tokens_path, self.encode(["q", "ī", "l", "íng"]), limit=1
        )
        self.assertEqual(capped, ["q ī l íng @七零", "j ī l íng @七零#1"])

    def test_keyword_file_holds_the_wake_word_and_its_variants(self):
        destination = Path(self.temporary.name) / "keywords.txt"
        write_keyword_file("七零", self.tokens_path, destination, self.encode(["q", "ī", "l", "íng"]))

        written = destination.read_text(encoding="utf-8").splitlines()
        self.assertEqual(written[0], "q ī l íng @七零")
        self.assertIn("j ī l íng @七零#1", written)
        self.assertEqual(written[-1], "q ī l ín @七零#3")

    def test_syllable_similarity_ranks_tone_above_new_phonemes(self):
        tone_slip = syllable_similarity(tone3_parts("qi1"), tone3_parts("qi4"))
        near_final = syllable_similarity(tone3_parts("lin2"), tone3_parts("ling2"))
        shared_final = syllable_similarity(tone3_parts("si4"), tone3_parts("qi1"))
        other_word = syllable_similarity(tone3_parts("si4"), tone3_parts("ling2"))

        self.assertAlmostEqual(tone_slip, 0.8)
        self.assertAlmostEqual(near_final, 0.82)
        self.assertAlmostEqual(shared_final, 0.45)
        self.assertEqual(other_word, 0.0)
        self.assertEqual(syllable_similarity(tone3_parts("qi1"), tone3_parts("qi1")), 1.0)

    def test_exact_transcript_needs_no_pinyin(self):
        self.assertTrue(is_wake_word_transcript(" 器灵。", "器灵"))
        self.assertFalse(is_wake_word_transcript("器", "器灵"))

    @unittest.skipUnless(PYPINYIN_AVAILABLE, "pypinyin is installed with the voice runtime")
    def test_homophone_transcripts_wake_the_pet(self):
        for transcript in ("欺凌欺凌", "其零其零", "麒麟麒麟", "七凌七凌"):
            with self.subTest(transcript=transcript):
                self.assertTrue(is_wake_word_transcript(transcript, "七零七零"))

    @unittest.skipUnless(PYPINYIN_AVAILABLE, "pypinyin is installed with the voice runtime")
    def test_unrelated_or_longer_transcripts_stay_questions(self):
        for transcript in ("四零四零", "七零七三", "我刚才说了七零七零", "帮我解释一下什么是闭包"):
            with self.subTest(transcript=transcript):
                self.assertFalse(is_wake_word_transcript(transcript, "七零七零"))
        self.assertIsNone(wake_word_similarity("我刚才说了七零七零", "七零七零"))

    @unittest.skipUnless(PYPINYIN_AVAILABLE, "pypinyin is installed with the voice runtime")
    def test_a_two_syllable_wake_word_tolerates_one_tone_slip(self):
        self.assertFalse(is_wake_word_transcript("西灵", "器灵"))
        self.assertTrue(is_wake_word_transcript("七零", "器灵"))
        self.assertTrue(is_wake_word_transcript("麒麟", "器灵"))

    @unittest.skipUnless(PYPINYIN_AVAILABLE, "pypinyin is installed with the voice runtime")
    def test_a_homophone_transcript_starts_the_wake_acknowledgment(self):
        events = []
        flow = VoiceFlow(
            FakeKeywordSpotter(),
            FakeRecognizer("欺凌欺凌"),
            events.append,
            "七零七零",
        )

        flow.start()
        flow.recognizer.endpoint = True
        flow.feed([0.1] * 1600, now=1.0)

        self.assertEqual(flow.state, "wake_acknowledgment")
        self.assertEqual(events[-1], {"type": "state", "state": "wake_acknowledgment"})


if __name__ == "__main__":
    unittest.main()
