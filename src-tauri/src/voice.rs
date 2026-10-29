use serde::Serialize;
use serde_json::{json, Value};

/// Upstream checkpoint. The local service loads this repo, not a renamed substitute.
pub const MODEL_ID: &str = "FunAudioLLM/Fun-CosyVoice3-0.5B-2512";
pub const ENGINE_ID: &str = "cosyvoice3-0.5b";
pub const CHILD_VOICE: &str = "child-girl-zero-shot";
pub const DEFAULT_SERVICE_URL: &str = "http://127.0.0.1:8765";
pub const READY_DETAIL: &str = "CosyVoice 3 0.5B 本机零样本，儿童女孩参考音";
/// CosyVoice3 requires this control prefix. It does not choose the speaker.
pub const PROMPT_PREFIX: &str = "You are a helpful assistant.<|endofprompt|>";
/// Official zero-shot demo line, recorded by an adult woman. Not 诗琚's voice.
const ADULT_DEMO: &str = "希望你以后能够做的比我还好";

pub const MIN_PROMPT_SECS: f32 = 2.5;
pub const MAX_PROMPT_SECS: f32 = 30.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceReport {
    pub ready: bool,
    pub engine: String,
    pub detail: String,
    pub prompt_wav: String,
    pub model_dir: String,
}

pub fn offline_report(detail: impl Into<String>) -> VoiceReport {
    VoiceReport {
        ready: false,
        engine: "system".to_string(),
        detail: detail.into(),
        prompt_wav: String::new(),
        model_dir: String::new(),
    }
}

pub fn ready_report(detail: impl Into<String>) -> VoiceReport {
    VoiceReport {
        ready: true,
        engine: ENGINE_ID.to_string(),
        detail: detail.into(),
        prompt_wav: String::new(),
        model_dir: String::new(),
    }
}

/// Loopback HTTP only. `localhost` is normalized to 127.0.0.1 so it matches the bind address.
pub fn service_url(raw: Option<&str>) -> Result<String, String> {
    let trimmed = raw.unwrap_or("").trim();
    let value = if trimmed.is_empty() {
        DEFAULT_SERVICE_URL
    } else {
        trimmed.trim_end_matches('/')
    };
    let Some(rest) = value.strip_prefix("http://") else {
        return Err("SIJU_COSYVOICE_URL 只接受本机 http 地址，例如 http://127.0.0.1:8765。".into());
    };
    if rest.is_empty()
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('@')
    {
        return Err("SIJU_COSYVOICE_URL 只接受本机 http 地址，例如 http://127.0.0.1:8765。".into());
    }
    let Some((host, port_text)) = rest.rsplit_once(':') else {
        return Err("SIJU_COSYVOICE_URL 要带端口，例如 http://127.0.0.1:8765。".into());
    };
    if host != "127.0.0.1" && host != "localhost" {
        return Err(
            "CosyVoice 只连接本机。请把 SIJU_COSYVOICE_URL 设成 http://127.0.0.1:8765 这种地址。"
                .into(),
        );
    }
    let port: u16 = port_text
        .parse()
        .map_err(|_| "SIJU_COSYVOICE_URL 的端口不对。".to_string())?;
    if port == 0 {
        return Err("SIJU_COSYVOICE_URL 的端口不对。".into());
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

/// `QILING_COSYVOICE_URL` wins. The old `SIJU_COSYVOICE_URL` still works.
pub fn configured_service_url() -> Result<String, String> {
    let raw = std::env::var("QILING_COSYVOICE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("SIJU_COSYVOICE_URL").ok());
    service_url(raw.as_deref())
}

/// Health is the only readiness signal. A process that merely has weights on disk is not ready.
pub fn health_ready(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    value.get("ok").and_then(Value::as_bool) == Some(true)
        && value.get("engine").and_then(Value::as_str) == Some(ENGINE_ID)
        && value.get("voice").and_then(Value::as_str) == Some(CHILD_VOICE)
}

/// Body sent to the local service. The reference clip is not included.
/// `stream` asks for PCM frames so playback can start before the sentence ends.
pub fn speech_body(text: &str, request_id: u64) -> Value {
    json!({
        "input": text,
        "request_id": request_id,
        "stream": true,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamFrame {
    Pcm(Vec<u8>),
    End,
    /// `cancelled` or `failed`. The text is whatever followed `0x02`.
    Status(String),
}

/// Incremental reader for the streaming body.
///
/// `0x01` + `u32le` length + s16le PCM, `0x00` ends, `0x02` + text is a failure.
#[derive(Debug, Default)]
pub struct FrameParser {
    buf: Vec<u8>,
    failed: bool,
}

impl FrameParser {
    pub fn push(&mut self, data: &[u8]) -> Vec<StreamFrame> {
        if self.failed {
            self.buf.extend_from_slice(data);
            return Vec::new();
        }
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        loop {
            if self.buf.is_empty() {
                break;
            }
            match self.buf[0] {
                0x00 => {
                    self.buf.drain(..1);
                    out.push(StreamFrame::End);
                }
                0x02 => {
                    self.buf.drain(..1);
                    self.failed = true;
                    break;
                }
                0x01 => {
                    if self.buf.len() < 5 {
                        break;
                    }
                    let len = u32::from_le_bytes(self.buf[1..5].try_into().unwrap()) as usize;
                    if len > 8 * 1024 * 1024 || self.buf.len() < 5 + len {
                        if len > 8 * 1024 * 1024 {
                            self.buf.clear();
                            self.failed = true;
                            out.push(StreamFrame::Status("failed".into()));
                        }
                        break;
                    }
                    let pcm = self.buf[5..5 + len].to_vec();
                    self.buf.drain(..5 + len);
                    out.push(StreamFrame::Pcm(pcm));
                }
                _ => {
                    self.buf.clear();
                    self.failed = true;
                    out.push(StreamFrame::Status("failed".into()));
                    break;
                }
            }
        }
        out
    }

    /// Call at EOF so a trailing `0x02` message is delivered.
    pub fn finish(&mut self) -> Option<StreamFrame> {
        if !self.failed {
            return None;
        }
        self.failed = false;
        let text = String::from_utf8_lossy(&self.buf).trim().to_string();
        self.buf.clear();
        Some(StreamFrame::Status(if text.is_empty() {
            "failed".into()
        } else {
            text
        }))
    }
}

/// PCM payload of a 16-bit WAV, for a service that still returns one file.
pub fn wav_pcm(bytes: &[u8]) -> Option<(u32, Vec<u8>)> {
    let info = wav_info(bytes)?;
    if bytes.len() < 44 {
        return None;
    }
    let mut offset = 12usize;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let start = offset + 8;
        if id == b"data" {
            let end = start.checked_add(size)?.min(bytes.len());
            if end <= start {
                return None;
            }
            return Some((info.sample_rate, bytes[start..end].to_vec()));
        }
        let padded = size + (size % 2);
        offset = start.checked_add(padded)?;
    }
    None
}

pub fn cancel_body(before: u64) -> Value {
    json!({ "before": before })
}

pub fn cosyvoice3_prompt(spoken: &str) -> String {
    if spoken.contains("<|endofprompt|>") {
        spoken.to_string()
    } else {
        format!("{PROMPT_PREFIX}{spoken}")
    }
}

/// Accept a real child-girl reference. Reject the silent stub and the adult demo line.
pub fn assess_reference(wav: Option<&[u8]>, transcript: Option<&str>) -> Result<String, String> {
    let Some(transcript) = transcript else {
        return Err("没有找到参考文稿。请在录音旁边放同名 txt，内容是录音里说的原句。".into());
    };
    let lines = content_lines(transcript);
    if lines.is_empty() {
        return Err("参考文稿是空的。请写成这句录音里实际说的话。".into());
    }
    if lines.iter().any(|line| is_stub_marker(line)) {
        return Err("参考文稿仍是占位 STUB。换成儿童女孩录音的逐字稿后再克隆。".into());
    }
    let spoken = spoken_body(&lines.join(""));
    if spoken.chars().count() < 2 {
        return Err("参考文稿太短。请写成录音里实际说的那句话。".into());
    }
    if is_adult_demo(&spoken) {
        return Err(
            "这是 CosyVoice 官方成年女声示例稿，诗琚不用。请换成儿童女孩录音，以及和录音一致的另一句文稿。"
                .into(),
        );
    }
    let Some(wav) = wav else {
        return Err("没有找到儿童女孩参考录音。".into());
    };
    let Some(info) = wav_info(wav) else {
        return Err("参考录音不是可用的 PCM WAV。请另存为普通 wav。".into());
    };
    if info.duration < MIN_PROMPT_SECS {
        return Err(format!(
            "参考录音只有 {:.1} 秒，还不能当儿童女孩音色。请换成大约 3–10 秒、单人、没有背景音乐的干声。",
            info.duration
        ));
    }
    if info.duration > MAX_PROMPT_SECS {
        return Err(format!(
            "参考录音有 {:.1} 秒，CosyVoice 3 不接受超过 30 秒的参考音。请裁到 3–10 秒。",
            info.duration
        ));
    }
    Ok(spoken)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WavInfo {
    pub duration: f32,
    pub sample_rate: u32,
}

pub fn wav_info(bytes: &[u8]) -> Option<WavInfo> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut offset = 12usize;
    let mut audio_format = None;
    let mut channels = None;
    let mut sample_rate = None;
    let mut bits = None;
    let mut data_len = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let start = offset + 8;
        if start + size.min(bytes.len().saturating_sub(start)) > bytes.len() && id != b"data" {
            break;
        }
        if id == b"fmt " && size >= 16 && start + 16 <= bytes.len() {
            audio_format = Some(u16::from_le_bytes([bytes[start], bytes[start + 1]]));
            channels = Some(u16::from_le_bytes([bytes[start + 2], bytes[start + 3]]));
            sample_rate = Some(u32::from_le_bytes(
                bytes[start + 4..start + 8].try_into().ok()?,
            ));
            bits = Some(u16::from_le_bytes([bytes[start + 14], bytes[start + 15]]));
        }
        if id == b"data" {
            data_len = Some(size);
            break;
        }
        let padded = size + (size % 2);
        offset = start.checked_add(padded)?;
    }
    let format = audio_format?;
    if format != 1 && format != 3 {
        return None;
    }
    let rate = sample_rate?;
    let channel_count = channels? as u32;
    let bits = bits? as u32;
    let data = data_len? as u32;
    if rate == 0 || channel_count == 0 || bits < 8 || bits % 8 != 0 {
        return None;
    }
    let bytes_per_sec = rate.checked_mul(channel_count)?.checked_mul(bits / 8)?;
    if bytes_per_sec == 0 {
        return None;
    }
    Some(WavInfo {
        duration: data as f32 / bytes_per_sec as f32,
        sample_rate: rate,
    })
}

fn content_lines(raw: &str) -> Vec<&str> {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect()
}

fn spoken_body(text: &str) -> String {
    text.rsplit_once("<|endofprompt|>")
        .map(|(_, tail)| tail)
        .unwrap_or(text)
        .trim()
        .to_string()
}

fn is_stub_marker(line: &str) -> bool {
    let marker = line
        .trim()
        .trim_matches(|ch| ch == '"' || ch == '\'' || ch == '`');
    marker.eq_ignore_ascii_case("STUB") || marker.eq_ignore_ascii_case("PLACEHOLDER")
}

fn is_adult_demo(spoken: &str) -> bool {
    let compact: String = spoken.chars().filter(|ch| !ch.is_whitespace()).collect();
    let compact =
        compact.trim_matches(|ch: char| matches!(ch, '。' | '！' | '!' | '.' | '呀' | '呦' | '哟'));
    compact.contains(ADULT_DEMO)
}

#[cfg(test)]
fn pcm_silence(samples: u32, sample_rate: u32) -> Vec<u8> {
    let data_len = samples.saturating_mul(2);
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    bytes.resize(bytes.len() + data_len as usize, 0);
    bytes
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    fn child_line() -> &'static str {
        "今天想先看棋盘上的这一步。"
    }

    #[test]
    fn stub_and_adult_demo_cannot_be_the_child_voice() {
        let short = pcm_silence(8_000, 16_000);
        let long = pcm_silence(16_000 * 4, 16_000);
        assert!(assess_reference(Some(&short), Some("STUB"))
            .unwrap_err()
            .contains("STUB"));
        assert!(assess_reference(Some(&long), Some("# 说明\nSTUB"))
            .unwrap_err()
            .contains("STUB"));
        let demo = format!("{PROMPT_PREFIX}希望你以后能够做的比我还好呦。");
        assert!(assess_reference(Some(&long), Some(&demo))
            .unwrap_err()
            .contains("成年"));
        assert!(assess_reference(Some(&short), Some(child_line()))
            .unwrap_err()
            .contains("秒"));
        let spoken = assess_reference(Some(&long), Some(child_line())).unwrap();
        assert_eq!(spoken, child_line());
        assert_eq!(
            cosyvoice3_prompt(&spoken),
            format!("{PROMPT_PREFIX}{spoken}")
        );
        assert!(!cosyvoice3_prompt(&spoken).contains(ADULT_DEMO));
    }

    #[test]
    fn bundled_placeholder_is_not_a_child_voice() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets/qiling");
        let wav = fs::read(root.join("voice-prompt-girl-child.wav")).expect("stub wav");
        let text = fs::read_to_string(root.join("voice-prompt-girl-child.txt")).expect("stub txt");
        let err = assess_reference(Some(&wav), Some(&text)).unwrap_err();
        assert!(err.contains("STUB") || err.contains("秒"), "{err}");
    }

    #[test]
    fn service_url_stays_on_loopback() {
        assert_eq!(service_url(None).unwrap(), DEFAULT_SERVICE_URL);
        assert_eq!(service_url(Some("  ")).unwrap(), DEFAULT_SERVICE_URL);
        assert_eq!(
            service_url(Some("http://127.0.0.1:9000/")).unwrap(),
            "http://127.0.0.1:9000"
        );
        assert_eq!(
            service_url(Some("http://localhost:8765")).unwrap(),
            DEFAULT_SERVICE_URL
        );
        assert!(service_url(Some("https://127.0.0.1:8765")).is_err());
        assert!(service_url(Some("http://example.com:8765")).is_err());
        assert!(service_url(Some("http://0.0.0.0:8765")).is_err());
        assert!(service_url(Some("http://127.0.0.1:8765/v1")).is_err());
        assert!(service_url(Some("http://127.0.0.1:0")).is_err());
    }

    #[test]
    fn health_and_speech_body_do_not_carry_a_reference_clip() {
        let ready = r#"{"ok":true,"engine":"cosyvoice3-0.5b","model":"Fun-CosyVoice3-0.5B-2512","voice":"child-girl-zero-shot","sampleRate":24000}"#;
        assert!(health_ready(ready));
        assert!(!health_ready(
            r#"{"ok":false,"engine":"cosyvoice3-0.5b","voice":"child-girl-zero-shot"}"#
        ));
        assert!(!health_ready(
            r#"{"ok":true,"engine":"other","voice":"child-girl-zero-shot"}"#
        ));
        assert!(!health_ready(
            r#"{"ok":true,"engine":"cosyvoice3-0.5b","voice":"adult"}"#
        ));
        assert!(!health_ready("not json"));

        let body = speech_body("红方略优。", 3);
        let object = body.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert_eq!(body["input"], "红方略优。");
        assert_eq!(body["request_id"], 3);
        assert_eq!(body["stream"], true);
        let raw = body.to_string();
        assert!(!raw.to_lowercase().contains("fen"));
        assert!(!raw.contains("prompt"));
        assert_eq!(cancel_body(4)["before"], 4);
        let report = ready_report(READY_DETAIL);
        assert!(report.ready);
        assert_eq!(report.engine, ENGINE_ID);
        assert!(!offline_report("没开").ready);
    }

    #[test]
    fn frame_parser_accepts_split_pcm_and_a_late_cancel() {
        let pcm = [9u8, 8, 7, 6];
        let mut bytes = vec![0x01];
        bytes.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&pcm);
        bytes.push(0x00);
        let mut parser = FrameParser::default();
        assert!(parser.push(&bytes[..3]).is_empty());
        let frames = parser.push(&bytes[3..]);
        assert_eq!(
            frames,
            vec![StreamFrame::Pcm(pcm.to_vec()), StreamFrame::End]
        );
        assert!(parser.finish().is_none());

        let mut failed = FrameParser::default();
        assert!(failed.push(b"\x02cancel").is_empty());
        let rest = failed.push(b"led");
        assert!(rest.is_empty());
        assert_eq!(
            failed.finish(),
            Some(StreamFrame::Status("cancelled".into()))
        );

        let wav = pcm_silence(4, 16_000);
        let (rate, data) = wav_pcm(&wav).unwrap();
        assert_eq!(rate, 16_000);
        assert_eq!(data.len(), 8);
    }
}
