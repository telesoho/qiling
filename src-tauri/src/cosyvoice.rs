use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::ipc::Channel;

use crate::voice;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const SYNTH_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceChunk {
    pub sample_rate: u32,
    pub pcm_base64: String,
}

/// HTTP client for a CosyVoice process the user started. This does not spawn Python.
pub struct VoiceHost {
    endpoint: Result<String, String>,
    generation: AtomicU64,
}

impl VoiceHost {
    pub fn new() -> Self {
        Self {
            endpoint: voice::configured_service_url(),
            generation: AtomicU64::new(1),
        }
    }

    pub fn status(&self) -> voice::VoiceReport {
        let url = match &self.endpoint {
            Ok(url) => url.clone(),
            Err(detail) => return voice::offline_report(detail.clone()),
        };
        match agent(HEALTH_TIMEOUT)
            .get(&format!("{url}/health"))
            .call()
        {
            Ok(resp) => match resp.into_string() {
                Ok(body) if voice::health_ready(&body) => {
                    voice::ready_report(voice::READY_DETAIL)
                }
                _ => voice::offline_report(
                    "本机这个端口有响应，但不是诗琚的 CosyVoice 3 儿童音色。",
                ),
            },
            Err(_) => voice::offline_report(format!(
                "本机 CosyVoice 服务没开（{url}）。先单独启动 services/cosyvoice-tts，器灵改用系统语音。"
            )),
        }
    }

    pub fn cancel(&self) {
        let next = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let Ok(url) = &self.endpoint else {
            return;
        };
        let _ = agent(Duration::from_secs(2))
            .post(&format!("{url}/v1/audio/cancel"))
            .send_json(voice::cancel_body(next));
    }

    pub fn shutdown(&self) {
        self.cancel();
    }

    /// Read PCM on this thread and push each chunk. Call it from `spawn_blocking`.
    ///
    /// If any chunk was already sent, a later cancel or failure returns `Ok` so the
    /// page can finish audio it has queued instead of speaking the line again.
    pub fn synthesize(&self, text: &str, on_chunk: Channel<VoiceChunk>) -> Result<(), String> {
        let line = text.trim();
        if line.is_empty() {
            return Err("failed:empty".into());
        }
        if line.chars().count() > 400 {
            return Err("failed:too_long".into());
        }
        let url = self
            .endpoint
            .as_ref()
            .map_err(|detail| format!("unavailable:{detail}"))?;
        let epoch = self.generation.load(Ordering::SeqCst);
        let response = agent(SYNTH_TIMEOUT)
            .post(&format!("{url}/v1/audio/speech"))
            .send_json(voice::speech_body(line, epoch));
        if self.generation.load(Ordering::SeqCst) != epoch {
            return Err("cancelled".into());
        }
        match response {
            Ok(resp) => self.read_audio(resp, epoch, &on_chunk),
            Err(ureq::Error::Status(409, _)) => Err("cancelled".into()),
            Err(ureq::Error::Status(code, resp)) => {
                let body = resp.into_string().unwrap_or_default();
                Err(format!("failed:CosyVoice HTTP {code} {body}"))
            }
            Err(ureq::Error::Transport(err)) => {
                Err(format!("unavailable:CosyVoice 服务没有响应 {err}"))
            }
        }
    }

    fn read_audio(
        &self,
        resp: ureq::Response,
        epoch: u64,
        on_chunk: &Channel<VoiceChunk>,
    ) -> Result<(), String> {
        let content_type = resp
            .header("Content-Type")
            .unwrap_or("")
            .to_ascii_lowercase();
        if content_type.contains("audio/wav") {
            return self.emit_wav(resp, epoch, on_chunk);
        }
        let sample_rate = resp
            .header("X-Sample-Rate")
            .and_then(|value| value.parse().ok())
            .unwrap_or(24_000);
        let mut reader = resp.into_reader().take(32 * 1024 * 1024);
        let mut parser = voice::FrameParser::default();
        let mut buf = [0u8; 16 * 1024];
        let mut sent = false;
        loop {
            if self.generation.load(Ordering::SeqCst) != epoch {
                return if sent {
                    Ok(())
                } else {
                    Err("cancelled".into())
                };
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Err(err) =
                        self.emit_frames(parser.push(&buf[..n]), sample_rate, on_chunk, &mut sent)
                    {
                        return if sent { Ok(()) } else { Err(err) };
                    }
                }
                Err(err) => {
                    return if sent {
                        Ok(())
                    } else {
                        Err(format!("unavailable:CosyVoice 服务没有响应 {err}"))
                    };
                }
            }
        }
        if let Some(frame) = parser.finish() {
            if let Err(err) = self.emit_frames(vec![frame], sample_rate, on_chunk, &mut sent) {
                return if sent { Ok(()) } else { Err(err) };
            }
        }
        if self.generation.load(Ordering::SeqCst) != epoch {
            return if sent {
                Ok(())
            } else {
                Err("cancelled".into())
            };
        }
        if sent {
            Ok(())
        } else {
            Err("failed:CosyVoice 没有返回音频".into())
        }
    }

    fn emit_wav(
        &self,
        resp: ureq::Response,
        epoch: u64,
        on_chunk: &Channel<VoiceChunk>,
    ) -> Result<(), String> {
        let mut bytes = Vec::new();
        resp.into_reader()
            .take(32 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|err| format!("failed:读取音频失败 {err}"))?;
        if self.generation.load(Ordering::SeqCst) != epoch {
            return Err("cancelled".into());
        }
        let Some((sample_rate, pcm)) = voice::wav_pcm(&bytes) else {
            return Err("failed:CosyVoice 没有返回音频".into());
        };
        if pcm.is_empty() {
            return Err("failed:CosyVoice 没有返回音频".into());
        }
        send_pcm(on_chunk, sample_rate, &pcm)
    }

    fn emit_frames(
        &self,
        frames: Vec<voice::StreamFrame>,
        sample_rate: u32,
        on_chunk: &Channel<VoiceChunk>,
        sent: &mut bool,
    ) -> Result<(), String> {
        for frame in frames {
            match frame {
                voice::StreamFrame::Pcm(pcm) => {
                    if pcm.is_empty() {
                        continue;
                    }
                    send_pcm(on_chunk, sample_rate, &pcm)?;
                    *sent = true;
                }
                voice::StreamFrame::End => {}
                voice::StreamFrame::Status(text) => {
                    if *sent {
                        return Ok(());
                    }
                    if text.contains("cancelled") {
                        return Err("cancelled".into());
                    }
                    return Err(format!("failed:{text}"));
                }
            }
        }
        Ok(())
    }
}

fn send_pcm(on_chunk: &Channel<VoiceChunk>, sample_rate: u32, pcm: &[u8]) -> Result<(), String> {
    on_chunk
        .send(VoiceChunk {
            sample_rate,
            pcm_base64: base64::engine::general_purpose::STANDARD.encode(pcm),
        })
        .map_err(|err| format!("failed:无法把音频交给界面 {err}"))
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(1))
        .timeout_read(timeout)
        .timeout_write(Duration::from_secs(10))
        .build()
}

#[cfg(test)]
mod tests {
    use crate::voice::{FrameParser, StreamFrame};

    #[test]
    fn splits_a_pcm_frame_across_reads() {
        let pcm = [1u8, 2, 3, 4, 5, 6];
        let mut bytes = vec![0x01];
        bytes.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&pcm);
        bytes.push(0x00);
        let mut parser = FrameParser::default();
        assert!(parser.push(&bytes[..4]).is_empty());
        let frames = parser.push(&bytes[4..]);
        assert_eq!(
            frames,
            vec![StreamFrame::Pcm(pcm.to_vec()), StreamFrame::End]
        );
    }
}
