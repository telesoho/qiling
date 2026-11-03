use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use edge_tts_rust::{EdgeTtsClient, SpeakOptions, DEFAULT_OUTPUT_FORMAT_MP3};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

const MAX_TEXT_CHARS: usize = 400;
const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_VOICE: &str = "zh-CN-XiaoxiaoNeural";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOption {
    pub id: String,
    pub label: String,
    pub locale: String,
}

pub struct EdgeVoiceHost {
    client: Result<EdgeTtsClient, String>,
    active: Mutex<HashMap<String, CancellationToken>>,
}

impl EdgeVoiceHost {
    pub fn new() -> Self {
        Self {
            client: EdgeTtsClient::builder()
                .ws_warmup(false)
                .build()
                .map_err(|error| error.to_string()),
            active: Mutex::new(HashMap::new()),
        }
    }

    pub async fn list_voices(&self) -> Result<Vec<VoiceOption>, String> {
        let client = self.client.as_ref().map_err(|error| error.clone())?;
        let voices = client
            .list_voices()
            .await
            .map_err(|error| format!("Edge TTS 音色列表读取失败：{error}"))?;

        let mut options = voices
            .into_iter()
            .filter(|voice| voice.locale.to_ascii_lowercase().starts_with("zh"))
            .map(|voice| VoiceOption {
                id: voice.short_name,
                label: voice.friendly_name.unwrap_or_else(|| voice.name.clone()),
                locale: voice.locale,
            })
            .collect::<Vec<_>>();
        options.sort_by(|left, right| {
            left.locale
                .cmp(&right.locale)
                .then_with(|| left.label.cmp(&right.label))
        });
        Ok(options)
    }

    pub async fn synthesize(
        &self,
        request_id: &str,
        text: &str,
        voice: &str,
    ) -> Result<String, String> {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err("failed:Edge TTS 请求编号无效".into());
        }
        let line = text.trim();
        if line.is_empty() {
            return Err("failed:播报内容为空".into());
        }
        if line.chars().count() > MAX_TEXT_CHARS {
            return Err(format!("failed:播报内容不能超过 {MAX_TEXT_CHARS} 个字符"));
        }
        let voice = voice.trim();
        if voice.is_empty() || voice.chars().count() > 128 {
            return Err("failed:Edge 音色名称无效".into());
        }

        let client = self.client.as_ref().map_err(|error| error.clone())?;
        let cancellation = self.begin_request(request_id)?;
        let options = SpeakOptions {
            voice: if voice == "auto" {
                DEFAULT_VOICE.to_string()
            } else {
                voice.to_string()
            },
            output_format: DEFAULT_OUTPUT_FORMAT_MP3.to_string(),
            ..SpeakOptions::default()
        };
        let result = tokio::select! {
            _ = cancellation.cancelled() => Err("cancelled".to_string()),
            result = client.synthesize(line, options) => {
                result
                    .map_err(|error| format!("unavailable:Edge TTS 合成失败：{error}"))
                    .and_then(|result| {
                        if result.audio.is_empty() {
                            Err("unavailable:Edge TTS 没有返回音频".into())
                        } else if result.audio.len() > MAX_AUDIO_BYTES {
                            Err("unavailable:Edge TTS 返回的音频过大".into())
                        } else {
                            Ok(STANDARD.encode(result.audio))
                        }
                    })
            }
        };
        self.finish_request(request_id)?;
        result
    }

    pub fn cancel(&self, request_id: &str) -> Result<(), String> {
        let cancellation = self
            .active
            .lock()
            .map_err(|_| "Edge TTS 请求状态不可用".to_string())?
            .remove(request_id);
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
        }
        Ok(())
    }

    pub fn cancel_all(&self) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Edge TTS 请求状态不可用".to_string())?
            .drain()
            .map(|(_, cancellation)| cancellation)
            .collect::<Vec<_>>();
        for cancellation in active {
            cancellation.cancel();
        }
        Ok(())
    }

    fn begin_request(&self, request_id: &str) -> Result<CancellationToken, String> {
        let cancellation = CancellationToken::new();
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Edge TTS 请求状态不可用".to_string())?;
        if active.contains_key(request_id) {
            return Err("failed:Edge TTS 请求编号重复".into());
        }
        active.insert(request_id.to_string(), cancellation.clone());
        Ok(cancellation)
    }

    fn finish_request(&self, request_id: &str) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Edge TTS 请求状态不可用".to_string())?;
        active.remove(request_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constructs_without_a_tokio_runtime() {
        let _host = EdgeVoiceHost::new();
    }

    #[test]
    fn rejects_empty_or_excessively_long_input() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let host = EdgeVoiceHost::new();
            assert!(host.synthesize("empty", "  ", DEFAULT_VOICE).await.is_err());
            assert!(host
                .synthesize("long", &"长".repeat(MAX_TEXT_CHARS + 1), DEFAULT_VOICE)
                .await
                .is_err());
        });
    }

    #[test]
    fn cancel_cancels_the_active_request() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let host = EdgeVoiceHost::new();
            let token = host.begin_request("pet-line").unwrap();
            host.cancel("pet-line").unwrap();
            assert!(token.is_cancelled());
            host.finish_request("pet-line").unwrap();
        });
    }

    #[test]
    fn cancelling_a_preview_does_not_cancel_pet_speech() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let host = EdgeVoiceHost::new();
            let pet = host.begin_request("pet-line").unwrap();
            let preview = host.begin_request("preview").unwrap();
            host.cancel("preview").unwrap();
            assert!(preview.is_cancelled());
            assert!(!pet.is_cancelled());
            host.cancel_all().unwrap();
            assert!(pet.is_cancelled());
        });
    }
}
