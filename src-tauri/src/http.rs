use axum::{
    body::{Body, Bytes},
    extract::{ws::WebSocketUpgrade, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::spirit::{handle_websocket, PairingManager, ProtocolEventEmitter};

pub const DEFAULT_PORT: u16 = 8766;
const ALLOWED_ORIGINS: [&str; 5] = [
    "http://localhost:1420",
    "http://localhost:1421",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

const DOCS_HTML: &str = include_str!("../../docs/swagger.html");
const OPENAPI_YAML: &str = include_str!("../../docs/openapi.yaml");
const SWAGGER_CSS: &[u8] = include_bytes!("../../docs/vendor/swagger-ui.css");
const SWAGGER_BUNDLE: &[u8] = include_bytes!("../../docs/vendor/swagger-ui-bundle.js");
const FAVICON_32: &[u8] = include_bytes!("../../docs/vendor/favicon-32x32.png");

struct Asset {
    content_type: &'static str,
    body: &'static [u8],
}

/// Files served next to the API. Swagger UI is embedded so `/docs` works offline.
fn asset(path: &str) -> Option<Asset> {
    match path {
        "/docs" | "/docs/" => Some(Asset {
            content_type: "text/html; charset=utf-8",
            body: DOCS_HTML.as_bytes(),
        }),
        "/openapi.yaml" => Some(Asset {
            content_type: "application/yaml; charset=utf-8",
            body: OPENAPI_YAML.as_bytes(),
        }),
        "/docs/swagger-ui.css" => Some(Asset {
            content_type: "text/css; charset=utf-8",
            body: SWAGGER_CSS,
        }),
        "/docs/swagger-ui-bundle.js" => Some(Asset {
            content_type: "application/javascript; charset=utf-8",
            body: SWAGGER_BUNDLE,
        }),
        "/docs/favicon-32x32.png" => Some(Asset {
            content_type: "image/png",
            body: FAVICON_32,
        }),
        _ => None,
    }
}

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

#[derive(Clone)]
struct HttpState {
    app: AppHandle,
    pairing: Arc<PairingManager>,
}

pub fn serve(app: AppHandle, pairing: Arc<PairingManager>) {
    let addr = listen_addr();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("器灵协议运行时启动失败: {err}");
            return;
        }
    };
    runtime.block_on(async move {
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("器灵没听上 {addr}: {err}");
                return;
            }
        };
        let state = HttpState { app, pairing };
        if let Err(err) = axum::serve(listener, router(state)).await {
            eprintln!("器灵本机服务退出: {err}");
        }
    });
}

fn router(state: HttpState) -> Router {
    let origins = ALLOWED_ORIGINS
        .iter()
        .map(|origin| HeaderValue::from_static(origin))
        .chain(local_origins().into_iter().map(|origin| {
            HeaderValue::from_bytes(origin.as_bytes())
                .expect("loopback origins are valid HTTP header values")
        }));
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE]);

    Router::new()
        .route("/v1/health", get(health).options(options))
        .route(
            "/v1/say",
            get(method_not_allowed).post(say).options(options),
        )
        .route(
            "/v1/cancel",
            get(method_not_allowed).post(cancel).options(options),
        )
        .route("/v1/connect", get(connect).options(options))
        .route("/docs", get(docs))
        .route("/docs/", get(docs))
        .route("/openapi.yaml", get(openapi))
        .route("/docs/swagger-ui.css", get(swagger_css))
        .route("/docs/swagger-ui-bundle.js", get(swagger_bundle))
        .route("/docs/favicon-32x32.png", get(favicon))
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024))
        .layer(cors)
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "name": "器灵" }))
}

async fn say(State(state): State<HttpState>, headers: HeaderMap, body: Bytes) -> Response {
    if !request_origin_allowed(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !content_type_is_json(&headers) {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    let body = match std::str::from_utf8(&body) {
        Ok(body) => body,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": "bad_json" })),
            )
                .into_response()
        }
    };
    match parse_say(body) {
        Ok(line) => {
            if let Err(err) = state.app.emit("qiling-line", &line) {
                eprintln!("器灵台词转发失败: {err}");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "ok": false, "error": "internal_error" })),
                )
                    .into_response();
            }
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
        Err(reason) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": reason })),
        )
            .into_response(),
    }
}

async fn cancel(State(state): State<HttpState>, headers: HeaderMap) -> StatusCode {
    if !request_origin_allowed(&headers) {
        return StatusCode::FORBIDDEN;
    }
    if let Err(err) = state.app.emit("qiling-interrupt", ()) {
        eprintln!("器灵语音取消转发失败: {err}");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::NO_CONTENT
}

async fn options() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn method_not_allowed() -> StatusCode {
    StatusCode::NOT_FOUND
}

async fn connect(
    State(state): State<HttpState>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Response {
    if let Some(origin) = headers.get(header::ORIGIN) {
        if origin
            .to_str()
            .map_or(true, |origin| !allowed_origin(origin))
        {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let app = state.app.clone();
    let emitter: Arc<dyn ProtocolEventEmitter> = Arc::new(move |event| {
        app.emit("spirit-event", event)
            .map_err(|err| err.to_string())
    });
    websocket
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| handle_websocket(socket, emitter, state.pairing))
        .into_response()
}

fn allowed_origin(origin: &str) -> bool {
    if ALLOWED_ORIGINS.contains(&origin) {
        return true;
    }
    local_origins().iter().any(|allowed| allowed == origin)
}

fn local_origins() -> [String; 2] {
    let port = listen_addr()
        .rsplit_once(':')
        .map(|(_, port)| port.to_string())
        .unwrap_or_else(|| DEFAULT_PORT.to_string());
    [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ]
}

fn request_origin_allowed(headers: &HeaderMap) -> bool {
    match headers.get(header::ORIGIN) {
        None => true,
        Some(origin) => origin.to_str().is_ok_and(allowed_origin),
    }
}

fn content_type_is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("application/json"))
}

fn asset_response(path: &str) -> Response {
    let Some(asset) = asset(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.content_type)
        .body(Body::from(asset.body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn docs() -> Response {
    asset_response("/docs")
}

async fn openapi() -> Response {
    asset_response("/openapi.yaml")
}

async fn swagger_css() -> Response {
    asset_response("/docs/swagger-ui.css")
}

async fn swagger_bundle() -> Response {
    asset_response("/docs/swagger-ui-bundle.js")
}

async fn favicon() -> Response {
    asset_response("/docs/favicon-32x32.png")
}

#[cfg(test)]
mod tests {
    use super::{
        allowed_origin, asset, content_type_is_json, listen_addr, parse_say, request_origin_allowed,
    };
    use axum::http::{header, HeaderMap, HeaderValue};

    #[test]
    fn cors_and_websocket_origin_allow_only_known_apps() {
        assert!(allowed_origin("http://localhost:1420"));
        assert!(allowed_origin("http://tauri.localhost"));
        let port = listen_addr().rsplit_once(':').unwrap().1.to_string();
        assert!(allowed_origin(&format!("http://127.0.0.1:{port}")));
        assert!(allowed_origin(&format!("http://localhost:{port}")));
        assert!(!allowed_origin("http://localhost:9999"));
        assert!(!allowed_origin("https://example.com"));
        assert!(!allowed_origin("null"));
    }

    #[test]
    fn legacy_posts_reject_cross_origin_and_non_json_requests() {
        let mut headers = HeaderMap::new();
        assert!(request_origin_allowed(&headers));
        assert!(!content_type_is_json(&headers));

        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://example.com"),
        );
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        assert!(!request_origin_allowed(&headers));
        assert!(!content_type_is_json(&headers));

        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://tauri.localhost"),
        );
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        assert!(request_origin_allowed(&headers));
        assert!(content_type_is_json(&headers));

        headers.insert(header::ORIGIN, HeaderValue::from_bytes(&[0xff]).unwrap());
        assert!(!request_origin_allowed(&headers));
    }

    #[test]
    fn docs_assets_are_embedded() {
        let docs = asset("/docs").expect("docs page");
        assert_eq!(docs.content_type, "text/html; charset=utf-8");
        let html = std::str::from_utf8(docs.body).unwrap();
        assert!(html.contains("SwaggerUIBundle"));
        assert!(html.contains("/openapi.yaml"));
        assert!(asset("/docs/").is_some());

        let spec = asset("/openapi.yaml").expect("openapi spec");
        assert_eq!(spec.content_type, "application/yaml; charset=utf-8");
        let spec = std::str::from_utf8(spec.body).unwrap();
        assert!(spec.starts_with("openapi: 3.1.0"));
        assert!(spec.contains("/v1/say"));
        assert!(spec.contains("bad_text"));

        assert!(asset("/docs/swagger-ui.css").unwrap().body.len() > 100_000);
        assert!(asset("/docs/swagger-ui-bundle.js").unwrap().body.len() > 1_000_000);
        assert!(asset("/docs/favicon-32x32.png").is_some());
        assert!(asset("/docs/nope").is_none());
    }

    #[test]
    fn accepts_a_finished_line() {
        let say = parse_say(r#"{"source":"siju","phase":"say","text":"红方略优。","mood":"up"}"#)
            .unwrap();
        assert_eq!(say.source, "siju");
        assert_eq!(say.phase, "say");
        assert_eq!(say.mood, "up");
        assert_eq!(say.text, "红方略优。");
    }

    #[test]
    fn rejects_a_chess_shaped_request() {
        assert!(
            parse_say(r#"{"source":"siju","phase":"narrate","text":"x","mood":"up"}"#).is_err()
        );
        assert!(parse_say(r#"{"source":" ","phase":"say","text":"x","mood":"up"}"#).is_err());
        assert!(parse_say(r#"{"source":"siju","phase":"say","text":"x","mood":"win"}"#).is_err());
        assert!(
            parse_say(r#"{"source":"siju","phase":"idle","text":"","mood":"neutral"}"#).is_ok()
        );
    }
}
