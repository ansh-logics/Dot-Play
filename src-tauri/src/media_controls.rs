//! System media controls.
//!
//! Publishes the current track to macOS Now Playing (Control Center, the lock
//! screen, the menu-bar media widget) and turns media keys, AirPods and
//! Control Center buttons into `media-control` events for the frontend, which
//! stays the single owner of playback.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// Event emitted to the frontend when the user presses a system media control.
pub const MEDIA_CONTROL_EVENT: &str = "media-control";
/// Event sent to the menu bar popover whenever the current track or its state changes.
pub const NOW_PLAYING_EVENT: &str = "now-playing";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingInfo {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    /// Seconds. Zero or less while the player has not reported a duration yet.
    pub duration: f64,
    /// Seconds. macOS extrapolates from this and the playback rate, so it only
    /// needs resending on play/pause, seeks and track changes.
    pub position: f64,
    pub is_playing: bool,
    pub artwork_url: Option<String>,
    /// Lets the menu bar popover look up lyrics for the track.
    #[serde(default)]
    pub video_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum MediaControlAction {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    Seek { position: f64 },
}

/// The last published track, for the menu bar popover. `updated_at_ms` is when `position`
/// was sampled, so the popover can extrapolate progress the same way macOS does.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingSnapshot {
    #[serde(flatten)]
    pub info: NowPlayingInfo,
    pub updated_at_ms: u64,
}

#[derive(Default)]
pub struct LastNowPlaying(pub Mutex<Option<NowPlayingSnapshot>>);

/// Registers the remote command handlers. Must run on the main thread.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::register_remote_commands(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Publishes `info` as the system's Now Playing item, or clears it when `None`.
#[tauri::command]
pub async fn set_now_playing(app: AppHandle, info: Option<NowPlayingInfo>) -> Result<(), String> {
    let snapshot = info.clone().map(|info| NowPlayingSnapshot {
        info,
        updated_at_ms: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
    });
    *app.state::<LastNowPlaying>().0.lock().unwrap() = snapshot.clone();
    let _ = app.emit_to("tray", NOW_PLAYING_EVENT, &snapshot);
    crate::tray::refresh_menu(&app, snapshot.as_ref().map(|s| &s.info));

    #[cfg(target_os = "macos")]
    {
        let artwork_url = info.as_ref().and_then(|i| i.artwork_url.clone());
        app.run_on_main_thread(move || macos::publish(info))
            .map_err(|e| e.to_string())?;

        // Artwork arrives after the text so the title updates without waiting
        // on the network.
        if let Some(url) = artwork_url.filter(|url| macos::claim_artwork_fetch(url)) {
            match fetch_artwork(&url).await {
                Ok(bytes) => {
                    app.run_on_main_thread(move || macos::set_artwork(url, bytes))
                        .map_err(|e| e.to_string())?;
                }
                Err(error) => {
                    macos::release_artwork_fetch(&url);
                    log::warn!("Now Playing artwork fetch failed: {error}");
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, info);
    Ok(())
}

/// The current track, for the popover when it first loads.
#[tauri::command]
pub fn get_now_playing(state: State<'_, LastNowPlaying>) -> Option<NowPlayingSnapshot> {
    state.0.lock().unwrap().clone()
}

/// Lets the menu bar popover drive playback through the same path as media keys.
#[tauri::command]
pub fn tray_media_control(app: AppHandle, action: MediaControlAction) {
    emit_action(&app, action);
}

pub fn emit_action(app: &AppHandle, action: MediaControlAction) {
    let _ = app.emit(MEDIA_CONTROL_EVENT, action);
}

#[cfg(target_os = "macos")]
async fn fetch_artwork(url: &str) -> Result<Vec<u8>, String> {
    let response = crate::ytmusic::HTTP_CLIENT
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{MediaControlAction, NowPlayingInfo, MEDIA_CONTROL_EVENT};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_app_kit::NSImage;
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{NSData, NSMutableDictionary, NSNumber, NSString};
    use objc2_media_player::{
        MPChangePlaybackPositionCommandEvent, MPMediaItemArtwork, MPMediaItemPropertyAlbumTitle,
        MPMediaItemPropertyArtist, MPMediaItemPropertyArtwork, MPMediaItemPropertyPlaybackDuration,
        MPMediaItemPropertyTitle, MPNowPlayingInfoCenter, MPNowPlayingInfoMediaType,
        MPNowPlayingInfoPropertyElapsedPlaybackTime, MPNowPlayingInfoPropertyMediaType,
        MPNowPlayingInfoPropertyPlaybackRate, MPNowPlayingPlaybackState, MPRemoteCommand,
        MPRemoteCommandCenter, MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
    };
    use std::cell::RefCell;
    use std::ptr::NonNull;
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter};

    thread_local! {
        // AppKit objects are not Send, so these live on the main thread only.
        static CURRENT: RefCell<Option<NowPlayingInfo>> = const { RefCell::new(None) };
        static ARTWORK: RefCell<Option<(String, Retained<MPMediaItemArtwork>)>> = const { RefCell::new(None) };
    }

    /// The artwork URL already fetched or being fetched, so repeated updates for
    /// the same track don't download it again.
    static ARTWORK_URL: Mutex<Option<String>> = Mutex::new(None);

    pub fn claim_artwork_fetch(url: &str) -> bool {
        let mut claimed = ARTWORK_URL.lock().unwrap();
        if claimed.as_deref() == Some(url) {
            return false;
        }
        *claimed = Some(url.to_string());
        true
    }

    pub fn release_artwork_fetch(url: &str) {
        let mut claimed = ARTWORK_URL.lock().unwrap();
        if claimed.as_deref() == Some(url) {
            *claimed = None;
        }
    }

    pub fn register_remote_commands(app: &AppHandle) {
        let center = unsafe { MPRemoteCommandCenter::sharedCommandCenter() };

        let bind = |command: &MPRemoteCommand, action: MediaControlAction| {
            let app = app.clone();
            let handler = RcBlock::new(move |_event: NonNull<MPRemoteCommandEvent>| {
                let _ = app.emit(MEDIA_CONTROL_EVENT, action.clone());
                MPRemoteCommandHandlerStatus::Success
            });
            unsafe {
                command.setEnabled(true);
                command.addTargetWithHandler(&handler);
            }
        };

        unsafe {
            bind(&center.playCommand(), MediaControlAction::Play);
            bind(&center.pauseCommand(), MediaControlAction::Pause);
            bind(&center.togglePlayPauseCommand(), MediaControlAction::Toggle);
            bind(&center.nextTrackCommand(), MediaControlAction::Next);
            bind(&center.previousTrackCommand(), MediaControlAction::Previous);
        }

        // Scrubbing the Control Center progress bar.
        let app = app.clone();
        let seek = RcBlock::new(move |event: NonNull<MPRemoteCommandEvent>| {
            let event = unsafe { event.cast::<MPChangePlaybackPositionCommandEvent>().as_ref() };
            let position = unsafe { event.positionTime() };
            let _ = app.emit(MEDIA_CONTROL_EVENT, MediaControlAction::Seek { position });
            MPRemoteCommandHandlerStatus::Success
        });
        unsafe {
            let command = center.changePlaybackPositionCommand();
            command.setEnabled(true);
            command.addTargetWithHandler(&seek);
        }
    }

    pub fn publish(info: Option<NowPlayingInfo>) {
        CURRENT.with_borrow_mut(|current| *current = info);
        CURRENT.with_borrow(|current| apply(current.as_ref()));
    }

    pub fn set_artwork(url: String, bytes: Vec<u8>) {
        // A slow fetch for a song already skipped past must not replace the current artwork.
        if ARTWORK_URL.lock().unwrap().as_deref() != Some(url.as_str()) {
            return;
        }
        let data = NSData::with_bytes(&bytes);
        let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
            release_artwork_fetch(&url);
            return;
        };
        let size = image.size();
        let handler = RcBlock::new(move |_size: CGSize| NonNull::from(&*image));
        let artwork = unsafe {
            MPMediaItemArtwork::initWithBoundsSize_requestHandler(
                MPMediaItemArtwork::alloc(),
                size,
                &handler,
            )
        };
        ARTWORK.with_borrow_mut(|cached| *cached = Some((url, artwork)));
        CURRENT.with_borrow(|current| apply(current.as_ref()));
    }

    fn apply(info: Option<&NowPlayingInfo>) {
        let center = unsafe { MPNowPlayingInfoCenter::defaultCenter() };
        let Some(info) = info else {
            unsafe {
                center.setNowPlayingInfo(None);
                center.setPlaybackState(MPNowPlayingPlaybackState::Stopped);
            }
            return;
        };

        let dict = NSMutableDictionary::<NSString, AnyObject>::new();
        let put = |key: &NSString, value: &AnyObject| dict.insert(key, value);

        unsafe {
            put(MPMediaItemPropertyTitle, &NSString::from_str(&info.title));
            put(MPMediaItemPropertyArtist, &NSString::from_str(&info.artist));
            if let Some(album) = info.album.as_deref().filter(|a| !a.is_empty()) {
                put(MPMediaItemPropertyAlbumTitle, &NSString::from_str(album));
            }
            if info.duration > 0.0 {
                put(MPMediaItemPropertyPlaybackDuration, &NSNumber::new_f64(info.duration));
            }
            put(MPNowPlayingInfoPropertyElapsedPlaybackTime, &NSNumber::new_f64(info.position.max(0.0)));
            put(
                MPNowPlayingInfoPropertyPlaybackRate,
                &NSNumber::new_f64(if info.is_playing { 1.0 } else { 0.0 }),
            );
            put(
                MPNowPlayingInfoPropertyMediaType,
                &NSNumber::new_usize(MPNowPlayingInfoMediaType::Audio.0),
            );
        }

        // Only attach artwork that belongs to this track; a stale cover is worse than none.
        ARTWORK.with_borrow(|cached| {
            if let Some((url, artwork)) = cached {
                if info.artwork_url.as_deref() == Some(url.as_str()) {
                    unsafe { put(MPMediaItemPropertyArtwork, artwork) };
                }
            }
        });

        unsafe {
            center.setNowPlayingInfo(Some(&dict));
            // macOS can't infer this from an audio session, so it must be set explicitly.
            center.setPlaybackState(if info.is_playing {
                MPNowPlayingPlaybackState::Playing
            } else {
                MPNowPlayingPlaybackState::Paused
            });
        }
    }
}
