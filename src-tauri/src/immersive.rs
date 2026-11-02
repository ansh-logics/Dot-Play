//! Immersive mode: a full-screen clock and the current song on every display.
//!
//! One borderless window per chosen display, above the menu bar and the Dock (the
//! screensaver's window level), each showing `immersive.html`. Settings lists the displays
//! (`list_immersive_displays`) and says which ones are turned off (`set_immersive_screens`).
//! Which view a display shows (the clock, the lyrics or the artwork) is the page's choice;
//! Rust only says which display it is.
//!
//! Two ways in:
//! - **Manual** (the I key, the Now Playing button, the menu bar menu). The windows take
//!   focus so the keyboard works; Esc, or switching to another app, leaves.
//! - **Idle**, like a screensaver: after the chosen number of minutes without input while
//!   music plays. The windows never take focus (the app you were in stays active), and any
//!   input at all leaves. The idle time comes from the system's own input counter, which
//!   needs no Accessibility or Input Monitoring permission.

use crate::media_controls::LastNowPlaying;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const LABEL_PREFIX: &str = "immersive-";
/// Tells the main window whether to push immersive state (see useImmersiveBridge).
const VISIBILITY_EVENT: &str = "immersive-visibility";
/// Tells every window which displays are turned off and how many show immersive mode.
const DISPLAYS_EVENT: &str = "immersive-displays";
/// Input this soon after an idle start is the tail of what was already happening, not the
/// user coming back.
const IDLE_EXIT_GRACE: Duration = Duration::from_millis(1500);

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Trigger {
    Manual,
    Idle,
}

struct Session {
    trigger: Trigger,
    opened_at: Instant,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// Minutes without input before immersive mode starts on its own; 0 = never.
static IDLE_MINUTES: AtomicU32 = AtomicU32::new(0);
/// Displays (by `screen_key`) the user turned off in Settings.
static SCREENS_OFF: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Release builds serve the frontend from the localhost plugin.
struct AppUrl(Option<tauri::Url>);

/// What each window is told about itself, as `window.__IMMERSIVE__`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenInfo {
    /// Position in `list_immersive_displays`; 0 is the display the main window is on (or the
    /// main display). Picks the default view.
    index: usize,
    /// How many displays are showing immersive mode.
    count: usize,
    /// Remembers the view chosen for this display between sessions.
    screen_key: String,
    trigger: Trigger,
}

pub fn init(app: &AppHandle, app_url: Option<tauri::Url>) {
    app.manage(AppUrl(app_url));
    let app = app.clone();
    std::thread::spawn(move || idle_watch(app));
}

fn is_immersive(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

fn windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| is_immersive(label))
        .map(|(_, window)| window)
        .collect()
}

/// Opens immersive mode on every chosen display. Must NOT run on the main thread: on Windows,
/// creating a webview window from the main thread (an event handler or `run_on_main_thread`)
/// deadlocks, so the windows are built here and only shown from the main thread.
fn open(app: &AppHandle, trigger: Trigger) {
    {
        let mut session = SESSION.lock().unwrap();
        if let Some(current) = session.as_mut() {
            // Asking for it by hand while the idle version shows turns it into the manual one.
            if trigger == Trigger::Manual && current.trigger == Trigger::Idle {
                current.trigger = Trigger::Manual;
                if let Some(first) = windows(app).into_iter().min_by_key(|w| w.label().to_string()) {
                    let _ = first.set_focus();
                }
            }
            return;
        }
        *session = Some(Session { trigger, opened_at: Instant::now() });
    }

    let all = ordered_monitors(app);
    let shown: Vec<(usize, &Monitor)> = {
        let off = SCREENS_OFF.lock().unwrap();
        let on: Vec<_> = all
            .iter()
            .enumerate()
            .filter(|(_, m)| !off.as_ref().is_some_and(|off| off.contains(&screen_key(m))))
            .collect();
        // Never nothing at all: with every display turned off, use the first.
        if on.is_empty() { all.iter().enumerate().take(1).collect() } else { on }
    };
    let count = shown.len();
    let mut built = Vec::new();
    for (index, monitor) in shown {
        let info = ScreenInfo {
            index,
            count,
            screen_key: screen_key(monitor),
            trigger,
        };
        match build_window(app, monitor, &info) {
            Ok(window) => built.push(window),
            Err(error) => log::warn!("Immersive window {index} could not be created: {error}"),
        }
    }

    if built.is_empty() {
        *SESSION.lock().unwrap() = None;
        return;
    }
    // The first one built is the display dot(.)music is on: it takes the keyboard.
    show(app, built, trigger == Trigger::Manual);
    let _ = app.emit_to("main", VISIBILITY_EVENT, serde_json::json!({ "open": true }));
}

/// Shows freshly built windows above everything, on the main thread (AppKit requires it), and
/// optionally gives the first one keyboard focus.
fn show(app: &AppHandle, windows: Vec<WebviewWindow>, focus_first: bool) {
    let _ = app.run_on_main_thread(move || {
        for window in &windows {
            #[cfg(target_os = "macos")]
            native::raise(window);
            #[cfg(not(target_os = "macos"))]
            let _ = window.show();
        }
        if focus_first {
            if let Some(first) = windows.first() {
                let _ = first.set_focus();
            }
        }
    });
}

/// Closes every immersive window. Must run on the main thread.
fn close(app: &AppHandle) {
    if SESSION.lock().unwrap().take().is_none() {
        return;
    }
    for window in windows(app) {
        let _ = window.destroy();
    }
    let _ = app.emit_to("main", VISIBILITY_EVENT, serde_json::json!({ "open": false }));
}

/// The display the main window is on first (that's where the user looks), then the rest
/// from left to right.
fn ordered_monitors(app: &AppHandle) -> Vec<Monitor> {
    let mut monitors = app.available_monitors().unwrap_or_default();
    let first = app
        .get_webview_window("main")
        .filter(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    monitors.sort_by_key(|m| m.position().x);
    if let Some(first) = first {
        if let Some(at) = monitors.iter().position(|m| same_monitor(m, &first)) {
            let m = monitors.remove(at);
            monitors.insert(0, m);
        }
    }
    monitors
}

fn same_monitor(a: &Monitor, b: &Monitor) -> bool {
    a.position() == b.position() && a.size() == b.size()
}

/// Display names can repeat (two of the same model), so the position is part of the key.
fn screen_key(monitor: &Monitor) -> String {
    let name = monitor.name().cloned().unwrap_or_else(|| "Display".into());
    format!("{name}@{},{}", monitor.position().x, monitor.position().y)
}

fn build_window(app: &AppHandle, monitor: &Monitor, info: &ScreenInfo) -> tauri::Result<WebviewWindow> {
    // Monitor geometry is physical; the display's own scale turns it into the logical
    // points windows are placed in (displays can have different scales).
    let scale = monitor.scale_factor();
    let position: LogicalPosition<f64> = monitor.position().to_logical(scale);
    let size: LogicalSize<f64> = monitor.size().to_logical(scale);
    let script = format!(
        "window.__IMMERSIVE__ = {};",
        serde_json::to_string(info).unwrap_or_else(|_| "null".into())
    );

    let window = WebviewWindowBuilder::new(
        app,
        format!("{LABEL_PREFIX}{}", info.index),
        WebviewUrl::App("immersive.html".into()),
    )
    .title("dot(.)music")
    .position(position.x, position.y)
    .inner_size(size.width, size.height)
    .decorations(false)
    .resizable(false)
    // Transparent, so the page can fade the screen to black instead of cutting to it.
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false)
    .focused(false)
    .initialization_script(script)
    .build()?;

    // Release builds serve the frontend from the localhost plugin (see `run`).
    if let Some(mut url) = app.state::<AppUrl>().0.clone() {
        url.set_path("/immersive.html");
        window.navigate(url)?;
    }

    let app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            leave_if_app_left(&app);
        }
    });
    Ok(window)
}

/// A manual session ends when the user switches to another app (focus moving between our
/// own windows is fine). Checked a moment later, once focus has landed somewhere.
fn leave_if_app_left(app: &AppHandle) {
    let manual = SESSION.lock().unwrap().as_ref().is_some_and(|s| s.trigger == Trigger::Manual);
    if !manual {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        let main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let ours_focused = main
                .webview_windows()
                .values()
                .any(|w| w.is_focused().unwrap_or(false));
            if !ours_focused {
                close(&main);
            }
        });
    });
}

/// Starts immersive mode after the chosen idle time while music plays, and ends an idle
/// session as soon as there's any input.
fn idle_watch(app: AppHandle) {
    loop {
        let session = SESSION
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| (s.trigger, s.opened_at.elapsed()));
        let idle = idle_seconds();

        match session {
            Some((Trigger::Idle, elapsed)) => {
                if elapsed > IDLE_EXIT_GRACE && idle.is_some_and(|s| s < 1.0) {
                    let main = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        // Still the idle session (not closed or made manual meanwhile)?
                        let idle_session = SESSION
                            .lock()
                            .unwrap()
                            .as_ref()
                            .is_some_and(|s| s.trigger == Trigger::Idle);
                        if idle_session {
                            close(&main);
                        }
                    });
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Some((Trigger::Manual, _)) => std::thread::sleep(Duration::from_secs(1)),
            None => {
                let minutes = IDLE_MINUTES.load(Ordering::Relaxed);
                let playing = app
                    .state::<LastNowPlaying>()
                    .0
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|s| s.info.is_playing);
                if minutes > 0 && playing && idle.is_some_and(|s| s >= f64::from(minutes) * 60.0) {
                    open(&app, Trigger::Idle); // this thread isn't the main one
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }
}

/// Seconds since the last keyboard, mouse or trackpad input anywhere on the system.
#[cfg(target_os = "macos")]
fn idle_seconds() -> Option<f64> {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT: u32 = !0;
    // SAFETY: a plain C query with no pointers.
    Some(unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) })
}

#[cfg(not(target_os = "macos"))]
fn idle_seconds() -> Option<f64> {
    None
}

/// Async, so it runs off the main thread (see `open`).
#[tauri::command]
pub async fn open_immersive(app: AppHandle) {
    open(&app, Trigger::Manual);
}

#[tauri::command]
pub fn close_immersive(app: AppHandle) {
    let main = app.clone();
    let _ = app.run_on_main_thread(move || close(&main));
}

/// Esc in immersive mode: one step back, to the app window with the player open (or home
/// when nothing plays). The ✕ button and idle input leave without opening anything.
#[tauri::command]
pub fn leave_immersive_to_player(app: AppHandle) {
    let main = app.clone();
    let _ = app.run_on_main_thread(move || {
        close(&main);
        crate::shortcuts::open_player(&main);
    });
}

/// One display as Settings shows it, in logical points.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    key: String,
    name: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// Pixels, for the resolution label.
    pixel_width: u32,
    pixel_height: u32,
    /// The display dot(.)music is on (it shows the clock by default).
    is_app_display: bool,
}

/// The displays in the order immersive mode uses them.
#[tauri::command]
pub fn list_immersive_displays(app: AppHandle) -> Vec<DisplayInfo> {
    ordered_monitors(&app)
        .iter()
        .enumerate()
        .map(|(index, m)| {
            let scale = m.scale_factor();
            let position: LogicalPosition<f64> = m.position().to_logical(scale);
            let size: LogicalSize<f64> = m.size().to_logical(scale);
            DisplayInfo {
                key: screen_key(m),
                name: m.name().cloned().unwrap_or_else(|| format!("Display {}", index + 1)),
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                pixel_width: m.size().width,
                pixel_height: m.size().height,
                is_app_display: index == 0,
            }
        })
        .collect()
}

/// The displays (by key) that should not show immersive mode.
#[tauri::command]
pub fn set_immersive_screens(off: Vec<String>) {
    *SCREENS_OFF.lock().unwrap() = Some(off.into_iter().collect());
}

/// Turns one display on or off from the controls on any display, live: a window appears on
/// it or goes away, and every window is told so its display chips stay in step. The last
/// display showing immersive mode can't be turned off (✕ leaves instead).
/// Async, so it runs off the main thread: turning a display on builds a window (see `open`).
#[tauri::command]
pub async fn set_immersive_display(app: AppHandle, key: String, on: bool) {
    let main = app;
    {
        let all = ordered_monitors(&main);
        let Some(index) = all.iter().position(|m| screen_key(m) == key) else { return };
        let label = format!("{LABEL_PREFIX}{index}");
        let open_windows = windows(&main);
        let is_open = open_windows.iter().any(|w| w.label() == label);
        if !on && is_open && open_windows.len() <= 1 {
            return;
        }

        {
            let mut off = SCREENS_OFF.lock().unwrap();
            let off = off.get_or_insert_with(HashSet::new);
            if on {
                off.remove(&key);
            } else {
                off.insert(key.clone());
            }
        }

        let trigger = SESSION.lock().unwrap().as_ref().map(|s| s.trigger);
        let mut count = open_windows.len();
        if let Some(trigger) = trigger {
            if on && !is_open {
                let info = ScreenInfo { index, count: count + 1, screen_key: key.clone(), trigger };
                match build_window(&main, &all[index], &info) {
                    Ok(window) => {
                        show(&main, vec![window], false);
                        count += 1;
                    }
                    Err(error) => log::warn!("Immersive window {index} could not be created: {error}"),
                }
            } else if !on && is_open {
                if let Some(window) = main.get_webview_window(&label) {
                    // Hand focus to another display first, or losing it would end a manual session.
                    if window.is_focused().unwrap_or(false) {
                        if let Some(other) = open_windows.iter().find(|w| w.label() != label) {
                            let _ = other.set_focus();
                        }
                    }
                    let _ = window.destroy();
                    count -= 1;
                }
            }
        }

        let off: Vec<String> = SCREENS_OFF.lock().unwrap().iter().flatten().cloned().collect();
        let _ = main.emit(DISPLAYS_EVENT, serde_json::json!({ "off": off, "count": count }));
    }
}

/// Minutes without input before immersive mode starts by itself; 0 turns it off.
#[tauri::command]
pub fn set_immersive_idle(minutes: u32) {
    IDLE_MINUTES.store(minutes, Ordering::Relaxed);
}

/// Opens it from the menu bar menu. Menu events arrive on the main thread, so the windows are
/// built from another one (see `open`).
pub fn open_manual(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || open(&app, Trigger::Manual));
}

#[cfg(target_os = "macos")]
mod native {
    use objc2_app_kit::{NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior};
    use tauri::WebviewWindow;

    /// Puts the window above the menu bar and the Dock on every Space (including other
    /// apps' full-screen Spaces) and shows it without activating the app. Main thread only.
    pub fn raise(window: &WebviewWindow) {
        let Ok(ptr) = window.ns_window() else { return };
        // SAFETY: Tauri's NSWindow lives as long as the WebviewWindow and is only used here
        // on the main thread.
        let Some(ns_window) = (unsafe { ptr.cast::<NSWindow>().as_ref() }) else { return };
        ns_window.setLevel(NSScreenSaverWindowLevel);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        ns_window.orderFrontRegardless();
    }
}
