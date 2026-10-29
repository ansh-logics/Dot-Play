//! The lyrics providers, tried in order until one returns lyrics.

use super::matching::{best_lyrics_candidate, clean_query_artist, clean_query_title, json_seconds, urlencoding_lite};
use super::LyricsPayload;
use std::sync::{LazyLock, Mutex};

/// Shared client for every lyrics provider request (same user agent and 3.2 s timeout as
/// the former per-call client), so connections and TLS sessions are reused.
static LYRICS_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent("DotMusic/0.1.0 (https://github.com/dot-music)")
        .timeout(std::time::Duration::from_millis(3200))
        .build()
        .map_err(|e| e.to_string())
});

static LAST_LYRICS_PLUS_MIRROR: Mutex<Option<String>> = Mutex::new(None);

const LYRICS_PLUS_MIRRORS: &[&str] = &[
    "https://lyricsplus.prjktla.my.id",
    "https://lyricsplus.atomix.one",
    "https://lyricsplus.binimum.org",
    "https://lyricsplus.prjktla.workers.dev",
    "https://lyricsplus-seven.vercel.app",
];

pub(super) async fn fetch_lyrics_from_providers(
    reached: &mut bool,
    video_id: Option<String>,
    title: String,
    artist: String,
    album: Option<String>,
    duration: Option<f64>,
) -> Result<Option<LyricsPayload>, String> {
    let client = match &*LYRICS_CLIENT {
        Ok(c) => c,
        Err(e) => return Err(e.clone()),
    };

    let clean_title = clean_query_title(&title);
    let (_clean_artist, primary_artist) = clean_query_artist(&artist);
    let dur_secs = duration.map(|d| d.round() as i64).unwrap_or(0);
    let dur_str = if dur_secs > 0 {
        dur_secs.to_string()
    } else {
        String::new()
    };
    let album_clean = album.unwrap_or_default();

    // -------------------------------------------------------------
    // 1. SimpMusic by YouTube Video ID
    // -------------------------------------------------------------
    if let Some(ref vid) = video_id {
        let clean_vid = vid.trim();
        if !clean_vid.is_empty() {
            let simp_url = format!("https://api-lyrics.simpmusic.org/v1/{}", clean_vid);
            if let Ok(res) = client.get(&simp_url).send().await {
        *reached = true;
                if res.status().is_success() {
                    if let Ok(val) = res.json::<serde_json::Value>().await {
                        let tracks = val
                            .get("data")
                            .and_then(|data| data.as_array())
                            .map(Vec::as_slice)
                            .unwrap_or(&[]);
                        let track = tracks
                            .iter()
                            .filter(|track| {
                                dur_secs <= 0
                                    || json_seconds(track)
                                        .is_some_and(|seconds| (seconds - dur_secs as f64).abs() <= 10.0)
                            })
                            .min_by(|left, right| {
                                let left_distance = json_seconds(left)
                                    .map(|seconds| (seconds - dur_secs as f64).abs())
                                    .unwrap_or(f64::MAX);
                                let right_distance = json_seconds(right)
                                    .map(|seconds| (seconds - dur_secs as f64).abs())
                                    .unwrap_or(f64::MAX);
                                left_distance.total_cmp(&right_distance)
                            });
                        let rich_sync = track
                            .and_then(|value| value.get("richSyncLyrics"))
                            .and_then(|value| value.as_str())
                            .map(str::to_string);
                        let synced = track
                            .and_then(|value| value.get("syncedLyrics"))
                            .and_then(|value| value.as_str())
                            .map(str::to_string);
                        let plain = track
                            .and_then(|value| value.get("plainLyrics").or_else(|| value.get("lyrics")))
                            .and_then(|value| value.as_str())
                            .map(str::to_string);

                        if rich_sync.is_some() || synced.is_some() || plain.is_some() {
                            return Ok(Some(LyricsPayload {
                                source: "SimpMusic".to_string(),
                                isrc: None,
                                ttml: None,
                                synced_lyrics: synced,
                                plain_lyrics: plain,
                                rich_sync_json: rich_sync,
                                instrumental: None,
                            }));
                        }
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------
    // 2. BiniLyrics (Identification / ISRC & TTML)
    // -------------------------------------------------------------
    let mut detected_isrc: Option<String> = None;
    let mut bini_req = client
        .get("https://lyrics-api.binimum.org/")
        .query(&[("track", &clean_title), ("artist", &primary_artist)]);
    if !dur_str.is_empty() {
        bini_req = bini_req.query(&[("duration", &dur_str)]);
    }
    if !album_clean.is_empty() {
        bini_req = bini_req.query(&[("album", &album_clean)]);
    }

    if let Ok(res) = bini_req.send().await {
        *reached = true;
        if res.status().is_success() {
            if let Ok(val) = res.json::<serde_json::Value>().await {
                let results = val
                    .get("results")
                    .and_then(|results| results.as_array())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                if let Some(result) = best_lyrics_candidate(results, &clean_title, &primary_artist, dur_secs) {
                if let Some(isrc_str) = result.get("isrc").and_then(|v| v.as_str()) {
                    if !isrc_str.trim().is_empty() {
                        detected_isrc = Some(isrc_str.trim().to_string());
                    }
                }

                if let Some(ttml_content) = result.get("ttml").and_then(|v| v.as_str()) {
                    if ttml_content.contains("<tt") || ttml_content.contains("<p") {
                        return Ok(Some(LyricsPayload {
                            source: "BiniLyrics".to_string(),
                            isrc: detected_isrc,
                            ttml: Some(ttml_content.to_string()),
                            synced_lyrics: None,
                            plain_lyrics: None,
                            rich_sync_json: None,
                            instrumental: None,
                        }));
                    }
                }

                if let Some(lyrics_url) = result.get("lyricsUrl").and_then(|v| v.as_str()) {
                    if let Ok(l_res) = client.get(lyrics_url).send().await {
        *reached = true;
                        if l_res.status().is_success() {
                            if let Ok(body) = l_res.text().await {
                                if body.contains("<tt") || body.contains("<p") {
                                    return Ok(Some(LyricsPayload {
                                        source: "BiniLyrics".to_string(),
                                        isrc: detected_isrc,
                                        ttml: Some(body),
                                        synced_lyrics: None,
                                        plain_lyrics: None,
                                        rich_sync_json: None,
                                        instrumental: None,
                                    }));
                                }
                            }
                        }
                    }
                }
                }
            }
        }
    }

    // -------------------------------------------------------------
    // 3. lrc.red (Apple-style TTML / Syllable timing by ISRC or search)
    // -------------------------------------------------------------
    let mut isrc_to_try = detected_isrc.clone();
    if isrc_to_try.is_none() {
        let lrc_search_url = format!(
            "https://lrc.red/search.json?q={}%20{}",
            urlencoding_lite(&clean_title),
            urlencoding_lite(&primary_artist)
        );
        if let Ok(res) = client.get(&lrc_search_url).send().await {
        *reached = true;
            if res.status().is_success() {
                if let Ok(val) = res.json::<serde_json::Value>().await {
                    let items = val
                        .get("hits")
                        .and_then(|hits| hits.as_array())
                        .or_else(|| val.as_array())
                        .map(Vec::as_slice)
                        .unwrap_or(&[]);
                    if let Some(first_match) = best_lyrics_candidate(items, &clean_title, &primary_artist, dur_secs) {
                        if let Some(i_val) = first_match.get("isrc").and_then(|v| v.as_str()) {
                            isrc_to_try = Some(i_val.to_string());
                        }
                    }
                }
            }
        }
    }

    if let Some(ref isrc) = isrc_to_try {
        let ttml_url = format!("https://lrc.red/s/{}.ttml", isrc);
        if let Ok(res) = client.get(&ttml_url).send().await {
        *reached = true;
            if res.status().is_success() {
                if let Ok(body) = res.text().await {
                    if body.contains("<tt") || body.contains("<p") {
                        return Ok(Some(LyricsPayload {
                            source: "lrc.red".to_string(),
                            isrc: Some(isrc.clone()),
                            ttml: Some(body),
                            synced_lyrics: None,
                            plain_lyrics: None,
                            rich_sync_json: None,
                            instrumental: None,
                        }));
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------
    // 4. BetterLyrics & QQ Karaoke
    // -------------------------------------------------------------
    let mut bl_req = client
        .get("https://lyrics-api.boidu.dev/getLyrics")
        .query(&[("s", &clean_title), ("a", &primary_artist)]);
    if !dur_str.is_empty() {
        bl_req = bl_req.query(&[("d", &dur_str)]);
    }
    if !album_clean.is_empty() {
        bl_req = bl_req.query(&[("al", &album_clean)]);
    }

    if let Ok(res) = bl_req.send().await {
        *reached = true;
        if res.status().is_success() {
            if let Ok(val) = res.json::<serde_json::Value>().await {
                let ttml = val
                    .get("ttml")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let synced = val
                    .get("syncedLyrics")
                    .or_else(|| val.get("karaoke"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let plain = val
                    .get("lyrics")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                if ttml.is_some() || synced.is_some() || plain.is_some() {
                    return Ok(Some(LyricsPayload {
                        source: "BetterLyrics".to_string(),
                        isrc: detected_isrc,
                        ttml,
                        synced_lyrics: synced,
                        plain_lyrics: plain,
                        rich_sync_json: None,
                        instrumental: None,
                    }));
                }
            }
        }
    }

    // -------------------------------------------------------------
    // 5. LyricsPlus Mirrors (with last-working-mirror cache)
    // -------------------------------------------------------------
    let mut mirror_candidates = Vec::new();
    if let Ok(guard) = LAST_LYRICS_PLUS_MIRROR.lock() {
        if let Some(ref m) = *guard {
            mirror_candidates.push(m.clone());
        }
    }
    for &m in LYRICS_PLUS_MIRRORS {
        if !mirror_candidates.iter().any(|existing| existing == m) {
            mirror_candidates.push(m.to_string());
        }
    }

    for mirror in mirror_candidates {
        let ep = format!("{}/v2/lyrics/get", mirror);
        let mut lp_req = client
            .get(&ep)
            .query(&[("title", &clean_title), ("artist", &primary_artist)]);
        if !dur_str.is_empty() {
            lp_req = lp_req.query(&[("duration", &dur_str)]);
        }
        if let Some(ref i) = detected_isrc {
            lp_req = lp_req.query(&[("isrc", i)]);
        }

        if let Ok(res) = lp_req.send().await {
        *reached = true;
            if res.status().is_success() {
                if let Ok(val) = res.json::<serde_json::Value>().await {
                    let ttml = val
                        .get("ttml")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let synced = val
                        .get("syncedLyrics")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let plain = val
                        .get("lyrics")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    if ttml.is_some() || synced.is_some() || plain.is_some() {
                        if let Ok(mut guard) = LAST_LYRICS_PLUS_MIRROR.lock() {
                            *guard = Some(mirror);
                        }
                        return Ok(Some(LyricsPayload {
                            source: "LyricsPlus".to_string(),
                            isrc: detected_isrc,
                            ttml,
                            synced_lyrics: synced,
                            plain_lyrics: plain,
                            rich_sync_json: None,
                            instrumental: None,
                        }));
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------
    // 6. Unison Fallback
    // -------------------------------------------------------------
    let mut uni_req = client
        .get("https://unison.boidu.dev/lyrics")
        .query(&[("song", &clean_title), ("artist", &primary_artist)]);
    if !dur_str.is_empty() {
        uni_req = uni_req.query(&[("duration", &dur_str)]);
    }

    if let Ok(res) = uni_req.send().await {
        *reached = true;
        if res.status().is_success() {
            if let Ok(val) = res.json::<serde_json::Value>().await {
                let synced = val
                    .get("syncedLyrics")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let plain = val
                    .get("lyrics")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                if synced.is_some() || plain.is_some() {
                    return Ok(Some(LyricsPayload {
                        source: "Unison".to_string(),
                        isrc: detected_isrc,
                        ttml: None,
                        synced_lyrics: synced,
                        plain_lyrics: plain,
                        rich_sync_json: None,
                        instrumental: None,
                    }));
                }
            }
        }
    }

    Ok(None)
}
