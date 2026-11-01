use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const KWS_MODEL: &str = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20";
const ASR_MODEL: &str = "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30";

pub struct VoiceAssistantHost {
    script: PathBuf,
    data_dir: PathBuf,
    child: Mutex<Option<Child>>,
    active_wake_word: Mutex<Option<String>>,
    current_state: Arc<Mutex<String>>,
    generation: Arc<AtomicU64>,
}

impl VoiceAssistantHost {
    pub fn new(script: PathBuf, data_dir: PathBuf) -> Self {
        Self {
            script,
            data_dir,
            child: Mutex::new(None),
            active_wake_word: Mutex::new(None),
            current_state: Arc::new(Mutex::new("stopped".into())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn start(&self, app: AppHandle, wake_word: &str) -> Result<(), String> {
        if !is_valid_wake_word(wake_word) {
            return Err("wake_word_invalid".into());
        }
        let python = python_path(&self.data_dir)?;
        let voice_home = self.data_dir.join("voice-assistant");
        let kws_dir = voice_home.join("models").join(KWS_MODEL);
        let asr_dir = voice_home.join("models").join(ASR_MODEL);

        if !self.script.is_file() {
            return Err("voice_runtime_not_installed".into());
        }
        for path in [
            kws_dir.join("tokens.txt"),
            kws_dir.join("encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"),
            kws_dir.join("decoder-epoch-13-avg-2-chunk-16-left-64.onnx"),
            kws_dir.join("joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx"),
            asr_dir.join("tokens.txt"),
            asr_dir.join("encoder.int8.onnx"),
            asr_dir.join("decoder.onnx"),
            asr_dir.join("joiner.int8.onnx"),
        ] {
            if !path.is_file() {
                return Err("voice_model_missing".into());
            }
        }

        let mut child_guard = self
            .child
            .lock()
            .map_err(|_| "voice_assistant_unavailable")?;
        if let Some(child) = child_guard.as_mut() {
            if child
                .try_wait()
                .map_err(|_| "voice_assistant_unavailable")?
                .is_none()
            {
                let active_wake_word = self
                    .active_wake_word
                    .lock()
                    .map_err(|_| "voice_assistant_unavailable")?;
                if active_wake_word.as_deref() == Some(wake_word) {
                    return Ok(());
                }
            }
        }
        if let Some(mut child) = child_guard.take() {
            self.generation.fetch_add(1, Ordering::SeqCst);
            if child
                .try_wait()
                .map_err(|_| "voice_assistant_unavailable")?
                .is_none()
            {
                child
                    .kill()
                    .and_then(|_| child.wait().map(|_| ()))
                    .map_err(|_| "voice_assistant_stop_failed")?;
            }
        }
        *self
            .active_wake_word
            .lock()
            .map_err(|_| "voice_assistant_unavailable")? = None;

        let mut child = Command::new(python)
            .arg(&self.script)
            .arg("--kws-dir")
            .arg(&kws_dir)
            .arg("--asr-dir")
            .arg(&asr_dir)
            .arg("--wake-word")
            .arg(wake_word)
            .arg("--keywords")
            .arg(voice_home.join("keywords.txt"))
            .arg("--log-file")
            .arg(voice_home.join("voice-assistant.log"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "voice_runtime_start_failed")?;
        let stdout = child.stdout.take().ok_or("voice_runtime_start_failed")?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let active_generation = Arc::clone(&self.generation);
        *child_guard = Some(child);
        *self
            .active_wake_word
            .lock()
            .map_err(|_| "voice_assistant_unavailable")? = Some(wake_word.to_string());
        set_current_state(&self.current_state, "starting")?;
        let current_state = Arc::clone(&self.current_state);
        drop(child_guard);

        emit_event(&app, json!({"type": "state", "state": "starting"}));
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut reported_error = false;
            for line in reader.lines() {
                if generation != active_generation.load(Ordering::SeqCst) {
                    return;
                }
                match line {
                    Ok(line) => match serde_json::from_str::<Value>(&line) {
                        Ok(event) if event.is_object() => {
                            reported_error |=
                                event.get("type").and_then(Value::as_str) == Some("error");
                            if let Some(state) = state_from_event(&event) {
                                if set_current_state(&current_state, state).is_err() {
                                    emit_event(
                                        &app,
                                        json!({"type": "error", "code": "voice_assistant_unavailable"}),
                                    );
                                }
                            } else if event.get("type").and_then(Value::as_str) == Some("error") {
                                let _ = set_current_state(&current_state, "error");
                            }
                            emit_event(&app, event);
                        }
                        _ => {
                            reported_error = true;
                            let _ = set_current_state(&current_state, "error");
                            emit_event(
                                &app,
                                json!({"type": "error", "code": "voice_runtime_protocol_error"}),
                            );
                        }
                    },
                    Err(_) => {
                        let _ = set_current_state(&current_state, "error");
                        emit_event(
                            &app,
                            json!({"type": "error", "code": "voice_runtime_output_failed"}),
                        );
                        return;
                    }
                }
            }
            if let Some(event) = runtime_stopped_event(
                generation == active_generation.load(Ordering::SeqCst),
                reported_error,
            ) {
                let _ = set_current_state(&current_state, "error");
                emit_event(&app, event);
            }
        });
        Ok(())
    }

    pub fn current_state(&self) -> Result<String, String> {
        self.current_state
            .lock()
            .map(|state| state.clone())
            .map_err(|_| "voice_assistant_unavailable".into())
    }

    pub fn cancel(&self) -> Result<(), String> {
        let mut child_guard = self
            .child
            .lock()
            .map_err(|_| "voice_assistant_unavailable")?;
        let child = child_guard.as_mut().ok_or("voice_assistant_unavailable")?;
        if child
            .try_wait()
            .map_err(|_| "voice_assistant_unavailable")?
            .is_some()
        {
            *child_guard = None;
            return Err("voice_assistant_unavailable".into());
        }
        let stdin = child.stdin.as_mut().ok_or("voice_assistant_unavailable")?;
        stdin
            .write_all(b"cancel\n")
            .and_then(|_| stdin.flush())
            .map_err(|_| "voice_assistant_cancel_failed".into())
    }

    pub fn listen(&self) -> Result<(), String> {
        let mut child_guard = self
            .child
            .lock()
            .map_err(|_| "voice_assistant_unavailable")?;
        let child = child_guard.as_mut().ok_or("voice_assistant_unavailable")?;
        if child
            .try_wait()
            .map_err(|_| "voice_assistant_unavailable")?
            .is_some()
        {
            *child_guard = None;
            return Err("voice_assistant_unavailable".into());
        }
        let stdin = child.stdin.as_mut().ok_or("voice_assistant_unavailable")?;
        stdin
            .write_all(b"listen\n")
            .and_then(|_| stdin.flush())
            .map_err(|_| "voice_assistant_listen_failed".into())
    }

    pub fn is_running(&self) -> Result<bool, String> {
        let mut child_guard = self
            .child
            .lock()
            .map_err(|_| "voice_assistant_unavailable")?;
        let Some(child) = child_guard.as_mut() else {
            return Ok(false);
        };
        if child
            .try_wait()
            .map_err(|_| "voice_assistant_unavailable")?
            .is_some()
        {
            *child_guard = None;
            *self
                .active_wake_word
                .lock()
                .map_err(|_| "voice_assistant_unavailable")? = None;
            Ok(false)
        } else {
            Ok(true)
        }
    }

    pub fn stop(&self) -> Result<(), String> {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let mut child_guard = self
            .child
            .lock()
            .map_err(|_| "voice_assistant_unavailable")?;
        if let Some(mut child) = child_guard.take() {
            if child
                .try_wait()
                .map_err(|_| "voice_assistant_stop_failed")?
                .is_none()
            {
                child.kill().map_err(|_| "voice_assistant_stop_failed")?;
                child.wait().map_err(|_| "voice_assistant_stop_failed")?;
            }
        }
        *self
            .active_wake_word
            .lock()
            .map_err(|_| "voice_assistant_unavailable")? = None;
        set_current_state(&self.current_state, "stopped")?;
        Ok(())
    }

    pub fn shutdown(&self) {
        let _ = self.stop();
    }
}

fn emit_event(app: &AppHandle, event: Value) {
    let _ = app.emit("voice-assistant-event", event);
}

fn state_from_event(event: &Value) -> Option<&str> {
    (event.get("type")?.as_str()? == "state")
        .then(|| event.get("state")?.as_str())
        .flatten()
}

fn set_current_state(current_state: &Mutex<String>, state: &str) -> Result<(), String> {
    *current_state
        .lock()
        .map_err(|_| "voice_assistant_unavailable")? = state.to_string();
    Ok(())
}

fn runtime_stopped_event(generation_is_active: bool, reported_error: bool) -> Option<Value> {
    (generation_is_active && !reported_error)
        .then(|| json!({"type": "error", "code": "voice_runtime_stopped"}))
}

fn is_valid_wake_word(wake_word: &str) -> bool {
    (2..=8).contains(&wake_word.chars().count())
        && wake_word
            .chars()
            .all(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
}

fn python_path(data_dir: &Path) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("QILING_VOICE_PYTHON") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err("voice_runtime_not_installed".into());
    }
    #[cfg(windows)]
    let python = data_dir
        .join("voice-assistant")
        .join(".venv")
        .join("Scripts")
        .join("python.exe");
    #[cfg(not(windows))]
    let python = data_dir
        .join("voice-assistant")
        .join(".venv")
        .join("bin")
        .join("python");
    if python.is_file() {
        Ok(python)
    } else {
        Err("voice_runtime_not_installed".into())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{is_valid_wake_word, runtime_stopped_event, set_current_state, state_from_event};

    #[test]
    fn accepts_only_short_chinese_wake_phrases() {
        assert!(is_valid_wake_word("小助手"));
        assert!(is_valid_wake_word("器灵"));
        assert!(!is_valid_wake_word("器"));
        assert!(!is_valid_wake_word("小助手123"));
        assert!(!is_valid_wake_word("小 助手"));
        assert!(!is_valid_wake_word("小助手小助手小助手"));
    }

    #[test]
    fn reports_unexpected_exit_without_overwriting_runtime_error() {
        assert!(runtime_stopped_event(true, false).is_some());
        assert!(runtime_stopped_event(true, true).is_none());
        assert!(runtime_stopped_event(false, false).is_none());
    }

    #[test]
    fn reads_the_latest_runtime_state_for_late_subscribers() {
        let state = std::sync::Mutex::new("starting".to_string());
        let event = json!({"type": "state", "state": "wake_acknowledgment"});

        set_current_state(&state, state_from_event(&event).unwrap()).unwrap();

        assert_eq!(*state.lock().unwrap(), "wake_acknowledgment");
        assert_eq!(state_from_event(&json!({"type": "transcript"})), None);
    }
}
