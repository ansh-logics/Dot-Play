//! Importing playlists from other services. A public playlist or album link (Spotify,
//! Apple Music, Deezer) or a pasted list of songs is read into an `ExternalPlaylist`, each
//! song is matched to a YouTube Music song, and the result is kept on this Mac in
//! `imported_playlists.json`. Only public pages are read; no other account is involved.

use crate::search::{search_songs, SongHit};
use crate::ytmusic::parse::find_ascii_ci;
use crate::ytmusic::{HTTP_CLIENT, SAFARI_USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Pasted lists longer than this are cut off.
const MAX_TEXT_LINES: usize = 500;
/// Deezer playlists are read in pages; this caps a single import.
const MAX_DEEZER_TRACKS: usize = 1000;
/// A candidate needs at least this score to count as the same song.
const MATCH_THRESHOLD: f32 = 0.62;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExternalTrack {
    pub title: String,
    pub artist: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPlaylist {
    /// "spotify", "apple", "deezer" or "text".
    pub source: String,
    pub source_url: String,
    /// "Playlist" or "Album".
    pub kind: String,
    pub title: String,
    pub description: String,
    pub owner: String,
    pub cover_url: String,
    /// How many songs the source says it has, when it shares more than it lists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
    pub tracks: Vec<ExternalTrack>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackMatch {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub thumbnail_url: String,
    pub duration: String,
    pub confidence: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    #[serde(flatten)]
    pub source: ExternalTrack,
    #[serde(rename = "match", default)]
    pub matched: Option<TrackMatch>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalPlaylist {
    pub id: String,
    pub source: String,
    pub source_url: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub owner: String,
    /// The cover as a data URL once saved, so it outlives the original.
    pub cover: String,
    pub imported_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
    pub tracks: Vec<LocalTrack>,
}

// ---------------------------------------------------------------------------------------
// Reading the source

#[tauri::command]
pub(crate) async fn fetch_external_playlist(input: String) -> Result<ExternalPlaylist, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Paste a playlist link or a list of songs".into());
    }
    let looks_like_link = !input.contains('\n') && (input.starts_with("http") || input.starts_with("spotify:"));
    if !looks_like_link {
        return parse_text_list(input);
    }

    let url = resolve_short_link(input).await?;
    if let Some((kind, id)) = spotify_target(&url) {
        let html = fetch_page(&format!("https://open.spotify.com/embed/{kind}/{id}")).await?;
        return parse_spotify_embed(&html, &format!("https://open.spotify.com/{kind}/{id}"));
    }
    if let Some((kind, id)) = deezer_target(&url) {
        return fetch_deezer(kind, id).await;
    }
    if url.contains("music.apple.com/") {
        let html = fetch_page(&url).await?;
        return parse_apple_page(&html, &url);
    }
    Err("That link isn't from Spotify, Apple Music, Deezer or YouTube".into())
}

/// Share links (spotify.link, deezer.page.link) redirect to the real page.
async fn resolve_short_link(input: &str) -> Result<String, String> {
    let short = ["spotify.link", "spotify.app.link", "deezer.page.link", "link.deezer.com"];
    if !short.iter().any(|host| input.contains(host)) {
        return Ok(input.to_string());
    }
    let res = HTTP_CLIENT
        .get(input)
        .header(reqwest::header::USER_AGENT, SAFARI_USER_AGENT)
        .send()
        .await
        .map_err(|_| "Couldn't open that link")?;
    Ok(res.url().to_string())
}

async fn fetch_page(url: &str) -> Result<String, String> {
    let res = HTTP_CLIENT
        .get(url)
        .header(reqwest::header::USER_AGENT, SAFARI_USER_AGENT)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|_| "Couldn't reach the playlist. Check your connection.")?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("That playlist doesn't exist or isn't public".into());
    }
    if !res.status().is_success() {
        return Err(format!("The playlist page answered with {}", res.status()));
    }
    res.text().await.map_err(|_| "Couldn't read the playlist page".to_string())
}

/// The JSON inside `<script id="{id}" ...>…</script>`.
fn script_json(html: &str, id: &str) -> Option<Value> {
    let start = html.find(&format!("id=\"{id}\""))?;
    let open = start + html[start..].find('>')? + 1;
    let close = open + html[open..].find("</script>")?;
    serde_json::from_str(&html[open..close]).ok()
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

/// `open.spotify.com/(intl-xx/)playlist/{id}` or `spotify:album:{id}` → ("playlist", id).
fn spotify_target(url: &str) -> Option<(&'static str, String)> {
    let rest = if let Some(rest) = url.strip_prefix("spotify:") {
        rest.replacen(':', "/", 1)
    } else {
        let idx = url.find("open.spotify.com/")?;
        url[idx + "open.spotify.com/".len()..].to_string()
    };
    let mut parts = rest.split('/').filter(|p| !p.is_empty() && !p.starts_with("intl-") && *p != "embed");
    let kind = match parts.next()? {
        "playlist" => "playlist",
        "album" => "album",
        _ => return None,
    };
    let id: String = parts.next()?.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    (!id.is_empty()).then_some((kind, id))
}

fn parse_spotify_embed(html: &str, source_url: &str) -> Result<ExternalPlaylist, String> {
    let data = script_json(html, "__NEXT_DATA__").ok_or("Spotify didn't share this playlist. Is it public?")?;
    let entity = data
        .pointer("/props/pageProps/state/data/entity")
        .ok_or("Spotify didn't share this playlist. Is it public?")?;
    let kind = if str_at(entity, "/type") == "album" { "Album" } else { "Playlist" };
    let cover_url = entity
        .pointer("/coverArt/sources")
        .and_then(Value::as_array)
        .and_then(|sources| {
            sources
                .iter()
                .max_by_key(|s| s.get("width").and_then(Value::as_u64).unwrap_or(0))
        })
        .map(|s| str_at(s, "/url").to_string())
        .unwrap_or_default();
    let tracks: Vec<ExternalTrack> = entity
        .get("trackList")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|t| str_at(t, "/entityType").is_empty() || str_at(t, "/entityType") == "track")
                .map(|t| ExternalTrack {
                    title: str_at(t, "/title").to_string(),
                    artist: str_at(t, "/subtitle").to_string(),
                    album: None,
                    duration_ms: t.get("duration").and_then(Value::as_u64),
                    cover_url: None,
                })
                .filter(|t| !t.title.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if tracks.is_empty() {
        return Err("This Spotify playlist has no songs we can read".into());
    }
    Ok(ExternalPlaylist {
        source: "spotify".into(),
        source_url: source_url.to_string(),
        kind: kind.into(),
        title: entity.get("name").or_else(|| entity.get("title")).and_then(Value::as_str).unwrap_or("Spotify playlist").to_string(),
        description: str_at(entity, "/description").to_string(),
        owner: str_at(entity, "/subtitle").to_string(),
        cover_url,
        // The embed lists at most 100 songs and doesn't say how many more there are.
        total: None,
        tracks,
    })
}

/// `deezer.com/(xx/)playlist/{id}` → ("playlist", id).
fn deezer_target(url: &str) -> Option<(&'static str, String)> {
    let idx = url.find("deezer.com/")?;
    let mut parts = url[idx + "deezer.com/".len()..].split('/');
    loop {
        let kind = match parts.next()? {
            "playlist" => "playlist",
            "album" => "album",
            _ => continue,
        };
        let id: String = parts.next()?.chars().take_while(|c| c.is_ascii_digit()).collect();
        return (!id.is_empty()).then_some((kind, id));
    }
}

async fn deezer_json(url: &str) -> Result<Value, String> {
    let json: Value = HTTP_CLIENT
        .get(url)
        .send()
        .await
        .map_err(|_| "Couldn't reach Deezer. Check your connection.")?
        .json()
        .await
        .map_err(|_| "Couldn't read Deezer's answer")?;
    if json.get("error").is_some() {
        return Err("That Deezer playlist doesn't exist or isn't public".into());
    }
    Ok(json)
}

fn deezer_track(t: &Value, album_cover: &str) -> ExternalTrack {
    let cover = str_at(t, "/album/cover_medium");
    ExternalTrack {
        title: str_at(t, "/title").to_string(),
        artist: str_at(t, "/artist/name").to_string(),
        album: Some(str_at(t, "/album/title").to_string()).filter(|a| !a.is_empty()),
        duration_ms: t.get("duration").and_then(Value::as_u64).map(|s| s * 1000),
        cover_url: Some(if cover.is_empty() { album_cover } else { cover }.to_string()).filter(|c| !c.is_empty()),
    }
}

async fn fetch_deezer(kind: &str, id: String) -> Result<ExternalPlaylist, String> {
    let head = deezer_json(&format!("https://api.deezer.com/{kind}/{id}")).await?;
    let cover = head
        .get("picture_xl")
        .or_else(|| head.get("cover_xl"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let album_cover = str_at(&head, "/cover_medium").to_string();
    let mut tracks: Vec<ExternalTrack> = Vec::new();
    let total = head.get("nb_tracks").and_then(Value::as_u64).unwrap_or(0) as usize;
    let first_page = head.pointer("/tracks/data").and_then(Value::as_array).cloned().unwrap_or_default();
    tracks.extend(first_page.iter().map(|t| deezer_track(t, &album_cover)));
    // Long playlists come in pages of 100 or more after the first.
    while tracks.len() < total.min(MAX_DEEZER_TRACKS) {
        let page = deezer_json(&format!("https://api.deezer.com/{kind}/{id}/tracks?index={}&limit=100", tracks.len())).await?;
        let items = page.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        if items.is_empty() {
            break;
        }
        tracks.extend(items.iter().map(|t| deezer_track(t, &album_cover)));
    }
    tracks.retain(|t| !t.title.is_empty());
    if tracks.is_empty() {
        return Err("This Deezer playlist has no songs".into());
    }
    let owner = head
        .pointer("/creator/name")
        .or_else(|| head.pointer("/artist/name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(ExternalPlaylist {
        source: "deezer".into(),
        source_url: str_at(&head, "/link").to_string(),
        kind: if kind == "album" { "Album" } else { "Playlist" }.into(),
        title: str_at(&head, "/title").to_string(),
        description: str_at(&head, "/description").to_string(),
        owner,
        cover_url: cover,
        total: (total > tracks.len()).then_some(total as u32),
        tracks,
    })
}

/// Apple's artwork URLs are templates: `…/{w}x{h}{c}.{f}`.
fn apple_artwork(item: &Value, size: u32) -> String {
    let template = str_at(item, "/artwork/dictionary/url");
    template
        .replace("{w}", &size.to_string())
        .replace("{h}", &size.to_string())
        .replace("{c}", "bb")
        .replace("{f}", "jpg")
}

fn parse_apple_page(html: &str, source_url: &str) -> Result<ExternalPlaylist, String> {
    let data = script_json(html, "serialized-server-data").ok_or("Apple Music didn't share this playlist. Is it public?")?;
    let sections = data
        .pointer("/data/0/data/sections")
        .and_then(Value::as_array)
        .ok_or("Apple Music didn't share this playlist. Is it public?")?;
    let header = sections
        .iter()
        .find(|s| str_at(s, "/itemKind").ends_with("HeaderLockup"))
        .and_then(|s| s.pointer("/items/0"))
        .ok_or("Apple Music didn't share this playlist. Is it public?")?;
    let owner = str_at(header, "/subtitleLinks/0/title").to_string();
    let cover_url = apple_artwork(header, 1000);
    let tracks: Vec<ExternalTrack> = sections
        .iter()
        .filter(|s| str_at(s, "/itemKind") == "trackLockup")
        .filter_map(|s| s.get("items").and_then(Value::as_array))
        .flatten()
        .map(|t| {
            let artist = t.get("artistName").and_then(Value::as_str).unwrap_or(&owner).to_string();
            let cover = apple_artwork(t, 300);
            ExternalTrack {
                title: str_at(t, "/title").to_string(),
                artist,
                album: Some(str_at(t, "/tertiaryLinks/0/title").to_string()).filter(|a| !a.is_empty()),
                duration_ms: t.get("duration").and_then(Value::as_u64),
                cover_url: Some(cover).filter(|c| !c.is_empty()),
            }
        })
        .filter(|t| !t.title.is_empty())
        .collect();
    if tracks.is_empty() {
        return Err("This Apple Music playlist has no songs we can read".into());
    }
    let total = header.get("trackCount").and_then(Value::as_u64).map(|n| n as u32);
    let is_album = source_url.contains("/album/");
    Ok(ExternalPlaylist {
        source: "apple".into(),
        source_url: source_url.to_string(),
        kind: if is_album { "Album" } else { "Playlist" }.into(),
        title: str_at(header, "/title").to_string(),
        description: String::new(),
        owner,
        cover_url,
        total: total.filter(|&n| n as usize > tracks.len()),
        tracks,
    })
}

/// Drops a list number ("1. ", "12) ") from the start of a line, but keeps numbers that belong to
/// the song: "50 Cent - In Da Club", "3 Doors Down - Kryptonite", "22".
fn strip_list_number(line: &str) -> &str {
    let digits = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 || digits > 4 {
        return line;
    }
    match line[digits..].strip_prefix(['.', ')']) {
        Some(rest) if rest.is_empty() || rest.starts_with(char::is_whitespace) => rest.trim_start(),
        _ => line,
    }
}

/// One song per line: "Artist - Title", "Title by Artist", or just a title.
fn parse_text_list(input: &str) -> Result<ExternalPlaylist, String> {
    let tracks: Vec<ExternalTrack> = input
        .lines()
        .map(|line| strip_list_number(line.trim()))
        .filter(|line| !line.is_empty())
        .take(MAX_TEXT_LINES)
        .map(|line| {
            let (artist, title) = [" - ", " – ", " — "]
                .iter()
                .find_map(|sep| line.split_once(sep))
                .or_else(|| line.rsplit_once(" by ").map(|(t, a)| (a, t)))
                .unwrap_or(("", line));
            ExternalTrack {
                title: title.trim().to_string(),
                artist: artist.trim().to_string(),
                album: None,
                duration_ms: None,
                cover_url: None,
            }
        })
        .collect();
    if tracks.is_empty() {
        return Err("Paste a playlist link or a list of songs".into());
    }
    Ok(ExternalPlaylist {
        source: "text".into(),
        source_url: String::new(),
        kind: "Playlist".into(),
        title: "Imported Songs".into(),
        description: String::new(),
        owner: String::new(),
        cover_url: String::new(),
        total: None,
        tracks,
    })
}

// ---------------------------------------------------------------------------------------
// Matching to YouTube Music

/// Lowercase letters and digits of any script, single-spaced.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = true;
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    }
    out.trim_end().to_string()
}

/// The title without bracketed notes or " - Remastered 2011"-style tails.
fn core_title(title: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in title.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    for marker in [" - ", " – ", " feat. ", " feat ", " ft. ", " with "] {
        if let Some(idx) = find_ascii_ci(&out, marker) {
            // "Artist - Title" (a video title) keeps the part after the dash.
            if marker.contains('-') || marker.contains('–') {
                let (head, tail) = out.split_at(idx);
                let tail = &tail[marker.len()..];
                let tail_core = normalize(tail);
                let is_note = ["remaster", "version", "edit", "mix", "live", "mono", "stereo", "from", "single"]
                    .iter()
                    .any(|w| tail_core.contains(w));
                out = if is_note { head.to_string() } else { tail.to_string() };
            } else {
                out.truncate(idx);
            }
            break;
        }
    }
    normalize(&out)
}

/// Words that mark a different recording of the same song.
const VARIANT_WORDS: [&str; 9] = ["live", "remix", "acoustic", "instrumental", "karaoke", "cover", "sped up", "slowed", "8d"];

fn variants(text: &str) -> Vec<&'static str> {
    let text = normalize(text);
    VARIANT_WORDS
        .iter()
        .copied()
        .filter(|w| text.split(' ').collect::<Vec<_>>().windows(w.split(' ').count()).any(|win| win.join(" ") == *w))
        .collect()
}

/// Dice similarity of character pairs, so it works with or without spaces between words.
fn similarity(a: &str, b: &str) -> f32 {
    let pairs = |s: &str| -> Vec<(char, char)> {
        let chars: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).collect();
        if chars.len() == 1 {
            return vec![(chars[0], ' ')];
        }
        chars.windows(2).map(|w| (w[0], w[1])).collect()
    };
    let (pa, mut pb) = (pairs(a), pairs(b));
    if pa.is_empty() || pb.is_empty() {
        return 0.0;
    }
    let total = (pa.len() + pb.len()) as f32;
    let mut shared = 0;
    for pair in &pa {
        if let Some(pos) = pb.iter().position(|p| p == pair) {
            pb.swap_remove(pos);
            shared += 1;
        }
    }
    2.0 * shared as f32 / total
}

fn artist_names(artist: &str) -> Vec<String> {
    let mut text = artist.to_string();
    for sep in [" feat. ", " feat ", " ft. ", " & ", " and ", " x ", " X ", ";", "/"] {
        text = text.replace(sep, ",");
    }
    text.split(',').map(normalize).filter(|a| !a.is_empty()).collect()
}

fn parse_duration_text(text: &str) -> Option<u64> {
    text.split(':').try_fold(0u64, |total, part| part.parse::<u64>().ok().map(|n| total * 60 + n))
}

/// How sure we are that `hit` is the source song, from 0 to about 1.
fn score(source: &ExternalTrack, hit: &SongHit, rank: usize) -> f32 {
    let candidate = &hit.result;
    let source_core = core_title(&source.title);
    let candidate_core = core_title(&candidate.title);
    let mut title = similarity(&source_core, &candidate_core);
    if !source_core.is_empty() && (candidate_core.contains(&source_core) || source_core.contains(&candidate_core)) {
        title = title.max(0.9);
    }

    let names = artist_names(&source.artist);
    let artist = if names.is_empty() {
        0.5
    } else {
        let haystack = normalize(&format!("{} {}", candidate.artist, candidate.title));
        let found = names
            .iter()
            .filter(|name| haystack.contains(name.as_str()) || similarity(name, &normalize(&candidate.artist)) > 0.7)
            .count();
        found as f32 / names.len() as f32
    };

    let mut total = 0.6 * title + 0.35 * artist;
    if let (Some(ms), Some(text)) = (source.duration_ms, hit.duration.as_deref()) {
        if let Some(secs) = parse_duration_text(text) {
            let diff = (ms / 1000).abs_diff(secs);
            total += match diff {
                0..=3 => 0.12,
                4..=8 => 0.05,
                9..=15 => 0.0,
                16..=40 => -0.2,
                _ => -0.45,
            };
        }
    }
    // A live or remixed version is a different recording unless the source asked for one.
    if variants(&candidate.title) != variants(&source.title) {
        total -= 0.3;
    }
    if rank == 0 {
        total += 0.03;
    }
    total
}

fn best_match(source: &ExternalTrack, hits: &[SongHit]) -> Option<(f32, usize)> {
    hits.iter()
        .enumerate()
        .map(|(rank, hit)| (score(source, hit, rank), rank))
        .max_by(|a, b| a.0.total_cmp(&b.0))
}

#[tauri::command]
pub(crate) async fn match_track(track: ExternalTrack) -> Result<Option<TrackMatch>, String> {
    let queries = [
        format!("{} {}", core_title(&track.title), track.artist.split(',').next().unwrap_or("")),
        track.title.clone(),
    ];
    let mut best: Option<(f32, SongHit)> = None;
    for query in queries.iter().filter(|q| !q.trim().is_empty()) {
        let hits = search_songs(query).await?;
        if let Some((value, rank)) = best_match(&track, &hits) {
            if best.as_ref().is_none_or(|(b, _)| value > *b) {
                best = hits.into_iter().nth(rank).map(|hit| (value, hit));
            }
        }
        if best.as_ref().is_some_and(|(b, _)| *b >= MATCH_THRESHOLD) {
            break;
        }
    }
    Ok(best.filter(|(value, _)| *value >= MATCH_THRESHOLD).map(|(value, hit)| TrackMatch {
        video_id: hit.result.video_id,
        title: hit.result.title,
        artist: hit.result.artist,
        thumbnail_url: hit.result.thumbnail_url,
        duration: hit.duration.unwrap_or_default(),
        confidence: value.min(1.0),
    }))
}

// ---------------------------------------------------------------------------------------
// The local store

static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("imported_playlists.json"))
        .map_err(|_| "Could not access the app data folder".to_string())
}

fn read_store(app: &AppHandle) -> Result<Vec<LocalPlaylist>, String> {
    let path = store_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(list) => Ok(list),
            Err(e) => {
                // Keep the unreadable file for recovery, and start a fresh list so imports keep
                // working instead of failing forever.
                let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                let backup = path.with_file_name(format!("imported_playlists.corrupt-{stamp}.json"));
                log::warn!("imported_playlists.json couldn't be read ({e}); moved it to {}", backup.display());
                std::fs::rename(&path, &backup).map_err(|e| format!("Your imported playlists couldn't be read: {e}"))?;
                Ok(Vec::new())
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Couldn't read imported playlists: {e}")),
    }
}

fn write_store(app: &AppHandle, playlists: &[LocalPlaylist]) -> Result<(), String> {
    let data = serde_json::to_vec(playlists).map_err(|e| e.to_string())?;
    crate::fsutil::write_atomic(&store_path(app)?, &data, false).map_err(|e| format!("Couldn't save the playlist: {e}"))
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The cover as a data URL; the original URL if it can't be downloaded.
async fn keep_cover(url: &str) -> String {
    if url.is_empty() || url.starts_with("data:") {
        return url.to_string();
    }
    const MAX_COVER_BYTES: usize = 4_000_000;
    let Ok(res) = HTTP_CLIENT.get(url).send().await else { return url.to_string() };
    // An error page saved as a "cover" would replace a working link with a broken image.
    if !res.status().is_success() || res.content_length().is_some_and(|n| n as usize >= MAX_COVER_BYTES) {
        return url.to_string();
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|m| m.starts_with("image/"))
        .unwrap_or("image/jpeg")
        .to_string();
    match res.bytes().await {
        Ok(bytes) if !bytes.is_empty() && bytes.len() < MAX_COVER_BYTES => format!("data:{mime};base64,{}", base64(&bytes)),
        _ => url.to_string(),
    }
}

#[tauri::command]
pub(crate) async fn list_local_playlists(app: AppHandle) -> Result<Vec<LocalPlaylist>, String> {
    let _guard = STORE_LOCK.lock().await;
    let mut list = read_store(&app)?;
    list.sort_by(|a, b| b.imported_at.cmp(&a.imported_at));
    Ok(list)
}

#[tauri::command]
pub(crate) async fn get_local_playlist(app: AppHandle, id: String) -> Result<LocalPlaylist, String> {
    let _guard = STORE_LOCK.lock().await;
    read_store(&app)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "That imported playlist was deleted".to_string())
}

/// Saves a new import (empty `id`) or replaces an existing one; returns it as stored.
#[tauri::command]
pub(crate) async fn save_local_playlist(app: AppHandle, mut playlist: LocalPlaylist) -> Result<LocalPlaylist, String> {
    playlist.cover = keep_cover(&playlist.cover).await;
    let _guard = STORE_LOCK.lock().await;
    let mut list = read_store(&app)?;
    if playlist.id.is_empty() {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        playlist.id = format!("local:{now:x}");
        playlist.imported_at = now;
    }
    match list.iter_mut().find(|p| p.id == playlist.id) {
        Some(existing) => *existing = playlist.clone(),
        None => list.push(playlist.clone()),
    }
    write_store(&app, &list)?;
    Ok(playlist)
}

#[tauri::command]
pub(crate) async fn delete_local_playlist(app: AppHandle, id: String) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().await;
    let mut list = read_store(&app)?;
    list.retain(|p| p.id != id);
    write_store(&app, &list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_numbers_are_dropped_but_song_numbers_kept() {
        let list = parse_text_list("1. Daft Punk - One More Time\n12) Adele - Hello\n50 Cent - In Da Club\n3 Doors Down - Kryptonite\n22\n7 rings").unwrap();
        let pairs: Vec<(&str, &str)> = list.tracks.iter().map(|t| (t.artist.as_str(), t.title.as_str())).collect();
        assert_eq!(
            pairs,
            [
                ("Daft Punk", "One More Time"),
                ("Adele", "Hello"),
                ("50 Cent", "In Da Club"),
                ("3 Doors Down", "Kryptonite"),
                ("", "22"),
                ("", "7 rings"),
            ]
        );
    }

    use crate::models::SearchResult;

    fn hit(title: &str, artist: &str, duration: &str) -> SongHit {
        SongHit {
            result: SearchResult {
                video_id: "v".into(),
                title: title.into(),
                artist: artist.into(),
                thumbnail_url: String::new(),
                playlist_id: None,
                item_type: None,
                queue_source: None,
            },
            duration: Some(duration.into()),
        }
    }

    fn track(title: &str, artist: &str, secs: u64) -> ExternalTrack {
        ExternalTrack { title: title.into(), artist: artist.into(), album: None, duration_ms: Some(secs * 1000), cover_url: None }
    }

    #[test]
    fn links_are_recognised() {
        assert_eq!(spotify_target("https://open.spotify.com/intl-de/playlist/37i9dQZF1DX5Ejj0EkURtP?si=abc"), Some(("playlist", "37i9dQZF1DX5Ejj0EkURtP".into())));
        assert_eq!(spotify_target("spotify:album:4aawyAB9vmqN3uQ7FjRGTy"), Some(("album", "4aawyAB9vmqN3uQ7FjRGTy".into())));
        assert_eq!(spotify_target("https://open.spotify.com/track/abc"), None);
        assert_eq!(deezer_target("https://www.deezer.com/us/playlist/3155776842"), Some(("playlist", "3155776842".into())));
        assert_eq!(deezer_target("https://www.deezer.com/album/302127?utm=x"), Some(("album", "302127".into())));
    }

    #[test]
    fn remaster_suffix_still_matches() {
        let source = track("Here Comes The Sun - Remastered 2009", "The Beatles", 185);
        assert!(score(&source, &hit("Here Comes The Sun (Remastered 2009)", "The Beatles", "3:06"), 0) >= MATCH_THRESHOLD);
    }

    #[test]
    fn feat_credit_still_matches() {
        let source = track("Stay (with Justin Bieber)", "The Kid LAROI, Justin Bieber", 141);
        assert!(score(&source, &hit("STAY", "The Kid LAROI & Justin Bieber", "2:22"), 0) >= MATCH_THRESHOLD);
    }

    #[test]
    fn video_title_with_artist_prefix_matches() {
        let source = track("Blinding Lights", "The Weeknd", 200);
        assert!(score(&source, &hit("The Weeknd - Blinding Lights (Official Video)", "The Weeknd", "4:22"), 1) >= MATCH_THRESHOLD - 0.25);
    }

    #[test]
    fn wrong_length_and_live_versions_lose() {
        let source = track("Yellow", "Coldplay", 266);
        let studio = score(&source, &hit("Yellow", "Coldplay", "4:27"), 1);
        let live = score(&source, &hit("Yellow (Live)", "Coldplay", "5:10"), 0);
        assert!(studio > live);
        assert!(live < MATCH_THRESHOLD);
    }

    #[test]
    fn non_latin_titles_match() {
        let source = track("夜に駆ける", "YOASOBI", 261);
        assert!(score(&source, &hit("夜に駆ける", "YOASOBI", "4:21"), 0) >= MATCH_THRESHOLD);
        assert!(score(&source, &hit("群青", "YOASOBI", "4:08"), 0) < MATCH_THRESHOLD);
    }

    #[test]
    fn text_lists_parse() {
        let list = parse_text_list("1. Daft Punk - One More Time\nHello by Adele\n\nJust A Title").unwrap();
        assert_eq!(list.tracks.len(), 3);
        assert_eq!((list.tracks[0].artist.as_str(), list.tracks[0].title.as_str()), ("Daft Punk", "One More Time"));
        assert_eq!((list.tracks[1].artist.as_str(), list.tracks[1].title.as_str()), ("Adele", "Hello"));
        assert_eq!(list.tracks[2].artist, "");
    }

    #[test]
    fn spotify_embed_parses() {
        let html = r#"<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"type":"playlist","name":"Mix","subtitle":"Someone","coverArt":{"sources":[{"url":"https://i.scdn.co/a","width":300},{"url":"https://i.scdn.co/b","width":640}]},"trackList":[{"title":"Song","subtitle":"Artist","duration":200000,"entityType":"track"}]}}}}}}</script></html>"#;
        let p = parse_spotify_embed(html, "https://open.spotify.com/playlist/x").unwrap();
        assert_eq!((p.title.as_str(), p.owner.as_str(), p.cover_url.as_str()), ("Mix", "Someone", "https://i.scdn.co/b"));
        assert_eq!(p.tracks[0].duration_ms, Some(200000));
    }

    #[test]
    fn apple_page_parses() {
        let html = r#"<script type="application/json" id="serialized-server-data">{"data":[{"data":{"sections":[{"itemKind":"containerDetailHeaderLockup","items":[{"title":"Hits","trackCount":80,"subtitleLinks":[{"title":"Apple Music"}],"artwork":{"dictionary":{"url":"https://is1.mzstatic.com/x/{w}x{h}{c}.{f}"}}}]},{"itemKind":"trackLockup","items":[{"title":"Song","artistName":"Artist","duration":218389,"tertiaryLinks":[{"title":"Album"}],"artwork":{"dictionary":{"url":"https://is1.mzstatic.com/y/{w}x{h}{c}.{f}"}}}]}]}}]}</script>"#;
        let p = parse_apple_page(html, "https://music.apple.com/us/playlist/hits/pl.x").unwrap();
        assert_eq!(p.cover_url, "https://is1.mzstatic.com/x/1000x1000bb.jpg");
        assert_eq!(p.total, Some(80));
        assert_eq!(p.tracks[0].album.as_deref(), Some("Album"));
        assert_eq!(p.tracks[0].cover_url.as_deref(), Some("https://is1.mzstatic.com/y/300x300bb.jpg"));
    }

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
    }
}
