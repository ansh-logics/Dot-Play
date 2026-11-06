//! The lyrics providers. They are asked at the same time, and the answer from the
//! highest-ranked provider that has the song wins, so a slow or dead provider can't hold
//! the lookup for long.

use super::matching::{best_lyrics_candidate, clean_query_artist, clean_query_title, json_seconds, urlencoding_lite};
use super::LyricsPayload;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Shared client for every lyrics provider request, so connections and TLS sessions are
/// reused. Each request gives up after 3.2 s.
static LYRICS_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent("DotMusic/0.1.0 (https://github.com/dot-music)")
        .timeout(Duration::from_millis(3200))
        .build()
        .map_err(|e| e.to_string())
});

/// The whole lookup ends after this; whatever the best answer is by then is used.
const LOOKUP_DEADLINE: Duration = Duration::from_secs(6);

static LAST_LYRICS_PLUS_MIRROR: Mutex<Option<String>> = Mutex::new(None);

const LYRICS_PLUS_MIRRORS: &[&str] = &[
    "https://lyricsplus.prjktla.my.id",
    "https://lyricsplus.atomix.one",
    "https://lyricsplus.binimum.org",
    "https://lyricsplus.prjktla.workers.dev",
    "https://lyricsplus-seven.vercel.app",
];

/// A provider "answered" when it replied with lyrics or a definite "not found"; rate
/// limits and server errors don't count, so the miss isn't cached for days.
fn answered(status: reqwest::StatusCode) -> bool {
    status.is_success() || status == reqwest::StatusCode::NOT_FOUND
}

/// What one provider found, and whether it answered at all.
#[derive(Default)]
struct Outcome {
    payload: Option<LyricsPayload>,
    reached: bool,
}

#[derive(Clone)]
struct Query {
    video_id: Option<String>,
    title: String,
    artist: String,
    album: String,
    dur_secs: i64,
    /// `dur_secs` as text, or empty when unknown.
    dur_str: String,
}

fn payload(source: &str, isrc: Option<String>, ttml: Option<String>, synced: Option<String>, plain: Option<String>) -> LyricsPayload {
    LyricsPayload {
        source: source.to_string(),
        isrc,
        ttml,
        synced_lyrics: synced,
        plain_lyrics: plain,
        rich_sync_json: None,
        instrumental: None,
    }
}

fn str_field(val: &serde_json::Value, key: &str) -> Option<String> {
    val.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn looks_like_ttml(body: &str) -> bool {
    body.contains("<tt") || body.contains("<p")
}

pub(super) async fn fetch_lyrics_from_providers(
    reached: &mut bool,
    video_id: Option<String>,
    title: String,
    artist: String,
    album: Option<String>,
    duration: Option<f64>,
) -> Result<Option<LyricsPayload>, String> {
    let client: &'static reqwest::Client = match &*LYRICS_CLIENT {
        Ok(c) => c,
        Err(e) => return Err(e.clone()),
    };

    let dur_secs = duration.map(|d| d.round() as i64).unwrap_or(0);
    let query = Query {
        video_id: video_id.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        title: clean_query_title(&title),
        artist: clean_query_artist(&artist).1,
        album: album.unwrap_or_default(),
        dur_secs,
        dur_str: if dur_secs > 0 { dur_secs.to_string() } else { String::new() },
    };

    // Ranked best first: word-synced sources before line-synced and plain ones.
    let mut tasks = Vec::new();
    macro_rules! start {
        ($provider:ident) => {{
            let q = query.clone();
            tasks.push(tauri::async_runtime::spawn(async move { $provider(client, &q).await }));
        }};
    }
    start!(simpmusic);
    start!(binilyrics);
    start!(lrc_red);
    start!(better_lyrics);
    start!(lyrics_plus);
    start!(unison);

    let deadline = tokio::time::Instant::now() + LOOKUP_DEADLINE;
    let mut found = None;
    for task in tasks.iter_mut() {
        if found.is_some() {
            break;
        }
        // A task that finished is still read after the deadline; one still running is skipped.
        match tokio::time::timeout_at(deadline, task).await {
            Ok(Ok(outcome)) => {
                *reached |= outcome.reached;
                found = outcome.payload;
            }
            Ok(Err(_)) | Err(_) => {}
        }
    }
    for task in &tasks {
        task.abort();
    }
    Ok(found)
}

/// 1. SimpMusic, by YouTube video id.
async fn simpmusic(client: &reqwest::Client, q: &Query) -> Outcome {
    let mut out = Outcome::default();
    let Some(vid) = &q.video_id else { return out };
    let Ok(res) = client.get(format!("https://api-lyrics.simpmusic.org/v1/{vid}")).send().await else { return out };
    out.reached = answered(res.status());
    if !res.status().is_success() {
        return out;
    }
    let Ok(val) = res.json::<serde_json::Value>().await else { return out };
    let tracks = val.get("data").and_then(|data| data.as_array()).map(Vec::as_slice).unwrap_or(&[]);
    let distance = |track: &serde_json::Value| {
        json_seconds(track).map(|seconds| (seconds - q.dur_secs as f64).abs()).unwrap_or(f64::MAX)
    };
    let track = tracks
        .iter()
        .filter(|track| q.dur_secs <= 0 || json_seconds(track).is_some_and(|seconds| (seconds - q.dur_secs as f64).abs() <= 10.0))
        .min_by(|left, right| distance(left).total_cmp(&distance(right)));
    let Some(track) = track else { return out };
    let rich_sync = str_field(track, "richSyncLyrics");
    let synced = str_field(track, "syncedLyrics");
    let plain = str_field(track, "plainLyrics").or_else(|| str_field(track, "lyrics"));
    if rich_sync.is_some() || synced.is_some() || plain.is_some() {
        let mut found = payload("SimpMusic", None, None, synced, plain);
        found.rich_sync_json = rich_sync;
        out.payload = Some(found);
    }
    out
}

/// 2. BiniLyrics: TTML, inline or behind a link.
async fn binilyrics(client: &reqwest::Client, q: &Query) -> Outcome {
    let mut out = Outcome::default();
    let mut req = client.get("https://lyrics-api.binimum.org/").query(&[("track", &q.title), ("artist", &q.artist)]);
    if !q.dur_str.is_empty() {
        req = req.query(&[("duration", &q.dur_str)]);
    }
    if !q.album.is_empty() {
        req = req.query(&[("album", &q.album)]);
    }
    let Ok(res) = req.send().await else { return out };
    out.reached = answered(res.status());
    if !res.status().is_success() {
        return out;
    }
    let Ok(val) = res.json::<serde_json::Value>().await else { return out };
    let results = val.get("results").and_then(|results| results.as_array()).map(Vec::as_slice).unwrap_or(&[]);
    let Some(result) = best_lyrics_candidate(results, &q.title, &q.artist, q.dur_secs) else { return out };
    let isrc = result.get("isrc").and_then(|v| v.as_str()).map(str::trim).filter(|i| !i.is_empty()).map(str::to_string);

    if let Some(ttml) = result.get("ttml").and_then(|v| v.as_str()).filter(|t| looks_like_ttml(t)) {
        out.payload = Some(payload("BiniLyrics", isrc, Some(ttml.to_string()), None, None));
        return out;
    }
    // The provider names this URL; only follow it to a public https host, never to
    // localhost or a LAN address.
    if let Some(lyrics_url) = result.get("lyricsUrl").and_then(|v| v.as_str()).filter(|u| is_public_https(u)) {
        if let Ok(res) = client.get(lyrics_url).send().await {
            out.reached |= answered(res.status());
            if res.status().is_success() {
                if let Ok(body) = res.text().await {
                    if looks_like_ttml(&body) {
                        out.payload = Some(payload("BiniLyrics", isrc, Some(body), None, None));
                    }
                }
            }
        }
    }
    out
}

/// 3. lrc.red: Apple-style TTML with syllable timing, found by search then ISRC.
async fn lrc_red(client: &reqwest::Client, q: &Query) -> Outcome {
    let mut out = Outcome::default();
    let search_url = format!(
        "https://lrc.red/search.json?q={}%20{}",
        urlencoding_lite(&q.title),
        urlencoding_lite(&q.artist)
    );
    let Ok(res) = client.get(&search_url).send().await else { return out };
    out.reached = answered(res.status());
    if !res.status().is_success() {
        return out;
    }
    let Ok(val) = res.json::<serde_json::Value>().await else { return out };
    let items = val
        .get("hits")
        .and_then(|hits| hits.as_array())
        .or_else(|| val.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let Some(isrc) = best_lyrics_candidate(items, &q.title, &q.artist, q.dur_secs)
        .and_then(|hit| hit.get("isrc"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return out;
    };
    if let Ok(res) = client.get(format!("https://lrc.red/s/{isrc}.ttml")).send().await {
        out.reached |= answered(res.status());
        if res.status().is_success() {
            if let Ok(body) = res.text().await {
                if looks_like_ttml(&body) {
                    out.payload = Some(payload("lrc.red", Some(isrc), Some(body), None, None));
                }
            }
        }
    }
    out
}

/// 4. BetterLyrics and QQ karaoke.
async fn better_lyrics(client: &reqwest::Client, q: &Query) -> Outcome {
    let mut out = Outcome::default();
    let mut req = client.get("https://lyrics-api.boidu.dev/getLyrics").query(&[("s", &q.title), ("a", &q.artist)]);
    if !q.dur_str.is_empty() {
        req = req.query(&[("d", &q.dur_str)]);
    }
    if !q.album.is_empty() {
        req = req.query(&[("al", &q.album)]);
    }
    let Ok(res) = req.send().await else { return out };
    out.reached = answered(res.status());
    if !res.status().is_success() {
        return out;
    }
    let Ok(val) = res.json::<serde_json::Value>().await else { return out };
    let ttml = str_field(&val, "ttml");
    let synced = str_field(&val, "syncedLyrics").or_else(|| str_field(&val, "karaoke"));
    let plain = str_field(&val, "lyrics");
    if ttml.is_some() || synced.is_some() || plain.is_some() {
        out.payload = Some(payload("BetterLyrics", None, ttml, synced, plain));
    }
    out
}

/// 5. LyricsPlus. Its mirrors are asked at once and the first with lyrics wins; that
/// mirror is remembered and listed first next time.
async fn lyrics_plus(client: &'static reqwest::Client, q: &Query) -> Outcome {
    let mut mirrors: Vec<String> = LAST_LYRICS_PLUS_MIRROR.lock().ok().and_then(|g| g.clone()).into_iter().collect();
    for &m in LYRICS_PLUS_MIRRORS {
        if !mirrors.iter().any(|existing| existing == m) {
            mirrors.push(m.to_string());
        }
    }
    let (tx, mut rx) = tokio::sync::mpsc::channel(mirrors.len());
    let mut tasks = Vec::new();
    for mirror in mirrors {
        let tx = tx.clone();
        let q = q.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            let _ = tx.send(lyrics_plus_mirror(client, &q, mirror).await).await;
        }));
    }
    drop(tx);
    let mut out = Outcome::default();
    while let Some((mirror, outcome)) = rx.recv().await {
        out.reached |= outcome.reached;
        if outcome.payload.is_some() {
            if let Ok(mut guard) = LAST_LYRICS_PLUS_MIRROR.lock() {
                *guard = Some(mirror);
            }
            out.payload = outcome.payload;
            break;
        }
    }
    for task in &tasks {
        task.abort();
    }
    out
}

async fn lyrics_plus_mirror(client: &reqwest::Client, q: &Query, mirror: String) -> (String, Outcome) {
    let mut out = Outcome::default();
    let mut req = client
        .get(format!("{mirror}/v2/lyrics/get"))
        .query(&[("title", &q.title), ("artist", &q.artist)]);
    if !q.dur_str.is_empty() {
        req = req.query(&[("duration", &q.dur_str)]);
    }
    if let Ok(res) = req.send().await {
        out.reached = answered(res.status());
        if res.status().is_success() {
            if let Ok(val) = res.json::<serde_json::Value>().await {
                let ttml = str_field(&val, "ttml");
                let synced = str_field(&val, "syncedLyrics");
                let plain = str_field(&val, "lyrics");
                if ttml.is_some() || synced.is_some() || plain.is_some() {
                    out.payload = Some(payload("LyricsPlus", None, ttml, synced, plain));
                }
            }
        }
    }
    (mirror, out)
}

/// 6. Unison, the last resort.
async fn unison(client: &reqwest::Client, q: &Query) -> Outcome {
    let mut out = Outcome::default();
    let mut req = client.get("https://unison.boidu.dev/lyrics").query(&[("song", &q.title), ("artist", &q.artist)]);
    if !q.dur_str.is_empty() {
        req = req.query(&[("duration", &q.dur_str)]);
    }
    let Ok(res) = req.send().await else { return out };
    out.reached = answered(res.status());
    if !res.status().is_success() {
        return out;
    }
    let Ok(val) = res.json::<serde_json::Value>().await else { return out };
    let synced = str_field(&val, "syncedLyrics");
    let plain = str_field(&val, "lyrics");
    if synced.is_some() || plain.is_some() {
        out.payload = Some(payload("Unison", None, None, synced, plain));
    }
    out
}

/// An https URL on a named public host (not an IP address or localhost).
fn is_public_https(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        // `domain()` is None for IP-address hosts.
        u.scheme() == "https"
            && u.domain().is_some_and(|d| d != "localhost" && !d.ends_with(".localhost") && !d.ends_with(".local"))
    })
}

#[cfg(test)]
mod url_tests {
    use super::is_public_https;

    #[test]
    fn only_public_https_lyrics_urls_are_followed() {
        assert!(is_public_https("https://lyrics.example.com/a.ttml"));
        assert!(!is_public_https("http://lyrics.example.com/a.ttml"));
        assert!(!is_public_https("https://127.0.0.1/a"));
        assert!(!is_public_https("https://[::1]/a"));
        assert!(!is_public_https("https://localhost:8080/a"));
        assert!(!is_public_https("https://router.local/a"));
        assert!(!is_public_https("not a url"));
    }
}
