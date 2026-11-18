//! Last.fm (https://www.last.fm/api): desktop sign-in, now playing and scrobbles.
//!
//! Every call is signed: md5 of the parameters sorted by name, each name followed by its
//! value, then the shared secret. The API key and secret identify DOT Music to Last.fm and
//! are set at build time (`DOT_LASTFM_API_KEY`, `DOT_LASTFM_API_SECRET`); builds without
//! them offer no Last.fm sign-in.

use super::Listen;
use md5::{Digest, Md5};
use std::collections::BTreeMap;

const API_URL: &str = "https://ws.audioscrobbler.com/2.0/";
const API_KEY: Option<&str> = option_env!("DOT_LASTFM_API_KEY");
const API_SECRET: Option<&str> = option_env!("DOT_LASTFM_API_SECRET");
/// Last.fm takes at most 50 scrobbles per request.
pub(super) const BATCH: usize = 50;

pub(super) fn keys() -> Option<(&'static str, &'static str)> {
    let key = API_KEY.map(str::trim).filter(|k| !k.is_empty())?;
    let secret = API_SECRET.map(str::trim).filter(|s| !s.is_empty())?;
    Some((key, secret))
}

/// The `api_sig` for `params` (format/callback excluded, as Last.fm specifies).
pub(super) fn signature(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut text = String::new();
    for (name, value) in params {
        if name == "format" || name == "callback" {
            continue;
        }
        text.push_str(name);
        text.push_str(value);
    }
    text.push_str(secret);
    format!("{:x}", Md5::digest(text.as_bytes()))
}

/// How a failed call should be handled.
#[derive(Debug, PartialEq)]
pub(super) enum Failure {
    /// Last.fm is down or busy, or the network is: keep the listen and try later.
    Retry(String),
    /// The sign-in was revoked: forget it.
    SignedOut,
    /// Last.fm refused this request for good (e.g. bad data): drop it.
    Rejected(String),
}

/// Last.fm error codes (https://www.last.fm/api/errorcodes).
pub(super) fn classify(code: i64, message: &str) -> Failure {
    match code {
        4 | 9 | 14 | 15 | 26 => Failure::SignedOut,
        8 | 11 | 16 | 29 => Failure::Retry(message.to_string()),
        _ => Failure::Rejected(message.to_string()),
    }
}

async fn call(method: &str, mut params: BTreeMap<String, String>, signed: bool) -> Result<serde_json::Value, Failure> {
    let (key, secret) = keys().ok_or_else(|| Failure::Rejected("Last.fm isn't set up in this build".into()))?;
    params.insert("method".into(), method.into());
    params.insert("api_key".into(), key.into());
    if signed {
        let sig = signature(&params, secret);
        params.insert("api_sig".into(), sig);
    }
    params.insert("format".into(), "json".into());
    let response = super::client()
        .post(API_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| Failure::Retry(e.to_string()))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|e| Failure::Retry(e.to_string()))?;
    if let Some(code) = body.get("error").and_then(|c| c.as_i64()) {
        let message = body.get("message").and_then(|m| m.as_str()).unwrap_or("Last.fm error");
        return Err(classify(code, message));
    }
    if status.is_server_error() {
        return Err(Failure::Retry(format!("Last.fm answered {status}")));
    }
    Ok(body)
}

/// Step 1 of sign-in: a request token, and the page where the listener approves it.
pub(super) async fn begin_auth() -> Result<(String, String), String> {
    let (key, _) = keys().ok_or("Last.fm isn't set up in this build")?;
    let body = call("auth.getToken", BTreeMap::new(), true).await.map_err(describe)?;
    let token = body.get("token").and_then(|t| t.as_str()).ok_or("Last.fm sent no token")?.to_string();
    let url = format!("https://www.last.fm/api/auth/?api_key={key}&token={token}");
    Ok((token, url))
}

/// Step 2: once the listener approved, the session. `Ok(None)` while not approved yet.
pub(super) async fn finish_auth(token: &str) -> Result<Option<(String, String)>, String> {
    let params = BTreeMap::from([("token".to_string(), token.to_string())]);
    match call("auth.getSession", params, true).await {
        Ok(body) => {
            let name = body.pointer("/session/name").and_then(|n| n.as_str()).ok_or("Last.fm sent no user")?;
            let key = body.pointer("/session/key").and_then(|k| k.as_str()).ok_or("Last.fm sent no session")?;
            Ok(Some((name.to_string(), key.to_string())))
        }
        // 14: not approved yet. Keep waiting.
        Err(Failure::SignedOut) => Ok(None),
        Err(other) => Err(describe(other)),
    }
}

fn describe(failure: Failure) -> String {
    match failure {
        Failure::Retry(m) | Failure::Rejected(m) => m,
        Failure::SignedOut => "Last.fm sign-in expired".into(),
    }
}

fn track_params(listen: &Listen, suffix: &str, params: &mut BTreeMap<String, String>) {
    params.insert(format!("artist{suffix}"), listen.artist.clone());
    params.insert(format!("track{suffix}"), listen.track.clone());
    if let Some(album) = listen.album.as_deref().filter(|a| !a.is_empty()) {
        params.insert(format!("album{suffix}"), album.to_string());
    }
    if let Some(duration) = listen.duration.filter(|d| *d > 0) {
        params.insert(format!("duration{suffix}"), duration.to_string());
    }
}

pub(super) async fn now_playing(session_key: &str, listen: &Listen) -> Result<(), Failure> {
    let mut params = BTreeMap::from([("sk".to_string(), session_key.to_string())]);
    track_params(listen, "", &mut params);
    call("track.updateNowPlaying", params, true).await.map(|_| ())
}

/// Sends up to BATCH scrobbles in one request.
pub(super) async fn scrobble(session_key: &str, listens: &[&Listen]) -> Result<(), Failure> {
    let mut params = BTreeMap::from([("sk".to_string(), session_key.to_string())]);
    for (i, listen) in listens.iter().take(BATCH).enumerate() {
        let suffix = format!("[{i}]");
        track_params(listen, &suffix, &mut params);
        params.insert(format!("timestamp{suffix}"), listen.started_at.to_string());
    }
    call("track.scrobble", params, true).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_sorted_params_without_format() {
        let params = BTreeMap::from([
            ("method".to_string(), "auth.getSession".to_string()),
            ("api_key".to_string(), "KEY".to_string()),
            ("token".to_string(), "TOKEN".to_string()),
            ("format".to_string(), "json".to_string()),
        ]);
        // md5("api_keyKEYmethodauth.getSessiontokenTOKENSECRET")
        let expected = format!("{:x}", Md5::digest(b"api_keyKEYmethodauth.getSessiontokenTOKENSECRET"));
        assert_eq!(signature(&params, "SECRET"), expected);
        assert_eq!(expected.len(), 32);
    }

    #[test]
    fn sorts_errors_into_retry_sign_out_and_reject() {
        assert_eq!(classify(9, "Invalid session key"), Failure::SignedOut);
        assert_eq!(classify(29, "Rate limit"), Failure::Retry("Rate limit".into()));
        assert_eq!(classify(11, "Offline"), Failure::Retry("Offline".into()));
        assert_eq!(classify(6, "Invalid parameters"), Failure::Rejected("Invalid parameters".into()));
    }

    #[test]
    fn numbers_batched_scrobbles() {
        let listen = Listen {
            artist: "Artist".into(),
            track: "Song".into(),
            album: None,
            duration: Some(200),
            started_at: 1_700_000_000,
            video_id: None,
        };
        let mut params = BTreeMap::new();
        track_params(&listen, "[1]", &mut params);
        assert_eq!(params.get("artist[1]").map(String::as_str), Some("Artist"));
        assert_eq!(params.get("duration[1]").map(String::as_str), Some("200"));
        assert!(!params.contains_key("album[1]"));
    }
}
