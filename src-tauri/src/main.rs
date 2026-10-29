#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cosyvoice;
mod http;
mod voice;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::utils::config::{BackgroundThrottlingPolicy, Color};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
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

fn bubble_origin(pet_x: i32, pet_y: i32, pet_w: i32, bubble_w: i32, bubble_h: i32, gap: i32) -> (i32, i32) {
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
    let mut builder = WebviewWindowBuilder::new(app, "bubble", WebviewUrl::App("index.html".into()))
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

fn open_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("设定")
        .inner_size(320.0, 220.0)
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
    let menu = Menu::with_items(&app, &[&settings, &separator, &quit])
        .map_err(|err| err.to_string())?;
    let pet = app.get_webview_window("pet").ok_or("没有器灵窗口")?;
    pet.popup_menu(&menu).map_err(|err| err.to_string())
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            app.manage(AppState {
                pet_placed: AtomicBool::new(true),
                voice: Arc::new(cosyvoice::VoiceHost::new()),
            });
            if let Some(pet) = app.get_webview_window("pet") {
                place_pet(&pet);
                let _ = pet.set_always_on_top(true);
                let _ = pet.show();
            }
            create_bubble(app)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || http::serve(handle));
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "bubble" => {
                api.prevent_close();
            }
            tauri::WindowEvent::CloseRequested { .. } if window.label() == "pet" => {
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
            bubble_present,
            pet_menu
        ])
        .build(tauri::generate_context!())
        .expect("error while running qiling");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.voice.shutdown();
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
