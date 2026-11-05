//! Phone Remote over an end-to-end encrypted relay.
//!
//! The Mac keeps one outgoing WebSocket to the relay (a Cloudflare Worker, see `relay/`),
//! in a room only it can claim. Phones open the relay's page, join the same room and talk
//! to the Mac through it. Nothing depends on the local network, so it works on any Wi-Fi
//! and on mobile data.
//!
//! Every message is sealed with AES-256-GCM. A phone pairs by scanning a QR link whose
//! `#fragment` (never sent to any server) carries a one-time pairing secret; it sends its own
//! random device secret sealed with that, the Mac asks "Allow?", and from then on that
//! phone's messages use keys derived from its device secret. The relay only ever sees
//! ciphertext and routing ids.
//!
//! Off until turned on in Settings. Paired phones, the room and its token are kept in the
//! private `remote_devices.json`.

use crate::media_controls::{emit_action, LastNowPlaying, MediaControlAction, NowPlayingSnapshot};
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// The deployed relay (relay/). `DOT_REMOTE_RELAY` overrides it at build time, and a variable
/// of the same name at run time, e.g. to test against `wrangler dev`.
const BUILT_IN_RELAY: Option<&str> = match option_env!("DOT_REMOTE_RELAY") {
    Some(url) => Some(url),
    None => Some("https://dot-music-remote.anshbhatt140.workers.dev"),
};
const PAIR_INFO: &[u8] = b"dot-music remote pair v1";
const DEVICE_INFO: &[u8] = b"dot-music remote device v1";
/// How long the Mac's "Allow this phone?" prompt waits for an answer.
const PAIR_WAIT: Duration = Duration::from_secs(90);
const PAIR_ATTEMPTS_PER_MINUTE: usize = 5;
/// Keeps the relay connection (and any proxy in between) from timing out while idle.
const PING_EVERY: Duration = Duration::from_secs(15);
/// Nothing heard (not even a pong) for this long: the connection died quietly, typically
/// across sleep or a network switch. Drop it and reconnect.
const SILENCE_LIMIT: Duration = Duration::from_secs(35);
/// Reconnect delays: first retry at once, then backing off to a few seconds at most.
const BACKOFF_MS: [u64; 6] = [0, 300, 1000, 2000, 4000, 8000];
/// Search answers kept for a while, so going back to an earlier query is instant.
const SEARCH_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const SEARCH_CACHE_SIZE: usize = 60;
const SEARCH_RESULTS: usize = 12;

// ---------------------------------------------------------------------------------------
// Sealing

type Key = [u8; 32];

fn derive(secret: &[u8], info: &[u8]) -> Key {
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, secret).expand(info, &mut key).expect("32 bytes is a valid HKDF length");
    key
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("the system random source is available");
    buf
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `nonce ‖ ciphertext ‖ tag`, base64url. `aad` binds the message to one phone and one
/// direction, so the relay can't redirect or reflect it.
fn seal_with_nonce(key: &Key, aad: &str, plaintext: &[u8], nonce: [u8; 12]) -> String {
    let cipher = Aes256Gcm::new(key.into());
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: aad.as_bytes() })
        .expect("AES-GCM encryption does not fail for in-memory buffers");
    let mut out = nonce.to_vec();
    out.extend_from_slice(&sealed);
    B64.encode(out)
}

fn seal(key: &Key, aad: &str, plaintext: &[u8]) -> String {
    seal_with_nonce(key, aad, plaintext, random_bytes())
}

fn open(key: &Key, aad: &str, sealed: &str) -> Option<Vec<u8>> {
    let bytes = B64.decode(sealed).ok()?;
    if bytes.len() < 12 + 16 {
        return None;
    }
    let (nonce, body) = bytes.split_at(12);
    Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(nonce), Payload { msg: body, aad: aad.as_bytes() }).ok()
}

// ---------------------------------------------------------------------------------------
// State

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    /// The phone's peer id in the room.
    id: String,
    name: String,
    /// The phone's device secret, base64url. Message keys are derived from it.
    secret: String,
    paired_at: u64,
}

impl Device {
    fn key(&self) -> Option<Key> {
        B64.decode(&self.secret).ok().map(|s| derive(&s, DEVICE_INFO))
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    enabled: bool,
    #[serde(default)]
    room: String,
    #[serde(default)]
    host_token: String,
    #[serde(default)]
    devices: Vec<Device>,
}

/// Track and queue updates on their way to every connected phone.
#[derive(Debug, Clone)]
struct Update {
    kind: &'static str,
    data: Value,
}

#[derive(Default)]
struct Inner {
    enabled: bool,
    room: String,
    host_token: String,
    pair_secret: [u8; 32],
    devices: Vec<Device>,
    pending: HashMap<String, oneshot::Sender<bool>>,
    pair_attempts: VecDeque<Instant>,
    /// Phones in the room right now (paired or not), as the relay reports them.
    present: HashSet<String>,
    /// The newest message number seen from each phone, so old messages can't be replayed.
    last_seq: HashMap<String, u64>,
    /// The latest queue/modes state from the main window.
    last_state: Option<Value>,
    relay: &'static str,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Frames to send on the current relay connection.
    out: Option<mpsc::UnboundedSender<String>>,
}

impl Inner {
    fn paired_present(&self) -> Vec<Device> {
        self.devices.iter().filter(|d| self.present.contains(&d.id)).cloned().collect()
    }
}

pub struct RemoteHub {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<Update>,
}

impl Default for RemoteHub {
    fn default() -> Self {
        Self { inner: Mutex::new(Inner { relay: "offline", ..Inner::default() }), tx: broadcast::channel(64).0 }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    id: String,
    name: String,
    paired_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    enabled: bool,
    /// "connecting", "online", "offline", or "unconfigured" when no relay is built in.
    relay: &'static str,
    /// The one-time pairing link the QR code encodes.
    url: Option<String>,
    qr_svg: Option<String>,
    devices: Vec<DeviceInfo>,
    clients: usize,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn relay_base() -> Option<String> {
    std::env::var("DOT_REMOTE_RELAY")
        .ok()
        .or_else(|| BUILT_IN_RELAY.map(str::to_string))
        .map(|url| url.trim_end_matches('/').to_string())
        .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
}

fn saved_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("remote_devices.json"))
}

fn persist(app: &AppHandle, inner: &Inner) {
    let Some(path) = saved_path(app) else { return };
    let saved = Saved {
        enabled: inner.enabled,
        room: inner.room.clone(),
        host_token: inner.host_token.clone(),
        devices: inner.devices.clone(),
    };
    if let Ok(data) = serde_json::to_vec(&saved) {
        // Private: these secrets let a phone control the app.
        if let Err(e) = crate::fsutil::write_atomic(&path, &data, true) {
            eprintln!("[DOT Music] Couldn't save remote devices: {e}");
        }
    }
}

fn qr_svg(text: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(200, 200)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

fn status_of(hub: &RemoteHub) -> RemoteStatus {
    let inner = hub.inner.lock().unwrap();
    let base = relay_base();
    let url = match (&base, inner.enabled) {
        (Some(base), true) => Some(format!("{base}/#r={}&p={}", inner.room, B64.encode(inner.pair_secret))),
        _ => None,
    };
    RemoteStatus {
        enabled: inner.enabled,
        relay: if base.is_none() { "unconfigured" } else { inner.relay },
        qr_svg: url.as_deref().and_then(qr_svg),
        url,
        devices: inner
            .devices
            .iter()
            .map(|d| DeviceInfo { id: d.id.clone(), name: d.name.clone(), paired_at: d.paired_at })
            .collect(),
        clients: inner.paired_present().len(),
    }
}

fn emit_clients(app: &AppHandle) {
    let count = app.state::<RemoteHub>().inner.lock().unwrap().paired_present().len();
    let _ = app.emit_to("main", "remote-clients", json!({ "count": count }));
}

fn set_relay(app: &AppHandle, relay: &'static str) {
    app.state::<RemoteHub>().inner.lock().unwrap().relay = relay;
    let _ = app.emit_to("main", "remote-status-changed", ());
}

/// The current track with how old its position sample is, so the phone can extrapolate
/// without its clock having to match the Mac's.
fn now_playing_data(snapshot: Option<&NowPlayingSnapshot>) -> Value {
    match snapshot {
        Some(s) => {
            let mut value = serde_json::to_value(s).unwrap_or(Value::Null);
            if let Value::Object(map) = &mut value {
                map.insert("ageMs".into(), now_ms().saturating_sub(s.updated_at_ms).into());
            }
            value
        }
        None => Value::Null,
    }
}

// ---------------------------------------------------------------------------------------
// Called from elsewhere in the app

/// Loads the room and paired phones, and reconnects to the relay if the remote was left on.
pub fn init(app: &AppHandle) {
    let saved: Saved = saved_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let enabled = saved.enabled;
    {
        let hub = app.state::<RemoteHub>();
        let mut inner = hub.inner.lock().unwrap();
        inner.room = saved.room;
        inner.host_token = saved.host_token;
        inner.devices = saved.devices;
        inner.pair_secret = random_bytes();
    }
    if enabled && relay_base().is_some() {
        start(app);
    }
}

/// Forwards a track change from `set_now_playing` to connected phones.
pub fn publish_now_playing(app: &AppHandle, snapshot: Option<&NowPlayingSnapshot>) {
    let hub = app.state::<RemoteHub>();
    if !hub.inner.lock().unwrap().paired_present().is_empty() {
        let _ = hub.tx.send(Update { kind: "nowPlaying", data: now_playing_data(snapshot) });
    }
}

// ---------------------------------------------------------------------------------------
// Commands for the main window

#[tauri::command]
pub(crate) fn get_remote_status(hub: State<'_, RemoteHub>) -> RemoteStatus {
    status_of(&hub)
}

#[tauri::command]
pub(crate) fn set_remote_enabled(app: AppHandle, enabled: bool) -> Result<RemoteStatus, String> {
    if enabled {
        if relay_base().is_none() {
            return Err("The Phone Remote relay isn't set up in this build yet.".into());
        }
        start(&app);
    } else {
        stop(&app);
    }
    let hub = app.state::<RemoteHub>();
    persist(&app, &hub.inner.lock().unwrap());
    Ok(status_of(&hub))
}

#[tauri::command]
pub(crate) fn answer_pair_request(hub: State<'_, RemoteHub>, id: String, allow: bool) {
    if let Some(reply) = hub.inner.lock().unwrap().pending.remove(&id) {
        let _ = reply.send(allow);
    }
}

#[tauri::command]
pub(crate) fn forget_remote_device(app: AppHandle, id: String) -> RemoteStatus {
    let hub = app.state::<RemoteHub>();
    {
        let mut inner = hub.inner.lock().unwrap();
        if let Some(device) = inner.devices.iter().find(|d| d.id == id).cloned() {
            if let (Some(out), Some(key)) = (inner.out.clone(), device.key()) {
                send_sealed(&out, &device.id, &key, &json!({ "type": "revoked" }));
                let _ = out.send(json!({ "kick": device.id }).to_string());
            }
        }
        inner.devices.retain(|d| d.id != id);
        inner.last_seq.remove(&id);
        persist(&app, &inner);
    }
    emit_clients(&app);
    status_of(&hub)
}

/// The queue, modes, volume and like state, from the main window while phones are connected.
#[tauri::command]
pub(crate) fn set_remote_state(hub: State<'_, RemoteHub>, state: Value) {
    hub.inner.lock().unwrap().last_state = Some(state.clone());
    let _ = hub.tx.send(Update { kind: "state", data: state });
}

// ---------------------------------------------------------------------------------------
// The relay connection

fn start(app: &AppHandle) {
    let hub = app.state::<RemoteHub>();
    let mut inner = hub.inner.lock().unwrap();
    inner.enabled = true;
    if inner.room.is_empty() || inner.host_token.is_empty() {
        inner.room = hex(&random_bytes::<16>());
        inner.host_token = hex(&random_bytes::<32>());
        persist(app, &inner);
    }
    if inner.task.is_none() {
        let app = app.clone();
        inner.task = Some(tauri::async_runtime::spawn(async move { relay_loop(app).await }));
    }
}

fn stop(app: &AppHandle) {
    let hub = app.state::<RemoteHub>();
    {
        let mut inner = hub.inner.lock().unwrap();
        inner.enabled = false;
        if let Some(task) = inner.task.take() {
            task.abort();
        }
        inner.out = None;
        inner.present.clear();
        inner.relay = "offline";
        for (_, reply) in inner.pending.drain() {
            let _ = reply.send(false);
        }
    }
    emit_clients(app);
}

async fn relay_loop(app: AppHandle) {
    let mut attempt = 0;
    loop {
        let Some(base) = relay_base() else { return };
        let url = {
            let hub = app.state::<RemoteHub>();
            let inner = hub.inner.lock().unwrap();
            let ws_base = base.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
            format!("{ws_base}/room/{}?role=host&token={}", inner.room, inner.host_token)
        };
        set_relay(&app, "connecting");
        match tokio_tungstenite::connect_async(url.as_str()).await {
            Ok((socket, _)) => {
                attempt = 0;
                set_relay(&app, "online");
                session(&app, socket).await;
            }
            Err(e) => log::warn!("Phone Remote: couldn't reach the relay: {e}"),
        }
        {
            let hub = app.state::<RemoteHub>();
            let mut inner = hub.inner.lock().unwrap();
            inner.out = None;
            inner.present.clear();
        }
        emit_clients(&app);
        set_relay(&app, "offline");
        let delay = BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)];
        attempt += 1;
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn session(app: &AppHandle, socket: Socket) {
    let (mut sink, mut stream) = socket.split();
    let (out, mut outgoing) = mpsc::unbounded_channel::<String>();
    let hub = app.state::<RemoteHub>();
    let mut updates = hub.tx.subscribe();
    hub.inner.lock().unwrap().out = Some(out.clone());
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let mut last_heard = Instant::now();

    loop {
        tokio::select! {
            frame = stream.next() => match frame {
                Some(Ok(WsMessage::Text(text))) => {
                    last_heard = Instant::now();
                    handle_frame(app, text.as_str(), &out);
                }
                Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => last_heard = Instant::now(),
            },
            Some(text) = outgoing.recv() => {
                if sink.send(WsMessage::Text(text.into())).await.is_err() { break; }
            },
            update = updates.recv() => match update {
                Ok(update) => {
                    let devices = hub.inner.lock().unwrap().paired_present();
                    let message = json!({ "type": update.kind, "data": update.data });
                    for device in devices {
                        if let Some(key) = device.key() {
                            send_sealed(&out, &device.id, &key, &message);
                        }
                    }
                }
                // Fell behind: the next update brings phones up to date.
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = ping.tick() => {
                if last_heard.elapsed() > SILENCE_LIMIT {
                    log::info!("Phone Remote: relay went quiet, reconnecting");
                    break;
                }
                // The relay answers "pong" itself without waking the room.
                if sink.send(WsMessage::Text("ping".into())).await.is_err() { break; }
            },
        }
    }
}

fn send_sealed(out: &mpsc::UnboundedSender<String>, peer: &str, key: &Key, message: &Value) {
    let sealed = seal(key, &format!("{peer}|down"), message.to_string().as_bytes());
    let _ = out.send(json!({ "to": peer, "m": sealed }).to_string());
}

/// The current track and queue, for a phone that just joined or asked for them.
fn send_snapshot(app: &AppHandle, out: &mpsc::UnboundedSender<String>, device: &Device) {
    let Some(key) = device.key() else { return };
    let snapshot = app.state::<LastNowPlaying>().0.lock().unwrap().clone();
    send_sealed(out, &device.id, &key, &json!({ "type": "nowPlaying", "data": now_playing_data(snapshot.as_ref()) }));
    if let Some(state) = app.state::<RemoteHub>().inner.lock().unwrap().last_state.clone() {
        send_sealed(out, &device.id, &key, &json!({ "type": "state", "data": state }));
    }
}

fn device(app: &AppHandle, peer: &str) -> Option<Device> {
    app.state::<RemoteHub>().inner.lock().unwrap().devices.iter().find(|d| d.id == peer).cloned()
}

fn handle_frame(app: &AppHandle, text: &str, out: &mpsc::UnboundedSender<String>) {
    let Ok(frame) = serde_json::from_str::<Value>(text) else { return };
    let hub = app.state::<RemoteHub>();

    if let Some(peers) = frame.get("peers").and_then(Value::as_array) {
        let present: HashSet<String> = peers.iter().filter_map(|p| p.as_str().map(str::to_string)).collect();
        let devices = {
            let mut inner = hub.inner.lock().unwrap();
            inner.present = present;
            inner.paired_present()
        };
        for device in devices {
            send_snapshot(app, out, &device);
        }
        emit_clients(app);
        return;
    }

    if let (Some(peer), Some(event)) = (frame.get("peer").and_then(Value::as_str), frame.get("event").and_then(Value::as_str)) {
        {
            let mut inner = hub.inner.lock().unwrap();
            if event == "join" {
                inner.present.insert(peer.to_string());
            } else {
                inner.present.remove(peer);
            }
        }
        if event == "join" {
            if let Some(device) = device(app, peer) {
                send_snapshot(app, out, &device);
            }
        }
        emit_clients(app);
        return;
    }

    let Some(peer) = frame.get("from").and_then(Value::as_str) else { return };
    if let Some(sealed) = frame.get("pair").and_then(Value::as_str) {
        let (app, out, peer, sealed) = (app.clone(), out.clone(), peer.to_string(), sealed.to_string());
        tauri::async_runtime::spawn(async move { pair(&app, &out, &peer, &sealed).await });
        return;
    }
    let Some(sealed) = frame.get("m").and_then(Value::as_str) else { return };
    let Some(device) = device(app, peer) else { return };
    let Some(key) = device.key() else { return };
    let Some(plain) = open(&key, &format!("{peer}|up"), sealed) else { return };
    let Ok(message) = serde_json::from_slice::<Value>(&plain) else { return };

    let seq = message.get("seq").and_then(Value::as_u64).unwrap_or(0);
    if !accept_seq(&mut hub.inner.lock().unwrap().last_seq, peer, seq) {
        return;
    }

    match message.get("type").and_then(Value::as_str) {
        Some("hello") => send_snapshot(app, out, &device),
        Some("cmd") => {
            if let Some(command) = message.get("cmd") {
                let _ = run_command(app, command.clone());
            }
        }
        Some("lyrics") => {
            let (app, out) = (app.clone(), out.clone());
            tauri::async_runtime::spawn(async move { lyrics(&app, &out, &device, &key, message).await });
        }
        Some("search") => {
            let out = out.clone();
            tauri::async_runtime::spawn(async move { search(&out, &device, &key, message).await });
        }
        _ => {}
    }
}

/// Messages must arrive with ever-increasing numbers; anything else is a replay.
fn accept_seq(last_seq: &mut HashMap<String, u64>, peer: &str, seq: u64) -> bool {
    match last_seq.get(peer) {
        Some(&last) if seq <= last => false,
        _ => {
            last_seq.insert(peer.to_string(), seq);
            true
        }
    }
}

/// Queue commands the phone may send to the main window (the menu bar popover's set).
const QUEUE_COMMANDS: [&str; 11] = [
    "playTrack",
    "playNextTrack",
    "queueTrack",
    "playQueueItem",
    "removeQueueItem",
    "moveQueueItem",
    "toggleShuffle",
    "cycleRepeat",
    "toggleMute",
    "toggleLike",
    "setVolume",
];

fn run_command(app: &AppHandle, command: Value) -> Result<(), String> {
    if command.get("action").is_some() {
        let action: MediaControlAction = serde_json::from_value(command).map_err(|_| "Unknown media action")?;
        emit_action(app, action);
        return Ok(());
    }
    let kind = command.get("type").and_then(Value::as_str).unwrap_or("");
    if !QUEUE_COMMANDS.contains(&kind) {
        return Err("Unknown command".into());
    }
    app.emit_to("main", "remote-command", command).map_err(|e| e.to_string())
}

async fn lyrics(app: &AppHandle, out: &mpsc::UnboundedSender<String>, device: &Device, key: &Key, message: Value) {
    let q = |name: &str| message.pointer(&format!("/q/{name}")).and_then(Value::as_str).map(str::to_string);
    let payload = crate::lyrics::get_lyrics(
        app.clone(),
        q("videoId").filter(|v| !v.is_empty()),
        q("title").unwrap_or_default(),
        q("artist").unwrap_or_default(),
        None,
        message.pointer("/q/duration").and_then(Value::as_f64),
    )
    .await
    .unwrap_or(None);
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    send_sealed(out, &device.id, key, &json!({ "type": "lyrics", "id": id, "payload": payload }));
}

/// A square thumbnail sharp on a 3× phone screen at the ~48 px the results show (240 px),
/// without sending full 800 px covers that make every search slow on mobile data.
fn small_thumbnail(url: &str) -> String {
    if url.contains("googleusercontent.com") || url.contains("ggpht.com") {
        if let Some(idx) = url.rfind("=w").or_else(|| url.rfind("=s")) {
            return format!("{}=w240-h240-l90-rj", &url[..idx]);
        }
    }
    url.replace("/hqdefault.jpg", "/mqdefault.jpg").replace("/maxresdefault.jpg", "/mqdefault.jpg")
}

/// Recent search answers, newest last.
static SEARCH_CACHE: Mutex<VecDeque<(String, Instant, Value)>> = Mutex::new(VecDeque::new());

fn cached_search(query: &str) -> Option<Value> {
    let cache = SEARCH_CACHE.lock().unwrap();
    cache.iter().rev().find(|(q, at, _)| q == query && at.elapsed() < SEARCH_CACHE_TTL).map(|(_, _, v)| v.clone())
}

fn remember_search(query: String, results: Value) {
    let mut cache = SEARCH_CACHE.lock().unwrap();
    cache.retain(|(q, at, _)| *q != query && at.elapsed() < SEARCH_CACHE_TTL);
    cache.push_back((query, Instant::now(), results));
    while cache.len() > SEARCH_CACHE_SIZE {
        cache.pop_front();
    }
}

/// Songs for a phone's search box, the same search the app uses.
async fn search(out: &mpsc::UnboundedSender<String>, device: &Device, key: &Key, message: Value) {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let query: String = message.get("q").and_then(Value::as_str).unwrap_or("").trim().chars().take(120).collect();
    let normalized = query.to_lowercase();
    let results = if normalized.is_empty() {
        json!([])
    } else if let Some(hit) = cached_search(&normalized) {
        hit
    } else {
        let hits = crate::search::search_songs(&query).await.unwrap_or_default();
        let results: Vec<Value> = hits
            .into_iter()
            .take(SEARCH_RESULTS)
            .map(|hit| {
                json!({
                    "videoId": hit.result.video_id,
                    "title": hit.result.title,
                    "artist": hit.result.artist,
                    "thumbnailUrl": small_thumbnail(&hit.result.thumbnail_url),
                    "duration": hit.duration,
                })
            })
            .collect();
        let results = Value::Array(results);
        // Empty answers may be a network blip; only keep real ones.
        if results.as_array().is_some_and(|r| !r.is_empty()) {
            remember_search(normalized, results.clone());
        }
        results
    };
    send_sealed(out, &device.id, key, &json!({ "type": "search", "id": id, "results": results }));
}

/// A phone sent its device secret, sealed with the current pairing secret: ask the Mac.
async fn pair(app: &AppHandle, out: &mpsc::UnboundedSender<String>, peer: &str, sealed: &str) {
    let hub = app.state::<RemoteHub>();
    let request = {
        let mut inner = hub.inner.lock().unwrap();
        let now = Instant::now();
        while inner.pair_attempts.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
            inner.pair_attempts.pop_front();
        }
        if inner.pair_attempts.len() >= PAIR_ATTEMPTS_PER_MINUTE {
            None
        } else {
            inner.pair_attempts.push_back(now);
            let pair_key = derive(&inner.pair_secret, PAIR_INFO);
            open(&pair_key, &format!("{peer}|pair"), sealed)
        }
    };
    // Wrong or used code, or too many tries: say nothing (the phone times out).
    let Some(plain) = request else { return };
    let Ok(hello) = serde_json::from_slice::<Value>(&plain) else { return };
    let Some(secret) = hello.get("secret").and_then(Value::as_str).filter(|s| B64.decode(s).is_ok_and(|b| b.len() == 32))
    else {
        return;
    };
    let name: String = hello
        .get("name")
        .and_then(Value::as_str)
        .map(|n| n.trim().chars().take(40).collect::<String>())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Phone".into());

    let candidate = Device { id: peer.to_string(), name: name.clone(), secret: secret.to_string(), paired_at: now_ms() };
    let Some(key) = candidate.key() else { return };

    let id = hex(&random_bytes::<8>());
    let (reply, answer) = oneshot::channel();
    hub.inner.lock().unwrap().pending.insert(id.clone(), reply);
    // The window may be hidden in the menu bar; the question has to be seen.
    crate::tray::show_main(app);
    let _ = app.emit_to("main", "remote-pair-request", json!({ "id": id, "name": name }));
    let allowed = matches!(tokio::time::timeout(PAIR_WAIT, answer).await, Ok(Ok(true)));
    hub.inner.lock().unwrap().pending.remove(&id);
    let _ = app.emit_to("main", "remote-pair-closed", json!({ "id": id }));

    if !allowed {
        send_sealed(out, peer, &key, &json!({ "type": "denied" }));
        let _ = out.send(json!({ "kick": peer }).to_string());
        return;
    }
    {
        let mut inner = hub.inner.lock().unwrap();
        inner.devices.retain(|d| d.id != candidate.id);
        inner.devices.push(candidate.clone());
        inner.last_seq.remove(peer);
        // One code, one phone: the next phone scans a fresh code.
        inner.pair_secret = random_bytes();
        persist(app, &inner);
    }
    send_sealed(out, peer, &key, &json!({ "type": "paired", "name": name }));
    send_snapshot(app, out, &candidate);
    let _ = app.emit_to("main", "remote-devices-changed", ());
    emit_clients(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The phone's WebCrypto code (src/remote/crypto.ts) must produce exactly this for the
    /// same inputs; `node scripts/remote-crypto-vector.mjs` checks the other side.
    #[test]
    fn matches_the_phone_test_vector() {
        let key = derive(&[7u8; 32], DEVICE_INFO);
        let sealed = seal_with_nonce(&key, "abcd1234abcd1234|up", br#"{"seq":1}"#, [1u8; 12]);
        assert_eq!(sealed, include_str!("../../src/remote/crypto-vector.txt").trim());
    }

    #[test]
    fn sealing_round_trips_and_binds_direction() {
        let key = derive(b"0123456789abcdef0123456789abcdef", PAIR_INFO);
        let sealed = seal(&key, "peer|up", b"hello");
        assert_eq!(open(&key, "peer|up", &sealed).as_deref(), Some(&b"hello"[..]));
        assert!(open(&key, "peer|down", &sealed).is_none());
        assert!(open(&key, "other|up", &sealed).is_none());
        let wrong = derive(b"another secret entirely, 32 byte", PAIR_INFO);
        assert!(open(&wrong, "peer|up", &sealed).is_none());
        assert!(open(&key, "peer|up", "not base64!").is_none());
    }

    #[test]
    fn search_thumbnails_are_small() {
        assert_eq!(small_thumbnail("https://lh3.googleusercontent.com/abc=w800-h800-l90-rj"), "https://lh3.googleusercontent.com/abc=w240-h240-l90-rj");
        assert_eq!(small_thumbnail("https://i.ytimg.com/vi/x/hqdefault.jpg"), "https://i.ytimg.com/vi/x/mqdefault.jpg");
    }

    #[test]
    fn search_cache_answers_repeat_queries() {
        remember_search("unit test query".into(), json!([{ "videoId": "a" }]));
        assert_eq!(cached_search("unit test query"), Some(json!([{ "videoId": "a" }])));
        assert_eq!(cached_search("something else"), None);
    }

    #[test]
    fn replays_are_rejected() {
        let mut seen = HashMap::new();
        assert!(accept_seq(&mut seen, "p", 10));
        assert!(!accept_seq(&mut seen, "p", 10));
        assert!(!accept_seq(&mut seen, "p", 9));
        assert!(accept_seq(&mut seen, "p", 11));
        assert!(accept_seq(&mut seen, "q", 1));
    }

    #[test]
    fn a_used_pairing_code_no_longer_opens() {
        let old_secret: [u8; 32] = random_bytes();
        let sealed = seal(&derive(&old_secret, PAIR_INFO), "peer|pair", b"{}");
        let new_secret: [u8; 32] = random_bytes();
        assert!(open(&derive(&new_secret, PAIR_INFO), "peer|pair", &sealed).is_none());
    }
}
