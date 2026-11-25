//! The lyrics providers. They are asked at the same time, and the answer from the
//! highest-ranked provider that has the song wins, so a slow or dead provider can't hold
//! the lookup for long.

use super::matching::{best_lyrics_candidate, clean_query_artist, clean_query_title, json_seconds, urlencoding_lite};
use super::LyricsPayload;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// Shared client for every lyrics provider request, so connections and TLS sessions are
/// reused. Each request gives up after 3.2 s.
static LYRICS_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(concat!("DotMusic/", env!("CARGO_PKG_VERSION"), " (https://github.com/dot-music)"))
        .timeout(Duration::from_millis(3200))
        .build()
        .map_err(|e| e.to_string())
});

/// Supported lyrics providers in default ranking order. Word-synced sources come
/// before line-synced and plain ones.
pub(crate) const PROVIDERS: [&str; 8] = [
    "SimpMusic",
    "BiniLyrics",
    "lrc.red",
    "BetterLyrics",
    "LyricsPlus",
    "Unison",
    "LRCLIB",
    "YouTube Music",
];

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
    /// The recording's ISRC, when the provider identified it (even without lyrics).
    isrc: Option<String>,
}

/// How long a provider that can use the ISRC waits for BiniLyrics to identify the recording.
const ISRC_WAIT: Duration = Duration::from_millis(1500);

#[derive(Clone)]
struct Query {
    video_id: Option<String>,
    title: String,
    artist: String,
    album: String,
    dur_secs: i64,
    /// `dur_secs` as text, or empty when unknown.
    dur_str: String,
    /// BiniLyrics' finding: `None` while it is still looking, then `Some(isrc or none)`.
    isrc: Arc<watch::Sender<Option<Option<String>>>>,
}

impl Query {
    /// The recording's ISRC once BiniLyrics has looked (waiting at most ISRC_WAIT).
    async fn isrc(&self) -> Option<String> {
        let mut rx = self.isrc.subscribe();
        let found = tokio::time::timeout(ISRC_WAIT, rx.wait_for(Option::is_some)).await.ok()?.ok()?;
        found.clone().flatten()
    }
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

/// Sets up the query and spawns lookup tasks for the requested providers in `order`.
///
/// An empty `order` defaults to [`PROVIDERS`]. Unknown provider names are ignored.
fn start_provider_tasks(
    video_id: Option<String>,
    title: &str,
    artist: &str,
    album: Option<String>,
    duration: Option<f64>,
    order: &[String],
) -> Result<(Query, Vec<tauri::async_runtime::JoinHandle<Outcome>>), String> {
    let client: &'static reqwest::Client = match &*LYRICS_CLIENT {
        Ok(c) => c,
        Err(e) => return Err(e.clone()),
    };

    let order_slice: Vec<&str> = if order.is_empty() {
        PROVIDERS.to_vec()
    } else {
        order.iter().map(String::as_str).collect()
    };
    let has_binilyrics = order_slice.iter().any(|&name| name == "BiniLyrics");

    let dur_secs = duration.map(|d| d.round() as i64).unwrap_or(0);
    let query = Query {
        video_id: video_id.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        title: clean_query_title(title),
        artist: clean_query_artist(artist).1,
        album: album.unwrap_or_default(),
        dur_secs,
        dur_str: if dur_secs > 0 { dur_secs.to_string() } else { String::new() },
        isrc: Arc::new(watch::channel(None).0),
    };

    let mut tasks = Vec::new();
    macro_rules! spawn_provider {
        ($func:ident) => {{
            let q = query.clone();
            tasks.push(tauri::async_runtime::spawn(async move { $func(client, &q).await }));
        }};
    }

    for name in order_slice {
        match name {
            "SimpMusic" => spawn_provider!(simpmusic),
            "BiniLyrics" => {
                let q = query.clone();
                tasks.push(tauri::async_runtime::spawn(async move {
                    let out = binilyrics(client, &q).await;
                    let isrc = out.isrc.clone().or_else(|| out.payload.as_ref().and_then(|p| p.isrc.clone()));
                    q.isrc.send_replace(Some(isrc));
                    out
                }));
            }
            "lrc.red" => spawn_provider!(lrc_red),
            "BetterLyrics" => spawn_provider!(better_lyrics),
            "LyricsPlus" => spawn_provider!(lyrics_plus),
            "Unison" => spawn_provider!(unison),
            "LRCLIB" => spawn_provider!(lrclib),
            "YouTube Music" => spawn_provider!(youtube_music),
            _ => {}
        }
    }
    // BiniLyrics switched off or not pinned: it still identifies the recording (its ISRC) for
    // the providers that match by it, so a pinned source finds the same version the picker
    // showed. Its lyrics are discarded; the others stop waiting for it after a short while.
    if !has_binilyrics {
        let q = query.clone();
        spawn_isrc_lookup(client, q);
    }

    Ok((query, tasks))
}

/// Runs BiniLyrics only for the ISRC it reports, shared through the query's watch channel.
fn spawn_isrc_lookup(client: &'static reqwest::Client, q: Query) {
    tauri::async_runtime::spawn(async move {
        let out = binilyrics(client, &q).await;
        let isrc = out.isrc.clone().or_else(|| out.payload.as_ref().and_then(|p| p.isrc.clone()));
        q.isrc.send_replace(Some(isrc));
    });
}

pub(super) async fn fetch_lyrics_from_providers(
    reached: &mut bool,
    video_id: Option<String>,
    title: String,
    artist: String,
    album: Option<String>,
    duration: Option<f64>,
    order: &[String],
) -> Result<Option<LyricsPayload>, String> {
    let (query, mut tasks) = start_provider_tasks(video_id, &title, &artist, album, duration, order)?;

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
    // Keep the recording's identity with the lyrics when another provider found it.
    if let Some(found) = found.as_mut() {
        if found.isrc.is_none() {
            found.isrc = query.isrc.borrow().clone().flatten();
        }
    }
    Ok(found)
}

pub(super) async fn fetch_lyrics_candidates(
    reached: &mut bool,
    video_id: Option<String>,
    title: String,
    artist: String,
    album: Option<String>,
    duration: Option<f64>,
    order: &[String],
) -> Result<Vec<LyricsPayload>, String> {
    let (query, mut tasks) = start_provider_tasks(video_id, &title, &artist, album, duration, order)?;

    let deadline = tokio::time::Instant::now() + LOOKUP_DEADLINE;
    let mut candidates = Vec::new();
    for task in tasks.iter_mut() {
        // A task that finished is still read after the deadline; one still running is skipped.
        match tokio::time::timeout_at(deadline, task).await {
            Ok(Ok(outcome)) => {
                *reached |= outcome.reached;
                if let Some(payload) = outcome.payload {
                    candidates.push(payload);
                }
            }
            Ok(Err(_)) | Err(_) => {}
        }
    }
    for task in &tasks {
        task.abort();
    }
    // Keep the recording's identity with the lyrics when another provider found it.
    let shared_isrc = query.isrc.borrow().clone().flatten();
    for candidate in &mut candidates {
        if candidate.isrc.is_none() {
            candidate.isrc = shared_isrc.clone();
        }
    }
    Ok(candidates)
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
    out.isrc = isrc.clone();

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
    if !q.album.is_empty() {
        req = req.query(&[("album", &q.album)]);
    }
    // The ISRC pins the exact recording; LyricsPlus prefers it over title matching.
    if let Some(isrc) = q.isrc().await {
        req = req.query(&[("isrc", &isrc)]);
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

/// 7. LRCLIB: the open, public lyrics database (https://lrclib.net). An exact lookup when the
/// album and length are known, otherwise a search, taking the closest matching version.
async fn lrclib(client: &reqwest::Client, q: &Query) -> Outcome {
    let mut out = Outcome::default();
    if !q.album.is_empty() && q.dur_secs > 0 {
        let req = client.get("https://lrclib.net/api/get").query(&[
            ("track_name", q.title.as_str()),
            ("artist_name", q.artist.as_str()),
            ("album_name", q.album.as_str()),
            ("duration", q.dur_str.as_str()),
        ]);
        if let Ok(res) = req.send().await {
            out.reached = answered(res.status());
            if res.status().is_success() {
                if let Ok(val) = res.json::<serde_json::Value>().await {
                    out.payload = lrclib_payload(&val);
                    if out.payload.is_some() {
                        return out;
                    }
                }
            }
        }
    }
    let req = client
        .get("https://lrclib.net/api/search")
        .query(&[("track_name", q.title.as_str()), ("artist_name", q.artist.as_str())]);
    let Ok(res) = req.send().await else { return out };
    out.reached |= answered(res.status());
    if !res.status().is_success() {
        return out;
    }
    let Ok(val) = res.json::<serde_json::Value>().await else { return out };
    let results = val.as_array().map(Vec::as_slice).unwrap_or(&[]);
    out.payload = pick_lrclib(results, q).and_then(lrclib_payload);
    out
}

/// Among LRCLIB search results for this song, synced lyrics beat plain ones, then the
/// closest length wins.
fn pick_lrclib<'a>(results: &'a [serde_json::Value], q: &Query) -> Option<&'a serde_json::Value> {
    let synced: Vec<serde_json::Value> = results
        .iter()
        .filter(|r| r.get("syncedLyrics").and_then(|v| v.as_str()).is_some_and(|s| !s.trim().is_empty()))
        .cloned()
        .collect();
    let best_synced = best_lyrics_candidate(&synced, &q.title, &q.artist, q.dur_secs)
        .and_then(|chosen| results.iter().find(|r| r.get("id") == chosen.get("id")));
    best_synced.or_else(|| best_lyrics_candidate(results, &q.title, &q.artist, q.dur_secs))
}

fn lrclib_payload(val: &serde_json::Value) -> Option<LyricsPayload> {
    if val.get("instrumental").and_then(|v| v.as_bool()) == Some(true) {
        let mut found = payload("LRCLIB", None, None, None, None);
        found.instrumental = Some(true);
        return Some(found);
    }
    let nonempty = |key: &str| str_field(val, key).filter(|s| !s.trim().is_empty());
    let synced = nonempty("syncedLyrics");
    let plain = nonempty("plainLyrics");
    (synced.is_some() || plain.is_some()).then(|| payload("LRCLIB", None, None, synced, plain))
}

/// 8. YouTube Music's own lyrics tab: plain text (usually from LyricFind), the last resort.
/// Asked anonymously, like the website does before sign-in.
async fn youtube_music(client: &reqwest::Client, q: &Query) -> Outcome {
    use crate::ytmusic::{web_remix_context, with_ytm_headers};
    let mut out = Outcome::default();
    let Some(video_id) = &q.video_id else { return out };
    let next = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/next"))
        .json(&serde_json::json!({ "context": web_remix_context(), "videoId": video_id }));
    let Ok(res) = next.send().await else { return out };
    out.reached = answered(res.status());
    let Ok(val) = res.json::<serde_json::Value>().await else { return out };
    // No lyrics tab target means YouTube Music has no lyrics for it: a definite answer.
    let Some(browse_id) = ytm_lyrics_browse_id(&val) else { return out };
    let browse = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/browse"))
        .json(&serde_json::json!({ "context": web_remix_context(), "browseId": browse_id }));
    let Ok(res) = browse.send().await else { return out };
    out.reached |= answered(res.status());
    let Ok(val) = res.json::<serde_json::Value>().await else { return out };
    if let Some(text) = ytm_lyrics_text(&val) {
        out.payload = Some(payload("YouTube Music", None, None, None, Some(text)));
    }
    out
}

/// The lyrics tab's browse id ("MPLYt…") from a `next` response, if the song has lyrics.
fn ytm_lyrics_browse_id(next: &serde_json::Value) -> Option<String> {
    let tabs = next
        .pointer("/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs")?
        .as_array()?;
    tabs.iter()
        .filter_map(|tab| tab.pointer("/tabRenderer/endpoint/browseEndpoint/browseId")?.as_str())
        .find(|id| id.starts_with("MPLY"))
        .map(str::to_string)
}

/// The lyrics text from the lyrics tab's `browse` response.
fn ytm_lyrics_text(browse: &serde_json::Value) -> Option<String> {
    let shelf = browse
        .pointer("/contents/sectionListRenderer/contents")?
        .as_array()?
        .iter()
        .find_map(|item| item.get("musicDescriptionShelfRenderer"))?;
    let text: String = shelf
        .pointer("/description/runs")?
        .as_array()?
        .iter()
        .filter_map(|run| run.get("text")?.as_str())
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
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
mod provider_tests {
    use super::*;
    use serde_json::json;

    fn query(title: &str, artist: &str, dur: i64) -> Query {
        Query {
            video_id: None,
            title: title.into(),
            artist: artist.into(),
            album: String::new(),
            dur_secs: dur,
            dur_str: dur.to_string(),
            isrc: Arc::new(watch::channel(None).0),
        }
    }

    #[test]
    fn lrclib_prefers_synced_then_the_closest_length() {
        let results = vec![
            json!({ "id": 1, "trackName": "Song", "artistName": "Artist", "duration": 200.0, "plainLyrics": "a" }),
            json!({ "id": 2, "trackName": "Song", "artistName": "Artist", "duration": 204.0, "syncedLyrics": "[00:01.00]a" }),
            json!({ "id": 3, "trackName": "Song", "artistName": "Artist", "duration": 201.0, "syncedLyrics": "[00:01.00]b" }),
            json!({ "id": 4, "trackName": "Song (Live)", "artistName": "Artist", "duration": 200.0, "syncedLyrics": "[00:01.00]c" }),
        ];
        let picked = pick_lrclib(&results, &query("Song", "Artist", 200)).unwrap();
        assert_eq!(picked["id"], 3);
    }

    #[test]
    fn lrclib_falls_back_to_plain_and_marks_instrumentals() {
        let results = vec![json!({ "id": 1, "trackName": "Song", "artistName": "Artist", "duration": 200.0, "plainLyrics": "words" })];
        let picked = pick_lrclib(&results, &query("Song", "Artist", 200)).unwrap();
        let found = lrclib_payload(picked).unwrap();
        assert_eq!(found.plain_lyrics.as_deref(), Some("words"));
        assert!(found.synced_lyrics.is_none());

        let instrumental = lrclib_payload(&json!({ "instrumental": true, "plainLyrics": null })).unwrap();
        assert_eq!(instrumental.instrumental, Some(true));
        assert!(lrclib_payload(&json!({ "syncedLyrics": "  ", "plainLyrics": "" })).is_none());
    }

    #[test]
    fn youtube_music_lyrics_tab_and_text_are_found() {
        let next = json!({ "contents": { "singleColumnMusicWatchNextResultsRenderer": { "tabbedRenderer": {
            "watchNextTabbedResultsRenderer": { "tabs": [
                { "tabRenderer": { "title": "Up next" } },
                { "tabRenderer": { "title": "Lyrics", "endpoint": { "browseEndpoint": { "browseId": "MPLYt_abc" } } } },
                { "tabRenderer": { "title": "Related", "endpoint": { "browseEndpoint": { "browseId": "MPTRt_xyz" } } } }
            ] } } } } });
        assert_eq!(ytm_lyrics_browse_id(&next).as_deref(), Some("MPLYt_abc"));

        let no_lyrics = json!({ "contents": { "singleColumnMusicWatchNextResultsRenderer": { "tabbedRenderer": {
            "watchNextTabbedResultsRenderer": { "tabs": [ { "tabRenderer": { "title": "Lyrics", "unselectable": true } } ] } } } } });
        assert!(ytm_lyrics_browse_id(&no_lyrics).is_none());

        let browse = json!({ "contents": { "sectionListRenderer": { "contents": [
            { "musicDescriptionShelfRenderer": { "description": { "runs": [ { "text": "Line one\nLine two\n" } ] },
              "footer": { "runs": [ { "text": "Source: LyricFind" } ] } } }
        ] } } });
        assert_eq!(ytm_lyrics_text(&browse).as_deref(), Some("Line one\nLine two"));
    }

    #[tokio::test]
    async fn waits_for_binilyrics_isrc_but_not_forever() {
        let q = query("Song", "Artist", 200);
        let sender = q.isrc.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            sender.send_replace(Some(Some("USABC1234567".into())));
        });
        assert_eq!(q.isrc().await.as_deref(), Some("USABC1234567"));

        let none = query("Song", "Artist", 200);
        none.isrc.send_replace(Some(None));
        assert_eq!(none.isrc().await, None);
    }
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
