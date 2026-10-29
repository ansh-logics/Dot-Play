//! Data shapes shared by several commands and sent to the frontend as JSON.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    #[serde(rename = "videoId")]
    pub video_id: String,
    pub title: String,
    pub artist: String,
    #[serde(rename = "thumbnailUrl")]
    pub thumbnail_url: String,
    #[serde(rename = "playlistId", skip_serializing_if = "Option::is_none")]
    pub playlist_id: Option<String>,
    #[serde(rename = "itemType", skip_serializing_if = "Option::is_none")]
    pub item_type: Option<String>,
    /// "user" for songs the listener queued themselves (Add to Queue / Play Next), which
    /// survive playing a different song directly. Set by the frontend; kept when saving the queue.
    #[serde(rename = "queueSource", default, skip_serializing_if = "Option::is_none")]
    pub queue_source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistTrack {
    #[serde(rename = "videoId")]
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub duration: String,
    #[serde(rename = "thumbnailUrl")]
    pub thumbnail_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistDetails {
    pub id: String,
    pub title: String,
    pub description: String,
    pub author: String,
    #[serde(rename = "thumbnailUrl")]
    pub thumbnail_url: String,
    #[serde(rename = "trackCount")]
    pub track_count: String,
    pub tracks: Vec<PlaylistTrack>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HomeSection {
    pub title: String,
    pub items: Vec<SearchResult>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HomeFeedResponse {
    pub sections: Vec<HomeSection>,
    #[serde(rename = "continuationToken", skip_serializing_if = "Option::is_none")]
    pub continuation_token: Option<String>,
}
