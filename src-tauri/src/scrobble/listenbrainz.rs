//! ListenBrainz (https://listenbrainz.readthedocs.io): the listener pastes their user token;
//! listens are sent as "playing_now", then as finished listens.

use super::lastfm::Failure;
use super::Listen;

const API: &str = "https://api.listenbrainz.org/1";
/// ListenBrainz accepts large imports; keep requests small anyway.
pub(super) const BATCH: usize = 100;

/// The user name for a token, or an error saying why it was refused.
pub(super) async fn validate(token: &str) -> Result<String, String> {
    let response = super::client()
        .get(format!("{API}/validate-token"))
        .header("Authorization", format!("Token {token}"))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach ListenBrainz: {e}"))?;
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if body.get("valid").and_then(|v| v.as_bool()) == Some(true) {
        if let Some(name) = body.get("user_name").and_then(|n| n.as_str()) {
            return Ok(name.to_string());
        }
    }
    Err("ListenBrainz didn't accept that token.".into())
}

/// One listen in ListenBrainz's JSON. `with_time`: finished listens carry when they started.
pub(super) fn listen_json(listen: &Listen, with_time: bool) -> serde_json::Value {
    let mut info = serde_json::json!({
        "media_player": "DOT Music",
        "submission_client": "DOT Music",
        "submission_client_version": env!("CARGO_PKG_VERSION"),
        "music_service": "music.youtube.com",
    });
    if let Some(duration) = listen.duration.filter(|d| *d > 0) {
        info["duration_ms"] = (duration * 1000).into();
    }
    if let Some(id) = listen.video_id.as_deref().filter(|id| !id.is_empty()) {
        info["origin_url"] = format!("https://music.youtube.com/watch?v={id}").into();
    }
    let mut metadata = serde_json::json!({
        "artist_name": listen.artist,
        "track_name": listen.track,
        "additional_info": info,
    });
    if let Some(album) = listen.album.as_deref().filter(|a| !a.is_empty()) {
        metadata["release_name"] = album.into();
    }
    let mut item = serde_json::json!({ "track_metadata": metadata });
    if with_time {
        item["listened_at"] = listen.started_at.into();
    }
    item
}

async fn submit(token: &str, listen_type: &str, payload: Vec<serde_json::Value>) -> Result<(), Failure> {
    let response = super::client()
        .post(format!("{API}/submit-listens"))
        .header("Authorization", format!("Token {token}"))
        .json(&serde_json::json!({ "listen_type": listen_type, "payload": payload }))
        .send()
        .await
        .map_err(|e| Failure::Retry(e.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let message = response.text().await.unwrap_or_default();
    Err(match status.as_u16() {
        401 => Failure::SignedOut,
        429 | 500..=599 => Failure::Retry(format!("ListenBrainz answered {status}")),
        _ => Failure::Rejected(format!("ListenBrainz answered {status}: {}", message.chars().take(200).collect::<String>())),
    })
}

pub(super) async fn now_playing(token: &str, listen: &Listen) -> Result<(), Failure> {
    submit(token, "playing_now", vec![listen_json(listen, false)]).await
}

pub(super) async fn send(token: &str, listens: &[&Listen]) -> Result<(), Failure> {
    let payload: Vec<_> = listens.iter().take(BATCH).map(|l| listen_json(l, true)).collect();
    let kind = if payload.len() == 1 { "single" } else { "import" };
    submit(token, kind, payload).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_listen_with_its_youtube_link() {
        let listen = Listen {
            artist: "Artist".into(),
            track: "Song".into(),
            album: Some("Album".into()),
            duration: Some(200),
            started_at: 1_700_000_000,
            video_id: Some("abc".into()),
        };
        let json = listen_json(&listen, true);
        assert_eq!(json["listened_at"], 1_700_000_000);
        assert_eq!(json["track_metadata"]["release_name"], "Album");
        assert_eq!(json["track_metadata"]["additional_info"]["duration_ms"], 200_000);
        assert_eq!(json["track_metadata"]["additional_info"]["origin_url"], "https://music.youtube.com/watch?v=abc");
        assert!(listen_json(&listen, false).get("listened_at").is_none());
    }
}
