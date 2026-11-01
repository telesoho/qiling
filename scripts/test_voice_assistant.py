import logging
import tempfile
import unittest
from pathlib import Path

from voice_assistant import (
    VoiceFlow,
    build_keyword_line,
    configure_logging,
    is_acknowledgment_echo,
)


class FakeKeywordStream:
    def __init__(self) -> None:
        self.samples = []
        self.ready = False

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
    def __init__(self, result="帮我解释一下什么是闭包") -> None:
        self.stream = FakeKeywordStream()
        self.endpoint = False
        self.result = result

    def create_stream(self):
        return self.stream

    def is_ready(self, stream) -> bool:
        return stream.ready

    def decode_stream(self, stream) -> None:
        stream.ready = False

    def is_endpoint(self, _stream) -> bool:
        return self.endpoint

    def get_result(self, _stream) -> str:
        return self.result

    def reset(self, _stream) -> None:
        self.endpoint = False


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

        self.assertEqual(flow.state, "listening")
        self.assertTrue(all(event["type"] != "transcript" for event in events))

    def test_acknowledgment_echo_matching_ignores_punctuation(self):
        self.assertTrue(is_acknowledgment_echo("说。"))
        self.assertTrue(is_acknowledgment_echo(" 我在，请说！"))
        self.assertFalse(is_acknowledgment_echo("今天天气怎么样"))
        self.assertFalse(is_acknowledgment_echo("，"))

    def test_listening_resumes_after_the_reply_was_played(self):
        events = []
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        flow.recognizer.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        self.assertEqual(flow.state, "responding")

        flow.listen()

        self.assertEqual(flow.state, "listening")
        self.assertEqual(events[-1], {"type": "state", "state": "listening"})

    def test_listen_still_starts_recognition_after_the_wake_word(self):
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), lambda _event: None, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.listen(now=5.0)

        self.assertEqual(flow.state, "recognizing")

    def test_a_reply_that_never_reports_back_releases_the_microphone(self):
        events = []
        flow = VoiceFlow(FakeKeywordSpotter(), FakeRecognizer(), events.append, "器灵")

        flow.start()
        flow._begin_wake_acknowledgment()
        flow.begin_recognition(now=1.0)
        flow.recognizer.endpoint = True
        flow.feed([0.1] * 1600, now=2.0)
        self.assertEqual(flow.state, "responding")

        flow.feed([0.1] * 1600, now=2.0 + 61.0)

        self.assertEqual(flow.state, "listening")
        self.assertEqual(events[-1], {"type": "state", "state": "listening"})

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
