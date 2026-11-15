//! Linking a TV to the desktop app over the local network.
//!
//! The TV app has no sign-in of its own. It listens on the local network (`host`), shows a
//! six-digit code, and the desktop app (`client`) links to it: the person types the code, both
//! sides run SPAKE2 over it (so someone listening, or sitting in the middle, gets one guess
//! per attempt and learns nothing from a wrong one), and the desktop then hands over a random
//! link secret and the signed-in session, sealed with the agreed key.
//!
//! After that the code is never used again: each connection derives a fresh AES-256-GCM key
//! from the link secret and both sides' nonces, and every frame carries a per-direction
//! counter in its associated data, so frames can't be replayed, reordered or reflected.
//!
//! Frames are JSON text over a WebSocket:
//!   TV → desktop   {t:"hi", v, id, name, nonce}
//!   desktop → TV   {t:"pair", msg, nonce}   then  TV → desktop {t:"pair", msg}
//!   desktop → TV   {t:"link", m}            then  TV → desktop {t:"linked", m}
//!   desktop → TV   {t:"resume", id, nonce}
//!   either way     {t:"m", m}               sealed messages once the keys are agreed
//!   TV → desktop   {t:"err", e}             "code" | "busy" | "unknown" | "version"
//!
//! Nothing here depends on Tauri, so the whole exchange is tested in-process.

pub mod client;
pub mod host;

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use std::time::Duration;

/// What the TV advertises on the local network.
pub const SERVICE_TYPE: &str = "_dotplay._tcp.local.";
/// The TV listens here; the Android side advertises the same port.
pub const PORT: u16 = 47873;
pub const VERSION: u64 = 1;

const PAIR_INFO: &[u8] = b"dot-play link pair v1";
const SESSION_INFO: &[u8] = b"dot-play link session v1";
const SPAKE_DESKTOP: &[u8] = b"dot-play desktop";
const SPAKE_TV: &[u8] = b"dot-play tv";
/// The session cookies are a few kilobytes; nothing legitimate comes close to this.
const MAX_FRAME: usize = 256 * 1024;
/// The desktop pings this often; either side gives up after `SILENCE_LIMIT` of nothing.
const PING_EVERY: Duration = Duration::from_secs(15);
const SILENCE_LIMIT: Duration = Duration::from_secs(40);
const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);

type Key = [u8; 32];

/// One side of a link, as the other side knows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
}

/// A stored link: the other device and the secret shared with it (base64url).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRecord {
    pub id: String,
    pub name: String,
    pub secret: String,
    #[serde(default)]
    pub linked_at: u64,
}

pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("the system random source is available");
    buf
}

pub fn random_id() -> String {
    random_bytes::<16>().iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A key bound to this one connection: both nonces go in as the HKDF salt.
fn derive(secret: &[u8], tv_nonce: &[u8], desktop_nonce: &[u8], info: &[u8]) -> Key {
    let mut salt = tv_nonce.to_vec();
    salt.extend_from_slice(desktop_nonce);
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), secret).expand(info, &mut key).expect("32 bytes is a valid HKDF length");
    key
}

/// `nonce ‖ ciphertext ‖ tag`, base64url.
fn seal(key: &Key, aad: &str, plaintext: &[u8]) -> String {
    let nonce: [u8; 12] = random_bytes();
    let sealed = Aes256Gcm::new(key.into())
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: aad.as_bytes() })
        .expect("AES-GCM encryption does not fail for in-memory buffers");
    let mut out = nonce.to_vec();
    out.extend_from_slice(&sealed);
    B64.encode(out)
}

fn open(key: &Key, aad: &str, sealed: &str) -> Option<Vec<u8>> {
    let bytes = B64.decode(sealed).ok()?;
    if bytes.len() < 12 + 16 {
        return None;
    }
    let (nonce, body) = bytes.split_at(12);
    Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(nonce), Payload { msg: body, aad: aad.as_bytes() }).ok()
}

/// The sealed channel once a connection's key is agreed. Each direction counts its own
/// frames; a frame only opens as the next one expected from the other side.
struct Channel {
    key: Key,
    send_label: &'static str,
    recv_label: &'static str,
    sent: u64,
    received: u64,
}

impl Channel {
    fn for_tv(key: Key) -> Self {
        Self { key, send_label: "t>d", recv_label: "d>t", sent: 0, received: 0 }
    }

    fn for_desktop(key: Key) -> Self {
        Self { key, send_label: "d>t", recv_label: "t>d", sent: 0, received: 0 }
    }

    fn seal(&mut self, message: &Value) -> String {
        let aad = format!("{}|{}", self.send_label, self.sent);
        self.sent += 1;
        serde_json::json!({ "t": "m", "m": seal(&self.key, &aad, message.to_string().as_bytes()) }).to_string()
    }

    fn open(&mut self, frame: &Value) -> Option<Value> {
        if frame.get("t").and_then(Value::as_str) != Some("m") {
            return None;
        }
        let aad = format!("{}|{}", self.recv_label, self.received);
        let plain = open(&self.key, &aad, frame.get("m")?.as_str()?)?;
        self.received += 1;
        serde_json::from_slice(&plain).ok()
    }
}

fn nonce_of(frame: &Value) -> Option<Vec<u8>> {
    let nonce = B64.decode(frame.get("nonce")?.as_str()?).ok()?;
    (nonce.len() == 16).then_some(nonce)
}

fn parse(text: &str) -> Option<Value> {
    if text.len() > MAX_FRAME {
        return None;
    }
    serde_json::from_str(text).ok()
}

#[cfg(test)]
mod tests {
    use super::client::{self, ConnectError};
    use super::host::{Host, HostEvent};
    use super::*;
    use serde_json::json;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    async fn tv(links: Vec<LinkRecord>) -> (Arc<Host>, SocketAddr, mpsc::UnboundedReceiver<HostEvent>) {
        let (events, inbox) = mpsc::unbounded_channel();
        let host = Host::new(Peer { id: "tv-1".into(), name: "Living room".into() }, links, events);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(host.clone().serve(listener));
        (host, addr, inbox)
    }

    fn mac() -> Peer {
        Peer { id: "mac-1".into(), name: "Studio Mac".into() }
    }

    async fn next_matching(inbox: &mut mpsc::UnboundedReceiver<HostEvent>, want: impl Fn(&HostEvent) -> bool) -> HostEvent {
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), inbox.recv()).await.expect("an event in time").expect("host alive");
            if want(&event) {
                return event;
            }
        }
    }

    #[tokio::test]
    async fn the_right_code_links_and_hands_over_the_session() {
        let (host, addr, mut inbox) = tv(vec![]).await;
        let code = host.code();
        let (link, mut session) = client::pair(addr, &mac(), &code, Some("LOGIN_INFO=a; SAPISID=b".into())).await.unwrap();
        assert_eq!(link.id, "tv-1");
        assert_eq!(link.name, "Living room");

        match next_matching(&mut inbox, |e| matches!(e, HostEvent::Linked { .. })).await {
            HostEvent::Linked { desktop, cookies } => {
                assert_eq!(desktop, mac());
                assert_eq!(cookies.as_deref(), Some("LOGIN_INFO=a; SAPISID=b"));
            }
            _ => unreachable!(),
        }
        assert_eq!(host.links().len(), 1);
        assert_ne!(host.code(), code, "a used code is replaced");

        // The same connection carries on as a session, both ways.
        session.send(json!({ "t": "session", "cookies": null }));
        assert!(matches!(
            next_matching(&mut inbox, |e| matches!(e, HostEvent::Session { .. })).await,
            HostEvent::Session { cookies: None }
        ));
        host.send(json!({ "t": "state", "playing": true }));
        let got = tokio::time::timeout(Duration::from_secs(5), session.recv()).await.unwrap().unwrap();
        assert_eq!(got["t"], "state");
    }

    #[tokio::test]
    async fn a_wrong_code_is_refused_and_teaches_nothing() {
        let (host, addr, _inbox) = tv(vec![]).await;
        let code = host.code();
        let wrong = if code == "000000" { "111111" } else { "000000" };
        let result = client::pair(addr, &mac(), wrong, Some("secret cookies".into())).await;
        assert!(matches!(result, Err(ConnectError::BadCode)));
        assert!(host.links().is_empty());
        assert_ne!(host.code(), code, "a failed attempt replaces the code");
    }

    #[tokio::test]
    async fn repeated_wrong_codes_lock_pairing_for_a_while() {
        let (host, addr, _inbox) = tv(vec![]).await;
        for _ in 0..host::MAX_FAILURES {
            let wrong = if host.code() == "000000" { "111111" } else { "000000" };
            assert!(matches!(client::pair(addr, &mac(), wrong, None).await, Err(ConnectError::BadCode)));
        }
        // Even the right code is refused now.
        assert!(matches!(client::pair(addr, &mac(), &host.code(), None).await, Err(ConnectError::Busy)));
    }

    #[tokio::test]
    async fn a_linked_desktop_reconnects_without_the_code() {
        let (host, addr, mut inbox) = tv(vec![]).await;
        let (link, session) = client::pair(addr, &mac(), &host.code(), None).await.unwrap();
        drop(session);
        next_matching(&mut inbox, |e| matches!(e, HostEvent::Online { online: false, .. })).await;

        let mut session = client::resume(addr, "mac-1", &link).await.unwrap();
        next_matching(&mut inbox, |e| matches!(e, HostEvent::Online { online: true, .. })).await;
        session.send(json!({ "t": "session", "cookies": "fresh" }));
        assert!(matches!(
            next_matching(&mut inbox, |e| matches!(e, HostEvent::Session { .. })).await,
            HostEvent::Session { cookies: Some(c) } if c == "fresh"
        ));
        host.send(json!({ "t": "state" }));
        assert!(tokio::time::timeout(Duration::from_secs(5), session.recv()).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn a_desktop_the_tv_forgot_is_told_so() {
        let (host, addr, _inbox) = tv(vec![]).await;
        let (link, session) = client::pair(addr, &mac(), &host.code(), None).await.unwrap();
        drop(session);
        host.remove_link("mac-1");
        assert!(matches!(client::resume(addr, "mac-1", &link).await, Err(ConnectError::Unknown)));
    }

    #[tokio::test]
    async fn the_wrong_link_secret_gets_nowhere() {
        let (host, addr, mut inbox) = tv(vec![]).await;
        let (mut link, session) = client::pair(addr, &mac(), &host.code(), None).await.unwrap();
        drop(session);
        next_matching(&mut inbox, |e| matches!(e, HostEvent::Online { online: false, .. })).await;
        link.secret = B64.encode([9u8; 32]);
        let mut session = client::resume(addr, "mac-1", &link).await.unwrap();
        session.send(json!({ "t": "session", "cookies": "stolen" }));
        // The TV can't open anything sealed with the wrong key: it hangs up, nothing is applied.
        assert!(tokio::time::timeout(Duration::from_secs(5), session.recv()).await.unwrap().is_none());
        assert!(inbox.try_recv().is_err());
    }

    /// Against a real TV on the network, leaving it as it was found:
    /// `DOTPLAY_TV=192.168.1.20:47873 DOTPLAY_CODE=123456 cargo test real_tv -- --ignored`
    #[tokio::test]
    #[ignore = "needs a TV running dot(.)play and the code on its screen"]
    async fn links_with_a_real_tv_then_unlinks() {
        let addr: SocketAddr = std::env::var("DOTPLAY_TV").expect("DOTPLAY_TV").parse().expect("ip:port");
        let code = std::env::var("DOTPLAY_CODE").expect("DOTPLAY_CODE");
        let me = Peer { id: "link-test".into(), name: "Link test".into() };

        // No session is handed over, so whoever is signed in on the TV stays signed in.
        let (link, session) = client::pair(addr, &me, &code, None).await.expect("pairing");
        println!("linked with {} ({})", link.name, link.id);
        drop(session);
        tokio::time::sleep(Duration::from_millis(500)).await;

        let session = client::resume(addr, &me.id, &link).await.expect("reconnecting without the code");
        session.send(json!({ "t": "unlink" }));
        tokio::time::sleep(Duration::from_millis(500)).await;
        drop(session);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(matches!(client::resume(addr, &me.id, &link).await, Err(ConnectError::Unknown)), "the TV forgot the link");
    }

    /// Plays a song on a real TV at low volume, the way the desktop app does, then unlinks:
    /// `DOTPLAY_TV=192.168.1.20:47873 DOTPLAY_CODE=123456 cargo test plays_on_a_real_tv -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "needs a TV running dot(.)play and the code on its screen"]
    async fn plays_on_a_real_tv_then_unlinks() {
        let addr: SocketAddr = std::env::var("DOTPLAY_TV").expect("DOTPLAY_TV").parse().expect("ip:port");
        let code = std::env::var("DOTPLAY_CODE").expect("DOTPLAY_CODE");
        let video = std::env::var("DOTPLAY_VIDEO").unwrap_or("M7lc1UVf-VE".into());
        let me = Peer { id: "play-test".into(), name: "Play test".into() };
        let (_link, mut session) = client::pair(addr, &me, &code, None).await.expect("pairing");

        // Waits for a state report matching `want`, printing what the TV says meanwhile.
        async fn until(session: &mut client::Session, what: &str, want: impl Fn(&Value) -> bool) -> Value {
            let wait = async {
                loop {
                    let message = session.recv().await.expect("the TV stayed connected");
                    println!("tv: {message}");
                    if message["t"] == "state" && want(&message) {
                        return message;
                    }
                }
            };
            tokio::time::timeout(Duration::from_secs(40), wait).await.unwrap_or_else(|_| panic!("timed out waiting for: {what}"))
        }

        session.send(json!({ "t": "volume", "volume": 5 }));
        session.send(json!({ "t": "now", "track": { "videoId": video, "title": "Link test song", "artist": "dot(.)play", "thumb": "" }, "upcoming": [] }));
        session.send(json!({ "t": "load", "videoId": video, "start": 30, "autoplay": true }));
        let playing = until(&mut session, "playing from 0:30", |m| m["state"] == "playing").await;
        assert!(playing["time"].as_f64().unwrap() >= 29.0, "started where it was asked to");

        session.send(json!({ "t": "pause" }));
        until(&mut session, "paused", |m| m["state"] == "paused").await;

        session.send(json!({ "t": "seek", "seconds": 120 }));
        session.send(json!({ "t": "play" }));
        until(&mut session, "playing from 2:00", |m| m["state"] == "playing" && m["time"].as_f64().unwrap_or(0.0) >= 119.0).await;
        let later = until(&mut session, "a duration and a moving position", |m| {
            m["duration"].as_f64().unwrap_or(0.0) > 0.0 && m["time"].as_f64().unwrap_or(0.0) >= 121.0
        })
        .await;
        println!("position {} of {}", later["time"], later["duration"]);

        session.send(json!({ "t": "stop" }));
        session.send(json!({ "t": "unlink" }));
        tokio::time::sleep(Duration::from_millis(800)).await;
    }

    #[test]
    fn frames_only_open_in_order_and_in_their_own_direction() {
        let key = [3u8; 32];
        let mut desktop = Channel::for_desktop(key);
        let mut tv = Channel::for_tv(key);
        let first: Value = serde_json::from_str(&desktop.seal(&json!({ "n": 1 }))).unwrap();
        let second: Value = serde_json::from_str(&desktop.seal(&json!({ "n": 2 }))).unwrap();
        assert!(tv.open(&second).is_none(), "out of order");
        assert_eq!(tv.open(&first).unwrap()["n"], 1);
        assert!(tv.open(&first).is_none(), "replayed");
        assert_eq!(tv.open(&second).unwrap()["n"], 2);
        let mut other_desktop = Channel::for_desktop(key);
        assert!(other_desktop.open(&first).is_none(), "reflected back at the sender");
    }
}
