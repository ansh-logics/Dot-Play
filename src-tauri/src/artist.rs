//! Artist page browsing and parsing.

use crate::models::ArtistPage;
use crate::session::SessionState;
use crate::ytmusic::parse::{parse_feed_item, upscale_thumbnail_url};
use crate::ytmusic::{attach_youtube_auth, web_remix_context, with_ytm_headers, HTTP_CLIENT};
use tauri::State;

/// Validates that an artist browse ID starts with "UC", contains only [A-Za-z0-9_-], and is at most 64 chars.
pub(crate) fn validate_artist_browse_id(id: &str) -> Result<(), String> {
    if !id.starts_with("UC") {
        return Err(format!("Invalid artist browse ID '{}': must start with 'UC'", id));
    }
    if id.len() > 64 {
        return Err(format!("Invalid artist browse ID: length {} exceeds 64 characters", id.len()));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(format!("Invalid artist browse ID '{}': contains invalid characters", id));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn get_artist(
    state: State<'_, SessionState>,
    browse_id: String,
) -> Result<ArtistPage, String> {
    let clean_id = browse_id.trim();
    validate_artist_browse_id(clean_id)?;

    let client = &*HTTP_CLIENT;
    let maybe_cookies = state
        .cookies
        .lock()
        .map_err(|e| format!("Failed to acquire cookie lock: {}", e))?
        .clone();

    let body = serde_json::json!({
        "context": web_remix_context(),
        "browseId": clean_id
    });

    let mut request = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/browse"));
    request = attach_youtube_auth(request, &maybe_cookies);

    let res = request
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch artist details: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("Artist page request failed: HTTP {}", res.status()));
    }

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse artist JSON: {}", e))?;

    let page = parse_artist_page(clean_id, &json);
    // A channel that isn't an artist (or no longer exists) parses to nothing: say so, so the
    // app shows its error screen rather than a blank page.
    if page.name.is_empty() && page.songs.is_empty() && page.albums.is_empty() && page.singles.is_empty() {
        return Err("This isn't an artist page.".to_string());
    }
    Ok(page)
}

pub(crate) fn parse_artist_page(browse_id: &str, json: &serde_json::Value) -> ArtistPage {
    // 1. Extract header metadata
    let header = json
        .pointer("/header/musicImmersiveHeaderRenderer")
        .or_else(|| json.pointer("/header/musicVisualHeaderRenderer"))
        .or_else(|| json.pointer("/contents/musicImmersiveHeaderRenderer"))
        .or_else(|| json.pointer("/contents/musicVisualHeaderRenderer"))
        .or_else(|| json.get("musicImmersiveHeaderRenderer"))
        .or_else(|| json.get("musicVisualHeaderRenderer"));

    let name = header
        .and_then(|h| h.pointer("/title/runs/0/text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let description = header
        .and_then(|h| {
            h.pointer("/description/runs")
                .or_else(|| h.pointer("/description/musicDescriptionShelfRenderer/description/runs"))
        })
        .and_then(|v| v.as_array())
        .map(|runs| {
            runs.iter()
                .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
                .collect::<String>()
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let raw_thumb = header
        .and_then(|h| {
            h.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")
                .or_else(|| h.pointer("/thumbnail/croppedSquareThumbnailRenderer/thumbnail/thumbnails"))
                .or_else(|| h.pointer("/thumbnail/thumbnails"))
        })
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.last())
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("");

    let thumbnail_url = if !raw_thumb.is_empty() {
        upscale_thumbnail_url(raw_thumb)
    } else {
        String::new()
    };

    let raw_subscribers = header
        .and_then(|h| {
            // The long form ("1.2M subscribers") reads better than the bare count ("1.2M").
            h.pointer("/subscriptionButton/subscribeButtonRenderer/longSubscriberCountText/runs/0/text")
                .or_else(|| h.pointer("/subscriptionButton/subscribeButtonRenderer/subscriberCountText/runs/0/text"))
                .or_else(|| h.pointer("/subscriptionButton/subscribeButtonRenderer/subscriberCountText/simpleText"))
        })
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let subscribers = raw_subscribers.map(|s| {
        if !s.to_lowercase().contains("subscriber") {
            format!("{} subscribers", s)
        } else {
            s.to_string()
        }
    });

    // 2. Extract sections (songs shelf, albums carousel, singles carousel)
    let mut songs = Vec::new();
    let mut songs_playlist_id = None;
    let mut albums = Vec::new();
    let mut singles = Vec::new();

    let section_list = json
        .pointer("/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents")
        .or_else(|| json.pointer("/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents"))
        .or_else(|| json.pointer("/contents/sectionListRenderer/contents"))
        .and_then(|v| v.as_array());

    if let Some(sections) = section_list {
        let mut all_sections = Vec::new();
        for section in sections {
            if let Some(inner) = section.pointer("/itemSectionRenderer/contents").and_then(|v| v.as_array()) {
                all_sections.extend(inner.iter());
            } else {
                all_sections.push(section);
            }
        }

        for section in all_sections {
            if let Some(shelf) = section.get("musicShelfRenderer") {
                if songs_playlist_id.is_none() {
                    let shelf_browse_id = shelf
                        .pointer("/title/runs/0/navigationEndpoint/browseEndpoint/browseId")
                        .or_else(|| shelf.pointer("/bottomEndpoint/browseEndpoint/browseId"))
                        .and_then(|v| v.as_str());
                    if let Some(bid) = shelf_browse_id {
                        let clean = bid.strip_prefix("VL").unwrap_or(bid);
                        if !clean.is_empty() {
                            songs_playlist_id = Some(clean.to_string());
                        }
                    }
                }

                if let Some(items) = shelf.get("contents").and_then(|c| c.as_array()) {
                    for item in items {
                        if let Some(track) = crate::playlist::parse_track(item, &thumbnail_url) {
                            songs.push(track);
                        }
                    }
                }
            } else if let Some(carousel) = section.get("musicCarouselShelfRenderer") {
                let header_title = carousel
                    .pointer("/header/musicCarouselShelfBasicHeaderRenderer/title/runs/0/text")
                    .or_else(|| carousel.pointer("/header/musicCarouselShelfBasicHeaderRenderer/title/runs"))
                    .and_then(|v| {
                        if let Some(s) = v.as_str() {
                            Some(s.to_string())
                        } else if let Some(arr) = v.as_array() {
                            let combined: String = arr.iter().filter_map(|r| r.get("text").and_then(|t| t.as_str())).collect();
                            Some(combined)
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default()
                    .to_lowercase();

                let is_albums = header_title.contains("album");
                // "EP" as a whole word: a bare substring check would also catch unrelated shelf titles.
                let is_singles = header_title.contains("single")
                    || header_title.split(|c: char| !c.is_alphanumeric()).any(|w| w == "ep" || w == "eps");

                if is_albums || is_singles {
                    if let Some(carousel_items) = carousel.get("contents").and_then(|v| v.as_array()) {
                        for item in carousel_items {
                            if let Some(mut search_result) = parse_feed_item(item) {
                                if search_result.item_type.is_none() {
                                    search_result.item_type = Some("album".to_string());
                                }
                                if search_result.playlist_id.is_none() {
                                    if let Some(bid) = item
                                        .pointer("/musicTwoRowItemRenderer/navigationEndpoint/browseEndpoint/browseId")
                                        .and_then(|v| v.as_str())
                                    {
                                        search_result.playlist_id = Some(bid.to_string());
                                    }
                                }
                                if is_albums {
                                    albums.push(search_result);
                                } else {
                                    singles.push(search_result);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    ArtistPage {
        id: browse_id.to_string(),
        name,
        description,
        thumbnail_url,
        subscribers,
        songs,
        songs_playlist_id,
        albums,
        singles,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_browse_id() {
        assert!(validate_artist_browse_id("VLxyz").is_err());
        assert!(validate_artist_browse_id("UC../evil").is_err());
        assert!(validate_artist_browse_id("UC1234567890abcdef_ABC-XYZ").is_ok());
        assert!(validate_artist_browse_id("").is_err());
        assert!(validate_artist_browse_id("UC").is_ok());
        let too_long = format!("UC{}", "a".repeat(63));
        assert!(validate_artist_browse_id(&too_long).is_err());
    }

    #[test]
    fn parses_artist_page_data() {
        let sample = json!({
            "header": {
                "musicImmersiveHeaderRenderer": {
                    "title": {
                        "runs": [{ "text": "Test Artist" }]
                    },
                    "description": {
                        "runs": [{ "text": "An indie artist biography." }]
                    },
                    "thumbnail": {
                        "musicThumbnailRenderer": {
                            "thumbnail": {
                                "thumbnails": [
                                    { "url": "https://lh3.googleusercontent.com/small" },
                                    { "url": "https://lh3.googleusercontent.com/large=w544-h544-l90-rj" }
                                ]
                            }
                        }
                    },
                    "subscriptionButton": {
                        "subscribeButtonRenderer": {
                            "subscriberCountText": {
                                "runs": [{ "text": "1.2M subscribers" }]
                            }
                        }
                    }
                }
            },
            "contents": {
                "singleColumnBrowseResultsRenderer": {
                    "tabs": [
                        {
                            "tabRenderer": {
                                "content": {
                                    "sectionListRenderer": {
                                        "contents": [
                                            {
                                                "musicShelfRenderer": {
                                                    "title": {
                                                        "runs": [
                                                            {
                                                                "text": "Top songs",
                                                                "navigationEndpoint": {
                                                                    "browseEndpoint": {
                                                                        "browseId": "VLPL_songs_123"
                                                                    }
                                                                }
                                                            }
                                                        ]
                                                    },
                                                    "contents": [
                                                        {
                                                            "musicResponsiveListItemRenderer": {
                                                                "playlistItemData": {
                                                                    "videoId": "song_vid_1"
                                                                },
                                                                "flexColumns": [
                                                                    {
                                                                        "musicResponsiveListItemFlexColumnRenderer": {
                                                                            "text": {
                                                                                "runs": [{ "text": "Song Title" }]
                                                                            }
                                                                        }
                                                                    },
                                                                    {
                                                                        "musicResponsiveListItemFlexColumnRenderer": {
                                                                            "text": {
                                                                                "runs": [
                                                                                    {
                                                                                        "text": "Test Artist",
                                                                                        "navigationEndpoint": {
                                                                                            "browseEndpoint": {
                                                                                                "browseId": "UCxxxx",
                                                                                                "browseEndpointContextSupportedConfigs": {
                                                                                                    "browseEndpointContextMusicConfig": {
                                                                                                        "pageType": "MUSIC_PAGE_TYPE_ARTIST"
                                                                                                    }
                                                                                                }
                                                                                            }
                                                                                        }
                                                                                    }
                                                                                ]
                                                                            }
                                                                        }
                                                                    }
                                                                ],
                                                                "fixedColumns": [
                                                                    {
                                                                        "musicResponsiveListItemFixedColumnRenderer": {
                                                                            "text": {
                                                                                "runs": [{ "text": "3:45" }]
                                                                            }
                                                                        }
                                                                    }
                                                                ],
                                                                "thumbnail": {
                                                                    "musicThumbnailRenderer": {
                                                                        "thumbnail": {
                                                                            "thumbnails": [
                                                                                { "url": "https://lh3.googleusercontent.com/track=w120-h120-l90-rj" }
                                                                            ]
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    ]
                                                }
                                            },
                                            {
                                                "musicCarouselShelfRenderer": {
                                                    "header": {
                                                        "musicCarouselShelfBasicHeaderRenderer": {
                                                            "title": {
                                                                "runs": [{ "text": "Albums" }]
                                                            }
                                                        }
                                                    },
                                                    "contents": [
                                                        {
                                                            "musicTwoRowItemRenderer": {
                                                                "title": {
                                                                    "runs": [{ "text": "Debut Album" }]
                                                                },
                                                                "subtitle": {
                                                                    "runs": [{ "text": "2023 • Album" }]
                                                                },
                                                                "navigationEndpoint": {
                                                                    "browseEndpoint": {
                                                                        "browseId": "MPREb_debut_album",
                                                                        "browseEndpointContextSupportedConfigs": {
                                                                            "browseEndpointContextMusicConfig": {
                                                                                "pageType": "MUSIC_PAGE_TYPE_ALBUM"
                                                                            }
                                                                        }
                                                                    }
                                                                },
                                                                "thumbnailRenderer": {
                                                                    "musicThumbnailRenderer": {
                                                                        "thumbnail": {
                                                                            "thumbnails": [
                                                                                { "url": "https://lh3.googleusercontent.com/album=w544-h544-l90-rj" }
                                                                            ]
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    ]
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        });

        let page = parse_artist_page("UCxxxx", &sample);

        // Asserting name, subscribers, one album
        assert_eq!(page.name, "Test Artist");
        assert_eq!(page.subscribers.as_deref(), Some("1.2M subscribers"));
        assert_eq!(page.albums.len(), 1);
        assert_eq!(page.albums[0].title, "Debut Album");
        assert_eq!(page.albums[0].playlist_id.as_deref(), Some("MPREb_debut_album"));

        // Additional assertions on songs and metadata
        assert_eq!(page.songs.len(), 1);
        assert_eq!(page.songs[0].title, "Song Title");
        assert_eq!(page.songs[0].video_id, "song_vid_1");
        assert_eq!(page.songs_playlist_id.as_deref(), Some("PL_songs_123"));
        assert_eq!(page.description.as_deref(), Some("An indie artist biography."));
    }

    #[test]
    fn appends_subscribers_when_numeric_only() {
        let sample = json!({
            "header": {
                "musicVisualHeaderRenderer": {
                    "title": { "runs": [{ "text": "Band" }] },
                    "subscriptionButton": {
                        "subscribeButtonRenderer": {
                            "subscriberCountText": {
                                "runs": [{ "text": "450" }]
                            }
                        }
                    }
                }
            }
        });
        let page = parse_artist_page("UC123", &sample);
        assert_eq!(page.subscribers.as_deref(), Some("450 subscribers"));
    }
}
