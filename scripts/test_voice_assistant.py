import logging
import tempfile
import unittest
from pathlib import Path

from voice_assistant import (
    VoiceFlow,
    build_keyword_line,
    configure_logging,
    is_acknowledgment_echo,
    is_echo_of,
    is_interrupt_phrase,
    parse_command,
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
    """One voice recognizer, many streams: each stream carries its own endpoint."""

    def __init__(self, result="帮我解释一下什么是闭包") -> None:
        self.streams = []
        self.result = result

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

    def test_the_microphone_stays_closed_while_the_pet_answers(self):
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

        # The pet's own answer is on the speakers; it must not be heard as a new
        # wake word or as the next question.
        emitted = len(events)
        kws.detect = True
        asr.endpoint = True
        flow.feed([0.3] * 1600, now=4.0)

        self.assertEqual(flow.state, "responding")
        self.assertEqual(len(events), emitted)

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

    def test_listening_pauses_while_another_client_line_is_spoken(self):
        events = []
        kws = FakeKeywordSpotter()
        asr = FakeRecognizer("七零七零")
        flow = VoiceFlow(kws, asr, events.append, "七零七零")

        flow.start()
        flow.speak("识局送来的一句解说。")
        asr.endpoint = True
        kws.detect = True
        emitted = len(events)
        flow.feed([0.1] * 1600, now=1.0)

        self.assertEqual(flow.state, "listening")
        self.assertEqual(len(events), emitted)

        flow.spoken(now=1.5)
        self.assertEqual(flow.state, "settle")
        flow.feed([0.1] * 1600, now=2.0)
        self.assertEqual(flow.state, "listening")

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

    def test_a_new_line_during_settle_keeps_the_microphone_closed(self):
        events = []
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow.speak("第一句。")
        flow.spoken(now=1.0)
        self.assertEqual(flow.state, "settle")

        flow.speak("第二句。")
        flow.feed([0.1] * 1600, now=2.0)
        self.assertEqual(flow.state, "settle")

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


if __name__ == "__main__":
    unittest.main()
