use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::extract::ws::{Message, WebSocket};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use data_encoding::BASE32_NOPAD;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    sync::{oneshot, OwnedSemaphorePermit},
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PAIRING_ATTEMPTS: u8 = 5;
const MAX_CLIENTS: usize = 32;
const MAX_CONNECTIONS: usize = 32;
const MAX_EVENTS_PER_MINUTE: u8 = 60;
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(5);
const PAIR_APPROVAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientInfo {
    pub id: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthenticateParams {
    access_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionCapability {
    pub id: String,
    pub risk: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub supports_cancellation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventCapabilities {
    #[serde(default)]
    pub publishes: Vec<String>,
    #[serde(default)]
    pub subscribes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityManifest {
    #[serde(default)]
    pub actions: Vec<ActionCapability>,
    pub events: EventCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairParams {
    pub pairing_code: String,
    pub client: ClientInfo,
    pub requested_capabilities: CapabilityManifest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub code: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequestView {
    pub request_id: String,
    pub client: ClientInfo,
    pub requested_capabilities: CapabilityManifest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedClientView {
    pub client_key: String,
    pub client: ClientInfo,
    pub capabilities: CapabilityManifest,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredClient {
    client_key: String,
    client: ClientInfo,
    token_hash: String,
    capabilities: CapabilityManifest,
    created_at: u64,
}

struct ActivePairing {
    code: String,
    expires_at: Instant,
    failed_attempts: u8,
}

struct PendingPairing {
    view: PairingRequestView,
    expires_at: Instant,
    decision: oneshot::Sender<Result<String, String>>,
}

struct ActiveSession {
    session_id: String,
    cancelled: CancellationToken,
}

#[derive(Default)]
struct Inner {
    pairing: Option<ActivePairing>,
    clients: HashMap<String, StoredClient>,
    pending: HashMap<String, PendingPairing>,
    sessions: HashMap<String, ActiveSession>,
}

pub struct PairingManager {
    directory: PathBuf,
    inner: Mutex<Inner>,
    connections: Arc<tokio::sync::Semaphore>,
}

pub trait ProtocolEventEmitter: Send + Sync {
    fn emit_event(&self, event: Value) -> Result<(), String>;
}

impl<F> ProtocolEventEmitter for F
where
    F: Fn(Value) -> Result<(), String> + Send + Sync,
{
    fn emit_event(&self, event: Value) -> Result<(), String> {
        self(event)
    }
}

impl PairingManager {
    pub fn load(directory: impl Into<PathBuf>) -> Result<Self, String> {
        let directory = directory.into();
        fs::create_dir_all(&directory).map_err(|err| format!("credential_directory:{err}"))?;

        let mut inner = Inner::default();
        for entry in
            fs::read_dir(&directory).map_err(|err| format!("credential_directory:{err}"))?
        {
            let entry = entry.map_err(|err| format!("credential_directory:{err}"))?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let data = fs::read(&path).map_err(|err| format!("credential_read:{err}"))?;
            let client: StoredClient = serde_json::from_slice(&data)
                .map_err(|err| format!("credential_record_invalid:{err}"))?;
            let file_stem = path.file_stem().and_then(|stem| stem.to_str());
            if Uuid::parse_str(&client.client_key).is_err()
                || file_stem != Some(client.client_key.as_str())
                || client.token_hash.len() != 64
                || !client
                    .token_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("credential_record_invalid".into());
            }
            validate_client(&client.client).map_err(|_| "credential_record_invalid")?;
            validate_capabilities(&client.capabilities).map_err(|_| "credential_record_invalid")?;
            inner.clients.insert(client.client_key.clone(), client);
        }

        Ok(Self {
            directory,
            inner: Mutex::new(inner),
            connections: Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS)),
        })
    }

    fn connection_permit(&self) -> Option<OwnedSemaphorePermit> {
        self.connections.clone().try_acquire_owned().ok()
    }

    pub fn begin_pairing(&self) -> Result<PairingCode, String> {
        let mut entropy = [0u8; 5];
        OsRng.fill_bytes(&mut entropy);
        let code = BASE32_NOPAD.encode(&entropy);
        let mut inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        inner.pairing = Some(ActivePairing {
            code: code.clone(),
            expires_at: Instant::now() + PAIRING_TTL,
            failed_attempts: 0,
        });
        Ok(PairingCode {
            code,
            expires_in_seconds: PAIRING_TTL.as_secs(),
        })
    }

    pub fn request_pairing(
        &self,
        params: PairParams,
    ) -> Result<
        (
            PairingRequestView,
            oneshot::Receiver<Result<String, String>>,
        ),
        String,
    > {
        validate_client(&params.client)?;
        validate_capabilities(&params.requested_capabilities)?;
        let requested_code = params.pairing_code.trim().to_ascii_uppercase();
        let mut inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        let Some(pairing) = inner.pairing.as_mut() else {
            return Err("pairing_required".into());
        };
        if Instant::now() >= pairing.expires_at {
            inner.pairing = None;
            return Err("pairing_expired".into());
        }
        if !constant_time_eq(&pairing.code, &requested_code) {
            pairing.failed_attempts = pairing.failed_attempts.saturating_add(1);
            if pairing.failed_attempts >= MAX_PAIRING_ATTEMPTS {
                inner.pairing = None;
                return Err("pairing_expired".into());
            }
            return Err("pairing_required".into());
        }

        inner.pairing = None;
        let request_id = Uuid::new_v4().to_string();
        let view = PairingRequestView {
            request_id: request_id.clone(),
            client: params.client,
            requested_capabilities: params.requested_capabilities,
        };
        let (decision, receiver) = oneshot::channel();
        inner.pending.insert(
            request_id,
            PendingPairing {
                view: view.clone(),
                expires_at: Instant::now() + PAIR_APPROVAL_TIMEOUT,
                decision,
            },
        );
        Ok((view, receiver))
    }

    pub fn pending_pairings(&self) -> Result<Vec<PairingRequestView>, String> {
        let mut inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        let now = Instant::now();
        let expired: Vec<String> = inner
            .pending
            .iter()
            .filter(|(_, pending)| now >= pending.expires_at)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(pending) = inner.pending.remove(&id) {
                let _ = pending.decision.send(Err("pairing_expired".into()));
            }
        }
        Ok(inner
            .pending
            .values()
            .map(|pending| pending.view.clone())
            .collect())
    }

    pub fn approve_pairing(&self, request_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        let pending = inner
            .pending
            .remove(request_id)
            .ok_or_else(|| "pairing_request_not_found".to_string())?;
        if Instant::now() >= pending.expires_at {
            let _ = pending.decision.send(Err("pairing_expired".into()));
            return Err("pairing_expired".into());
        }
        if inner.clients.len() >= MAX_CLIENTS {
            let _ = pending.decision.send(Err("client_limit".into()));
            return Err("client_limit".into());
        }

        let mut entropy = [0u8; 32];
        OsRng.fill_bytes(&mut entropy);
        let access_token = URL_SAFE_NO_PAD.encode(entropy);
        let record = StoredClient {
            client_key: Uuid::new_v4().to_string(),
            client: pending.view.client,
            token_hash: token_hash(&access_token),
            capabilities: pending.view.requested_capabilities,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "system_clock_invalid")?
                .as_secs(),
        };
        if inner
            .clients
            .values()
            .any(|existing| existing.client.id == record.client.id)
        {
            let _ = pending.decision.send(Err("client_already_paired".into()));
            return Err("client_already_paired".into());
        }
        if let Err(err) = self.persist(&record) {
            let _ = pending.decision.send(Err(err.clone()));
            return Err(err);
        }
        let client_key = record.client_key.clone();
        inner.clients.insert(client_key.clone(), record);
        if pending.decision.send(Ok(access_token)).is_err() {
            match fs::remove_file(self.record_path(&client_key)) {
                Ok(()) => {
                    inner.clients.remove(&client_key);
                    return Err("pairing_client_disconnected".into());
                }
                Err(err) => {
                    return Err(format!(
                        "pairing_client_disconnected_credential_cleanup_failed:{err}"
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn reject_pairing(&self, request_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        let pending = inner
            .pending
            .remove(request_id)
            .ok_or_else(|| "pairing_request_not_found".to_string())?;
        let _ = pending.decision.send(Err("not_authorized".into()));
        Ok(())
    }

    pub fn list_clients(&self) -> Result<Vec<AuthorizedClientView>, String> {
        let inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        let mut clients: Vec<_> = inner
            .clients
            .values()
            .map(|record| AuthorizedClientView {
                client_key: record.client_key.clone(),
                client: record.client.clone(),
                capabilities: record.capabilities.clone(),
                created_at: record.created_at,
            })
            .collect();
        clients.sort_by(|left, right| left.client.name.cmp(&right.client.name));
        Ok(clients)
    }

    pub fn revoke_client(&self, client_key: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        if !inner.clients.contains_key(client_key) {
            return Err("client_not_found".into());
        }
        fs::remove_file(self.record_path(client_key))
            .map_err(|err| format!("credential_revoke_failed:{err}"))?;
        inner.clients.remove(client_key);
        if let Some(session) = inner.sessions.remove(client_key) {
            session.cancelled.cancel();
        }
        Ok(())
    }

    fn authenticate(&self, token: &str) -> Result<StoredClient, String> {
        let candidate = token_hash(token);
        let inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        inner
            .clients
            .values()
            .find(|record| constant_time_eq(&record.token_hash, &candidate))
            .cloned()
            .ok_or_else(|| "not_authorized".into())
    }

    fn open_session(&self, client_key: &str) -> Result<(String, CancellationToken), String> {
        let mut inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        if !inner.clients.contains_key(client_key) {
            return Err("not_authorized".into());
        }
        if let Some(previous) = inner.sessions.remove(client_key) {
            previous.cancelled.cancel();
        }
        let session_id = Uuid::new_v4().to_string();
        let cancelled = CancellationToken::new();
        inner.sessions.insert(
            client_key.to_string(),
            ActiveSession {
                session_id: session_id.clone(),
                cancelled: cancelled.clone(),
            },
        );
        Ok((session_id, cancelled))
    }

    fn close_session(&self, client_key: &str, session_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .sessions
                .get(client_key)
                .map(|session| session.session_id.as_str())
                == Some(session_id)
            {
                inner.sessions.remove(client_key);
            }
        }
    }

    fn record_path(&self, client_key: &str) -> PathBuf {
        self.directory.join(format!("{client_key}.json"))
    }

    fn persist(&self, record: &StoredClient) -> Result<(), String> {
        let path = self.record_path(&record.client_key);
        let temp_path = self.directory.join(format!("{}.tmp", record.client_key));
        let data =
            serde_json::to_vec(record).map_err(|err| format!("credential_serialize:{err}"))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|err| format!("credential_write:{err}"))?;
        if let Err(err) = file.write_all(&data).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("credential_write:{err}"));
        }
        fs::rename(&temp_path, &path).map_err(|err| {
            let _ = fs::remove_file(&temp_path);
            format!("credential_commit:{err}")
        })
    }
}

fn validate_client(client: &ClientInfo) -> Result<(), String> {
    if client.id.trim().is_empty()
        || client.id.chars().count() > 128
        || client.name.trim().is_empty()
        || client.name.chars().count() > 80
        || client.version.trim().is_empty()
        || client.version.chars().count() > 40
    {
        return Err("invalid_params".into());
    }
    Ok(())
}

fn validate_capabilities(capabilities: &CapabilityManifest) -> Result<(), String> {
    let expected_input = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {}
    });
    let expected_output = json!({
        "type": "object",
        "required": ["text", "mood"],
        "properties": {
            "text": { "type": "string", "maxLength": 400 },
            "mood": { "type": "string", "enum": ["neutral", "up", "down"] }
        },
        "additionalProperties": false
    });
    if capabilities.actions.len() != 1
        || capabilities.actions[0].id != "siju.narrate_current"
        || capabilities.actions[0].risk != "no_state_change"
        || capabilities.actions[0].input_schema != expected_input
        || capabilities.actions[0].output_schema != expected_output
        || capabilities.actions[0].supports_cancellation
        || capabilities.events.subscribes.len() > 0
        || capabilities.events.publishes.len() > 1
        || capabilities
            .events
            .publishes
            .iter()
            .any(|event| event != "siju.analysis.status")
    {
        return Err("unsupported_capabilities".into());
    }
    Ok(())
}

fn token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |different, (left, right)| different | (left ^ right))
        == 0
}

fn rpc_error(id: Value, code: i64, data_code: &str, retryable: bool) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": "Protocol request failed",
            "data": { "code": data_code, "retryable": retryable }
        }
    })
}

fn request_parts(message: &Value) -> Result<(Value, String, Value), &'static str> {
    let object = message.as_object().ok_or("invalid_request")?;
    if object.len() != 4
        || !object.contains_key("jsonrpc")
        || !object.contains_key("id")
        || !object.contains_key("method")
        || !object.contains_key("params")
    {
        return Err("invalid_request");
    }
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("invalid_request");
    }
    let id = message.get("id").cloned().ok_or("invalid_request")?;
    if !(id.is_string() || id.as_u64().is_some()) {
        return Err("invalid_request");
    }
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .ok_or("invalid_request")?
        .to_string();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    Ok((id, method, params))
}

async fn send_json(socket: &mut WebSocket, value: &Value) -> Result<(), ()> {
    let text = serde_json::to_string(value).map_err(|_| ())?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

async fn first_text(socket: &mut WebSocket) -> Result<String, &'static str> {
    match timeout(INITIALIZE_TIMEOUT, socket.recv()).await {
        Err(_) => Err("deadline_exceeded"),
        Ok(None) => Err("client_unavailable"),
        Ok(Some(Err(_))) => Err("client_unavailable"),
        Ok(Some(Ok(Message::Text(text)))) => Ok(text.to_string()),
        Ok(Some(Ok(Message::Close(_)))) => Err("client_unavailable"),
        Ok(Some(Ok(_))) => Err("invalid_request"),
    }
}

pub async fn handle_websocket(
    mut socket: WebSocket,
    emitter: Arc<dyn ProtocolEventEmitter>,
    manager: Arc<PairingManager>,
) {
    let Some(_connection) = manager.connection_permit() else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    let first = match first_text(&mut socket).await {
        Ok(text) => text,
        Err(_) => return,
    };
    if first.len() > 64 * 1024 {
        return;
    }
    let message: Value = match serde_json::from_str(&first) {
        Ok(value) => value,
        Err(_) => {
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 1002,
                    reason: "invalid_json".into(),
                })))
                .await;
            return;
        }
    };
    let (id, method, params) = match request_parts(&message) {
        Ok(parts) => parts,
        Err(_) => return,
    };

    match method.as_str() {
        "client.pair" => {
            let params: PairParams = match serde_json::from_value(params) {
                Ok(params) => params,
                Err(_) => {
                    let _ = send_json(&mut socket, &rpc_error(id, -32602, "invalid_params", false))
                        .await;
                    return;
                }
            };
            let (pending, receiver) = match manager.request_pairing(params) {
                Ok(pairing) => pairing,
                Err(code) => {
                    let _ = send_json(&mut socket, &rpc_error(id, -32000, &code, false)).await;
                    return;
                }
            };
            let token = match timeout(PAIR_APPROVAL_TIMEOUT, receiver).await {
                Ok(Ok(Ok(token))) => token,
                Ok(Ok(Err(code))) => {
                    let _ = send_json(&mut socket, &rpc_error(id, -32000, &code, false)).await;
                    return;
                }
                _ => {
                    let _ = manager.reject_pairing(&pending.request_id);
                    let _ = send_json(
                        &mut socket,
                        &rpc_error(id, -32000, "pairing_expired", false),
                    )
                    .await;
                    return;
                }
            };
            let _ = send_json(
                &mut socket,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "clientId": pending.client.id, "accessToken": token }
                }),
            )
            .await;
        }
        "client.authenticate" => {
            let auth = match serde_json::from_value::<AuthenticateParams>(params) {
                Ok(auth) if auth.access_token.len() >= 32 => auth,
                _ => {
                    let _ = send_json(&mut socket, &rpc_error(id, -32602, "invalid_params", false))
                        .await;
                    return;
                }
            };
            let client = match manager.authenticate(&auth.access_token) {
                Ok(client) => client,
                Err(code) => {
                    let _ = send_json(&mut socket, &rpc_error(id, -32000, &code, false)).await;
                    return;
                }
            };
            if send_json(
                &mut socket,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "authenticated": true, "clientId": client.client.id }
                }),
            )
            .await
            .is_err()
            {
                return;
            }
            authenticated_session(socket, emitter, manager, client).await;
        }
        _ => {
            let _ = send_json(
                &mut socket,
                &rpc_error(id, -32000, "pairing_required", false),
            )
            .await;
        }
    }
}

async fn authenticated_session(
    mut socket: WebSocket,
    emitter: Arc<dyn ProtocolEventEmitter>,
    manager: Arc<PairingManager>,
    client: StoredClient,
) {
    let init_text = match first_text(&mut socket).await {
        Ok(text) => text,
        Err(_) => return,
    };
    let init_message: Value = match serde_json::from_str(&init_text) {
        Ok(value) if init_text.len() <= 64 * 1024 => value,
        _ => return,
    };
    let (id, method, params) = match request_parts(&init_message) {
        Ok(parts) => parts,
        Err(_) => return,
    };
    if method != "client.initialize" {
        let _ = send_json(
            &mut socket,
            &rpc_error(id, -32601, "pairing_required", false),
        )
        .await;
        return;
    }
    let init: InitializeParams = match serde_json::from_value(params) {
        Ok(init) => init,
        Err(_) => {
            let _ = send_json(&mut socket, &rpc_error(id, -32602, "invalid_params", false)).await;
            return;
        }
    };
    if init.protocol_version != "1" {
        let _ = send_json(
            &mut socket,
            &rpc_error(id, -32000, "version_unsupported", false),
        )
        .await;
        return;
    }
    if init.client != client.client || init.capabilities != client.capabilities {
        let _ = send_json(&mut socket, &rpc_error(id, -32000, "not_authorized", false)).await;
        return;
    }
    let (session_id, cancelled) = match manager.open_session(&client.client_key) {
        Ok(session) => session,
        Err(code) => {
            let _ = send_json(&mut socket, &rpc_error(id, -32000, &code, false)).await;
            return;
        }
    };
    let granted = granted_capabilities(&client.capabilities);
    if send_json(
        &mut socket,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "sessionId": session_id,
                "protocolVersion": "1",
                "serverInfo": {
                    "id": "com.qiling.pet",
                    "name": "器灵",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "runtimeCapabilities": [],
                "grantedCapabilities": granted
            }
        }),
    )
    .await
    .is_err()
    {
        manager.close_session(&client.client_key, &session_id);
        return;
    }

    let mut event_window_start = Instant::now();
    let mut event_count = 0u8;
    loop {
        tokio::select! {
            _ = cancelled.cancelled() => {
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if text.len() > 64 * 1024 {
                            let _ = socket.send(Message::Close(None)).await;
                            break;
                        }
                        if event_window_start.elapsed() >= Duration::from_secs(60) {
                            event_window_start = Instant::now();
                            event_count = 0;
                        }
                        if !handle_client_message(
                            &mut socket,
                            emitter.as_ref(),
                            &manager,
                            &client,
                            &text,
                            &mut event_count,
                        )
                        .await
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        }
    }
    manager.close_session(&client.client_key, &session_id);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitializeParams {
    protocol_version: String,
    client: ClientInfo,
    capabilities: CapabilityManifest,
}

async fn handle_client_message(
    socket: &mut WebSocket,
    emitter: &dyn ProtocolEventEmitter,
    manager: &PairingManager,
    client: &StoredClient,
    text: &str,
    event_count: &mut u8,
) -> bool {
    let message: Value = match serde_json::from_str(text) {
        Ok(message) => message,
        Err(_) => return false,
    };
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return false;
    }
    if message.get("id").is_some() {
        let Ok((id, method, params)) = request_parts(&message) else {
            return false;
        };
        if method != "client.unpair" {
            let _ = send_json(socket, &rpc_error(id, -32601, "action_not_found", false)).await;
            return true;
        }
        if params != json!({}) {
            let _ = send_json(socket, &rpc_error(id, -32602, "invalid_params", false)).await;
            return true;
        }
        if let Err(code) = manager.revoke_client(&client.client_key) {
            let _ = send_json(socket, &rpc_error(id, -32000, &code, false)).await;
            return true;
        }
        let response_sent = send_json(
            socket,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "unpaired": true }
            }),
        )
        .await
        .is_ok();
        if response_sent {
            let _ = socket.send(Message::Close(None)).await;
        }
        return false;
    }
    if message.get("method").and_then(Value::as_str) != Some("event.publish") {
        return false;
    }
    if *event_count >= MAX_EVENTS_PER_MINUTE {
        return false;
    }
    let params: EventPublishParams =
        match serde_json::from_value(message.get("params").cloned().unwrap_or(Value::Null)) {
            Ok(params) => params,
            Err(_) => return false,
        };
    if params.event_type != "siju.analysis.status"
        || !client
            .capabilities
            .events
            .publishes
            .iter()
            .any(|event| event == &params.event_type)
        || params.event_id.trim().is_empty()
        || params.event_id.chars().count() > 128
    {
        return false;
    }
    let status = params.payload.get("status").and_then(Value::as_str);
    if !matches!(status, Some("ready" | "unavailable"))
        || params.payload.as_object().map(|p| p.len()) != Some(1)
        || params.occurred_at.trim().is_empty()
        || params.occurred_at.chars().count() > 40
    {
        return false;
    }
    *event_count += 1;
    if let Err(err) = emitter.emit_event(json!({
        "clientId": client.client.id,
        "eventId": params.event_id,
        "eventType": params.event_type,
        "occurredAt": params.occurred_at,
        "payload": params.payload
    })) {
        eprintln!("器灵协议事件转发失败: {err}");
        return false;
    }
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventPublishParams {
    event_id: String,
    event_type: String,
    occurred_at: String,
    payload: Value,
}

fn granted_capabilities(capabilities: &CapabilityManifest) -> Vec<String> {
    let mut granted: Vec<String> = capabilities
        .actions
        .iter()
        .map(|action| action.id.clone())
        .collect();
    granted.extend(
        capabilities
            .events
            .publishes
            .iter()
            .map(|event| format!("event.publish:{event}")),
    );
    granted
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{ws::WebSocketUpgrade, State},
        response::Response,
        routing::get,
        Router,
    };
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        connect_async, tungstenite::Message as ClientMessage, MaybeTlsStream, WebSocketStream,
    };

    fn test_directory() -> PathBuf {
        std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("qiling-spirit-test-{}", Uuid::new_v4()))
    }

    fn manifest() -> CapabilityManifest {
        CapabilityManifest {
            actions: vec![ActionCapability {
                id: "siju.narrate_current".into(),
                risk: "no_state_change".into(),
                input_schema: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {}
                }),
                output_schema: json!({
                    "type": "object",
                    "required": ["text", "mood"],
                    "properties": {
                        "text": { "type": "string", "maxLength": 400 },
                        "mood": { "type": "string", "enum": ["neutral", "up", "down"] }
                    },
                    "additionalProperties": false
                }),
                supports_cancellation: false,
            }],
            events: EventCapabilities {
                publishes: vec!["siju.analysis.status".into()],
                subscribes: vec![],
            },
        }
    }

    fn pair_params(code: &str) -> PairParams {
        PairParams {
            pairing_code: code.into(),
            client: ClientInfo {
                id: "com.siju.app".into(),
                name: "识局".into(),
                version: "0.1.0".into(),
            },
            requested_capabilities: manifest(),
        }
    }

    fn manager() -> (PairingManager, PathBuf) {
        let directory = test_directory();
        (PairingManager::load(&directory).unwrap(), directory)
    }

    #[test]
    fn connection_semaphore_caps_simultaneous_sessions() {
        let (manager, directory) = manager();
        let permits: Vec<_> = (0..MAX_CONNECTIONS)
            .map(|_| manager.connection_permit().unwrap())
            .collect();
        assert!(manager.connection_permit().is_none());
        drop(permits);
        assert!(manager.connection_permit().is_some());
        fs::remove_dir_all(directory).unwrap();
    }

    fn approve(manager: &PairingManager, code: &str) -> String {
        let (pending, receiver) = manager.request_pairing(pair_params(code)).unwrap();
        manager.approve_pairing(&pending.request_id).unwrap();
        receiver.blocking_recv().unwrap().unwrap()
    }

    #[derive(Clone)]
    struct WebSocketTestState {
        manager: Arc<PairingManager>,
        emitter: Arc<dyn ProtocolEventEmitter>,
    }

    async fn test_connect(
        State(state): State<WebSocketTestState>,
        websocket: WebSocketUpgrade,
    ) -> Response {
        websocket.on_upgrade(move |socket| handle_websocket(socket, state.emitter, state.manager))
    }

    type TestClientSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

    async fn send_client_json(socket: &mut TestClientSocket, value: Value) {
        socket
            .send(ClientMessage::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    async fn receive_client_json(socket: &mut TestClientSocket) -> Value {
        match socket.next().await {
            Some(Ok(ClientMessage::Text(text))) => serde_json::from_str(&text).unwrap(),
            message => panic!("expected JSON response, got {message:?}"),
        }
    }

    #[test]
    fn pairing_requires_user_approval_and_persists_only_a_token_hash() {
        let (manager, directory) = manager();
        let pairing = manager.begin_pairing().unwrap();
        let (pending, receiver) = manager.request_pairing(pair_params(&pairing.code)).unwrap();
        assert_eq!(manager.list_clients().unwrap().len(), 0);
        assert_eq!(manager.pending_pairings().unwrap(), vec![pending.clone()]);

        manager.approve_pairing(&pending.request_id).unwrap();
        let token = receiver.blocking_recv().unwrap().unwrap();
        assert!(token.len() >= 40);
        assert_eq!(manager.list_clients().unwrap().len(), 1);
        let stored =
            fs::read_to_string(manager.record_path(&manager.list_clients().unwrap()[0].client_key))
                .unwrap();
        assert!(!stored.contains(&token));

        let reloaded = PairingManager::load(&directory).unwrap();
        assert_eq!(reloaded.list_clients().unwrap().len(), 1);
        assert!(reloaded.authenticate(&token).is_ok());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn pairing_code_is_single_use_and_failed_attempts_are_limited() {
        let (manager, directory) = manager();
        let pairing = manager.begin_pairing().unwrap();
        for attempt in 0..MAX_PAIRING_ATTEMPTS {
            let result = manager.request_pairing(pair_params("WRONG123"));
            if attempt + 1 == MAX_PAIRING_ATTEMPTS {
                assert_eq!(result.unwrap_err(), "pairing_expired");
            } else {
                assert_eq!(result.unwrap_err(), "pairing_required");
            }
        }
        assert_eq!(
            manager
                .request_pairing(pair_params(&pairing.code))
                .unwrap_err(),
            "pairing_required"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unsupported_capabilities_cannot_be_paired() {
        let (manager, directory) = manager();
        let pairing = manager.begin_pairing().unwrap();
        let mut params = pair_params(&pairing.code);
        params.requested_capabilities.actions[0].id = "system.run_command".into();
        assert_eq!(
            manager.request_pairing(params).unwrap_err(),
            "unsupported_capabilities"
        );
        assert_eq!(manager.list_clients().unwrap().len(), 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn revoked_tokens_stop_authenticating_and_remove_the_persisted_record() {
        let (manager, directory) = manager();
        let pairing = manager.begin_pairing().unwrap();
        let token = approve(&manager, &pairing.code);
        let client_key = manager.list_clients().unwrap()[0].client_key.clone();
        manager.revoke_client(&client_key).unwrap();
        assert_eq!(manager.authenticate(&token).unwrap_err(), "not_authorized");
        assert!(manager.list_clients().unwrap().is_empty());
        assert!(!manager.record_path(&client_key).exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn already_paired_client_must_be_revoked_before_pairing_again() {
        let (manager, directory) = manager();
        let first = manager.begin_pairing().unwrap();
        let _token = approve(&manager, &first.code);
        let second = manager.begin_pairing().unwrap();
        let (pending, receiver) = manager.request_pairing(pair_params(&second.code)).unwrap();
        assert_eq!(
            manager.approve_pairing(&pending.request_id).unwrap_err(),
            "client_already_paired"
        );
        assert_eq!(
            receiver.blocking_recv().unwrap().unwrap_err(),
            "client_already_paired"
        );
        assert_eq!(manager.list_clients().unwrap().len(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn revocation_cancels_the_active_session() {
        let (manager, directory) = manager();
        let pairing = manager.begin_pairing().unwrap();
        let _token = approve(&manager, &pairing.code);
        let client_key = manager.list_clients().unwrap()[0].client_key.clone();
        let (_, cancelled) = manager.open_session(&client_key).unwrap();
        manager.revoke_client(&client_key).unwrap();
        assert!(cancelled.is_cancelled());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn json_rpc_requests_require_exact_envelopes() {
        let valid = json!({
            "jsonrpc": "2.0",
            "id": "request-1",
            "method": "client.authenticate",
            "params": { "accessToken": "token" }
        });
        assert!(request_parts(&valid).is_ok());
        let extra = json!({
            "jsonrpc": "2.0",
            "id": "request-1",
            "method": "client.authenticate",
            "params": {},
            "token": "secret"
        });
        assert_eq!(request_parts(&extra).unwrap_err(), "invalid_request");
        let missing_params = json!({
            "jsonrpc": "2.0",
            "id": "request-1",
            "method": "client.authenticate"
        });
        assert_eq!(
            request_parts(&missing_params).unwrap_err(),
            "invalid_request"
        );
    }

    #[test]
    fn approved_schema_handshake_examples_match_rust_types() {
        let schema: Value =
            serde_json::from_str(include_str!("../../docs/spirit-protocol-v1.schema.json"))
                .unwrap();
        let examples = schema["examples"].as_array().unwrap();
        let mut checked = 0;
        for example in examples {
            let Some(method) = example.get("method").and_then(Value::as_str) else {
                continue;
            };
            let params = example["params"].clone();
            match method {
                "client.pair" => {
                    let params: PairParams = serde_json::from_value(params).unwrap();
                    validate_capabilities(&params.requested_capabilities).unwrap();
                    checked += 1;
                }
                "client.authenticate" => {
                    let params: AuthenticateParams = serde_json::from_value(params).unwrap();
                    assert!(params.access_token.len() >= 32);
                    checked += 1;
                }
                "client.initialize" => {
                    let params: InitializeParams = serde_json::from_value(params).unwrap();
                    assert_eq!(params.protocol_version, "1");
                    validate_capabilities(&params.capabilities).unwrap();
                    checked += 1;
                }
                _ => {}
            }
        }
        assert_eq!(checked, 3);
    }

    #[tokio::test]
    async fn websocket_pair_authenticate_initialize_and_client_unpair_work_over_wire() {
        let (manager, directory) = manager();
        let manager = Arc::new(manager);
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let emitter: Arc<dyn ProtocolEventEmitter> =
            Arc::new(move |event| event_tx.send(event).map_err(|err| err.to_string()));
        let app = Router::new()
            .route("/v1/connect", get(test_connect))
            .with_state(WebSocketTestState {
                manager: Arc::clone(&manager),
                emitter,
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let pairing = manager.begin_pairing().unwrap();
        let (mut pairing_socket, _) = connect_async(format!("ws://{addr}/v1/connect"))
            .await
            .unwrap();
        send_client_json(
            &mut pairing_socket,
            json!({
                "jsonrpc": "2.0",
                "id": "pair-1",
                "method": "client.pair",
                "params": pair_params(&pairing.code)
            }),
        )
        .await;

        let pending = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(pending) = manager.pending_pairings().unwrap().into_iter().next() {
                    break pending;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        manager.approve_pairing(&pending.request_id).unwrap();
        let pair_response = receive_client_json(&mut pairing_socket).await;
        let token = pair_response["result"]["accessToken"]
            .as_str()
            .unwrap()
            .to_string();
        pairing_socket.close(None).await.unwrap();

        let (mut client_socket, _) = connect_async(format!("ws://{addr}/v1/connect"))
            .await
            .unwrap();
        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "id": "auth-1",
                "method": "client.authenticate",
                "params": { "accessToken": token }
            }),
        )
        .await;
        let auth_response = receive_client_json(&mut client_socket).await;
        assert_eq!(auth_response["result"]["authenticated"], true);

        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "id": "init-1",
                "method": "client.initialize",
                "params": {
                    "protocolVersion": "1",
                    "client": pair_params("unused").client,
                    "capabilities": manifest()
                }
            }),
        )
        .await;
        let init_response = receive_client_json(&mut client_socket).await;
        assert_eq!(init_response["result"]["protocolVersion"], "1");
        assert_eq!(
            init_response["result"]["grantedCapabilities"],
            json!(["siju.narrate_current", "event.publish:siju.analysis.status"])
        );

        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "method": "event.publish",
                "params": {
                    "eventId": "event-1",
                    "eventType": "siju.analysis.status",
                    "occurredAt": "2026-11-01T00:00:00Z",
                    "payload": { "status": "ready" }
                }
            }),
        )
        .await;
        let event = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["clientId"], "com.siju.app");
        assert_eq!(event["payload"]["status"], "ready");

        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "id": "unpair-1",
                "method": "client.unpair",
                "params": {}
            }),
        )
        .await;
        let unpair_response = receive_client_json(&mut client_socket).await;
        assert_eq!(unpair_response["id"], "unpair-1");
        assert_eq!(unpair_response["result"]["unpaired"], true);
        assert!(manager.list_clients().unwrap().is_empty());
        assert_eq!(manager.authenticate(&token).unwrap_err(), "not_authorized");
        let close = tokio::time::timeout(Duration::from_secs(2), client_socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(close, ClientMessage::Close(_)));

        server.abort();
        fs::remove_dir_all(directory).unwrap();
    }
}
