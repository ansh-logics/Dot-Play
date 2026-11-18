//! Scrobbling to Last.fm and ListenBrainz.
//!
//! The frontend decides when a listen counts (it watches playback) and hands it here. Listens
//! go into a saved queue first and are sent from there, so a listen made offline, or while a
//! service is down, is sent later, even after a restart.

mod credentials;
mod lastfm;
mod listenbrainz;

use lastfm::Failure;
use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Settings refreshes its Connections section on this.
const STATUS_EVENT: &str = "scrobble-status-changed";
/// Listens kept while they can't be sent; the oldest go first beyond this.
const QUEUE_MAX: usize = 1000;
/// How often the queue is retried while something is waiting.
const RETRY_EVERY: Duration = Duration::from_secs(5 * 60);
/// How long sign-in waits for the listener to approve DOT Music on last.fm.
const AUTH_WAIT: Duration = Duration::from_secs(180);
const AUTH_POLL: Duration = Duration::from_secs(3);

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(concat!("DotMusic/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_default()
});

fn client() -> &'static reqwest::Client {
    &CLIENT
}

/// One listen. `started_at` is Unix seconds when the song started playing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listen {
    pub artist: String,
    pub track: String,
    #[serde(default)]
    pub album: Option<String>,
    /// Seconds.
    #[serde(default)]
    pub duration: Option<u64>,
    pub started_at: i64,
    #[serde(default)]
    pub video_id: Option<String>,
}

impl Listen {
    fn is_valid(&self) -> bool {
        !self.artist.trim().is_empty() && !self.track.trim().is_empty() && self.started_at > 0
    }
}

/// A listen still to be sent, and to which services.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Pending {
    listen: Listen,
    lastfm: bool,
    listenbrainz: bool,
}

// ---- The queue (pure parts, tested) ----------------------------------------------------

fn enqueue(queue: &mut Vec<Pending>, item: Pending) {
    if !item.lastfm && !item.listenbrainz {
        return;
    }
    queue.push(item);
    if queue.len() > QUEUE_MAX {
        let excess = queue.len() - QUEUE_MAX;
        queue.drain(..excess);
    }
}

fn drop_sent(queue: &mut Vec<Pending>) {
    queue.retain(|p| p.lastfm || p.listenbrainz);
}

#[derive(Clone, Copy)]
enum Service {
    LastFm,
    ListenBrainz,
}

impl Service {
    fn wants(self, p: &Pending) -> bool {
        match self {
            Service::LastFm => p.lastfm,
            Service::ListenBrainz => p.listenbrainz,
        }
    }
    fn done(self, p: &mut Pending) {
        match self {
            Service::LastFm => p.lastfm = false,
            Service::ListenBrainz => p.listenbrainz = false,
        }
    }
    fn batch(self) -> usize {
        match self {
            Service::LastFm => lastfm::BATCH,
            Service::ListenBrainz => listenbrainz::BATCH,
        }
    }
}

/// Marks `sent` as done for `service`, matching by content: the queue may have moved since
/// the batch was taken (new listens, or the oldest dropped at the limit).
fn mark_sent(queue: &mut [Pending], service: Service, sent: &[Listen]) {
    for listen in sent {
        if let Some(p) = queue.iter_mut().find(|p| service.wants(p) && p.listen == *listen) {
            service.done(p);
        }
    }
}

/// Positions in the queue of the next batch for `service`.
fn next_batch(queue: &[Pending], service: Service) -> Vec<usize> {
    queue.iter().enumerate().filter(|(_, p)| service.wants(p)).map(|(i, _)| i).take(service.batch()).collect()
}

// ---- Saved queue ------------------------------------------------------------------------

static QUEUE: Mutex<Option<Vec<Pending>>> = Mutex::new(None);
/// One flush at a time.
static FLUSHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn queue_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    Some(credentials::data_dir(app)?.join("scrobble_queue.json"))
}

fn with_queue<T>(app: &AppHandle, f: impl FnOnce(&mut Vec<Pending>) -> T) -> T {
    let mut guard = QUEUE.lock().unwrap_or_else(|e| e.into_inner());
    let queue = guard.get_or_insert_with(|| {
        queue_path(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    });
    let before = queue.clone();
    let out = f(queue);
    if *queue != before {
        if let (Some(path), Ok(json)) = (queue_path(app), serde_json::to_string(&*queue)) {
            let _ = crate::fsutil::write_atomic(&path, json.as_bytes(), false);
        }
    }
    out
}

fn notify(app: &AppHandle) {
    let _ = app.emit(STATUS_EVENT, ());
}

/// Sends what the queue holds for each signed-in service. Listens for a service nobody is
/// signed in to any more are dropped; a revoked sign-in is forgotten.
async fn flush(app: &AppHandle) {
    let _one_at_a_time = FLUSHING.lock().await;
    for service in [Service::LastFm, Service::ListenBrainz] {
        loop {
            let creds = credentials::load(app);
            let account = match service {
                Service::LastFm => creds.lastfm.clone().filter(|_| lastfm::keys().is_some()),
                Service::ListenBrainz => creds.listenbrainz.clone(),
            };
            let Some(account) = account else {
                with_queue(app, |q| {
                    q.iter_mut().for_each(|p| service.done(p));
                    drop_sent(q);
                });
                break;
            };
            let batch: Vec<Listen> = with_queue(app, |q| next_batch(q, service).into_iter().map(|i| q[i].listen.clone()).collect());
            if batch.is_empty() {
                break;
            }
            let refs: Vec<&Listen> = batch.iter().collect();
            let result = match service {
                Service::LastFm => lastfm::scrobble(&account.secret, &refs).await,
                Service::ListenBrainz => listenbrainz::send(&account.secret, &refs).await,
            };
            match result {
                // Sent, or refused for good: either way these are done for this service.
                Ok(()) | Err(Failure::Rejected(_)) => with_queue(app, |q| {
                    mark_sent(q, service, &batch);
                    drop_sent(q);
                }),
                Err(Failure::Retry(_)) => break,
                Err(Failure::SignedOut) => {
                    let _ = credentials::update(app, |c| match service {
                        Service::LastFm => c.lastfm = None,
                        Service::ListenBrainz => c.listenbrainz = None,
                    });
                }
            }
        }
    }
    notify(app);
}

/// Retries the queue now and then, starting shortly after launch.
pub(crate) fn init(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            if with_queue(&app, |q| !q.is_empty()) {
                flush(&app).await;
            }
            tokio::time::sleep(RETRY_EVERY).await;
        }
    });
}

// ---- Commands ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScrobbleStatus {
    /// This build has Last.fm API keys.
    lastfm_available: bool,
    lastfm_user: Option<String>,
    listenbrainz_user: Option<String>,
    /// Listens waiting to be sent.
    pending: usize,
}

#[tauri::command]
pub(crate) fn scrobble_status(app: AppHandle) -> ScrobbleStatus {
    let creds = credentials::load(&app);
    ScrobbleStatus {
        lastfm_available: lastfm::keys().is_some(),
        lastfm_user: creds.lastfm.map(|a| a.username),
        listenbrainz_user: creds.listenbrainz.map(|a| a.username),
        pending: with_queue(&app, |q| q.len()),
    }
}

fn open_in_browser(url: &str) -> Result<(), String> {
    if !url.starts_with("https://www.last.fm/") {
        return Err("refusing to open an unexpected address".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(windows)]
    let mut command = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    command.arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

static AUTH_TOKEN: Mutex<Option<String>> = Mutex::new(None);

/// Opens last.fm in the browser to approve DOT Music, then waits (up to 3 minutes) for the
/// approval. Returns the Last.fm user name.
#[tauri::command]
pub(crate) async fn lastfm_connect(app: AppHandle) -> Result<String, String> {
    let (token, url) = lastfm::begin_auth().await?;
    *AUTH_TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(token.clone());
    open_in_browser(&url)?;
    let deadline = tokio::time::Instant::now() + AUTH_WAIT;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(AUTH_POLL).await;
        // A newer attempt (or Cancel) replaced this one.
        if AUTH_TOKEN.lock().unwrap_or_else(|e| e.into_inner()).as_deref() != Some(token.as_str()) {
            return Err("cancelled".into());
        }
        if let Some((username, session_key)) = lastfm::finish_auth(&token).await? {
            *AUTH_TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
            credentials::update(&app, |c| {
                c.lastfm = Some(credentials::Account { username: username.clone(), secret: session_key })
            })?;
            notify(&app);
            return Ok(username);
        }
    }
    *AUTH_TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
    Err("Last.fm wasn't approved in time. Try again.".into())
}

#[tauri::command]
pub(crate) fn lastfm_cancel_connect() {
    *AUTH_TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[tauri::command]
pub(crate) fn lastfm_disconnect(app: AppHandle) -> Result<(), String> {
    credentials::update(&app, |c| c.lastfm = None)?;
    with_queue(&app, |q| {
        q.iter_mut().for_each(|p| p.lastfm = false);
        drop_sent(q);
    });
    notify(&app);
    Ok(())
}

/// Checks a ListenBrainz user token and keeps it. Returns the ListenBrainz user name.
#[tauri::command]
pub(crate) async fn listenbrainz_connect(app: AppHandle, token: String) -> Result<String, String> {
    let token = token.trim().to_string();
    if token.is_empty() || token.len() > 200 {
        return Err("Paste your ListenBrainz user token.".into());
    }
    let username = listenbrainz::validate(&token).await?;
    credentials::update(&app, |c| {
        c.listenbrainz = Some(credentials::Account { username: username.clone(), secret: token })
    })?;
    notify(&app);
    Ok(username)
}

#[tauri::command]
pub(crate) fn listenbrainz_disconnect(app: AppHandle) -> Result<(), String> {
    credentials::update(&app, |c| c.listenbrainz = None)?;
    with_queue(&app, |q| {
        q.iter_mut().for_each(|p| p.listenbrainz = false);
        drop_sent(q);
    });
    notify(&app);
    Ok(())
}

/// "Now playing" on each signed-in service. Best effort: not queued.
#[tauri::command]
pub(crate) async fn scrobble_now_playing(app: AppHandle, listen: Listen) {
    if !listen.is_valid() {
        return;
    }
    let creds = credentials::load(&app);
    let mut signed_out = false;
    if let Some(account) = creds.lastfm.as_ref().filter(|_| lastfm::keys().is_some()) {
        if lastfm::now_playing(&account.secret, &listen).await == Err(Failure::SignedOut) {
            let _ = credentials::update(&app, |c| c.lastfm = None);
            signed_out = true;
        }
    }
    if let Some(account) = creds.listenbrainz.as_ref() {
        if listenbrainz::now_playing(&account.secret, &listen).await == Err(Failure::SignedOut) {
            let _ = credentials::update(&app, |c| c.listenbrainz = None);
            signed_out = true;
        }
    }
    if signed_out {
        notify(&app);
    }
}

/// A listen that counts: queued for each signed-in service, then sent.
#[tauri::command]
pub(crate) async fn scrobble_listen(app: AppHandle, listen: Listen) {
    if !listen.is_valid() {
        return;
    }
    let creds = credentials::load(&app);
    let item = Pending {
        listen,
        lastfm: creds.lastfm.is_some() && lastfm::keys().is_some(),
        listenbrainz: creds.listenbrainz.is_some(),
    };
    if !item.lastfm && !item.listenbrainz {
        return;
    }
    with_queue(&app, |q| enqueue(q, item));
    flush(&app).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(n: i64, lastfm: bool, listenbrainz: bool) -> Pending {
        Pending {
            listen: Listen {
                artist: "A".into(),
                track: format!("T{n}"),
                album: None,
                duration: None,
                started_at: n,
                video_id: None,
            },
            lastfm,
            listenbrainz,
        }
    }

    #[test]
    fn queue_keeps_the_newest_and_skips_listens_for_nobody() {
        let mut q = Vec::new();
        enqueue(&mut q, pending(1, false, false));
        assert!(q.is_empty());
        for n in 0..(QUEUE_MAX as i64 + 5) {
            enqueue(&mut q, pending(n, true, false));
        }
        assert_eq!(q.len(), QUEUE_MAX);
        assert_eq!(q[0].listen.started_at, 5);
    }

    #[test]
    fn batches_follow_each_service_and_sent_listens_leave() {
        let mut q = vec![pending(1, true, true), pending(2, false, true), pending(3, true, false)];
        assert_eq!(next_batch(&q, Service::LastFm), vec![0, 2]);
        assert_eq!(next_batch(&q, Service::ListenBrainz), vec![0, 1]);
        let sent: Vec<Listen> = next_batch(&q, Service::LastFm).into_iter().map(|i| q[i].listen.clone()).collect();
        // A new listen arrives at the front's expense while the batch is in flight.
        q.remove(1);
        mark_sent(&mut q, Service::LastFm, &sent);
        drop_sent(&mut q);
        assert_eq!(q.len(), 1); // #3 had only Last.fm left; #2 was removed
        assert_eq!(q[0].listen.started_at, 1);
        assert!(!q[0].lastfm && q[0].listenbrainz);
    }

    #[test]
    fn listens_need_an_artist_a_title_and_a_time() {
        let mut l = pending(1, true, true).listen;
        assert!(l.is_valid());
        l.artist = "  ".into();
        assert!(!l.is_valid());
    }
}
