#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cosyvoice;
mod http;
mod local_llm;
mod spirit;
mod voice;
mod voice_assistant;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::utils::config::{BackgroundThrottlingPolicy, Color};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Runtime, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const PET_FALLBACK_W: f64 = 210.0;
const PET_FALLBACK_H: f64 = 270.0;
const BUBBLE_GAP: f64 = 16.0;

pub struct AppState {
    pet_placed: AtomicBool,
    voice: Arc<cosyvoice::VoiceHost>,
    voice_assistant: Arc<voice_assistant::VoiceAssistantHost>,
    local_llm: Arc<local_llm::LocalLlm>,
    protocol: Arc<spirit::PairingManager>,
}

fn place_pet(pet: &WebviewWindow) {
    let Ok(Some(monitor)) = pet.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return;
    }
    let screen_w = monitor.size().width as f64 / scale;
    let screen_h = monitor.size().height as f64 / scale;
    let origin_x = monitor.position().x as f64 / scale;
    let origin_y = monitor.position().y as f64 / scale;
    let (mut win_w, mut win_h) = pet
        .outer_size()
        .map(|size| (size.width as f64 / scale, size.height as f64 / scale))
        .unwrap_or((0.0, 0.0));
    if win_w < 80.0 {
        win_w = PET_FALLBACK_W;
    }
    if win_h < 80.0 {
        win_h = PET_FALLBACK_H;
    }
    let x = origin_x + screen_w - win_w - 24.0;
    let y = origin_y + (screen_h - win_h) * 0.58;
    let _ = pet.set_position(LogicalPosition::new(
        x.max(origin_x + 8.0),
        y.max(origin_y + 8.0),
    ));
}

fn hide_bubble(app: &AppHandle) {
    if let Some(bubble) = app.get_webview_window("bubble") {
        let _ = bubble.hide();
    }
}

fn bubble_size(width: f64, height: f64) -> (f64, f64) {
    (width.clamp(160.0, 280.0), height.clamp(72.0, 220.0))
}

fn bubble_origin(
    pet_x: i32,
    pet_y: i32,
    pet_w: i32,
    bubble_w: i32,
    bubble_h: i32,
    gap: i32,
) -> (i32, i32) {
    (pet_x + (pet_w - bubble_w) / 2, pet_y - bubble_h - gap)
}

fn glue_bubble(pet: &WebviewWindow, bubble: &WebviewWindow, bubble_w: i32, bubble_h: i32) {
    let Ok(pet_pos) = pet.outer_position() else {
        return;
    };
    let Ok(pet_size) = pet.outer_size() else {
        return;
    };
    let Ok(scale) = pet.scale_factor() else {
        return;
    };
    if scale <= 0.0 {
        return;
    }
    let gap = (BUBBLE_GAP * scale).round() as i32;
    let (x, y) = bubble_origin(
        pet_pos.x,
        pet_pos.y,
        pet_size.width as i32,
        bubble_w,
        bubble_h,
        gap,
    );
    let _ = bubble.set_position(PhysicalPosition::new(x, y));
}

#[tauri::command]
fn pet_set_open(app: AppHandle, state: State<AppState>, open: bool) -> Result<bool, String> {
    let pet = app.get_webview_window("pet").ok_or("没有器灵窗口")?;
    if open {
        if !state.pet_placed.swap(true, Ordering::SeqCst) {
            place_pet(&pet);
        }
        pet.set_always_on_top(true).map_err(|err| err.to_string())?;
        pet.show().map_err(|err| err.to_string())?;
    } else {
        state.local_llm.cancel();
        state.voice.cancel();
        state.voice_assistant.stop()?;
        let _ = app.emit("qiling-interrupt", ());
        let _ = app.emit(
            "voice-assistant-event",
            serde_json::json!({ "type": "state", "state": "stopped" }),
        );
        hide_bubble(&app);
        pet.hide().map_err(|err| err.to_string())?;
    }
    let _ = app.emit("pet-visibility", open);
    Ok(open)
}

#[tauri::command]
fn pet_is_open(app: AppHandle) -> bool {
    app.get_webview_window("pet")
        .and_then(|pet| pet.is_visible().ok())
        .unwrap_or(false)
}

#[tauri::command]
fn bubble_present(app: AppHandle, open: bool, width: f64, height: f64) -> Result<(), String> {
    let bubble = app.get_webview_window("bubble").ok_or("没有气泡窗口")?;
    let pet_open = app
        .get_webview_window("pet")
        .and_then(|pet| pet.is_visible().ok())
        .unwrap_or(false);
    if !open || !pet_open {
        bubble.hide().map_err(|err| err.to_string())?;
        return Ok(());
    }
    let (width, height) = bubble_size(width, height);
    bubble
        .set_size(LogicalSize::new(width, height))
        .map_err(|err| err.to_string())?;
    if let Some(pet) = app.get_webview_window("pet") {
        let scale = pet.scale_factor().unwrap_or(1.0);
        let scale = if scale <= 0.0 { 1.0 } else { scale };
        glue_bubble(
            &pet,
            &bubble,
            (width * scale).round() as i32,
            (height * scale).round() as i32,
        );
    }
    bubble.show().map_err(|err| err.to_string())
}

fn create_bubble<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let Some(pet) = app.get_webview_window("pet") else {
        return Ok(());
    };
    let mut builder =
        WebviewWindowBuilder::new(app, "bubble", WebviewUrl::App("index.html".into()))
            .title("器灵")
            .inner_size(210.0, 120.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .focused(false)
            .focusable(true)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .shadow(false)
            .visible(false)
            .no_redirection_bitmap(true)
            .zoom_hotkeys_enabled(false)
            .background_color(Color(0, 0, 0, 0))
            .background_throttling(BackgroundThrottlingPolicy::Disabled);
    #[cfg(windows)]
    {
        builder = builder.owner(&pet)?;
    }
    #[cfg(not(windows))]
    {
        builder = builder.parent(&pet)?;
    }
    builder.build()?;
    Ok(())
}

#[tauri::command]
fn qiling_voice_status(state: State<AppState>) -> voice::VoiceReport {
    state.voice.status()
}

#[tauri::command]
async fn qiling_voice_synthesize(
    state: State<'_, AppState>,
    text: String,
    on_chunk: tauri::ipc::Channel<cosyvoice::VoiceChunk>,
) -> Result<(), String> {
    let voice = Arc::clone(&state.voice);
    tauri::async_runtime::spawn_blocking(move || voice.synthesize(&text, on_chunk))
        .await
        .map_err(|err| format!("failed:{err}"))?
}

#[tauri::command]
fn qiling_voice_cancel(state: State<AppState>) {
    state.voice.cancel();
}

#[tauri::command]
fn qiling_llm_get_settings(state: State<AppState>) -> Result<local_llm::LlmSettingsView, String> {
    state.local_llm.settings()
}

#[tauri::command]
fn qiling_llm_save_settings(
    state: State<AppState>,
    provider: local_llm::LlmProvider,
    base_url: String,
    model: String,
    api_key: String,
    clear_api_key: bool,
) -> Result<local_llm::LlmSettingsView, String> {
    state.local_llm.save_settings(
        local_llm::LlmSettings {
            provider,
            base_url,
            model,
        },
        &api_key,
        clear_api_key,
    )
}

#[tauri::command]
async fn qiling_llm_test_connection(state: State<'_, AppState>) -> Result<(), String> {
    let llm = Arc::clone(&state.local_llm);
    tauri::async_runtime::spawn_blocking(move || llm.test_connection())
        .await
        .map_err(|error| format!("llm_test_failed:{error}"))?
}

#[tauri::command]
fn qiling_voice_assistant_start(
    app: AppHandle,
    state: State<AppState>,
    wake_word: String,
) -> Result<(), String> {
    match state.voice_assistant.start(app.clone(), &wake_word) {
        Ok(()) => Ok(()),
        Err(code) => {
            let _ = app.emit(
                "voice-assistant-event",
                serde_json::json!({ "type": "error", "code": code }),
            );
            Err(code)
        }
    }
}

#[tauri::command]
fn qiling_voice_assistant_status(state: State<AppState>) -> Result<String, String> {
    state.voice_assistant.current_state()
}

#[tauri::command]
fn qiling_voice_assistant_cancel(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    state.local_llm.cancel();
    state.voice.cancel();
    app.emit("qiling-interrupt", ())
        .map_err(|error| format!("voice_interrupt_failed:{error}"))?;
    state.voice_assistant.cancel()
}

#[tauri::command]
fn qiling_voice_assistant_listen(state: State<AppState>) -> Result<(), String> {
    state.voice_assistant.listen()
}

#[tauri::command]
fn qiling_voice_assistant_stop(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    state.local_llm.cancel();
    state.voice.cancel();
    app.emit("qiling-interrupt", ())
        .map_err(|error| format!("voice_interrupt_failed:{error}"))?;
    state.voice_assistant.stop()?;
    app.emit(
        "voice-assistant-event",
        serde_json::json!({ "type": "state", "state": "stopped" }),
    )
    .map_err(|error| format!("voice_status_feedback_failed:{error}"))
}

#[tauri::command]
async fn qiling_voice_assistant_respond(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Result<(), String> {
    if !state.voice_assistant.is_running()? {
        return Err("voice_assistant_unavailable".into());
    }
    let transcript = text.trim().to_string();
    if transcript.is_empty() || transcript.chars().count() > 2_000 {
        return Err("invalid_voice_prompt".into());
    }
    app.emit(
        "qiling-line",
        serde_json::json!({ "phase": "thinking", "text": "", "mood": "neutral" }),
    )
    .map_err(|error| format!("voice_feedback_failed:{error}"))?;
    let llm = Arc::clone(&state.local_llm);
    let response = tauri::async_runtime::spawn_blocking(move || llm.respond(&transcript))
        .await
        .map_err(|_| "local_llm_failed".to_string())?;
    match response {
        Ok(text) => app
            .emit(
                "qiling-line",
                serde_json::json!({ "phase": "say", "text": text, "mood": "neutral" }),
            )
            .map_err(|error| format!("voice_feedback_failed:{error}")),
        Err(code) => {
            let message = match code.as_str() {
                "cancelled" => "已取消本轮语音对话。",
                "model_unavailable" => "所选语言模型不存在，请检查服务商和模型名称。",
                "invalid_voice_prompt" => "识别到的语音内容为空或过长，请重新说一次。",
                "response_too_large" => "模型回答太长，请缩短问题后重试。",
                "busy" => "器灵正在回答上一条语音，请稍后再试。",
                "llm_api_key_missing" => "尚未配置所选云端模型的 API 密钥，请先到设定页保存密钥。",
                "llm_auth_failed" => "语言模型 API 密钥无效或已失效，请检查设定。",
                "llm_timeout" => "等待语言模型响应超时，请检查网络和模型服务后重试。",
                "credential_store_unavailable" => {
                    "无法访问 Windows 凭据管理器，请检查系统凭据服务。"
                }
                _ => "语言模型服务暂时不可用，请检查设定和服务状态。",
            };
            let _ = app.emit(
                "qiling-line",
                serde_json::json!({ "phase": "say", "text": message, "mood": "down" }),
            );
            Err(code)
        }
    }
}

#[tauri::command]
async fn spirit_invoke_vscode_explain_selection(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    app.emit(
        "qiling-line",
        serde_json::json!({ "phase": "thinking", "text": "", "mood": "neutral" }),
    )
    .map_err(|error| format!("narration_feedback_unavailable:{error}"))?;
    match state
        .protocol
        .invoke_action(
            "com.qiling.vscode",
            "vscode.explain_selection",
            spirit::DEFAULT_ACTION_TIMEOUT,
        )
        .await
    {
        Ok(result) => app
            .emit(
                "qiling-line",
                serde_json::json!({
                    "phase": "say",
                    "text": result.text,
                    "mood": result.mood
                }),
            )
            .map_err(|error| format!("narration_display_failed:{error}")),
        Err(code) => {
            let message = match code.as_str() {
                "client_unavailable" => "VS Code 当前未连接，暂时无法解释选区。",
                "action_not_found" | "not_authorized" => "VS Code 尚未获准提供选区解释能力。",
                "busy" => "VS Code 正在处理另一条解释请求，请稍后再试。",
                "selection_unavailable" => "VS Code 当前没有可解释的选区。",
                "selection_too_large" => "当前选区太长，请缩小选区后再试。",
                "model_unavailable" => "VS Code 当前没有可用且已授权的语言模型。",
                "cancelled" => "已取消本次选区解释。",
                "deadline_exceeded" => "解释选区超时，请稍后重试。",
                _ => "解释选区失败，请检查 VS Code 状态后重试。",
            };
            let _ = app.emit(
                "qiling-line",
                serde_json::json!({ "phase": "say", "text": message, "mood": "down" }),
            );
            Err(code)
        }
    }
}

#[tauri::command]
fn spirit_start_pairing(state: State<AppState>) -> Result<spirit::PairingCode, String> {
    state.protocol.begin_pairing()
}

#[tauri::command]
fn spirit_pending_pairings(
    state: State<AppState>,
) -> Result<Vec<spirit::PairingRequestView>, String> {
    state.protocol.pending_pairings()
}

#[tauri::command]
fn spirit_approve_pairing(state: State<AppState>, request_id: String) -> Result<(), String> {
    state.protocol.approve_pairing(&request_id)
}

#[tauri::command]
fn spirit_reject_pairing(state: State<AppState>, request_id: String) -> Result<(), String> {
    state.protocol.reject_pairing(&request_id)
}

#[tauri::command]
fn spirit_list_clients(
    state: State<AppState>,
) -> Result<Vec<spirit::AuthorizedClientView>, String> {
    state.protocol.list_clients()
}

#[tauri::command]
fn spirit_revoke_client(state: State<AppState>, client_key: String) -> Result<(), String> {
    state.protocol.revoke_client(&client_key)
}

#[tauri::command]
async fn spirit_invoke_narrate_current(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    app.emit(
        "qiling-line",
        serde_json::json!({ "phase": "thinking", "text": "", "mood": "neutral" }),
    )
    .map_err(|error| format!("narration_feedback_unavailable:{error}"))?;
    match state
        .protocol
        .invoke_narrate_current("com.siju.app", spirit::DEFAULT_ACTION_TIMEOUT)
        .await
    {
        Ok(result) => app
            .emit(
                "qiling-line",
                serde_json::json!({
                    "phase": "say",
                    "text": result.text,
                    "mood": result.mood
                }),
            )
            .map_err(|error| format!("narration_display_failed:{error}")),
        Err(code) => {
            let message = match code.as_str() {
                "client_unavailable" => "识局当前未连接，暂时无法重新解说。",
                "not_authorized" => "识局尚未获准提供重新解说能力。",
                "busy" => "识局正在处理另一条解说请求，请稍后再试。",
                "state_unavailable" => "识局当前没有可用的局面分析。",
                "state_stale" => "局面已经变化，请等待识局更新分析后再试。",
                "summarizer_unavailable" => "识局当前的解说服务不可用，请检查解说设置。",
                "deadline_exceeded" => "重新解说超时，请确认识局状态后再试。",
                _ => "重新解说失败，请检查识局状态后重试。",
            };
            let _ = app.emit(
                "qiling-line",
                serde_json::json!({ "phase": "say", "text": message, "mood": "down" }),
            );
            Err(code)
        }
    }
}

fn open_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("设定")
        .inner_size(460.0, 580.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(true)
        .closable(true)
        .focused(true)
        .decorations(true)
        .always_on_top(false)
        .skip_taskbar(false)
        .transparent(false)
        .visible(true)
        .center()
        .build()
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn pet_menu(app: AppHandle) -> Result<(), String> {
    let settings = MenuItem::with_id(&app, "settings", "设定", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", "退出", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let separator = PredefinedMenuItem::separator(&app).map_err(|err| err.to_string())?;
    let menu =
        Menu::with_items(&app, &[&settings, &separator, &quit]).map_err(|err| err.to_string())?;
    let pet = app.get_webview_window("pet").ok_or("没有器灵窗口")?;
    pet.popup_menu(&menu).map_err(|err| err.to_string())
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let protocol_dir = app.path().app_config_dir()?.join("spirit-clients");
            let llm_settings_path = app.path().app_config_dir()?.join("llm-settings.json");
            let voice_data_dir = app.path().app_data_dir()?;
            let bundled_voice_script = app
                .path()
                .resource_dir()?
                .join("qiling")
                .join("voice_assistant.py");
            let voice_script = if bundled_voice_script.is_file() {
                bundled_voice_script
            } else {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../scripts/voice_assistant.py")
            };
            let protocol = Arc::new(
                spirit::PairingManager::load(protocol_dir)
                    .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?,
            );
            app.manage(AppState {
                pet_placed: AtomicBool::new(true),
                voice: Arc::new(cosyvoice::VoiceHost::new()),
                voice_assistant: Arc::new(voice_assistant::VoiceAssistantHost::new(
                    voice_script,
                    voice_data_dir,
                )),
                local_llm: Arc::new(
                    local_llm::LocalLlm::new(llm_settings_path)
                        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?,
                ),
                protocol: protocol.clone(),
            });
            if let Some(pet) = app.get_webview_window("pet") {
                place_pet(&pet);
                let _ = pet.set_always_on_top(true);
                let _ = pet.show();
            }
            create_bubble(app)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || http::serve(handle, protocol));
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "bubble" => {
                api.prevent_close();
            }
            tauri::WindowEvent::CloseRequested { .. } if window.label() == "pet" => {
                let state = window.app_handle().state::<AppState>();
                state.local_llm.cancel();
                state.voice.cancel();
                state.voice_assistant.shutdown();
                let _ = window.app_handle().emit(
                    "voice-assistant-event",
                    serde_json::json!({ "type": "state", "state": "stopped" }),
                );
                hide_bubble(window.app_handle());
            }
            tauri::WindowEvent::Moved(_) if window.label() == "pet" => {
                let app = window.app_handle();
                let (Some(pet), Some(bubble)) = (
                    app.get_webview_window("pet"),
                    app.get_webview_window("bubble"),
                ) else {
                    return;
                };
                if !bubble.is_visible().unwrap_or(false) {
                    return;
                }
                let Ok(size) = bubble.outer_size() else {
                    return;
                };
                glue_bubble(&pet, &bubble, size.width as i32, size.height as i32);
            }
            _ => {}
        })
        .on_menu_event(|app, event| {
            if event.id() == "settings" {
                let _ = open_settings(app);
            } else if event.id() == "quit" {
                app.exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            pet_set_open,
            pet_is_open,
            qiling_voice_status,
            qiling_voice_synthesize,
            qiling_voice_cancel,
            qiling_voice_assistant_start,
            qiling_llm_get_settings,
            qiling_llm_save_settings,
            qiling_llm_test_connection,
            qiling_voice_assistant_status,
            qiling_voice_assistant_cancel,
            qiling_voice_assistant_listen,
            qiling_voice_assistant_stop,
            qiling_voice_assistant_respond,
            spirit_start_pairing,
            spirit_pending_pairings,
            spirit_approve_pairing,
            spirit_reject_pairing,
            spirit_list_clients,
            spirit_revoke_client,
            spirit_invoke_narrate_current,
            spirit_invoke_vscode_explain_selection,
            bubble_present,
            pet_menu
        ])
        .build(tauri::generate_context!())
        .expect("error while running qiling");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.voice.shutdown();
                state.voice_assistant.shutdown();
                state.local_llm.cancel();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{bubble_origin, bubble_size};

    #[test]
    fn bubble_sits_on_the_pet() {
        assert_eq!(bubble_size(10.0, 10.0), (160.0, 72.0));
        assert_eq!(bubble_size(400.0, 400.0), (280.0, 220.0));
        assert_eq!(bubble_size(210.0, 96.0), (210.0, 96.0));
        assert_eq!(bubble_origin(100, 400, 210, 210, 120, 16), (100, 264));
        assert_eq!(bubble_origin(100, 400, 210, 180, 80, 16), (115, 304));
    }
}
