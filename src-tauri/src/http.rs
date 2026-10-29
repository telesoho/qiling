use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::Read;
use tauri::{AppHandle, Emitter};

pub const DEFAULT_PORT: u16 = 8766;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Say {
    pub source: String,
    pub phase: String,
    pub text: String,
    pub mood: String,
}

pub fn parse_say(body: &str) -> Result<Say, String> {
    let say: Say = serde_json::from_str(body).map_err(|_| "bad_json".to_string())?;
    let source = say.source.trim();
    if source.is_empty() || source.chars().count() > 64 {
        return Err("bad_source".into());
    }
    if !matches!(say.phase.as_str(), "thinking" | "say" | "idle") {
        return Err("bad_phase".into());
    }
    if !matches!(say.mood.as_str(), "neutral" | "up" | "down") {
        return Err("bad_mood".into());
    }
    if say.text.chars().count() > 400 {
        return Err("bad_text".into());
    }
    Ok(Say {
        source: source.to_string(),
        phase: say.phase,
        text: say.text.trim().to_string(),
        mood: say.mood,
    })
}

pub fn listen_addr() -> String {
    let port = std::env::var("QILING_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(DEFAULT_PORT);
    format!("127.0.0.1:{port}")
}

pub fn serve(app: AppHandle) {
    let addr = listen_addr();
    let server = match tiny_http::Server::http(&addr) {
        Ok(server) => server,
        Err(err) => {
            eprintln!("器灵没听上 {addr}: {err}");
            return;
        }
    };
    for mut request in server.incoming_requests() {
        let response = route(&app, &mut request);
        let _ = request.respond(response);
    }
}

fn route(app: &AppHandle, request: &mut tiny_http::Request) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    if request.method() == &tiny_http::Method::Options {
        return empty(204);
    }
    let path = request.url().split('?').next().unwrap_or("");
    match (request.method(), path) {
        (&tiny_http::Method::Get, "/v1/health") => json_ok(json!({ "ok": true, "name": "器灵" })),
        (&tiny_http::Method::Post, "/v1/say") => say(app, request),
        (&tiny_http::Method::Post, "/v1/cancel") => {
            let _ = app.emit("qiling-interrupt", ());
            empty(204)
        }
        _ => empty(404),
    }
}

fn say(app: &AppHandle, request: &mut tiny_http::Request) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let mut body = String::new();
    let _ = request.as_reader().take(64 * 1024).read_to_string(&mut body);
    match parse_say(&body) {
        Ok(line) => {
            let _ = app.emit("qiling-line", &line);
            json_ok(json!({ "ok": true }))
        }
        Err(reason) => json_status(400, json!({ "ok": false, "error": reason })),
    }
}

fn json_ok(value: serde_json::Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    json_status(200, value)
}

fn json_status(code: u16, value: serde_json::Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let bytes = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    let length = bytes.len();
    let mut response = tiny_http::Response::new(
        tiny_http::StatusCode(code),
        vec![
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
            tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        ],
        std::io::Cursor::new(bytes),
        Some(length),
        None,
    );
    let _ = &mut response;
    response
}

fn empty(code: u16) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let mut response = tiny_http::Response::new(
        tiny_http::StatusCode(code),
        vec![
            tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
            tiny_http::Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS"[..]).unwrap(),
            tiny_http::Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..]).unwrap(),
        ],
        std::io::Cursor::new(Vec::new()),
        Some(0),
        None,
    );
    let _ = &mut response;
    response
}

#[cfg(test)]
mod tests {
    use super::parse_say;

    #[test]
    fn accepts_a_finished_line() {
        let say = parse_say(
            r#"{"source":"siju","phase":"say","text":"红方略优。","mood":"up"}"#,
        )
        .unwrap();
        assert_eq!(say.source, "siju");
        assert_eq!(say.phase, "say");
        assert_eq!(say.mood, "up");
        assert_eq!(say.text, "红方略优。");
    }

    #[test]
    fn rejects_a_chess_shaped_request() {
        assert!(parse_say(r#"{"source":"siju","phase":"narrate","text":"x","mood":"up"}"#).is_err());
        assert!(parse_say(r#"{"source":" ","phase":"say","text":"x","mood":"up"}"#).is_err());
        assert!(parse_say(r#"{"source":"siju","phase":"say","text":"x","mood":"win"}"#).is_err());
        assert!(parse_say(r#"{"source":"siju","phase":"idle","text":"","mood":"neutral"}"#).is_ok());
    }
}
