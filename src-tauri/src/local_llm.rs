use std::{
    env, fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        RwLock,
    },
    time::{Duration, Instant},
};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

const KEYRING_SERVICE: &str = "com.qiling.pet";
const DEFAULT_OLLAMA_MODEL: &str = "qwen3.5:4b";
const DEFAULT_DEEPSEEK_URL: &str = "https://api.deepseek.com";
const MAX_INPUT_CODE_POINTS: usize = 2_000;
const MAX_OUTPUT_CODE_POINTS: usize = 400;
const MAX_REQUEST_SECONDS: u64 = 120;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmProvider {
    Ollama,
    Deepseek,
    OpenaiCompatible,
}

impl Default for LlmProvider {
    fn default() -> Self {
        Self::Ollama
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    pub provider: LlmProvider,
    pub base_url: String,
    pub model: String,
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            provider: LlmProvider::Ollama,
            base_url: "http://127.0.0.1:11434".into(),
            model: DEFAULT_OLLAMA_MODEL.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettingsView {
    pub provider: LlmProvider,
    pub base_url: String,
    pub model: String,
    pub api_key_configured: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSettings {
    provider: LlmProvider,
    base_url: String,
    model: String,
}

impl From<&LlmSettings> for PersistedSettings {
    fn from(settings: &LlmSettings) -> Self {
        Self {
            provider: settings.provider.clone(),
            base_url: settings.base_url.clone(),
            model: settings.model.clone(),
        }
    }
}

pub struct LocalLlm {
    settings_path: PathBuf,
    settings: RwLock<LlmSettings>,
    generation: AtomicU64,
    busy: AtomicBool,
}

impl LocalLlm {
    pub fn new(settings_path: PathBuf) -> Result<Self, String> {
        let settings = read_settings(&settings_path)?;
        Ok(Self {
            settings_path,
            settings: RwLock::new(settings),
            generation: AtomicU64::new(0),
            busy: AtomicBool::new(false),
        })
    }

    #[cfg(test)]
    fn for_test(endpoint: String) -> Self {
        Self {
            settings_path: PathBuf::new(),
            settings: RwLock::new(LlmSettings {
                provider: LlmProvider::Ollama,
                base_url: endpoint,
                model: "test-model".into(),
            }),
            generation: AtomicU64::new(0),
            busy: AtomicBool::new(false),
        }
    }

    pub fn settings(&self) -> Result<LlmSettingsView, String> {
        let settings = self
            .settings
            .read()
            .map_err(|_| "llm_settings_unavailable")?
            .clone();
        let api_key_configured = match &settings.provider {
            LlmProvider::Ollama => false,
            provider => match key_entry(provider)?.get_password() {
                Ok(_) => true,
                Err(keyring::Error::NoEntry) => false,
                Err(_) => return Err("credential_store_unavailable".into()),
            },
        };
        Ok(LlmSettingsView {
            provider: settings.provider,
            base_url: settings.base_url,
            model: settings.model,
            api_key_configured,
        })
    }

    pub fn save_settings(
        &self,
        settings: LlmSettings,
        api_key: &str,
        clear_api_key: bool,
    ) -> Result<LlmSettingsView, String> {
        let settings = validate_settings(settings)?;
        if !api_key.is_empty() && api_key.trim().is_empty() {
            return Err("invalid_api_key".into());
        }
        if clear_api_key {
            if settings.provider == LlmProvider::Ollama {
                return Err("invalid_api_key".into());
            }
            let entry = key_entry(&settings.provider)?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(_) => return Err("credential_store_unavailable".into()),
            }
        } else if settings.provider != LlmProvider::Ollama && !api_key.trim().is_empty() {
            if api_key.len() > 4_096 || api_key.chars().any(char::is_control) {
                return Err("invalid_api_key".into());
            }
            key_entry(&settings.provider)?
                .set_password(api_key.trim())
                .map_err(|_| "credential_store_unavailable")?;
        }

        write_settings(&self.settings_path, &settings)?;
        *self
            .settings
            .write()
            .map_err(|_| "llm_settings_unavailable")? = settings;
        self.cancel();
        self.settings()
    }

    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn test_connection(&self) -> Result<(), String> {
        self.respond("请只回复：连接成功").map(|_| ())
    }

    pub fn respond(&self, input: &str) -> Result<String, String> {
        let prompt = input.trim();
        if prompt.is_empty() || prompt.chars().count() > MAX_INPUT_CODE_POINTS {
            return Err("invalid_voice_prompt".into());
        }
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("busy".into());
        }
        let _busy = BusyGuard(&self.busy);
        let generation = self.generation.load(Ordering::SeqCst);
        let settings = self
            .settings
            .read()
            .map_err(|_| "llm_settings_unavailable")?
            .clone();
        let api_key = match &settings.provider {
            LlmProvider::Ollama => None,
            _ => Some(key_entry(&settings.provider)?.get_password().map_err(
                |error| match error {
                    keyring::Error::NoEntry => "llm_api_key_missing",
                    _ => "credential_store_unavailable",
                },
            )?),
        };
        let endpoint = settings.endpoint()?;
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout_connect(Duration::from_secs(5))
            .timeout_read(Duration::from_millis(100))
            .timeout_write(Duration::from_secs(5))
            .build();
        let mut request = agent.post(&endpoint);
        if let Some(api_key) = api_key.as_deref() {
            request = request.set("Authorization", &["Bearer ", api_key].concat());
        }
        let response = request.send_json(settings.request_body(prompt));
        let response = match response {
            Ok(response) => response,
            Err(ureq::Error::Status(401 | 403, _)) => return Err("llm_auth_failed".into()),
            Err(ureq::Error::Status(404, _)) => return Err("model_unavailable".into()),
            Err(ureq::Error::Status(_, _)) | Err(ureq::Error::Transport(_)) => {
                return Err("llm_unavailable".into())
            }
        };
        let mut reader = response.into_reader();
        let mut bytes = [0u8; 4096];
        let mut line = Vec::new();
        let mut output = String::new();
        let mut done = false;
        let deadline = Instant::now() + Duration::from_secs(MAX_REQUEST_SECONDS);
        loop {
            if self.generation.load(Ordering::SeqCst) != generation {
                return Err("cancelled".into());
            }
            if Instant::now() >= deadline {
                return Err("llm_timeout".into());
            }
            match reader.read(&mut bytes) {
                Ok(0) => {
                    if !line.is_empty() {
                        done = process_line(&line, &settings.provider, &mut output)?;
                    }
                    break;
                }
                Ok(count) => {
                    for byte in &bytes[..count] {
                        if *byte == b'\n' {
                            done = process_line(&line, &settings.provider, &mut output)?;
                            line.clear();
                            if done {
                                break;
                            }
                        } else {
                            line.push(*byte);
                            if line.len() > 16 * 1024 {
                                return Err("local_llm_failed".into());
                            }
                        }
                    }
                    if done {
                        break;
                    }
                }
                Err(error)
                    if error.kind() == ErrorKind::TimedOut
                        || error.kind() == ErrorKind::WouldBlock
                        || error.kind() == ErrorKind::Interrupted =>
                {
                    continue;
                }
                Err(_) => return Err("local_llm_failed".into()),
            }
        }
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err("cancelled".into());
        }
        if !done {
            return Err("local_llm_failed".into());
        }
        let answer = output.trim().to_string();
        if answer.is_empty() {
            return Err("local_llm_failed".into());
        }
        Ok(answer)
    }
}

impl LlmSettings {
    fn endpoint(&self) -> Result<String, String> {
        let validated = validate_settings(self.clone())?;
        let base = validated.base_url.trim_end_matches('/');
        Ok(match &validated.provider {
            LlmProvider::Ollama if base.ends_with("/api/chat") => base.into(),
            LlmProvider::Ollama => format!("{base}/api/chat"),
            LlmProvider::Deepseek if base.ends_with("/chat/completions") => base.into(),
            LlmProvider::Deepseek => format!("{base}/chat/completions"),
            LlmProvider::OpenaiCompatible if base.ends_with("/chat/completions") => base.into(),
            LlmProvider::OpenaiCompatible if base.ends_with("/v1") => {
                format!("{base}/chat/completions")
            }
            LlmProvider::OpenaiCompatible => format!("{base}/v1/chat/completions"),
        })
    }

    fn request_body(&self, prompt: &str) -> Value {
        let mut body = json!({
            "model": self.model,
            "stream": true,
            "messages": [
                {
                    "role": "system",
                    "content": "你是器灵，一个友善的中文桌面助手。用简短中文回答，不要声称已查看屏幕、文件或执行过操作。你不能调用工具或控制电脑。回答限制在400个Unicode码点以内。"
                },
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.6
        });
        if self.provider == LlmProvider::Ollama {
            body["options"] = json!({"num_predict": 240});
        } else {
            body["max_tokens"] = json!(400);
        }
        body
    }
}

fn validate_settings(mut settings: LlmSettings) -> Result<LlmSettings, String> {
    settings.base_url = settings.base_url.trim().trim_end_matches('/').to_string();
    settings.model = settings.model.trim().to_string();
    if settings.model.is_empty()
        || settings.model.len() > 128
        || settings.model.chars().any(char::is_control)
    {
        return Err("invalid_llm_model".into());
    }
    if settings.provider == LlmProvider::Deepseek {
        settings.base_url = DEFAULT_DEEPSEEK_URL.into();
    }
    let url = Url::parse(&settings.base_url).map_err(|_| "invalid_llm_url")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid_llm_url".into());
    }
    let host = url.host_str().ok_or("invalid_llm_url")?;
    match &settings.provider {
        LlmProvider::Ollama => {
            let loopback = host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .map(|address| address.is_loopback())
                    .unwrap_or(false);
            if url.scheme() != "http" || !loopback {
                return Err("ollama_must_use_loopback".into());
            }
        }
        LlmProvider::Deepseek | LlmProvider::OpenaiCompatible => {
            if url.scheme() != "https" || host.parse::<std::net::IpAddr>().is_ok() {
                return Err("cloud_llm_requires_https".into());
            }
        }
    }
    Ok(settings)
}

fn key_entry(provider: &LlmProvider) -> Result<Entry, String> {
    let user = match provider {
        LlmProvider::Ollama => return Err("invalid_api_key".into()),
        LlmProvider::Deepseek => "llm-api-key-deepseek",
        LlmProvider::OpenaiCompatible => "llm-api-key-openai-compatible",
    };
    Entry::new(KEYRING_SERVICE, user).map_err(|_| "credential_store_unavailable".into())
}

fn read_settings(path: &Path) -> Result<LlmSettings, String> {
    if !path.exists() {
        let mut settings = LlmSettings::default();
        if let Ok(model) = env::var("QILING_LOCAL_LLM_MODEL") {
            settings.model = model;
        }
        return validate_settings(settings);
    }
    let contents = fs::read_to_string(path).map_err(|_| "llm_settings_unavailable")?;
    let persisted: PersistedSettings =
        serde_json::from_str(&contents).map_err(|_| "llm_settings_invalid")?;
    validate_settings(LlmSettings {
        provider: persisted.provider,
        base_url: persisted.base_url,
        model: persisted.model,
    })
}

fn write_settings(path: &Path, settings: &LlmSettings) -> Result<(), String> {
    let parent = path.parent().ok_or("llm_settings_unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "llm_settings_unavailable")?;
    let contents = serde_json::to_vec(&PersistedSettings::from(settings))
        .map_err(|_| "llm_settings_unavailable")?;
    fs::write(path, contents).map_err(|_| "llm_settings_unavailable")?;
    Ok(())
}

struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn process_line(line: &[u8], provider: &LlmProvider, output: &mut String) -> Result<bool, String> {
    let line = std::str::from_utf8(line)
        .map_err(|_| "local_llm_failed")?
        .trim();
    let data = match line.strip_prefix("data:") {
        Some(data) => data.trim(),
        None => line,
    };
    if data.is_empty() {
        return Ok(false);
    }
    if line.starts_with(':') || line.starts_with("event:") || line.starts_with("id:") {
        return Ok(false);
    }
    if data == "[DONE]" {
        return Ok(true);
    }
    let value: Value = serde_json::from_str(data).map_err(|_| "local_llm_failed")?;
    let fragment = match provider {
        LlmProvider::Ollama => value.pointer("/message/content").and_then(Value::as_str),
        LlmProvider::Deepseek | LlmProvider::OpenaiCompatible => value
            .pointer("/choices/0/delta/content")
            .or_else(|| value.pointer("/choices/0/message/content"))
            .and_then(Value::as_str),
    };
    if let Some(fragment) = fragment {
        output.push_str(fragment);
        if output.chars().count() > MAX_OUTPUT_CODE_POINTS {
            return Err("response_too_large".into());
        }
    }
    let ollama_done = value.get("done").and_then(Value::as_bool) == Some(true);
    let compatible_done = value
        .pointer("/choices/0/finish_reason")
        .is_some_and(|reason| !reason.is_null());
    Ok(ollama_done || compatible_done)
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };

    use super::{
        process_line, validate_settings, LlmProvider, LlmSettings, LocalLlm, DEFAULT_DEEPSEEK_URL,
    };

    fn server(response_body: String) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut headers = Vec::new();
            let mut byte = [0u8; 1];
            while !headers.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            let content_length = headers
                .split(|byte| *byte == b'\n')
                .find_map(|line| {
                    let line = std::str::from_utf8(line).ok()?.trim();
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            let mut body = vec![0; content_length];
            stream.read_exact(&mut body).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .unwrap();
        });
        (format!("http://{address}/api/chat"), handle)
    }

    #[test]
    fn voice_response_uses_the_local_streaming_model_and_returns_its_answer() {
        let body = concat!(
            "{\"message\":{\"content\":\"本机回答\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"。\"},\"done\":true}\n"
        );
        let (endpoint, server) = server(body.into());
        let model = LocalLlm::for_test(endpoint);

        assert_eq!(model.respond("你好").unwrap(), "本机回答。");
        server.join().unwrap();
    }

    #[test]
    fn openai_compatible_stream_extracts_delta_and_done_marker() {
        let mut output = String::new();

        assert!(!process_line(
            r#"data: {"choices":[{"delta":{"content":"云端"}}]}"#.as_bytes(),
            &LlmProvider::Deepseek,
            &mut output,
        )
        .unwrap());
        assert_eq!(
            process_line(b"data: [DONE]", &LlmProvider::Deepseek, &mut output).unwrap(),
            true
        );
        assert_eq!(output, "云端");
    }

    #[test]
    fn cloud_configuration_requires_https_and_ollama_stays_on_loopback() {
        let deepseek = LlmSettings {
            provider: LlmProvider::Deepseek,
            base_url: "https://ignored.example".into(),
            model: "deepseek-chat".into(),
        };
        assert_eq!(
            validate_settings(deepseek).unwrap().base_url,
            DEFAULT_DEEPSEEK_URL
        );

        let custom = LlmSettings {
            provider: LlmProvider::OpenaiCompatible,
            base_url: "http://example.test/v1".into(),
            model: "model".into(),
        };
        assert_eq!(
            validate_settings(custom).unwrap_err(),
            "cloud_llm_requires_https"
        );

        let remote_ollama = LlmSettings {
            provider: LlmProvider::Ollama,
            base_url: "http://example.test".into(),
            model: "model".into(),
        };
        assert_eq!(
            validate_settings(remote_ollama).unwrap_err(),
            "ollama_must_use_loopback"
        );
    }

    #[test]
    fn provider_endpoints_follow_their_chat_completion_contracts() {
        let ollama = LlmSettings::default();
        assert_eq!(
            ollama.endpoint().unwrap(),
            "http://127.0.0.1:11434/api/chat"
        );

        let deepseek = LlmSettings {
            provider: LlmProvider::Deepseek,
            base_url: DEFAULT_DEEPSEEK_URL.into(),
            model: "deepseek-chat".into(),
        };
        assert_eq!(
            deepseek.endpoint().unwrap(),
            "https://api.deepseek.com/chat/completions"
        );

        let compatible = LlmSettings {
            provider: LlmProvider::OpenaiCompatible,
            base_url: "https://models.example.test/v1".into(),
            model: "example-model".into(),
        };
        assert_eq!(
            compatible.endpoint().unwrap(),
            "https://models.example.test/v1/chat/completions"
        );
    }

    #[test]
    fn cancelling_a_stream_discards_a_late_local_model_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let first = "{\"message\":{\"content\":\"稍后回答\"},\"done\":false}\n";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: keep-alive\r\n\r\n{first}"
            )
            .unwrap();
            started_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(300));
        });
        let model = std::sync::Arc::new(LocalLlm::for_test(format!("http://{address}/api/chat")));
        let worker_model = std::sync::Arc::clone(&model);
        let worker = thread::spawn(move || worker_model.respond("你好"));

        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        model.cancel();
        assert_eq!(worker.join().unwrap().unwrap_err(), "cancelled");
        server.join().unwrap();
    }

    #[test]
    fn voice_input_is_bounded_before_it_reaches_the_local_model() {
        let model = LocalLlm::for_test("http://127.0.0.1:1/api/chat".into());

        assert_eq!(
            model.respond(&"你".repeat(2_001)).unwrap_err(),
            "invalid_voice_prompt"
        );
        assert_eq!(model.respond(" \n ").unwrap_err(), "invalid_voice_prompt");
    }
}
