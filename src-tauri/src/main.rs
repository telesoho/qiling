#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cosyvoice;
mod edge_tts;
mod http;
mod local_llm;
mod music;
mod narration;
mod pet_pack;
mod spirit;
mod voice;
mod voice_assistant;
mod voice_command;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::{BackgroundThrottlingPolicy, Color};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Runtime, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

const PET_FALLBACK_W: f64 = 210.0;
const PET_FALLBACK_H: f64 = 270.0;
const BUBBLE_GAP: f64 = 16.0;
const TRAY_ID: &str = "qiling-tray";

pub struct AppState {
    pet_placed: AtomicBool,
    voice: Arc<cosyvoice::VoiceHost>,
    edge_voice: Arc<edge_tts::EdgeVoiceHost>,
    voice_assistant: Arc<voice_assistant::VoiceAssistantHost>,
    local_llm: Arc<local_llm::LocalLlm>,
    protocol: Arc<spirit::PairingManager>,
    /// Which voice turn owns the speakers; see `voice_assistant::TurnGate`.
    turns: Arc<voice_assistant::TurnGate>,
    /// The last lines other apps asked the pet to read, for "刚才讲了什么".
    narrations: Arc<narration::NarrationLog>,
    /// Installed character resource packs and the active character.
    packs: Arc<pet_pack::PetPackRegistry>,
    /// System audio loopback for the music-following state.
    music: Arc<music::MusicSense>,
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
fn pet_set_open(app: AppHandle, open: bool) -> Result<bool, String> {
    set_pet_open(&app, open)
}

fn set_pet_open(app: &AppHandle, open: bool) -> Result<bool, String> {
    let pet = app.get_webview_window("pet").ok_or("没有器灵窗口")?;
    let state = app.state::<AppState>();
    if open {
        if !state.pet_placed.swap(true, Ordering::SeqCst) {
            place_pet(&pet);
        }
        pet.set_always_on_top(true).map_err(|err| err.to_string())?;
        pet.show().map_err(|err| err.to_string())?;
    } else {
        state.turns.retire();
        state.local_llm.cancel();
        state.voice.cancel();
        state.edge_voice.cancel_all()?;
        // Hidden pet must not keep reading the system output.
        state.music.stop()?;
        let stopped = state.voice_assistant.stop();
        let _ = app.emit("qiling-interrupt", ());
        let _ = app.emit(
            "voice-assistant-event",
            serde_json::json!({ "type": "state", "state": "stopped" }),
        );
        hide_bubble(app);
        pet.hide().map_err(|err| err.to_string())?;
        stopped?;
    }
    let _ = app.emit("pet-visibility", open);
    refresh_tray(app);
    Ok(open)
}

#[tauri::command]
fn pet_is_open(app: AppHandle) -> bool {
    app.get_webview_window("pet")
        .and_then(|pet| pet.is_visible().ok())
        .unwrap_or(false)
}

#[tauri::command]
fn pet_packs_open(app: AppHandle) -> Result<(), String> {
    open_pet_packs(&app)
}

#[tauri::command]
fn pet_packs_list(state: State<AppState>) -> pet_pack::PacksView {
    state.packs.packs_view()
}

#[tauri::command]
fn pet_character_current(state: State<AppState>) -> pet_pack::ActiveCharacter {
    state.packs.active_character()
}

#[tauri::command]
fn qiling_music_sense_start(
    app: AppHandle,
    state: State<AppState>,
) -> Result<bool, String> {
    state.music.start(app)
}

#[tauri::command]
fn qiling_music_sense_stop(state: State<AppState>) -> Result<(), String> {
    state.music.stop()
}

#[tauri::command]
fn qiling_music_sense_status(state: State<AppState>) -> music::MusicSenseStatus {
    state.music.status()
}

#[tauri::command]
async fn pet_pack_load(
    state: State<'_, AppState>,
    pack_id: String,
) -> Result<pet_pack::PackRuntime, String> {
    let packs = Arc::clone(&state.packs);
    tauri::async_runtime::spawn_blocking(move || packs.load_runtime(&pack_id))
        .await
        .map_err(|_| "pack_io_failed".to_string())?
}

#[tauri::command]
async fn pet_pack_install(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    replace: bool,
) -> Result<pet_pack::CharacterSummary, String> {
    let packs = Arc::clone(&state.packs);
    let summary = tauri::async_runtime::spawn_blocking(move || {
        packs.install(std::path::Path::new(&path), replace)
    })
    .await
    .map_err(|_| "pack_io_failed".to_string())??;
    if summary.active {
        // Replacing the active pack keeps the same id but new bytes; the pet
        // window must drop its cached library and images.
        let _ = app.emit(
            "qiling-character-changed",
            pet_pack::ActiveCharacter {
                id: summary.id.clone(),
                name: summary.name.clone(),
                builtin: false,
                renderer: pet_pack::CharacterRenderer::Webp,
            },
        );
    }
    Ok(summary)
}

#[tauri::command]
async fn pet_pack_uninstall(
    app: AppHandle,
    state: State<'_, AppState>,
    pack_id: String,
) -> Result<pet_pack::ActiveCharacter, String> {
    let before = state.packs.active_character();
    let packs = Arc::clone(&state.packs);
    let active = tauri::async_runtime::spawn_blocking(move || packs.uninstall(&pack_id))
        .await
        .map_err(|_| "pack_io_failed".to_string())??;
    if before.id != active.id {
        let _ = app.emit("qiling-character-changed", active.clone());
    }
    Ok(active)
}

#[tauri::command]
async fn pet_pack_set_active(
    app: AppHandle,
    state: State<'_, AppState>,
    pack_id: String,
) -> Result<pet_pack::ActiveCharacter, String> {
    let packs = Arc::clone(&state.packs);
    let active = tauri::async_runtime::spawn_blocking(move || packs.set_active(&pack_id))
        .await
        .map_err(|_| "pack_io_failed".to_string())??;
    let _ = app.emit("qiling-character-changed", active.clone());
    Ok(active)
}

#[tauri::command]
async fn pet_pack_pick_archive(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("器灵角色资源包", &["qilingpet", "zip"]);
    if let Some(window) = app
        .get_webview_window("packs")
        .or_else(|| app.get_webview_window("settings"))
    {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| "pack_io_failed".to_string())?;
    Ok(picked
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
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
async fn qiling_edge_voice_list(
    state: State<'_, AppState>,
) -> Result<Vec<edge_tts::VoiceOption>, String> {
    state.edge_voice.list_voices().await
}

#[tauri::command]
async fn qiling_edge_voice_synthesize(
    state: State<'_, AppState>,
    request_id: String,
    text: String,
    voice: String,
) -> Result<String, String> {
    state
        .edge_voice
        .synthesize(&request_id, &text, &voice)
        .await
}

#[tauri::command]
fn qiling_edge_voice_cancel(state: State<AppState>, request_id: String) -> Result<(), String> {
    state.edge_voice.cancel(&request_id)
}

#[tauri::command]
async fn qiling_voice_synthesize(
    state: State<'_, AppState>,
    text: String,
    on_chunk: tauri::ipc::Channel<cosyvoice::VoiceChunk>,
) -> Result<u32, String> {
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
async fn qiling_llm_list_models(
    state: State<'_, AppState>,
    base_url: String,
) -> Result<Vec<String>, String> {
    let llm = Arc::clone(&state.local_llm);
    tauri::async_runtime::spawn_blocking(move || llm.list_ollama_models(&base_url))
        .await
        .map_err(|error| format!("llm_models_failed:{error}"))?
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
    state.turns.retire();
    state.local_llm.cancel();
    state.voice.cancel();
    app.emit("qiling-interrupt", ())
        .map_err(|error| format!("voice_interrupt_failed:{error}"))?;
    state.voice_assistant.cancel()
}

/// The runtime decided the user took the floor back. Cancel the model answer,
/// both synthesis paths and the audio still queued, in one step, and tell the
/// page to stop playing. The runtime's own recognition is left alone: it is
/// still listening to the rest of the interruption.
#[tauri::command]
fn qiling_voice_barge_in(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    state.turns.retire();
    state.local_llm.cancel();
    state.voice.cancel();
    state.edge_voice.cancel_all()?;
    app.emit("qiling-interrupt", ())
        .map_err(|error| format!("voice_interrupt_failed:{error}"))
}

#[tauri::command]
fn qiling_voice_assistant_listen(state: State<AppState>) -> Result<(), String> {
    state.voice_assistant.listen()
}

#[tauri::command]
fn qiling_voice_assistant_speaking(state: State<AppState>, text: String) -> Result<(), String> {
    if text.trim().is_empty() || text.chars().count() > 2_000 {
        return Err("invalid_voice_prompt".into());
    }
    state.voice_assistant.speaking(&text)
}

#[tauri::command]
fn qiling_voice_assistant_spoken(state: State<AppState>) -> Result<(), String> {
    state.voice_assistant.spoken()
}

#[tauri::command]
fn qiling_voice_assistant_stop(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    state.turns.retire();
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

/// A new turn owns the speakers: any old model answer or synthesized audio is
/// retired before the next line can be published.
fn begin_voice_turn(state: &AppState) -> Result<u64, String> {
    let turn = state.turns.begin();
    state.local_llm.cancel();
    state.voice.cancel();
    state.edge_voice.cancel_all()?;
    Ok(turn)
}

/// A client display name safe to speak: control characters removed and capped.
fn display_client_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(24)
        .collect();
    if cleaned.trim().is_empty() {
        "该客户端".into()
    } else {
        cleaned
    }
}

/// Local Chinese feedback for a failed Action. The client's own error text is
/// never spoken or displayed: only its stable error code is used.
fn action_failure_message(client_name: &str, code: &str) -> String {
    let name = display_client_name(client_name);
    match code {
        "client_unavailable" => format!("{name}当前未连接，暂时无法执行这个操作。"),
        "not_authorized" | "action_not_found" => format!("{name}尚未获准执行这个操作。"),
        "busy" => format!("{name}正在处理另一条请求，请稍后再试。"),
        "state_unavailable" => format!("{name}当前没有可用的状态来执行这个操作。"),
        "state_stale" => format!("{name}的状态已经变化，请稍后再试。"),
        "summarizer_unavailable" => format!("{name}当前的服务不可用，请检查它的设置。"),
        "selection_unavailable" => format!("{name}当前没有可解释的选区。"),
        "selection_too_large" => "当前选区太长，请缩小选区后再试。".into(),
        "model_unavailable" => format!("{name}当前没有可用且已授权的语言模型。"),
        "deadline_exceeded" => format!("等待{name}执行超时，请稍后再试。"),
        "cancelled" => "已取消这次操作。".into(),
        "invalid_action_response" => format!("{name}返回的结果格式不正确。"),
        _ => format!("执行{name}的操作失败，请检查它的状态后重试。"),
    }
}

/// Speak a locally generated line and own the speakers for this turn.
fn speak_text(app: &AppHandle, state: &AppState, text: &str) -> Result<(), String> {
    begin_voice_turn(state)?;
    app.emit(
        "qiling-line",
        serde_json::json!({ "phase": "say", "text": text, "mood": "neutral" }),
    )
    .map_err(|error| format!("voice_feedback_failed:{error}"))
}

/// Execute one approved client Action and feed its narration back to the pet.
///
/// Both the generic settings button and the dynamic voice route end up here, so
/// permission checks, timeout handling and stale-result protection stay in one
/// place.
async fn invoke_client_action(
    app: &AppHandle,
    state: &AppState,
    client_id: &str,
    client_name: &str,
    action_id: &str,
    connected: bool,
) -> Result<(), String> {
    if !connected {
        return speak_text(
            app,
            state,
            &format!(
                "{}当前未连接，暂时无法执行这个操作。",
                display_client_name(client_name)
            ),
        );
    }
    let turn = begin_voice_turn(state)?;
    app.emit(
        "qiling-line",
        serde_json::json!({ "phase": "thinking", "text": "", "mood": "neutral" }),
    )
    .map_err(|error| format!("narration_feedback_unavailable:{error}"))?;
    let outcome = state
        .protocol
        .invoke_action(client_id, action_id, spirit::DEFAULT_ACTION_TIMEOUT)
        .await;
    if let Ok(result) = &outcome {
        // Remembered even when the user cut the line off: the part that was
        // heard is exactly what a follow-up question may refer to.
        state.narrations.record(client_id, &result.text);
    }
    if !state.turns.is_current(turn) {
        return Ok(());
    }
    match outcome {
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
            let _ = app.emit(
                "qiling-line",
                serde_json::json!({
                    "phase": "say",
                    "text": action_failure_message(client_name, &code),
                    "mood": "down"
                }),
            );
            Err(code)
        }
    }
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
    // A spoken command is a request to a paired desktop client, not a chat
    // message. It must not reach the model: the model would answer over the
    // line or try to plan an operation V1 does not expose. The catalog is read
    // fresh for every final transcript, so disconnects and revocations take
    // effect immediately.
    let actions = match state.protocol.route_actions() {
        Ok(actions) => actions,
        Err(error) => {
            eprintln!("[Voice Command] route snapshot failed: {error}");
            Vec::new()
        }
    };
    match voice_command::match_transcript(&actions, &transcript) {
        voice_command::VoiceOutcome::Action(target) => {
            eprintln!(
                "[Voice Command] outcome=matched client={} action={} connected={}",
                target.client_id, target.action_id, target.connected
            );
            return invoke_client_action(
                &app,
                &*state,
                &target.client_id,
                &target.client_name,
                &target.action_id,
                target.connected,
            )
            .await;
        }
        voice_command::VoiceOutcome::Ambiguous(candidates) => {
            eprintln!(
                "[Voice Command] outcome=ambiguous candidates={}",
                candidates.len()
            );
            return speak_text(&app, &*state, &voice_command::ambiguity_text(&candidates));
        }
        voice_command::VoiceOutcome::Guidance(command) => {
            eprintln!("[Voice Command] outcome=guidance");
            return speak_text(&app, &*state, voice_command::guidance(command));
        }
        voice_command::VoiceOutcome::Conversation => {}
    }
    // A new question owns the speakers from here on. Anything the previous turn
    // is still generating is retired before this question reaches the model.
    let turn = begin_voice_turn(&*state)?;
    let turns = Arc::clone(&state.turns);
    app.emit(
        "qiling-line",
        serde_json::json!({ "phase": "thinking", "text": "", "mood": "neutral" }),
    )
    .map_err(|error| format!("voice_feedback_failed:{error}"))?;
    // "刚才讲了什么" style questions get the recent narrated lines, and only
    // those questions: an ordinary question never carries them.
    let context = state.narrations.context_for(&transcript);
    let llm = Arc::clone(&state.local_llm);
    let response = tauri::async_runtime::spawn_blocking(move || {
        // Replaces the answer that was still running instead of failing `busy`.
        llm.begin_turn()?;
        llm.respond_in_context(&transcript, context.as_deref())
    })
    .await
    .map_err(|_| "local_llm_failed".to_string())?;
    if !turns.is_current(turn) {
        // A barge-in or a newer question retired this turn while the model was
        // thinking; publishing the answer now would revive the interrupted line.
        return Ok(());
    }
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
async fn spirit_invoke_action(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: String,
    action_id: String,
) -> Result<(), String> {
    if client_id.chars().count() > 128 || action_id.chars().count() > 128 {
        return Err("invalid_params".into());
    }
    let client_name = state
        .protocol
        .client_name(&client_id)?
        .ok_or_else(|| "not_authorized".to_string())?;
    invoke_client_action(&app, &*state, &client_id, &client_name, &action_id, true).await
}

fn open_pet_packs(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("packs") {
        let _ = window.unminimize();
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "packs", WebviewUrl::App("index.html".into()))
        .title("器灵 · 角色资源包")
        .inner_size(720.0, 780.0)
        .min_inner_size(560.0, 620.0)
        .resizable(true)
        .maximizable(false)
        .minimizable(true)
        .closable(true)
        .focused(true)
        .decorations(true)
        .always_on_top(false)
        .skip_taskbar(false)
        .transparent(false)
        .theme(Some(tauri::Theme::Dark))
        .background_color(Color(246, 238, 227, 255))
        .visible(true)
        .center()
        .build()
        .map_err(|err| err.to_string())?;
    Ok(())
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
    let packs = MenuItem::with_id(&app, "packs", "角色资源包…", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let settings = MenuItem::with_id(&app, "settings", "设定", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", "退出", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let separator = PredefinedMenuItem::separator(&app).map_err(|err| err.to_string())?;
    let menu = Menu::with_items(&app, &[&packs, &settings, &separator, &quit])
        .map_err(|err| err.to_string())?;
    let pet = app.get_webview_window("pet").ok_or("没有器灵窗口")?;
    pet.popup_menu(&menu).map_err(|err| err.to_string())
}

fn pet_is_visible(app: &AppHandle) -> bool {
    app.get_webview_window("pet")
        .and_then(|pet| pet.is_visible().ok())
        .unwrap_or(false)
}

fn tray_menu(app: &AppHandle, visible: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let toggle = MenuItem::with_id(
        app,
        "tray-toggle",
        if visible {
            "隐藏器灵"
        } else {
            "显示器灵"
        },
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "tray-settings", "设定…", true, None::<&str>)?;
    let packs = MenuItem::with_id(app, "tray-packs", "角色资源包…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出器灵", true, None::<&str>)?;
    Menu::with_items(app, &[&toggle, &settings, &packs, &separator, &quit])
}

/// Keep the tray menu label and tooltip in step with the pet window.
fn refresh_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let visible = pet_is_visible(app);
    if let Ok(menu) = tray_menu(app, visible) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(if visible {
        "器灵"
    } else {
        "器灵（已隐藏）"
    }));
}

fn toggle_pet_from_tray(app: &AppHandle) {
    let open = !pet_is_visible(app);
    let _ = set_pet_open(app, open);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app, pet_is_visible(app))?;
    let icon = match app.default_window_icon() {
        Some(icon) => icon.clone(),
        None => tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?,
    };
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("器灵")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-toggle" => toggle_pet_from_tray(app),
            "tray-settings" => {
                let _ = open_settings(app);
            }
            "tray-packs" => {
                let _ = open_pet_packs(app);
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_pet_from_tray(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("qilingpet", |ctx, request, responder| {
            let packs = ctx.app_handle().state::<AppState>().packs.clone();
            std::thread::spawn(move || {
                responder.respond(packs.asset_response(&request));
            });
        })
        .setup(|app| {
            let protocol_dir = app.path().app_config_dir()?.join("spirit-clients");
            let llm_settings_path = app.path().app_config_dir()?.join("llm-settings.json");
            let voice_data_dir = app.path().app_data_dir()?;
            let packs_root = app.path().app_data_dir()?.join("pet-packs");
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
            let narrations = Arc::new(narration::NarrationLog::default());
            let packs = Arc::new(
                pet_pack::PetPackRegistry::load(packs_root)
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?,
            );
            app.manage(AppState {
                pet_placed: AtomicBool::new(true),
                voice: Arc::new(cosyvoice::VoiceHost::new()),
                edge_voice: Arc::new(edge_tts::EdgeVoiceHost::new()),
                voice_assistant: Arc::new(voice_assistant::VoiceAssistantHost::new(
                    voice_script,
                    voice_data_dir,
                )),
                local_llm: Arc::new(
                    local_llm::LocalLlm::new(llm_settings_path)
                        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?,
                ),
                protocol: protocol.clone(),
                turns: Arc::new(voice_assistant::TurnGate::default()),
                narrations: Arc::clone(&narrations),
                packs,
                music: Arc::new(music::MusicSense::new()),
            });
            if let Some(pet) = app.get_webview_window("pet") {
                place_pet(&pet);
                let _ = pet.set_always_on_top(true);
                let _ = pet.show();
            }
            create_bubble(app)?;
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || http::serve(handle, protocol, narrations));
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "bubble" => {
                api.prevent_close();
            }
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "pet" => {
                // The tray keeps the pet reachable; closing hides it instead of
                // shutting the app down with no way back.
                api.prevent_close();
                let app = window.app_handle().clone();
                let _ = set_pet_open(&app, false);
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
            } else if event.id() == "packs" {
                let _ = open_pet_packs(app);
            } else if event.id() == "quit" {
                app.exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            pet_set_open,
            pet_is_open,
            pet_packs_open,
            pet_packs_list,
            pet_character_current,
            pet_pack_load,
            pet_pack_install,
            pet_pack_uninstall,
            pet_pack_set_active,
            pet_pack_pick_archive,
            qiling_music_sense_start,
            qiling_music_sense_stop,
            qiling_music_sense_status,
            qiling_voice_status,
            qiling_voice_synthesize,
            qiling_voice_cancel,
            qiling_edge_voice_list,
            qiling_edge_voice_synthesize,
            qiling_edge_voice_cancel,
            qiling_voice_assistant_start,
            qiling_llm_get_settings,
            qiling_llm_save_settings,
            qiling_llm_test_connection,
            qiling_llm_list_models,
            qiling_voice_assistant_status,
            qiling_voice_assistant_cancel,
            qiling_voice_barge_in,
            qiling_voice_assistant_listen,
            qiling_voice_assistant_speaking,
            qiling_voice_assistant_spoken,
            qiling_voice_assistant_stop,
            qiling_voice_assistant_respond,
            spirit_start_pairing,
            spirit_pending_pairings,
            spirit_approve_pairing,
            spirit_reject_pairing,
            spirit_list_clients,
            spirit_revoke_client,
            spirit_invoke_action,
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
                state.music.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{action_failure_message, bubble_origin, bubble_size, display_client_name};

    #[test]
    fn bubble_sits_on_the_pet() {
        assert_eq!(bubble_size(10.0, 10.0), (160.0, 72.0));
        assert_eq!(bubble_size(400.0, 400.0), (280.0, 220.0));
        assert_eq!(bubble_size(210.0, 96.0), (210.0, 96.0));
        assert_eq!(bubble_origin(100, 400, 210, 210, 120, 16), (100, 264));
        assert_eq!(bubble_origin(100, 400, 210, 180, 80, 16), (115, 304));
    }

    #[test]
    fn spoken_client_names_are_short_and_never_empty() {
        assert_eq!(display_client_name("  识局  "), "识局");
        assert_eq!(display_client_name(""), "该客户端");
        assert_eq!(display_client_name("\u{7}"), "该客户端");
        assert_eq!(display_client_name(&"长".repeat(40)).chars().count(), 24);
    }

    #[test]
    fn failures_are_explained_locally_without_client_error_text() {
        assert_eq!(
            action_failure_message("识局", "client_unavailable"),
            "识局当前未连接，暂时无法执行这个操作。"
        );
        assert_eq!(
            action_failure_message("识局", "not_authorized"),
            "识局尚未获准执行这个操作。"
        );
        assert_eq!(
            action_failure_message("识局", "deadline_exceeded"),
            "等待识局执行超时，请稍后再试。"
        );
        assert!(action_failure_message("识局", "state_unavailable").contains("没有可用的状态"));
        assert!(action_failure_message("识局", "invalid_action_response").contains("格式不正确"));
        assert!(action_failure_message("识局", "some_new_code").contains("操作失败"));
    }
}
