//! Parsing helpers for YouTube Music API responses: artist/title cleanup, thumbnail
//! upscaling, feed items, shelves and continuation tokens.

use crate::models::{HomeSection, SearchResult};

fn is_duration_or_views_or_year(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    if t.split(':').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) && t.contains(':') {
        return true;
    }
    let lower = t.to_lowercase();
    if lower.ends_with("views") || lower.ends_with("plays") || lower.ends_with("subscribers") {
        return true;
    }
    if t.len() == 4 && t.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(y) = t.parse::<u32>() {
            if (1900..=2099).contains(&y) {
                return true;
            }
        }
    }
    false
}

pub(crate) fn parse_ytmusic_artist_from_runs(runs: &[serde_json::Value]) -> String {
    // 1. Check if any run has an explicit artist browseEndpoint
    let mut explicit_artists = Vec::new();
    for run in runs {
        let is_artist = run
            .pointer("/navigationEndpoint/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
            .and_then(|v| v.as_str())
            .map(|pt| pt == "MUSIC_PAGE_TYPE_ARTIST" || pt == "MUSIC_PAGE_TYPE_USER_CHANNEL")
            .unwrap_or(false)
            || run
                .pointer("/navigationEndpoint/browseEndpoint/browseId")
                .and_then(|v| v.as_str())
                .map(|id| id.starts_with("UC") || id.starts_with("FEmusic_library_privately_owned_artist"))
                .unwrap_or(false);

        if is_artist {
            if let Some(txt) = run.get("text").and_then(|v| v.as_str()) {
                let trimmed = txt.trim();
                if !trimmed.is_empty() && !explicit_artists.iter().any(|&e: &&str| e == trimmed) {
                    explicit_artists.push(trimmed);
                }
            }
        }
    }

    if !explicit_artists.is_empty() {
        return explicit_artists.join(", ");
    }

    // 2. Iterate through runs, skipping type badges and separators
    let mut candidate_parts: Vec<&str> = Vec::new();
    let mut passed_type_badge = false;

    for (i, run) in runs.iter().enumerate() {
        let txt = run.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
        if txt.is_empty() {
            continue;
        }

        if txt == "•" || txt == "·" || txt == "|" || txt == "-" {
            continue;
        }

        let is_type_badge = txt.eq_ignore_ascii_case("Song")
            || txt.eq_ignore_ascii_case("Video")
            || txt.eq_ignore_ascii_case("Track")
            || txt.eq_ignore_ascii_case("Audio")
            || txt.eq_ignore_ascii_case("Single")
            || txt.eq_ignore_ascii_case("EP")
            || txt.eq_ignore_ascii_case("Album")
            || txt.eq_ignore_ascii_case("Playlist")
            || txt.eq_ignore_ascii_case("Featured Playlist")
            || txt.eq_ignore_ascii_case("Community Playlist");

        if !passed_type_badge && is_type_badge {
            passed_type_badge = true;
            continue;
        }

        if is_duration_or_views_or_year(txt) {
            break;
        }

        candidate_parts.push(txt);

        if let Some(next_run) = runs.get(i + 1) {
            let next_txt = next_run.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
            if next_txt == "&" || next_txt == "," || next_txt.eq_ignore_ascii_case("feat.") || next_txt.eq_ignore_ascii_case("ft.") {
                continue;
            }
        }

        if !candidate_parts.is_empty() {
            break;
        }
    }

    if !candidate_parts.is_empty() {
        return candidate_parts.join(" ");
    }

    let all_text = runs
        .iter()
        .filter_map(|r| r.get("text").and_then(|v| v.as_str()))
        .collect::<Vec<_>>()
        .join("");

    clean_artist_string(&all_text)
}

fn clean_artist_string(raw: &str) -> String {
    let mut s = raw.trim();
    let prefixes = [
        "Song •", "Song ·", "Video •", "Video ·", "Track •", "Track ·",
        "Single •", "Single ·", "EP •", "EP ·", "Album •", "Album ·",
    ];
    for p in prefixes {
        if s.to_lowercase().starts_with(&p.to_lowercase()) {
            s = s[p.len()..].trim();
        }
    }
    if let Some((first, _rest)) = s.split_once(" • ") {
        s = first.trim();
    } else if let Some((first, _rest)) = s.split_once(" · ") {
        s = first.trim();
    }

    if s.is_empty() || s.eq_ignore_ascii_case("Song") || s.eq_ignore_ascii_case("Video") {
        return "Unknown Artist".to_string();
    }
    s.to_string()
}

pub(crate) fn clean_ytmusic_title_and_artist(raw_title: &str, raw_artist: &str) -> (String, String) {
    let mut title = raw_title.trim().to_string();
    let mut artist = clean_artist_string(raw_artist);

    if (artist == "Unknown Artist" || artist.eq_ignore_ascii_case("Song") || artist.eq_ignore_ascii_case("Video"))
        && title.contains(" - ")
    {
        if let Some((a, t)) = title.split_once(" - ") {
            artist = a.trim().to_string();
            title = t.trim().to_string();
        }
    }

    if artist.ends_with(" - Topic") {
        artist = artist.trim_end_matches(" - Topic").trim().to_string();
    } else if artist.ends_with("VEVO") && artist.len() > 4 {
        artist = artist.trim_end_matches("VEVO").trim().to_string();
    } else if artist.ends_with(" Official") && artist.len() > 9 {
        artist = artist.trim_end_matches(" Official").trim().to_string();
    }

    (title, artist)
}

/// Square album art from YouTube Music's image CDN (as opposed to i.ytimg.com video frames).
pub(crate) fn is_square_cover_url(url: &str) -> bool {
    url.contains("googleusercontent.com") || url.contains("ggpht.com")
}

pub(crate) fn upscale_thumbnail_url(raw_url: &str) -> String {
    if raw_url.is_empty() {
        return String::new();
    }
    if raw_url.contains("googleusercontent.com") || raw_url.contains("ggpht.com") {
        if let Some(idx) = raw_url.rfind("=w") {
            let base = &raw_url[..idx];
            return format!("{}=w800-h800-l90-rj", base);
        } else if let Some(idx) = raw_url.rfind("=s") {
            let base = &raw_url[..idx];
            return format!("{}=s800-l90-rj", base);
        }
    }
    raw_url.to_string()
}

pub(crate) fn parse_feed_item(item: &serde_json::Value) -> Option<SearchResult> {
    let renderer = item.get("musicTwoRowItemRenderer")
        .or_else(|| item.get("musicResponsiveListItemRenderer"))?;

    // 1. Extract Title
    let raw_title = renderer
        .pointer("/title/runs/0/text")
        .or_else(|| renderer.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/text"))
        .and_then(|v| v.as_str())?;

    // 2. Extract Artist / Subtitle
    let mut subtitle_parts = Vec::new();
    let subtitle_runs_opt = renderer.pointer("/subtitle/runs")
        .or_else(|| renderer.pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs"))
        .and_then(|v| v.as_array());

    if let Some(runs) = subtitle_runs_opt {
        for run in runs {
            if let Some(txt) = run.get("text").and_then(|v| v.as_str()) {
                subtitle_parts.push(txt);
            }
        }
    }
    let raw_artist = if let Some(runs) = subtitle_runs_opt {
        parse_ytmusic_artist_from_runs(runs)
    } else {
        "YouTube Music".to_string()
    };
    let (title, artist) = clean_ytmusic_title_and_artist(raw_title, &raw_artist);

    // 3. Extract Thumbnail
    let raw_thumb = renderer
        .pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail/thumbnails")
        .or_else(|| renderer.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails"))
        .or_else(|| renderer.pointer("/thumbnail/thumbnails"))
        .or_else(|| renderer.pointer("/thumbnailRenderer/thumbnails"))
        .or_else(|| renderer.pointer("/thumbnail/croppedSquareThumbnailRenderer/thumbnail/thumbnails"))
        .or_else(|| renderer.pointer("/thumbnails"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.last().or_else(|| arr.first()))
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("");
    let thumb = upscale_thumbnail_url(raw_thumb);

    // Subtitle type flags
    let is_song_subtitle = subtitle_parts.iter().any(|p| {
        let t = p.trim();
        t.eq_ignore_ascii_case("Song") || t.eq_ignore_ascii_case("Video")
    }) || artist.trim().starts_with("Song •") 
       || artist.trim().starts_with("Song ·")
       || artist.trim().starts_with("Video •")
       || artist.trim().starts_with("Video ·");

    let is_playlist_or_album_subtitle = subtitle_parts.iter().any(|p| {
        let t = p.trim();
        t.eq_ignore_ascii_case("Playlist")
            || t.eq_ignore_ascii_case("Featured Playlist")
            || t.eq_ignore_ascii_case("Community Playlist")
            || t.eq_ignore_ascii_case("Album")
            || t.eq_ignore_ascii_case("EP")
            || t.eq_ignore_ascii_case("Single")
    }) || artist.trim().starts_with("Playlist •") 
       || artist.trim().starts_with("Playlist ·")
       || artist.trim().starts_with("Album •")
       || artist.trim().starts_with("Album ·")
       || artist.trim().starts_with("EP •")
       || artist.trim().starts_with("EP ·")
       || artist.trim().starts_with("Single •")
       || artist.trim().starts_with("Single ·");

    // 4. Primary card watch endpoint (indicates card clicks directly to play a song/video)
    let card_watch = renderer.pointer("/navigationEndpoint/watchEndpoint")
        .or_else(|| renderer.pointer("/title/runs/0/navigationEndpoint/watchEndpoint"))
        .or_else(|| renderer.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint"));

    let card_watch_video_id = card_watch.and_then(|w| w.get("videoId")).and_then(|v| v.as_str());
    let card_watch_playlist_id = card_watch.and_then(|w| w.get("playlistId")).and_then(|v| v.as_str());

    // 5. Primary card browse endpoint (indicates card clicks to open a playlist, album, or artist)
    let browse_endpoint = renderer.pointer("/navigationEndpoint/browseEndpoint")
        .or_else(|| renderer.pointer("/title/runs/0/navigationEndpoint/browseEndpoint"))
        .or_else(|| renderer.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/browseEndpoint"));

    let browse_id = browse_endpoint.and_then(|b| b.get("browseId")).and_then(|v| v.as_str());
    let browse_page_type = browse_endpoint
        .and_then(|b| b.pointer("/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType"))
        .and_then(|v| v.as_str());

    // 6. Thumbnail overlay (play button on thumbnail)
    let overlay_watch = renderer.pointer("/thumbnailOverlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint")
        .or_else(|| renderer.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint"));

    let overlay_watch_video_id = overlay_watch.and_then(|w| w.get("videoId")).and_then(|v| v.as_str());
    let overlay_watch_playlist_id = overlay_watch.and_then(|w| w.get("playlistId")).and_then(|v| v.as_str());

    let playlist_item_video_id = renderer.pointer("/playlistItemData/videoId").and_then(|v| v.as_str());

    // Resolve playlist ID
    let mut resolved_playlist_id: Option<String> = None;
    let is_playlist_browse = if let Some(bid) = browse_id {
        let is_known_type = browse_page_type == Some("MUSIC_PAGE_TYPE_PLAYLIST")
            || browse_page_type == Some("MUSIC_PAGE_TYPE_ALBUM")
            || browse_page_type == Some("MUSIC_PAGE_TYPE_ARTIST");

        if bid.starts_with("VL") {
            resolved_playlist_id = Some(bid[2..].to_string());
            true
        } else if bid.starts_with("PL")
            || bid.starts_with("RDCL")
            || bid.starts_with("MPRE")
            || bid.starts_with("OLAK")
            || bid.starts_with("FEmusic_")
        {
            resolved_playlist_id = Some(bid.to_string());
            true
        } else if is_known_type {
            resolved_playlist_id = Some(bid.to_string());
            true
        } else {
            false
        }
    } else {
        false
    };

    if resolved_playlist_id.is_none() {
        if let Some(pid) = overlay_watch_playlist_id.or(card_watch_playlist_id) {
            resolved_playlist_id = Some(pid.to_string());
        }
    }

    // Resolve video ID
    let resolved_video_id = card_watch_video_id
        .or(playlist_item_video_id)
        .or(overlay_watch_video_id)
        .unwrap_or("");

    // Determine whether this item is a playlist or a song
    let is_playlist = if is_song_subtitle {
        false
    } else if is_playlist_or_album_subtitle {
        true
    } else if is_playlist_browse {
        true
    } else if card_watch_video_id.is_some() {
        false
    } else if !resolved_video_id.is_empty() && (resolved_playlist_id.is_none() || resolved_playlist_id.as_ref().map(|p| p.starts_with("RDAMVM")).unwrap_or(false)) {
        false
    } else if resolved_playlist_id.is_some() && resolved_video_id.is_empty() {
        true
    } else {
        resolved_video_id.is_empty() && resolved_playlist_id.is_some()
    };

    let item_type = if is_playlist { "playlist" } else { "song" };

    let final_playlist_id = if is_playlist {
        resolved_playlist_id
    } else {
        // If it's a song, only keep playlist_id if it's a real standard playlist (PL...), not an auto-radio mix (RDAMVM...)
        resolved_playlist_id.filter(|p| p.starts_with("PL"))
    };

    if !resolved_video_id.is_empty() || final_playlist_id.is_some() {
        let final_thumb = if !thumb.is_empty() {
            thumb
        } else if !resolved_video_id.is_empty() {
            format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", resolved_video_id)
        } else {
            String::new()
        };

        Some(SearchResult {
            video_id: resolved_video_id.to_string(),
            title,
            artist,
            thumbnail_url: final_thumb,
            playlist_id: final_playlist_id,
            item_type: Some(item_type.to_string()),
            queue_source: None,
        })
    } else {
        None
    }
}

pub(crate) fn extract_continuation_token(value: &serde_json::Value) -> Option<String> {
    // 1. Try direct continuations array
    if let Some(token) = value.pointer("/continuations/0/nextContinuationData/continuation")
        .and_then(|v| v.as_str()) {
        return Some(token.to_string());
    }

    // 2. Try sectionListContinuation
    if let Some(token) = value.pointer("/continuationContents/sectionListContinuation/continuations/0/nextContinuationData/continuation")
        .and_then(|v| v.as_str()) {
        return Some(token.to_string());
    }

    // 3. Try continuationItemRenderer in contents array
    let contents_opt = value.pointer("/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents")
        .or_else(|| value.pointer("/continuationContents/sectionListContinuation/contents"))
        .or_else(|| value.pointer("/contents"))
        .and_then(|v| v.as_array());

    if let Some(contents) = contents_opt {
        for item in contents.iter().rev() {
            if let Some(token) = item.pointer("/continuationItemRenderer/continuationEndpoint/continuationCommand/token")
                .and_then(|v| v.as_str()) {
                return Some(token.to_string());
            }
        }
    }

    None
}

pub(crate) fn parse_shelves(shelves: &[serde_json::Value]) -> Vec<HomeSection> {
    let mut sections = Vec::new();

    for shelf in shelves {
        // Handle itemSectionRenderer wrappers
        if let Some(inner_contents) = shelf.pointer("/itemSectionRenderer/contents").and_then(|v| v.as_array()) {
            let inner_sections = parse_shelves(inner_contents);
            sections.extend(inner_sections);
            continue;
        }

        // 1. Horizontal Carousel Shelves (Featured playlists, Romance Right Now, Quick picks, etc.)
        if let Some(carousel) = shelf.get("musicCarouselShelfRenderer") {
            let section_title = carousel
                .pointer("/header/musicCarouselShelfBasicHeaderRenderer/title/runs/0/text")
                .or_else(|| carousel.pointer("/header/musicCarouselShelfBasicHeaderRenderer/strapline/runs/0/text"))
                .and_then(|v| v.as_str())
                .unwrap_or("Featured");

            let mut items = Vec::new();
            if let Some(carousel_items) = carousel.get("contents").and_then(|v| v.as_array()) {
                for item in carousel_items {
                    if let Some(parsed) = parse_feed_item(item) {
                        items.push(parsed);
                    }
                }
            }

            if !items.is_empty() {
                sections.push(HomeSection {
                    title: section_title.to_string(),
                    items,
                });
            }
        }
        // 2. Vertical Shelves (Songs, Quick picks list, History date groups, etc.)
        else if let Some(music_shelf) = shelf.get("musicShelfRenderer") {
            let section_title = music_shelf
                .pointer("/title/runs/0/text")
                .or_else(|| music_shelf.pointer("/header/musicShelfHeaderRenderer/title/runs/0/text"))
                .or_else(|| music_shelf.pointer("/header/musicHeaderRenderer/title/runs/0/text"))
                .or_else(|| music_shelf.pointer("/bottomEndpoint/searchEndpoint/query"))
                .and_then(|v| v.as_str())
                .unwrap_or("History");

            let mut items = Vec::new();
            if let Some(shelf_items) = music_shelf.get("contents").and_then(|v| v.as_array()) {
                for item in shelf_items {
                    if let Some(parsed) = parse_feed_item(item) {
                        items.push(parsed);
                    }
                }
            }

            if !items.is_empty() {
                sections.push(HomeSection {
                    title: section_title.to_string(),
                    items,
                });
            }
        }
        // 3. Grid Shelves (Library playlists, albums grid, etc.)
        else if let Some(grid) = shelf.get("gridRenderer") {
            let section_title = grid
                .pointer("/header/gridHeaderRenderer/title/runs/0/text")
                .and_then(|v| v.as_str())
                .unwrap_or("Playlists");

            let mut items = Vec::new();
            if let Some(grid_items) = grid.get("items").and_then(|v| v.as_array()) {
                for item in grid_items {
                    if let Some(parsed) = parse_feed_item(item) {
                        items.push(parsed);
                    }
                }
            }

            if !items.is_empty() {
                sections.push(HomeSection {
                    title: section_title.to_string(),
                    items,
                });
            }
        }
    }

    sections
}
