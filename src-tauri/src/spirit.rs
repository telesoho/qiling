use std::{
    collections::{HashMap, HashSet},
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
    sync::{mpsc, oneshot, OwnedSemaphorePermit},
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::voice_command;

const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PAIRING_ATTEMPTS: u8 = 5;
const MAX_CLIENTS: usize = 32;
const MAX_CONNECTIONS: usize = 32;
const MAX_EVENTS_PER_MINUTE: u8 = 60;
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(5);
const PAIR_APPROVAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_ACTIONS_PER_CLIENT: usize = 16;
const MAX_EVENTS_PER_CLIENT: usize = 16;
const MAX_ACTION_ID_CHARS: usize = 128;
const MAX_DESCRIPTION_CHARS: usize = 120;
const MAX_SCHEMA_BYTES: usize = 16 * 1024;
const MAX_SCHEMA_DEPTH: usize = 8;
const MAX_VOICE_EXAMPLES: usize = 12;
const MAX_VOICE_EXAMPLE_CHARS: usize = 40;
const MAX_VOICE_TOTAL_CHARS: usize = 240;
const MAX_VOICE_ACTIONS: usize = 64;
const MAX_LOCALE_CHARS: usize = 16;
const MAX_EVENT_PAYLOAD_BYTES: usize = 4 * 1024;
const MAX_EVENT_PAYLOAD_DEPTH: usize = 4;
pub const DEFAULT_ACTION_TIMEOUT: Duration = Duration::from_secs(60);

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
    #[serde(default)]
    pub description: Option<String>,
    pub input_schema: Value,
    pub output_schema: Value,
    pub supports_cancellation: bool,
    /// Optional client-declared voice entry. It only narrows matching: it can
    /// never add an Action, raise its risk, or bypass the pairing approval.
    #[serde(default)]
    pub voice: Option<VoiceCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceCapability {
    #[serde(default)]
    pub examples: Vec<String>,
    #[serde(default)]
    pub locale: Option<String>,
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
    pub connected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NarrationResult {
    pub text: String,
    pub mood: String,
}

struct ActionDispatch {
    request_id: String,
    action_id: String,
    timeout_ms: u64,
    response: oneshot::Sender<Result<NarrationResult, String>>,
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
    action_tx: mpsc::UnboundedSender<ActionDispatch>,
    pending_action_id: Option<String>,
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
        if total_voice_actions(&inner.clients) > MAX_VOICE_ACTIONS {
            return Err("credential_record_invalid".into());
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
        {
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
        }
        if total_voice_actions(&inner.clients) + count_voice_actions(&params.requested_capabilities)
            > MAX_VOICE_ACTIONS
        {
            return Err("voice_command_limit".into());
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
        if total_voice_actions(&inner.clients)
            + count_voice_actions(&pending.view.requested_capabilities)
            > MAX_VOICE_ACTIONS
        {
            let _ = pending.decision.send(Err("voice_command_limit".into()));
            return Err("voice_command_limit".into());
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
                connected: inner.sessions.contains_key(&record.client_key),
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

    fn open_session(
        &self,
        client_key: &str,
        action_tx: mpsc::UnboundedSender<ActionDispatch>,
    ) -> Result<(String, CancellationToken), String> {
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
                action_tx,
                pending_action_id: None,
            },
        );
        Ok((session_id, cancelled))
    }

    pub async fn invoke_action(
        &self,
        client_id: &str,
        action_id: &str,
        action_timeout: Duration,
    ) -> Result<NarrationResult, String> {
        let started_at = Instant::now();
        let timeout_ms = u64::try_from(action_timeout.as_millis())
            .unwrap_or(u64::MAX)
            .clamp(1_000, 120_000);
        let client_key = {
            let inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
            let record = inner
                .clients
                .values()
                .find(|record| record.client.id == client_id)
                .ok_or_else(|| "not_authorized".to_string())?;
            if !record
                .capabilities
                .actions
                .iter()
                .any(|action| action.id == action_id)
            {
                return Err("action_not_found".into());
            }
            record.client_key.clone()
        };
        let request_id = Uuid::new_v4().to_string();
        let (response_tx, response_rx) = oneshot::channel();
        {
            let mut inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
            let session = inner
                .sessions
                .get_mut(&client_key)
                .ok_or_else(|| "client_unavailable".to_string())?;
            if session.pending_action_id.is_some() {
                return Err("busy".into());
            }
            session.pending_action_id = Some(request_id.clone());
            if session
                .action_tx
                .send(ActionDispatch {
                    request_id: request_id.clone(),
                    action_id: action_id.to_string(),
                    timeout_ms,
                    response: response_tx,
                })
                .is_err()
            {
                session.pending_action_id = None;
                return Err("client_unavailable".into());
            }
        }

        let outcome = match timeout(action_timeout, response_rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err("client_unavailable".into()),
            Err(_) => Err("deadline_exceeded".into()),
        };
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(session) = inner.sessions.get_mut(&client_key) {
                if session.pending_action_id.as_deref() == Some(&request_id) {
                    session.pending_action_id = None;
                }
            }
        }
        let status = outcome
            .as_ref()
            .map(|_| "success")
            .unwrap_or_else(|code| code.as_str());
        eprintln!(
            "[Spirit Action] request_id={request_id} client_id={client_id} action={action_id} outcome={status} elapsed_ms={}",
            started_at.elapsed().as_millis()
        );
        outcome
    }

    /// Update the voice metadata of an already-approved client.
    ///
    /// Actions, events, schemas, risk and descriptions stay exactly as the user
    /// approved them. Only client-provided matching hints may change, and the
    /// updated record is persisted so the settings page keeps showing what will
    /// trigger the command.
    fn adopt_voice_metadata(
        &self,
        client_key: &str,
        declared: CapabilityManifest,
    ) -> Result<StoredClient, String> {
        let mut inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        let record = inner
            .clients
            .get(client_key)
            .ok_or_else(|| "not_authorized".to_string())?
            .clone();
        if !authorization_equal(&record.capabilities, &declared) {
            return Err("not_authorized".into());
        }
        if record.capabilities == declared {
            return Ok(record);
        }
        let other_voice: usize = inner
            .clients
            .values()
            .filter(|client| client.client_key != record.client_key)
            .map(|client| count_voice_actions(&client.capabilities))
            .sum();
        if other_voice + count_voice_actions(&declared) > MAX_VOICE_ACTIONS {
            return Err("voice_command_limit".into());
        }
        let mut updated = record;
        updated.capabilities = declared;
        self.persist(&updated)?;
        inner
            .clients
            .insert(client_key.to_string(), updated.clone());
        Ok(updated)
    }

    /// Snapshot every approved Action of every paired client, for the voice
    /// router. Offline clients stay in the snapshot so a recognised command can
    /// answer "not connected" instead of falling through to the conversation
    /// model. Nothing is cached: disconnects and revocations take effect on the
    /// next utterance.
    pub fn route_actions(&self) -> Result<Vec<voice_command::AvailableAction>, String> {
        let inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        let mut actions = Vec::new();
        for record in inner.clients.values() {
            let connected = inner.sessions.contains_key(&record.client_key);
            for action in &record.capabilities.actions {
                actions.push(voice_command::AvailableAction {
                    client_id: record.client.id.clone(),
                    client_name: record.client.name.clone(),
                    action_id: action.id.clone(),
                    voice: action.voice.as_ref().map(|voice| voice.examples.clone()),
                    connected,
                });
            }
        }
        actions.sort_by(|left, right| {
            left.client_name
                .cmp(&right.client_name)
                .then_with(|| left.client_id.cmp(&right.client_id))
                .then_with(|| left.action_id.cmp(&right.action_id))
        });
        Ok(actions)
    }

    pub fn client_name(&self, client_id: &str) -> Result<Option<String>, String> {
        let inner = self.inner.lock().map_err(|_| "pairing_state_unavailable")?;
        Ok(inner
            .clients
            .values()
            .find(|record| record.client.id == client_id)
            .map(|record| record.client.name.clone()))
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
            .create(true)
            .truncate(true)
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
    let id = client.id.trim();
    let id_length = id.chars().count();
    if id_length < 3
        || id_length > 128
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
        || !id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
    {
        return Err("invalid_client".into());
    }
    if client.name.trim().is_empty()
        || client.name.chars().count() > 80
        || voice_command::spoken_key(&client.name).is_empty()
        || client.version.trim().is_empty()
        || client.version.chars().count() > 40
    {
        return Err("invalid_client".into());
    }
    Ok(())
}

#[cfg(test)]
fn action_capability(id: &str, risk: &str) -> ActionCapability {
    ActionCapability {
        id: id.into(),
        risk: risk.into(),
        description: None,
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
        voice: None,
    }
}

#[cfg(test)]
fn siju_capabilities() -> CapabilityManifest {
    CapabilityManifest {
        actions: vec![action_capability("siju.narrate_current", "no_state_change")],
        events: EventCapabilities {
            publishes: vec!["siju.analysis.status".into()],
            subscribes: vec![],
        },
    }
}

#[cfg(test)]
fn vscode_capabilities() -> CapabilityManifest {
    CapabilityManifest {
        actions: vec![action_capability("vscode.explain_selection", "sensitive")],
        events: EventCapabilities {
            publishes: vec!["vscode.editor.status".into()],
            subscribes: vec![],
        },
    }
}

/// Validate a client-declared capability manifest against the generic V1
/// policy. No client ID is special-cased: authorization comes from the pairing
/// approval, not from this function.
fn validate_capabilities(capabilities: &CapabilityManifest) -> Result<(), String> {
    if capabilities.actions.len() > MAX_ACTIONS_PER_CLIENT {
        return Err("invalid_capabilities".into());
    }
    let mut action_ids = HashSet::new();
    for action in &capabilities.actions {
        validate_action(action)?;
        if !action_ids.insert(action.id.as_str()) {
            return Err("invalid_capabilities".into());
        }
    }
    validate_event_types(&capabilities.events.publishes)?;
    validate_event_types(&capabilities.events.subscribes)?;
    Ok(())
}

fn validate_action(action: &ActionCapability) -> Result<(), String> {
    if !is_valid_dotted_id(&action.id) {
        return Err("invalid_capabilities".into());
    }
    if !matches!(
        action.risk.as_str(),
        "no_state_change" | "state_change" | "sensitive"
    ) {
        return Err("invalid_capabilities".into());
    }
    if let Some(description) = &action.description {
        let trimmed = description.trim();
        if trimmed.is_empty()
            || trimmed.chars().count() > MAX_DESCRIPTION_CHARS
            || description.chars().any(char::is_control)
        {
            return Err("invalid_capabilities".into());
        }
    }
    if !is_no_argument_schema(&action.input_schema)
        || !is_narration_output_schema(&action.output_schema)
        || schema_too_large(&action.input_schema)
        || schema_too_large(&action.output_schema)
        || schema_depth_exceeded(&action.input_schema)
        || schema_depth_exceeded(&action.output_schema)
    {
        return Err("invalid_capabilities".into());
    }
    if let Some(voice) = &action.voice {
        if action.risk != "no_state_change" || action.supports_cancellation {
            return Err("invalid_capabilities".into());
        }
        validate_voice(voice)?;
    }
    Ok(())
}

fn validate_event_types(event_types: &[String]) -> Result<(), String> {
    if event_types.len() > MAX_EVENTS_PER_CLIENT {
        return Err("invalid_capabilities".into());
    }
    let mut seen = HashSet::new();
    for event_type in event_types {
        if !is_valid_dotted_id(event_type) || !seen.insert(event_type.as_str()) {
            return Err("invalid_capabilities".into());
        }
    }
    Ok(())
}

fn validate_voice(voice: &VoiceCapability) -> Result<(), String> {
    if voice.examples.is_empty() || voice.examples.len() > MAX_VOICE_EXAMPLES {
        return Err("invalid_capabilities".into());
    }
    if let Some(locale) = &voice.locale {
        if !is_valid_locale(locale) {
            return Err("invalid_capabilities".into());
        }
    }
    let mut keys = HashSet::new();
    let mut total = 0usize;
    for example in &voice.examples {
        let trimmed = example.trim();
        if trimmed.is_empty()
            || trimmed.chars().count() > MAX_VOICE_EXAMPLE_CHARS
            || example.chars().any(char::is_control)
        {
            return Err("invalid_capabilities".into());
        }
        let key = voice_command::spoken_key(trimmed);
        if key.chars().count() < 2
            || !keys.insert(key.clone())
            || voice_command::is_reserved_example(&key)
            || voice_command::contains_negation(&key)
        {
            return Err("invalid_capabilities".into());
        }
        total += trimmed.chars().count();
        if total > MAX_VOICE_TOTAL_CHARS {
            return Err("invalid_capabilities".into());
        }
    }
    Ok(())
}

fn is_valid_dotted_id(value: &str) -> bool {
    let length = value.chars().count();
    if length == 0 || length > MAX_ACTION_ID_CHARS {
        return false;
    }
    let mut segments = value.split('.');
    let Some(first) = segments.next() else {
        return false;
    };
    if !is_lower_segment(first) {
        return false;
    }
    let rest: Vec<&str> = segments.collect();
    !rest.is_empty() && rest.iter().all(|segment| is_lower_segment(segment))
}

fn is_lower_segment(segment: &str) -> bool {
    let mut characters = segment.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

fn is_valid_locale(locale: &str) -> bool {
    let length = locale.chars().count();
    if length == 0 || length > MAX_LOCALE_CHARS {
        return false;
    }
    let mut parts = locale.split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    let first_length = first.chars().count();
    if !(2..=3).contains(&first_length)
        || !first
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return false;
    }
    parts.all(|part| {
        let length = part.chars().count();
        (2..=8).contains(&length)
            && part
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
    })
}

fn is_no_argument_schema(schema: &Value) -> bool {
    let Some(object) = schema.as_object() else {
        return false;
    };
    if object.get("type").and_then(Value::as_str) != Some("object")
        || object.get("additionalProperties") != Some(&Value::Bool(false))
    {
        return false;
    }
    let properties_empty = match object.get("properties") {
        None => true,
        Some(Value::Object(properties)) => properties.is_empty(),
        _ => false,
    };
    let required_empty = match object.get("required") {
        None => true,
        Some(Value::Array(required)) => required.is_empty(),
        _ => false,
    };
    properties_empty && required_empty
}

fn is_narration_output_schema(schema: &Value) -> bool {
    let Some(object) = schema.as_object() else {
        return false;
    };
    if object.get("type").and_then(Value::as_str) != Some("object")
        || object.get("additionalProperties") != Some(&Value::Bool(false))
    {
        return false;
    }
    let required_ok = object
        .get("required")
        .and_then(Value::as_array)
        .is_some_and(|required| {
            required.len() == 2
                && required.iter().any(|value| value.as_str() == Some("text"))
                && required.iter().any(|value| value.as_str() == Some("mood"))
        });
    if !required_ok {
        return false;
    }
    let Some(properties) = object.get("properties").and_then(Value::as_object) else {
        return false;
    };
    if properties.len() != 2 {
        return false;
    }
    let Some(text) = properties.get("text").and_then(Value::as_object) else {
        return false;
    };
    let Some(mood) = properties.get("mood").and_then(Value::as_object) else {
        return false;
    };
    let moods = mood.get("enum").and_then(Value::as_array).map(|values| {
        let mut names: Vec<&str> = values.iter().filter_map(Value::as_str).collect();
        names.sort_unstable();
        names
    });
    text.get("type").and_then(Value::as_str) == Some("string")
        && text.get("maxLength").and_then(Value::as_u64) == Some(400)
        && mood.get("type").and_then(Value::as_str) == Some("string")
        && moods == Some(vec!["down", "neutral", "up"])
}

fn schema_too_large(schema: &Value) -> bool {
    json_size_exceeds(schema, MAX_SCHEMA_BYTES)
}

fn json_size_exceeds(value: &Value, limit: usize) -> bool {
    serde_json::to_vec(value)
        .map(|encoded| encoded.len() > limit)
        .unwrap_or(true)
}

fn schema_depth_exceeded(schema: &Value) -> bool {
    value_depth(schema) > MAX_SCHEMA_DEPTH
}

fn value_depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(value_depth).max().unwrap_or(0),
        Value::Object(object) => 1 + object.values().map(value_depth).max().unwrap_or(0),
        _ => 1,
    }
}

fn count_voice_actions(capabilities: &CapabilityManifest) -> usize {
    capabilities
        .actions
        .iter()
        .filter(|action| action.voice.is_some())
        .count()
}

fn total_voice_actions(clients: &HashMap<String, StoredClient>) -> usize {
    clients
        .values()
        .map(|client| count_voice_actions(&client.capabilities))
        .sum()
}

/// The parts of a manifest the user approved. Voice metadata is matching-only
/// and may be refreshed by a reconnecting client; everything else is fixed
/// until the user pairs the client again.
fn authorization_equal(approved: &CapabilityManifest, declared: &CapabilityManifest) -> bool {
    approved.events == declared.events
        && approved.actions.len() == declared.actions.len()
        && approved.actions.iter().all(|approved_action| {
            declared
                .actions
                .iter()
                .any(|declared_action| action_authorization_equal(approved_action, declared_action))
        })
}

fn action_authorization_equal(approved: &ActionCapability, declared: &ActionCapability) -> bool {
    approved.id == declared.id
        && approved.risk == declared.risk
        && approved.description == declared.description
        && approved.input_schema == declared.input_schema
        && approved.output_schema == declared.output_schema
        && approved.supports_cancellation == declared.supports_cancellation
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
    if init.client != client.client {
        let _ = send_json(&mut socket, &rpc_error(id, -32000, "not_authorized", false)).await;
        return;
    }
    if validate_capabilities(&init.capabilities).is_err() {
        let _ = send_json(
            &mut socket,
            &rpc_error(id, -32000, "invalid_capabilities", false),
        )
        .await;
        return;
    }
    if !authorization_equal(&client.capabilities, &init.capabilities) {
        let _ = send_json(&mut socket, &rpc_error(id, -32000, "not_authorized", false)).await;
        return;
    }
    // Only client-provided voice hints may differ from the approved record.
    // They are persisted so the settings page and the next connection keep
    // showing the same phrases.
    let client = match manager.adopt_voice_metadata(&client.client_key, init.capabilities) {
        Ok(client) => client,
        Err(code) => {
            let _ = send_json(&mut socket, &rpc_error(id, -32000, &code, false)).await;
            return;
        }
    };
    let (action_tx, mut action_rx) = mpsc::unbounded_channel();
    let (session_id, cancelled) = match manager.open_session(&client.client_key, action_tx) {
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
    let mut pending_actions: HashMap<String, oneshot::Sender<Result<NarrationResult, String>>> =
        HashMap::new();
    loop {
        tokio::select! {
            _ = cancelled.cancelled() => {
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
            dispatch = action_rx.recv() => {
                let Some(dispatch) = dispatch else { break };
                pending_actions.retain(|_, response| !response.is_closed());
                if !pending_actions.is_empty() {
                    let _ = dispatch.response.send(Err("busy".into()));
                    continue;
                }
                let request = json!({
                    "jsonrpc": "2.0",
                    "id": dispatch.request_id,
                    "method": "action.invoke",
                    "params": {
                        "action": dispatch.action_id,
                        "arguments": {},
                        "timeoutMs": dispatch.timeout_ms
                    }
                });
                pending_actions.insert(
                    request["id"].as_str().unwrap_or_default().to_string(),
                    dispatch.response,
                );
                if send_json(&mut socket, &request).await.is_err() {
                    break;
                }
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
                        if let Ok(response) = serde_json::from_str::<Value>(&text) {
                            if let Some(id) = response.get("id").and_then(Value::as_str) {
                                if let Some(reply) = pending_actions.remove(id) {
                                    let _ = reply.send(parse_narration_response(&response, id));
                                    continue;
                                }
                            }
                            if response.get("method").is_none()
                                && response.get("id").is_some()
                                && (response.get("result").is_some()
                                    || response.get("error").is_some())
                            {
                                continue;
                            }
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

fn parse_narration_response(message: &Value, request_id: &str) -> Result<NarrationResult, String> {
    let object = message
        .as_object()
        .ok_or_else(|| "invalid_action_response".to_string())?;
    if object.len() != 3
        || message.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || message.get("id").and_then(Value::as_str) != Some(request_id)
    {
        return Err("invalid_action_response".into());
    }
    if let Some(error) = message.get("error") {
        return Err(error
            .get("data")
            .and_then(|data| data.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("internal_error")
            .to_string());
    }
    let result = message
        .get("result")
        .cloned()
        .ok_or_else(|| "invalid_action_response".to_string())?;
    let result: NarrationResult =
        serde_json::from_value(result).map_err(|_| "invalid_action_response".to_string())?;
    if result.text.trim().is_empty()
        || result.text.chars().count() > 400
        || !matches!(result.mood.as_str(), "neutral" | "up" | "down")
    {
        return Err("invalid_action_response".into());
    }
    Ok(result)
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
    if !client
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
    if !params.payload.is_object()
        || json_size_exceeds(&params.payload, MAX_EVENT_PAYLOAD_BYTES)
        || value_depth(&params.payload) > MAX_EVENT_PAYLOAD_DEPTH
        || params.occurred_at.trim().is_empty()
        || params.occurred_at.chars().count() > 40
    {
        return false;
    }
    if matches!(
        params.event_type.as_str(),
        "siju.analysis.status" | "vscode.editor.status"
    ) {
        let status = params.payload.get("status").and_then(Value::as_str);
        if !matches!(status, Some("ready" | "unavailable"))
            || params.payload.as_object().map(|payload| payload.len()) != Some(1)
        {
            return false;
        }
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
        siju_capabilities()
    }

    fn vscode_manifest() -> CapabilityManifest {
        vscode_capabilities()
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

    fn vscode_pair_params(code: &str) -> PairParams {
        PairParams {
            pairing_code: code.into(),
            client: ClientInfo {
                id: "com.qiling.vscode".into(),
                name: "Visual Studio Code".into(),
                version: "0.1.0".into(),
            },
            requested_capabilities: vscode_manifest(),
        }
    }

    fn voice_manifest() -> CapabilityManifest {
        CapabilityManifest {
            actions: vec![ActionCapability {
                id: "demo.say_hello".into(),
                risk: "no_state_change".into(),
                description: Some("打个招呼".into()),
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
                voice: Some(VoiceCapability {
                    examples: vec!["打个招呼".into(), "说声你好".into()],
                    locale: Some("zh-CN".into()),
                }),
            }],
            events: EventCapabilities {
                publishes: vec![],
                subscribes: vec![],
            },
        }
    }

    fn voice_pair_params(code: &str) -> PairParams {
        PairParams {
            pairing_code: code.into(),
            client: ClientInfo {
                id: "com.example.voice-demo".into(),
                name: "示例客户端".into(),
                version: "0.1.0".into(),
            },
            requested_capabilities: voice_manifest(),
        }
    }

    fn approve_generic(manager: &PairingManager, code: &str) -> String {
        let (pending, receiver) = manager.request_pairing(voice_pair_params(code)).unwrap();
        manager.approve_pairing(&pending.request_id).unwrap();
        receiver.blocking_recv().unwrap().unwrap()
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
    fn generic_clients_pair_but_invalid_manifests_are_rejected() {
        let (manager, directory) = manager();
        let pairing = manager.begin_pairing().unwrap();

        let mut voice_on_sensitive = voice_pair_params(&pairing.code);
        voice_on_sensitive.requested_capabilities.actions[0].risk = "sensitive".into();
        assert_eq!(
            manager.request_pairing(voice_on_sensitive).unwrap_err(),
            "invalid_capabilities"
        );

        let mut invalid_client = voice_pair_params(&pairing.code);
        invalid_client.client.id = "bad id!".into();
        assert_eq!(
            manager.request_pairing(invalid_client).unwrap_err(),
            "invalid_client"
        );

        assert_eq!(manager.list_clients().unwrap().len(), 0);
        let _token = approve_generic(&manager, &pairing.code);
        assert_eq!(
            manager.list_clients().unwrap()[0].client.id,
            "com.example.voice-demo"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn voice_metadata_is_bounded_and_low_risk_only() {
        let mut manifest = voice_manifest();
        manifest.actions[0].supports_cancellation = true;
        assert_eq!(
            validate_capabilities(&manifest).unwrap_err(),
            "invalid_capabilities"
        );

        let mut manifest = voice_manifest();
        manifest.actions[0].risk = "state_change".into();
        assert_eq!(
            validate_capabilities(&manifest).unwrap_err(),
            "invalid_capabilities"
        );

        let mut manifest = voice_manifest();
        manifest.actions[0].voice = Some(VoiceCapability {
            examples: vec!["停止导航".into()],
            locale: None,
        });
        assert_eq!(
            validate_capabilities(&manifest).unwrap_err(),
            "invalid_capabilities"
        );

        let mut manifest = voice_manifest();
        manifest.actions[0].voice = Some(VoiceCapability {
            examples: vec!["打个招呼".into(), "打个招呼".into()],
            locale: None,
        });
        assert_eq!(
            validate_capabilities(&manifest).unwrap_err(),
            "invalid_capabilities"
        );

        let mut manifest = voice_manifest();
        manifest.actions[0].voice = Some(VoiceCapability {
            examples: (0..13).map(|index| format!("示例口令{index}")).collect(),
            locale: None,
        });
        assert_eq!(
            validate_capabilities(&manifest).unwrap_err(),
            "invalid_capabilities"
        );

        let mut manifest = voice_manifest();
        manifest.actions[0].input_schema = json!({
            "type": "object",
            "additionalProperties": false,
            "properties": { "target": { "type": "string" } }
        });
        assert_eq!(
            validate_capabilities(&manifest).unwrap_err(),
            "invalid_capabilities"
        );

        let mut manifest = voice_manifest();
        manifest.actions[0].output_schema = json!({ "type": "object" });
        assert_eq!(
            validate_capabilities(&manifest).unwrap_err(),
            "invalid_capabilities"
        );
    }

    #[test]
    fn voice_metadata_updates_without_reapproval_but_actions_stay_fixed() {
        let (manager, directory) = manager();
        let pairing = manager.begin_pairing().unwrap();
        let _token = approve_generic(&manager, &pairing.code);
        let client_key = manager.list_clients().unwrap()[0].client_key.clone();

        let mut updated = voice_manifest();
        updated.actions[0].voice = Some(VoiceCapability {
            examples: vec!["你好呀".into()],
            locale: None,
        });
        let record = manager
            .adopt_voice_metadata(&client_key, updated.clone())
            .unwrap();
        assert_eq!(
            record.capabilities.actions[0]
                .voice
                .as_ref()
                .unwrap()
                .examples,
            vec!["你好呀"]
        );

        let reloaded = PairingManager::load(&directory).unwrap();
        assert_eq!(
            reloaded.list_clients().unwrap()[0].capabilities.actions[0]
                .voice
                .as_ref()
                .unwrap()
                .examples,
            vec!["你好呀"]
        );

        let mut changed_action = voice_manifest();
        changed_action.actions[0].id = "demo.other".into();
        assert_eq!(
            manager
                .adopt_voice_metadata(&client_key, changed_action)
                .unwrap_err(),
            "not_authorized"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn route_snapshot_tracks_voice_metadata_and_connection_state() {
        let (manager, directory) = manager();
        let pairing = manager.begin_pairing().unwrap();
        let _token = approve_generic(&manager, &pairing.code);
        let client_key = manager.list_clients().unwrap()[0].client_key.clone();

        let actions = manager.route_actions().unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].client_id, "com.example.voice-demo");
        assert_eq!(
            actions[0].voice.as_deref(),
            Some(["打个招呼".to_string(), "说声你好".to_string()].as_slice())
        );
        assert!(!actions[0].connected);
        assert!(matches!(
            voice_command::match_transcript(&actions, "打个招呼"),
            voice_command::VoiceOutcome::Action(voice_command::MatchedAction {
                connected: false,
                ..
            })
        ));

        let (action_tx, _action_rx) = mpsc::unbounded_channel();
        manager.open_session(&client_key, action_tx).unwrap();
        assert!(manager.route_actions().unwrap()[0].connected);

        manager.revoke_client(&client_key).unwrap();
        assert!(manager.route_actions().unwrap().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn generic_actions_are_invocable_without_a_client_whitelist() {
        let (manager, directory) = manager();
        let pairing = manager.begin_pairing().unwrap();
        let _token = approve_generic(&manager, &pairing.code);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            assert_eq!(
                manager
                    .invoke_action(
                        "com.example.voice-demo",
                        "demo.say_hello",
                        Duration::from_secs(1)
                    )
                    .await
                    .unwrap_err(),
                "client_unavailable"
            );
            assert_eq!(
                manager
                    .invoke_action(
                        "com.example.voice-demo",
                        "demo.missing",
                        Duration::from_secs(1)
                    )
                    .await
                    .unwrap_err(),
                "action_not_found"
            );
        });
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
        let (action_tx, _) = mpsc::unbounded_channel();
        let (_, cancelled) = manager.open_session(&client_key, action_tx).unwrap();
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
        assert_eq!(checked, 6);
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

        let invoke_manager = Arc::clone(&manager);
        let invocation = tokio::spawn(async move {
            invoke_manager
                .invoke_action(
                    "com.siju.app",
                    "siju.narrate_current",
                    Duration::from_secs(2),
                )
                .await
        });
        let action_request = receive_client_json(&mut client_socket).await;
        assert_eq!(action_request["method"], "action.invoke");
        assert_eq!(action_request["params"]["action"], "siju.narrate_current");
        assert_eq!(action_request["params"]["arguments"], json!({}));
        assert_eq!(
            manager
                .invoke_action(
                    "com.siju.app",
                    "siju.narrate_current",
                    Duration::from_secs(2)
                )
                .await
                .unwrap_err(),
            "busy"
        );
        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "id": action_request["id"],
                "result": { "text": "当前局面红方略优。", "mood": "up" }
            }),
        )
        .await;
        assert_eq!(
            invocation.await.unwrap().unwrap(),
            NarrationResult {
                text: "当前局面红方略优。".into(),
                mood: "up".into()
            }
        );

        let timeout_manager = Arc::clone(&manager);
        let timed_invocation = tokio::spawn(async move {
            timeout_manager
                .invoke_action(
                    "com.siju.app",
                    "siju.narrate_current",
                    Duration::from_millis(20),
                )
                .await
        });
        let late_action_request = receive_client_json(&mut client_socket).await;
        assert_eq!(
            timed_invocation.await.unwrap().unwrap_err(),
            "deadline_exceeded"
        );
        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "id": late_action_request["id"],
                "result": { "text": "迟到的结果不能算成功。", "mood": "neutral" }
            }),
        )
        .await;

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

    #[tokio::test]
    async fn vscode_client_pairs_initializes_and_publishes_editor_status_over_wire() {
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
                "id": "vscode-pair",
                "method": "client.pair",
                "params": vscode_pair_params(&pairing.code)
            }),
        )
        .await;
        let pending = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(pending) = manager.pending_pairings().unwrap().into_iter().next() {
                    break pending;
                }
                tokio::select! {
                    message = pairing_socket.next() => {
                        panic!("expected an approval request, got {message:?}");
                    }
                    _ = tokio::time::sleep(Duration::from_millis(10)) => {}
                }
            }
        })
        .await
        .unwrap();
        manager.approve_pairing(&pending.request_id).unwrap();
        let token = receive_client_json(&mut pairing_socket).await["result"]["accessToken"]
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
                "id": "vscode-auth",
                "method": "client.authenticate",
                "params": { "accessToken": token }
            }),
        )
        .await;
        assert_eq!(
            receive_client_json(&mut client_socket).await["result"]["authenticated"],
            true
        );
        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "id": "vscode-init",
                "method": "client.initialize",
                "params": {
                    "protocolVersion": "1",
                    "client": vscode_pair_params("unused").client,
                    "capabilities": vscode_manifest()
                }
            }),
        )
        .await;
        assert_eq!(
            receive_client_json(&mut client_socket).await["result"]["grantedCapabilities"],
            json!([
                "vscode.explain_selection",
                "event.publish:vscode.editor.status"
            ])
        );

        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "method": "event.publish",
                "params": {
                    "eventId": "vscode-event-1",
                    "eventType": "vscode.editor.status",
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
        assert_eq!(event["clientId"], "com.qiling.vscode");
        assert_eq!(event["eventType"], "vscode.editor.status");
        assert_eq!(event["payload"]["status"], "ready");

        let invoke_manager = Arc::clone(&manager);
        let invocation = tokio::spawn(async move {
            invoke_manager
                .invoke_action(
                    "com.qiling.vscode",
                    "vscode.explain_selection",
                    Duration::from_secs(2),
                )
                .await
        });
        let action_request = receive_client_json(&mut client_socket).await;
        assert_eq!(action_request["method"], "action.invoke");
        assert_eq!(
            action_request["params"]["action"],
            "vscode.explain_selection"
        );
        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "id": action_request["id"],
                "result": { "text": "const answer = 42;", "mood": "neutral" }
            }),
        )
        .await;
        assert_eq!(
            invocation.await.unwrap().unwrap(),
            NarrationResult {
                text: "const answer = 42;".into(),
                mood: "neutral".into()
            }
        );

        server.abort();
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn generic_voice_client_is_discovered_over_the_wire() {
        let (manager, directory) = manager();
        let manager = Arc::new(manager);
        let emitter: Arc<dyn ProtocolEventEmitter> = Arc::new(|_event: Value| Ok(()));
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
                "id": "voice-pair-1",
                "method": "client.pair",
                "params": voice_pair_params(&pairing.code)
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
        let token = receive_client_json(&mut pairing_socket).await["result"]["accessToken"]
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
                "id": "voice-auth-1",
                "method": "client.authenticate",
                "params": { "accessToken": token }
            }),
        )
        .await;
        assert_eq!(
            receive_client_json(&mut client_socket).await["result"]["authenticated"],
            true
        );

        let mut initialize = voice_pair_params("unused");
        initialize.requested_capabilities.actions[0].voice = Some(VoiceCapability {
            examples: vec!["你好呀".into(), "打个招呼".into()],
            locale: Some("zh-CN".into()),
        });
        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "id": "voice-init-1",
                "method": "client.initialize",
                "params": {
                    "protocolVersion": "1",
                    "client": initialize.client,
                    "capabilities": initialize.requested_capabilities
                }
            }),
        )
        .await;
        let init_response = receive_client_json(&mut client_socket).await;
        assert_eq!(
            init_response["result"]["grantedCapabilities"],
            json!(["demo.say_hello"])
        );

        // The reconnecting client's new example set is visible immediately.
        let actions = manager.route_actions().unwrap();
        assert_eq!(actions.len(), 1);
        assert!(actions[0].connected);
        assert_eq!(
            actions[0].voice.as_ref().unwrap(),
            &vec!["你好呀".to_string(), "打个招呼".to_string()]
        );
        assert!(matches!(
            voice_command::match_transcript(&actions, "你好呀"),
            voice_command::VoiceOutcome::Action(voice_command::MatchedAction {
                connected: true,
                ..
            })
        ));

        let invoke_manager = Arc::clone(&manager);
        let invocation = tokio::spawn(async move {
            invoke_manager
                .invoke_action(
                    "com.example.voice-demo",
                    "demo.say_hello",
                    Duration::from_secs(2),
                )
                .await
        });
        let action_request = receive_client_json(&mut client_socket).await;
        assert_eq!(action_request["method"], "action.invoke");
        assert_eq!(action_request["params"]["action"], "demo.say_hello");
        assert_eq!(action_request["params"]["arguments"], json!({}));
        send_client_json(
            &mut client_socket,
            json!({
                "jsonrpc": "2.0",
                "id": action_request["id"],
                "result": { "text": "你好呀，我是示例客户端。", "mood": "up" }
            }),
        )
        .await;
        assert_eq!(
            invocation.await.unwrap().unwrap(),
            NarrationResult {
                text: "你好呀，我是示例客户端。".into(),
                mood: "up".into()
            }
        );

        server.abort();
        fs::remove_dir_all(directory).unwrap();
    }
}
