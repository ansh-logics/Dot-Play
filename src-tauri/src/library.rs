//! Changes to the signed-in user's library: liking songs, saving them to playlists and
//! creating playlists.

use crate::session::SessionState;
use crate::ytmusic::{attach_youtube_auth, web_remix_context, with_ytm_headers, HTTP_CLIENT};
use serde::Serialize;
use tauri::State;

/// YouTube Music's like states, as its API spells them.
const LIKE: &str = "LIKE";
const DISLIKE: &str = "DISLIKE";
const INDIFFERENT: &str = "INDIFFERENT";

fn signed_in_cookies(state: &State<'_, SessionState>) -> Option<String> {
    state.cookies.lock().unwrap().clone().filter(|c| !c.is_empty())
}

/// Finds the like button for `video_id` anywhere in a `next` response. Its position moves
/// between API versions, so search for it instead of hard-coding a path.
fn find_like_status<'a>(value: &'a serde_json::Value, video_id: &str) -> Option<&'a str> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(button) = map.get("likeButtonRenderer") {
                let target = button.pointer("/target/videoId").and_then(|v| v.as_str());
                if target.is_none_or(|t| t == video_id) {
                    if let Some(status) = button.get("likeStatus").and_then(|v| v.as_str()) {
                        return Some(status);
                    }
                }
            }
            map.values().find_map(|v| find_like_status(v, video_id))
        }
        serde_json::Value::Array(items) => items.iter().find_map(|v| find_like_status(v, video_id)),
        _ => None,
    }
}

/// Whether the signed-in user likes this song: "LIKE", "DISLIKE" or "INDIFFERENT".
/// Signed out, every song is "INDIFFERENT".
#[tauri::command]
pub(crate) async fn get_like_status(state: State<'_, SessionState>, video_id: String) -> Result<String, String> {
    let Some(cookies) = signed_in_cookies(&state) else {
        return Ok(INDIFFERENT.to_string());
    };
    let body = serde_json::json!({ "context": web_remix_context(), "videoId": video_id });
    let request = with_ytm_headers(HTTP_CLIENT.post("https://music.youtube.com/youtubei/v1/next"));
    let json: serde_json::Value = attach_youtube_auth(request, &Some(cookies))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't check if you like this song: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Couldn't read the like status: {e}"))?;

    Ok(match find_like_status(&json, &video_id) {
        Some(LIKE) => LIKE,
        Some(DISLIKE) => DISLIKE,
        _ => INDIFFERENT,
    }
    .to_string())
}

/// Likes a song ("LIKE") or takes the like back ("INDIFFERENT"). Liked songs land in the
/// user's Liked Music playlist, the same one their phone shows.
#[tauri::command]
pub(crate) async fn rate_song(state: State<'_, SessionState>, video_id: String, rating: String) -> Result<(), String> {
    let cookies = signed_in_cookies(&state).ok_or("Sign in to like songs")?;
    let endpoint = match rating.as_str() {
        LIKE => "like",
        INDIFFERENT => "removelike",
        DISLIKE => "dislike",
        _ => return Err(format!("Unknown rating: {rating}")),
    };
    let body = serde_json::json!({ "context": web_remix_context(), "target": { "videoId": video_id } });
    post_signed_in(cookies, &format!("like/{endpoint}"), body).await.map(|_| ())
}

/// One of the user's playlists, as the "Save to playlist" picker shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistOption {
    playlist_id: String,
    title: String,
    /// Whether the song is already in it.
    contains: bool,
    /// "PUBLIC", "UNLISTED" or "PRIVATE", when YouTube Music says.
    privacy: Option<String>,
}

/// POSTs to a `youtubei/v1` endpoint as the signed-in user and returns the JSON reply.
async fn post_signed_in(cookies: String, endpoint: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let request = with_ytm_headers(HTTP_CLIENT.post(format!("https://music.youtube.com/youtubei/v1/{endpoint}")));
    let res = attach_youtube_auth(request, &Some(cookies))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach YouTube Music: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("YouTube Music refused the request ({})", res.status()));
    }
    res.json().await.map_err(|e| format!("Couldn't read YouTube Music's reply: {e}"))
}

fn text_of(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?;
    value
        .get("simpleText")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            let runs = value.get("runs")?.as_array()?;
            Some(runs.iter().filter_map(|r| r.get("text").and_then(|t| t.as_str())).collect())
        })
        .filter(|t: &String| !t.is_empty())
}

/// The playlists this song can be saved to (the user's own), each marked with whether it
/// already holds the song. The same list YouTube Music's own "Save to playlist" shows.
#[tauri::command]
pub(crate) async fn get_playlists_for_song(
    state: State<'_, SessionState>,
    video_id: String,
) -> Result<Vec<PlaylistOption>, String> {
    let cookies = signed_in_cookies(&state).ok_or("Sign in to save songs to playlists")?;
    let body = serde_json::json!({
        "context": web_remix_context(),
        "videoIds": [video_id],
        "excludeWatchLater": true,
    });
    let json = post_signed_in(cookies, "playlist/get_add_to_playlist", body).await?;
    let options = json
        .pointer("/contents/0/addToPlaylistRenderer/playlists")
        .and_then(|v| v.as_array())
        .ok_or("YouTube Music didn't send your playlists")?;

    Ok(options
        .iter()
        .filter_map(|item| {
            let r = item.get("playlistAddToOptionRenderer")?;
            Some(PlaylistOption {
                playlist_id: r.get("playlistId")?.as_str()?.to_string(),
                title: text_of(r.get("title")).unwrap_or_else(|| "Untitled playlist".to_string()),
                contains: r.get("containsSelectedVideos").and_then(|v| v.as_str()) == Some("ALL"),
                privacy: r.get("privacy").and_then(|v| v.as_str()).map(str::to_string),
            })
        })
        .collect())
}

/// Adds a song to one of the user's playlists, or takes it out again (`add: false`).
#[tauri::command]
pub(crate) async fn set_song_in_playlist(
    state: State<'_, SessionState>,
    playlist_id: String,
    video_id: String,
    add: bool,
) -> Result<(), String> {
    let cookies = signed_in_cookies(&state).ok_or("Sign in to save songs to playlists")?;
    let playlist_id = playlist_id.strip_prefix("VL").unwrap_or(&playlist_id).to_string();
    let action = if add {
        serde_json::json!({ "action": "ACTION_ADD_VIDEO", "addedVideoId": video_id })
    } else {
        serde_json::json!({ "action": "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", "removedVideoId": video_id })
    };
    let body = serde_json::json!({
        "context": web_remix_context(),
        "playlistId": playlist_id,
        "actions": [action],
    });
    let json = post_signed_in(cookies, "browse/edit_playlist", body).await?;
    match json.get("status").and_then(|v| v.as_str()) {
        Some("STATUS_SUCCEEDED") | None => Ok(()),
        Some(other) => Err(format!("YouTube Music couldn't change the playlist ({other})")),
    }
}

/// Creates a playlist owned by the user, optionally with songs already in it, and returns
/// its ID. `privacy` is "PRIVATE", "UNLISTED" or "PUBLIC".
#[tauri::command]
pub(crate) async fn create_playlist(
    state: State<'_, SessionState>,
    title: String,
    privacy: String,
    video_ids: Vec<String>,
) -> Result<String, String> {
    let cookies = signed_in_cookies(&state).ok_or("Sign in to create playlists")?;
    let title = title.trim();
    if title.is_empty() {
        return Err("Give the playlist a name".to_string());
    }
    if !matches!(privacy.as_str(), "PRIVATE" | "UNLISTED" | "PUBLIC") {
        return Err(format!("Unknown privacy: {privacy}"));
    }
    let mut body = serde_json::json!({
        "context": web_remix_context(),
        "title": title,
        "description": "",
        "privacyStatus": privacy,
    });
    if !video_ids.is_empty() {
        body["videoIds"] = serde_json::json!(video_ids);
    }
    let json = post_signed_in(cookies, "playlist/create", body).await?;
    json.get("playlistId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "YouTube Music didn't create the playlist".to_string())
}
