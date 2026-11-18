//! Discord status ("Listening to DOT Music") through the Discord app's local IPC socket: the
//! supported Rich Presence route. No Discord account token is involved; the running Discord
//! client shows the activity for whoever is signed in to it.
//!
//! Protocol: frames of `opcode: u32 LE`, `length: u32 LE`, then JSON. A HANDSHAKE (0) with the
//! application id, answered by a READY event, then FRAME (1) commands such as SET_ACTIVITY.
//!
//! The application id is a public identifier for the "DOT Music" app registered in Discord's
//! developer portal (its name and icon are what Discord shows). `DOT_DISCORD_CLIENT_ID` at
//! build time overrides it, e.g. for a test application.

use serde::Deserialize;

/// The "DOT Music" application in Discord's developer portal.
const DOT_MUSIC_APPLICATION_ID: &str = "1572622899297124382";

const CLIENT_ID: Option<&str> = match option_env!("DOT_DISCORD_CLIENT_ID") {
    Some(id) => Some(id),
    None => Some(DOT_MUSIC_APPLICATION_ID),
};

/// What the frontend sends for the current song. Times are Unix milliseconds.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub artwork_url: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// "Listen on YouTube Music" button target.
    pub url: Option<String>,
}

/// Discord limits text fields to 2–128 characters.
fn field(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.chars().count() < 2 {
        return None;
    }
    Some(trimmed.chars().take(128).collect())
}

/// The SET_ACTIVITY arguments for `activity` (None clears the status).
fn activity_args(activity: Option<&Activity>, pid: u32) -> serde_json::Value {
    let Some(a) = activity else {
        return serde_json::json!({ "pid": pid });
    };
    let mut body = serde_json::json!({ "type": 2 }); // 2 = "Listening to"
    if let Some(details) = field(&a.title) {
        body["details"] = details.into();
    }
    if let Some(state) = field(&a.artist).map(|artist| format!("by {artist}")).and_then(|s| field(&s)) {
        body["state"] = state.into();
    }
    let start = a.start_ms.filter(|ms| *ms > 0);
    let end = a.end_ms.filter(|end| start.is_some_and(|start| *end > start));
    if let Some(start) = start {
        body["timestamps"] = serde_json::json!({ "start": start });
        if let Some(end) = end {
            body["timestamps"]["end"] = end.into();
        }
    }
    if let Some(art) = a.artwork_url.as_deref().filter(|u| u.starts_with("https://") && u.len() <= 256) {
        body["assets"] = serde_json::json!({ "large_image": art });
        if let Some(album) = a.album.as_deref().and_then(field).or_else(|| field(&a.title)) {
            body["assets"]["large_text"] = album.into();
        }
    }
    if let Some(url) = a.url.as_deref().filter(|u| u.starts_with("https://music.youtube.com/")) {
        body["buttons"] = serde_json::json!([{ "label": "Listen on YouTube Music", "url": url }]);
    }
    serde_json::json!({ "pid": pid, "activity": body })
}

#[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
mod ipc {
    use std::path::PathBuf;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;
    use tokio::sync::Mutex;

    const OP_HANDSHAKE: u32 = 0;
    const OP_FRAME: u32 = 1;
    const IO_TIMEOUT: Duration = Duration::from_secs(2);
    /// Bigger replies than this are not Discord's.
    const MAX_FRAME: usize = 64 * 1024;

    static CONNECTION: Mutex<Option<UnixStream>> = Mutex::const_new(None);

    /// Where Discord (desktop, Flatpak or Snap) puts discord-ipc-0…9.
    fn socket_paths() -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
            .iter()
            .filter_map(|key| std::env::var_os(key))
            .map(PathBuf::from)
            .collect();
        dirs.push(PathBuf::from("/tmp"));
        let mut paths = Vec::new();
        for dir in dirs {
            for sub in ["", "app/com.discordapp.Discord", "snap.discord"] {
                let base = if sub.is_empty() { dir.clone() } else { dir.join(sub) };
                for n in 0..10 {
                    paths.push(base.join(format!("discord-ipc-{n}")));
                }
            }
        }
        paths
    }

    async fn write_frame(stream: &mut UnixStream, op: u32, body: &serde_json::Value) -> std::io::Result<()> {
        let data = serde_json::to_vec(body)?;
        let mut frame = Vec::with_capacity(8 + data.len());
        frame.extend_from_slice(&op.to_le_bytes());
        frame.extend_from_slice(&(data.len() as u32).to_le_bytes());
        frame.extend_from_slice(&data);
        tokio::time::timeout(IO_TIMEOUT, stream.write_all(&frame)).await??;
        Ok(())
    }

    async fn read_frame(stream: &mut UnixStream) -> std::io::Result<serde_json::Value> {
        let read = async {
            let mut header = [0u8; 8];
            stream.read_exact(&mut header).await?;
            let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
            if len > MAX_FRAME {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
            }
            let mut body = vec![0u8; len];
            stream.read_exact(&mut body).await?;
            Ok(serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null))
        };
        tokio::time::timeout(IO_TIMEOUT, read).await?
    }

    async fn connect(client_id: &str) -> Option<UnixStream> {
        for path in socket_paths() {
            let Ok(mut stream) = UnixStream::connect(&path).await else { continue };
            let hello = serde_json::json!({ "v": 1, "client_id": client_id });
            if write_frame(&mut stream, OP_HANDSHAKE, &hello).await.is_err() {
                continue;
            }
            match read_frame(&mut stream).await {
                Ok(reply) if reply.get("evt").and_then(|e| e.as_str()) == Some("READY") => return Some(stream),
                _ => continue,
            }
        }
        None
    }

    /// Sends SET_ACTIVITY, connecting first if needed. Ok(false): Discord isn't running.
    pub(super) async fn set_activity(client_id: &str, args: serde_json::Value) -> Result<bool, String> {
        let mut guard = CONNECTION.lock().await;
        // One retry: a connection from before Discord restarted fails on first use.
        for _ in 0..2 {
            if guard.is_none() {
                *guard = connect(client_id).await;
            }
            let Some(stream) = guard.as_mut() else { return Ok(false) };
            let nonce = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
            let command = serde_json::json!({ "cmd": "SET_ACTIVITY", "args": args, "nonce": nonce });
            let sent = async {
                write_frame(stream, OP_FRAME, &command).await?;
                // Read the reply so Discord's answers never pile up in the socket.
                read_frame(stream).await
            };
            match sent.await {
                Ok(reply) => {
                    if reply.get("evt").and_then(|e| e.as_str()) == Some("ERROR") {
                        let message = reply.pointer("/data/message").and_then(|m| m.as_str()).unwrap_or("Discord refused the status");
                        return Err(message.to_string());
                    }
                    return Ok(true);
                }
                Err(_) => *guard = None,
            }
        }
        Ok(false)
    }

    pub(super) async fn disconnect() {
        *CONNECTION.lock().await = None;
    }
}

const SUPPORTED: bool = cfg!(all(unix, not(any(target_os = "android", target_os = "ios"))));

/// Whether this build can show a Discord status at all.
#[tauri::command]
pub(crate) fn discord_presence_available() -> bool {
    SUPPORTED && CLIENT_ID.is_some_and(|id| !id.trim().is_empty())
}

/// Shows `activity` as the Discord status, or clears it (None). Returns whether Discord was
/// reached; a closed Discord app is not an error.
#[tauri::command]
pub(crate) async fn set_discord_activity(activity: Option<Activity>) -> Result<bool, String> {
    let Some(client_id) = CLIENT_ID.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(false);
    };
    let args = activity_args(activity.as_ref(), std::process::id());
    #[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
    {
        ipc::set_activity(client_id, args).await
    }
    #[cfg(not(all(unix, not(any(target_os = "android", target_os = "ios")))))]
    {
        let _ = (client_id, args);
        Ok(false)
    }
}

/// Clears the status and lets go of the socket (the setting was turned off).
#[tauri::command]
pub(crate) async fn stop_discord_presence() {
    #[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
    {
        if let Some(client_id) = CLIENT_ID.map(str::trim).filter(|id| !id.is_empty()) {
            let _ = ipc::set_activity(client_id, activity_args(None, std::process::id())).await;
        }
        ipc::disconnect().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song() -> Activity {
        Activity {
            title: "Song Title".into(),
            artist: "The Artist".into(),
            album: None,
            artwork_url: Some("https://i.ytimg.com/vi/abc/hqdefault.jpg".into()),
            start_ms: Some(1_000_000),
            end_ms: Some(1_200_000),
            url: Some("https://music.youtube.com/watch?v=abc".into()),
        }
    }

    #[test]
    fn builds_a_listening_activity() {
        let args = activity_args(Some(&song()), 42);
        assert_eq!(args["pid"], 42);
        let a = &args["activity"];
        assert_eq!(a["type"], 2);
        assert_eq!(a["details"], "Song Title");
        assert_eq!(a["state"], "by The Artist");
        assert_eq!(a["timestamps"]["start"], 1_000_000);
        assert_eq!(a["timestamps"]["end"], 1_200_000);
        assert_eq!(a["assets"]["large_image"], "https://i.ytimg.com/vi/abc/hqdefault.jpg");
        assert_eq!(a["buttons"][0]["url"], "https://music.youtube.com/watch?v=abc");
    }

    #[test]
    fn clearing_sends_no_activity() {
        let args = activity_args(None, 7);
        assert_eq!(args, serde_json::json!({ "pid": 7 }));
    }

    #[test]
    fn drops_what_discord_would_reject() {
        let mut a = song();
        a.title = "x".into(); // under 2 characters
        a.artwork_url = Some("http://insecure.example/a.jpg".into());
        a.url = Some("https://evil.example/".into());
        a.end_ms = Some(10); // before the start
        let args = activity_args(Some(&a), 1);
        let body = &args["activity"];
        assert!(body.get("details").is_none());
        assert!(body.get("assets").is_none());
        assert!(body.get("buttons").is_none());
        assert!(body["timestamps"].get("end").is_none());
        let long = "a".repeat(300);
        assert_eq!(field(&long).unwrap().len(), 128);
    }
}

#[cfg(all(test, unix, not(any(target_os = "android", target_os = "ios"))))]
mod live_check {
    /// Run by hand with Discord open: cargo test --lib discord::live_check -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn talks_to_the_running_discord() {
        let activity = super::Activity {
            title: "Live check".into(),
            artist: "DOT Music".into(),
            album: None,
            artwork_url: None,
            start_ms: None,
            end_ms: None,
            url: None,
        };
        let shown = super::set_discord_activity(Some(activity)).await;
        println!("set: {shown:?}");
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        println!("clear: {:?}", super::set_discord_activity(None).await);
    }
}
