//! The TV's side of a link: listens on the local network, pairs by code, then serves the
//! desktops it is linked to.

use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use spake2::{Ed25519Group, Identity, Password, Spake2};
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

/// Wrong codes allowed within `FAILURE_WINDOW` before pairing is refused outright.
pub const MAX_FAILURES: usize = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Connections at once: a couple of desktops, plus room for a pairing attempt.
const MAX_CONNECTIONS: usize = 8;

#[derive(Debug)]
pub enum HostEvent {
    /// A desktop linked with the code and handed over its session (if it is signed in).
    Linked { desktop: Peer, cookies: Option<String> },
    /// A linked desktop signed in, refreshed its session or signed out.
    Session { cookies: Option<String> },
    /// A linked desktop removed this TV.
    Unlinked { desktop_id: String },
    Online { desktop_id: String, online: bool },
    /// The code on screen changed (it was used, or guessed wrong).
    CodeChanged,
    /// Anything else a linked desktop says (playback commands).
    Message { desktop_id: String, message: Value },
}

pub struct Host {
    me: Peer,
    code: Mutex<String>,
    links: Mutex<Vec<LinkRecord>>,
    failures: Mutex<VecDeque<Instant>>,
    online: Mutex<HashSet<String>>,
    connections: Mutex<usize>,
    events: mpsc::UnboundedSender<HostEvent>,
    outbox: broadcast::Sender<Value>,
}

fn new_code() -> String {
    // Rejection sampling keeps every code equally likely.
    loop {
        let n = u32::from_le_bytes(random_bytes::<4>());
        if n < 4_294_000_000 {
            return format!("{:06}", n % 1_000_000);
        }
    }
}

type Socket = tokio_tungstenite::WebSocketStream<TcpStream>;

impl Host {
    pub fn new(me: Peer, links: Vec<LinkRecord>, events: mpsc::UnboundedSender<HostEvent>) -> Arc<Self> {
        Arc::new(Self {
            me,
            code: Mutex::new(new_code()),
            links: Mutex::new(links),
            failures: Mutex::new(VecDeque::new()),
            online: Mutex::new(HashSet::new()),
            connections: Mutex::new(0),
            events,
            outbox: broadcast::channel(64).0,
        })
    }

    pub fn me(&self) -> &Peer {
        &self.me
    }

    /// The pairing code to show on screen.
    pub fn code(&self) -> String {
        self.code.lock().unwrap().clone()
    }

    pub fn links(&self) -> Vec<LinkRecord> {
        self.links.lock().unwrap().clone()
    }

    pub fn online(&self) -> Vec<String> {
        self.online.lock().unwrap().iter().cloned().collect()
    }

    /// Forgets a desktop (signing out on the TV). Its open connection ends on its next frame.
    pub fn remove_link(&self, desktop_id: &str) {
        self.links.lock().unwrap().retain(|l| l.id != desktop_id);
    }

    /// Sends a message to every connected desktop.
    pub fn send(&self, message: Value) {
        let _ = self.outbox.send(message);
    }

    fn emit(&self, event: HostEvent) {
        let _ = self.events.send(event);
    }

    fn rotate_code(&self) {
        *self.code.lock().unwrap() = new_code();
        self.emit(HostEvent::CodeChanged);
    }

    fn locked_out(&self) -> bool {
        let mut failures = self.failures.lock().unwrap();
        while failures.front().is_some_and(|at| at.elapsed() > FAILURE_WINDOW) {
            failures.pop_front();
        }
        failures.len() >= MAX_FAILURES
    }

    pub async fn serve(self: Arc<Self>, listener: TcpListener) {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            };
            {
                let mut open = self.connections.lock().unwrap();
                if *open >= MAX_CONNECTIONS {
                    continue;
                }
                *open += 1;
            }
            let host = self.clone();
            tokio::spawn(async move {
                host.connection(stream).await;
                *host.connections.lock().unwrap() -= 1;
            });
        }
    }

    async fn connection(self: &Arc<Self>, stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let config = WebSocketConfig::default().max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME));
        let Ok(Ok(mut socket)) =
            tokio::time::timeout(HANDSHAKE_WAIT, tokio_tungstenite::accept_async_with_config(stream, Some(config))).await
        else {
            return;
        };

        let tv_nonce: [u8; 16] = random_bytes();
        let hi = json!({ "t": "hi", "v": VERSION, "id": self.me.id, "name": self.me.name, "nonce": B64.encode(tv_nonce) });
        if socket.send(Message::text(hi.to_string())).await.is_err() {
            return;
        }
        let Some(first) = read(&mut socket, HANDSHAKE_WAIT).await else { return };

        let Some(desktop_nonce) = nonce_of(&first) else { return };
        let (desktop_id, secret) = match first.get("t").and_then(Value::as_str) {
            Some("pair") => match self.pair(&mut socket, &first, &tv_nonce, &desktop_nonce).await {
                Some(link) => link,
                None => return,
            },
            Some("resume") => {
                let id = first.get("id").and_then(Value::as_str).unwrap_or("");
                let link = self.links.lock().unwrap().iter().find(|l| l.id == id).cloned();
                match link.and_then(|l| B64.decode(&l.secret).ok().map(|s| (l.id, s))) {
                    Some(found) => found,
                    None => {
                        refuse(&mut socket, "unknown").await;
                        return;
                    }
                }
            }
            _ => return,
        };

        let channel = Channel::for_tv(derive(&secret, &tv_nonce, &desktop_nonce, SESSION_INFO));
        let paired_now = first.get("t").and_then(Value::as_str) == Some("pair");
        self.session(socket, channel, &desktop_id, paired_now).await;
        if self.online.lock().unwrap().remove(&desktop_id) {
            self.emit(HostEvent::Online { desktop_id, online: false });
        }
    }

    /// Runs the code exchange. Returns the new link's desktop id and secret.
    async fn pair(self: &Arc<Self>, socket: &mut Socket, first: &Value, tv_nonce: &[u8], desktop_nonce: &[u8]) -> Option<(String, Vec<u8>)> {
        if self.locked_out() {
            refuse(socket, "busy").await;
            return None;
        }
        let inbound = B64.decode(first.get("msg")?.as_str()?).ok()?;
        let (spake, outbound) = Spake2::<Ed25519Group>::start_b(
            &Password::new(self.code().as_bytes()),
            &Identity::new(SPAKE_DESKTOP),
            &Identity::new(SPAKE_TV),
        );
        let shared = spake.finish(&inbound).ok()?;
        let pair_key = derive(&shared, tv_nonce, desktop_nonce, PAIR_INFO);
        socket.send(Message::text(json!({ "t": "pair", "msg": B64.encode(outbound) }).to_string())).await.ok()?;

        let frame = read(socket, HANDSHAKE_WAIT).await?;
        let offer = (frame.get("t").and_then(Value::as_str) == Some("link"))
            .then(|| frame.get("m").and_then(Value::as_str))
            .flatten()
            .and_then(|sealed| open(&pair_key, "link|d>t", sealed))
            .and_then(|plain| serde_json::from_slice::<Value>(&plain).ok());
        // Whatever happened, this code has been tried: the next attempt needs a new one.
        let Some(offer) = offer else {
            self.failures.lock().unwrap().push_back(Instant::now());
            self.rotate_code();
            refuse(socket, "code").await;
            return None;
        };

        let id = offer.get("id")?.as_str()?.to_string();
        let name: String = offer.get("name").and_then(Value::as_str).unwrap_or("Computer").chars().take(60).collect();
        let secret_text = offer.get("secret")?.as_str()?.to_string();
        let secret = B64.decode(&secret_text).ok().filter(|s| s.len() == 32)?;
        if id.is_empty() || id.len() > 64 {
            return None;
        }
        let cookies = offer.get("cookies").and_then(Value::as_str).map(str::to_string);

        {
            let mut links = self.links.lock().unwrap();
            links.retain(|l| l.id != id);
            links.push(LinkRecord { id: id.clone(), name: name.clone(), secret: secret_text, linked_at: now_ms() });
        }
        self.failures.lock().unwrap().clear();
        self.rotate_code();
        self.emit(HostEvent::Linked { desktop: Peer { id: id.clone(), name }, cookies });

        let done = json!({ "t": "linked", "m": seal(&pair_key, "link|t>d", br#"{"ok":true}"#) });
        socket.send(Message::text(done.to_string())).await.ok()?;
        Some((id, secret))
    }

    async fn session(self: &Arc<Self>, socket: Socket, mut channel: Channel, desktop_id: &str, mut proven: bool) {
        let (mut sink, mut stream) = socket.split();
        let mut outbox = self.outbox.subscribe();
        let mut last_heard = Instant::now();
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        if proven {
            self.online.lock().unwrap().insert(desktop_id.to_string());
            self.emit(HostEvent::Online { desktop_id: desktop_id.to_string(), online: true });
        }

        loop {
            tokio::select! {
                frame = stream.next() => {
                    let text = match frame {
                        Some(Ok(Message::Text(text))) => text,
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                        _ => return,
                    };
                    // A frame that doesn't open means the wrong key or a tampered stream: hang up.
                    let Some(message) = parse(text.as_str()).and_then(|frame| channel.open(&frame)) else { return };
                    // Forgotten on the TV while connected.
                    if !self.links.lock().unwrap().iter().any(|l| l.id == desktop_id) {
                        return;
                    }
                    last_heard = Instant::now();
                    if !proven {
                        proven = true;
                        self.online.lock().unwrap().insert(desktop_id.to_string());
                        self.emit(HostEvent::Online { desktop_id: desktop_id.to_string(), online: true });
                    }
                    match message.get("t").and_then(Value::as_str) {
                        Some("ping") => {
                            if sink.send(Message::text(channel.seal(&json!({ "t": "pong" })))).await.is_err() {
                                return;
                            }
                        }
                        Some("hello") => {}
                        Some("session") => {
                            let cookies = message.get("cookies").and_then(Value::as_str).map(str::to_string);
                            self.emit(HostEvent::Session { cookies });
                        }
                        Some("unlink") => {
                            self.remove_link(desktop_id);
                            self.emit(HostEvent::Unlinked { desktop_id: desktop_id.to_string() });
                            return;
                        }
                        _ => self.emit(HostEvent::Message { desktop_id: desktop_id.to_string(), message }),
                    }
                }
                outgoing = outbox.recv() => {
                    // Nothing goes to a desktop that hasn't shown it holds the key.
                    let Ok(message) = outgoing else { continue };
                    if proven && sink.send(Message::text(channel.seal(&message))).await.is_err() {
                        return;
                    }
                }
                _ = tick.tick() => {
                    if last_heard.elapsed() > SILENCE_LIMIT {
                        return;
                    }
                }
            }
        }
    }
}

async fn read(socket: &mut Socket, wait: Duration) -> Option<Value> {
    match tokio::time::timeout(wait, socket.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => parse(text.as_str()),
        _ => None,
    }
}

async fn refuse(socket: &mut Socket, reason: &str) {
    let _ = socket.send(Message::text(json!({ "t": "err", "e": reason }).to_string())).await;
    let _ = socket.close(None).await;
}
