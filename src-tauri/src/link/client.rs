//! The desktop's side of a link: pairs with a TV by code, or reconnects to one already linked.

use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use spake2::{Ed25519Group, Identity, Password, Spake2};
use std::net::SocketAddr;
use std::time::Instant;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;

#[derive(Debug)]
pub enum ConnectError {
    /// Nothing answered at that address.
    Unreachable,
    /// The TV runs a version this app can't talk to.
    Version,
    /// The code didn't match what the TV shows.
    BadCode,
    /// Too many wrong codes: the TV refuses pairing for a while.
    Busy,
    /// The TV no longer knows this desktop (it was signed out there).
    Unknown,
    /// A different TV answered at the address than the one expected.
    WrongDevice,
    Protocol,
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unreachable => "Couldn't reach the TV. Check that it's on and on the same Wi-Fi.",
            Self::Version => "The TV app and this app are different versions. Update both and try again.",
            Self::BadCode => "That code didn't match. The TV is showing a new one.",
            Self::Busy => "Too many wrong codes. Wait a few minutes and try again.",
            Self::Unknown => "The TV was signed out. Link it again.",
            Self::WrongDevice => "A different TV answered at that address.",
            Self::Protocol => "The TV didn't answer as expected.",
        })
    }
}

type Socket = tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>;

/// An open, authenticated connection to a TV. Dropping it closes the connection.
pub struct Session {
    out: mpsc::UnboundedSender<Value>,
    inbox: mpsc::UnboundedReceiver<Value>,
}

impl Session {
    pub fn send(&self, message: Value) {
        let _ = self.out.send(message);
    }

    /// The next message from the TV; `None` once the connection has ended.
    pub async fn recv(&mut self) -> Option<Value> {
        self.inbox.recv().await
    }
}

struct Opened {
    socket: Socket,
    tv: Peer,
    tv_nonce: Vec<u8>,
}

async fn open_socket(addr: SocketAddr) -> Result<Opened, ConnectError> {
    let config = WebSocketConfig::default().max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME));
    let url = format!("ws://{addr}/");
    let connect = tokio_tungstenite::connect_async_with_config(url, Some(config), true);
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(4), connect)
        .await
        .map_err(|_| ConnectError::Unreachable)?
        .map_err(|_| ConnectError::Unreachable)?;
    let hi = read(&mut socket, HANDSHAKE_WAIT).await.ok_or(ConnectError::Protocol)?;
    if hi.get("t").and_then(Value::as_str) != Some("hi") {
        return Err(ConnectError::Protocol);
    }
    if hi.get("v").and_then(Value::as_u64) != Some(VERSION) {
        return Err(ConnectError::Version);
    }
    let tv = Peer {
        id: hi.get("id").and_then(Value::as_str).ok_or(ConnectError::Protocol)?.to_string(),
        name: hi.get("name").and_then(Value::as_str).unwrap_or("TV").chars().take(60).collect(),
    };
    let tv_nonce = nonce_of(&hi).ok_or(ConnectError::Protocol)?;
    Ok(Opened { socket, tv, tv_nonce })
}

async fn read(socket: &mut Socket, wait: Duration) -> Option<Value> {
    match tokio::time::timeout(wait, socket.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => parse(text.as_str()),
        _ => None,
    }
}

fn refusal(frame: &Value) -> Option<ConnectError> {
    if frame.get("t").and_then(Value::as_str) != Some("err") {
        return None;
    }
    Some(match frame.get("e").and_then(Value::as_str) {
        Some("code") => ConnectError::BadCode,
        Some("busy") => ConnectError::Busy,
        Some("unknown") => ConnectError::Unknown,
        Some("version") => ConnectError::Version,
        _ => ConnectError::Protocol,
    })
}

/// Links to the TV at `addr` with the code it shows, handing over `cookies` (the signed-in
/// session, if there is one). Returns the link to store and the open session.
pub async fn pair(addr: SocketAddr, me: &Peer, code: &str, cookies: Option<String>) -> Result<(LinkRecord, Session), ConnectError> {
    let Opened { mut socket, tv, tv_nonce } = open_socket(addr).await?;
    let desktop_nonce: [u8; 16] = random_bytes();
    let (spake, outbound) = Spake2::<Ed25519Group>::start_a(
        &Password::new(code.trim().as_bytes()),
        &Identity::new(SPAKE_DESKTOP),
        &Identity::new(SPAKE_TV),
    );
    let hello = json!({ "t": "pair", "msg": B64.encode(outbound), "nonce": B64.encode(desktop_nonce) });
    socket.send(Message::text(hello.to_string())).await.map_err(|_| ConnectError::Unreachable)?;

    let answer = read(&mut socket, HANDSHAKE_WAIT).await.ok_or(ConnectError::Protocol)?;
    if let Some(error) = refusal(&answer) {
        return Err(error);
    }
    let inbound = answer.get("msg").and_then(Value::as_str).and_then(|m| B64.decode(m).ok()).ok_or(ConnectError::Protocol)?;
    let shared = spake.finish(&inbound).map_err(|_| ConnectError::Protocol)?;
    let pair_key = derive(&shared, &tv_nonce, &desktop_nonce, PAIR_INFO);

    // With the wrong code the two sides hold different keys: the TV can't open this, and
    // nothing in it (the session least of all) is readable by anyone.
    let secret: [u8; 32] = random_bytes();
    let secret_text = B64.encode(secret);
    let offer = json!({ "id": me.id, "name": me.name, "secret": secret_text, "cookies": cookies });
    let frame = json!({ "t": "link", "m": seal(&pair_key, "link|d>t", offer.to_string().as_bytes()) });
    socket.send(Message::text(frame.to_string())).await.map_err(|_| ConnectError::Unreachable)?;

    let done = read(&mut socket, HANDSHAKE_WAIT).await.ok_or(ConnectError::Protocol)?;
    if let Some(error) = refusal(&done) {
        return Err(error);
    }
    // The TV proves it derived the same key (so it really is showing that code).
    let confirmed = (done.get("t").and_then(Value::as_str) == Some("linked"))
        .then(|| done.get("m").and_then(Value::as_str))
        .flatten()
        .and_then(|sealed| open(&pair_key, "link|t>d", sealed))
        .is_some();
    if !confirmed {
        return Err(ConnectError::Protocol);
    }

    let channel = Channel::for_desktop(derive(&secret, &tv_nonce, &desktop_nonce, SESSION_INFO));
    let link = LinkRecord { id: tv.id, name: tv.name, secret: secret_text, linked_at: now_ms() };
    Ok((link, run(socket, channel)))
}

/// Reconnects to a TV linked earlier. `Unknown` means the TV dropped the link.
pub async fn resume(addr: SocketAddr, my_id: &str, link: &LinkRecord) -> Result<Session, ConnectError> {
    let Opened { mut socket, tv, tv_nonce } = open_socket(addr).await?;
    if tv.id != link.id {
        return Err(ConnectError::WrongDevice);
    }
    let secret = B64.decode(&link.secret).map_err(|_| ConnectError::Protocol)?;
    let desktop_nonce: [u8; 16] = random_bytes();
    let hello = json!({ "t": "resume", "id": my_id, "nonce": B64.encode(desktop_nonce) });
    socket.send(Message::text(hello.to_string())).await.map_err(|_| ConnectError::Unreachable)?;

    let mut channel = Channel::for_desktop(derive(&secret, &tv_nonce, &desktop_nonce, SESSION_INFO));
    // The first sealed frame is what shows the TV this desktop holds the link secret.
    let proof = channel.seal(&json!({ "t": "hello" }));
    socket.send(Message::text(proof)).await.map_err(|_| ConnectError::Unreachable)?;

    // A refusal arrives at once; silence means the TV accepted.
    if let Ok(Some(Ok(Message::Text(text)))) = tokio::time::timeout(Duration::from_millis(400), socket.next()).await {
        let frame = parse(text.as_str()).ok_or(ConnectError::Protocol)?;
        if let Some(error) = refusal(&frame) {
            return Err(error);
        }
        // An early message from the TV: keep it.
        return Ok(run_with(socket, channel, Some(frame)));
    }
    Ok(run(socket, channel))
}

fn run(socket: Socket, channel: Channel) -> Session {
    run_with(socket, channel, None)
}

fn run_with(socket: Socket, mut channel: Channel, early: Option<Value>) -> Session {
    let (out, mut outgoing) = mpsc::unbounded_channel::<Value>();
    let (deliver, inbox) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        if let Some(frame) = early {
            match channel.open(&frame) {
                Some(message) => {
                    let _ = deliver.send(message);
                }
                None => return,
            }
        }
        let (mut sink, mut stream) = socket.split();
        let mut ping = tokio::time::interval(PING_EVERY);
        let mut last_heard = Instant::now();
        loop {
            tokio::select! {
                frame = stream.next() => {
                    let text = match frame {
                        Some(Ok(Message::Text(text))) => text,
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                        _ => break,
                    };
                    let Some(message) = parse(text.as_str()).and_then(|frame| channel.open(&frame)) else { break };
                    last_heard = Instant::now();
                    if message.get("t").and_then(Value::as_str) == Some("pong") {
                        continue;
                    }
                    if deliver.send(message).is_err() {
                        break;
                    }
                }
                message = outgoing.recv() => {
                    // The `Session` was dropped: close.
                    let Some(message) = message else { break };
                    if sink.send(Message::text(channel.seal(&message))).await.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    if last_heard.elapsed() > SILENCE_LIMIT
                        || sink.send(Message::text(channel.seal(&json!({ "t": "ping" })))).await.is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = sink.close().await;
    });
    Session { out, inbox }
}
