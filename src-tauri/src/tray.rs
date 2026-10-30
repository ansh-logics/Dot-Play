//! Menu bar (status bar) controls.
//!
//! Left-clicking the `(•)` icon toggles a mini-player popover window; right-clicking
//! opens a plain menu. Both drive playback through the same `media-control` event as the
//! system media keys, so the main window stays the single owner of playback.
//!
//! The popover is a separate web view (its own WebKit process), so it only exists while it's
//! in use: created on the first click and destroyed after it has been hidden for a while.

use crate::media_controls::{emit_action, MediaControlAction, NowPlayingInfo};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Rect, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, Wry,
};

pub const POPOVER_LABEL: &str = "tray";
const POPOVER_WIDTH: f64 = 320.0;
const POPOVER_HEIGHT: f64 = 580.0;
/// Gap between the menu bar and the popover, in logical pixels.
const POPOVER_GAP: f64 = 6.0;
/// A click on the icon this soon after the popover lost focus is the click that closed it.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

/// How long the hidden popover is kept around (instant reopen) before its web view is freed.
const IDLE_DESTROY_AFTER: Duration = Duration::from_secs(45);
/// Tells the main window whether to push queue/mode updates to the popover.
const VISIBILITY_EVENT: &str = "tray-visibility";

static LAST_BLUR_HIDE: Mutex<Option<Instant>> = Mutex::new(None);
/// Bumped every time the popover is shown, so a pending idle-destroy can tell it's stale.
static SHOW_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Release builds serve the frontend from the localhost plugin; the popover needs the URL
/// each time it is (re)created.
struct PopoverUrl(Option<tauri::Url>);

/// Menu items whose text follows the current track.
struct TrayMenu {
    title: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
}

pub fn init(app: &AppHandle, app_url: Option<tauri::Url>) -> tauri::Result<()> {
    let title = MenuItem::with_id(app, "title", "Nothing playing", false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Play", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let previous = MenuItem::with_id(app, "previous", "Previous", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show dot(.)music", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit dot(.)music", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(
        app,
        &[
            &title,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &next,
            &previous,
            &PredefinedMenuItem::separator(app)?,
            &show,
            &quit,
        ],
    )?;
    app.manage(TrayMenu { title, toggle });
    app.manage(PopoverUrl(app_url));

    // macOS tints the black template glyph to the menu bar; elsewhere it would vanish on a
    // dark taskbar, so use the app icon.
    #[cfg(target_os = "macos")]
    let icon = tauri::include_image!("icons/tray-template@2x.png");
    #[cfg(not(target_os = "macos"))]
    let icon = tauri::include_image!("icons/32x32.png");

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("dot(.)music")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => emit_action(app, MediaControlAction::Toggle),
            "next" => emit_action(app, MediaControlAction::Next),
            "previous" => emit_action(app, MediaControlAction::Previous),
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_popover(tray.app_handle(), rect);
            }
        })
        .build(app)?;
    Ok(())
}

/// Creates the (hidden) popover window.
fn build_popover(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, POPOVER_LABEL, WebviewUrl::App("tray.html".into()))
        .title("dot(.)music")
        .inner_size(POPOVER_WIDTH, POPOVER_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .focused(false)
        // Native macOS popover blur behind the transparent page.
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .radius(14.0)
                .build(),
        )
        .build()?;

    #[cfg(target_os = "macos")]
    panel::convert(&window);

    // Release builds serve the frontend from the localhost plugin (see `run`).
    if let Some(mut url) = app.state::<PopoverUrl>().0.clone() {
        url.set_path("/tray.html");
        window.navigate(url)?;
    }

    let handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            if handle.is_visible().unwrap_or(false) {
                *LAST_BLUR_HIDE.lock().unwrap() = Some(Instant::now());
                hide_popover(handle.app_handle());
            }
        }
    });
    Ok(window)
}

fn popover(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(POPOVER_LABEL)
}

fn toggle_popover(app: &AppHandle, icon: Rect) {
    if let Some(window) = popover(app) {
        if window.is_visible().unwrap_or(false) {
            hide_popover(app);
            return;
        }
    }
    // This click already closed the popover by taking focus away from it.
    if LAST_BLUR_HIDE.lock().unwrap().is_some_and(|at| at.elapsed() < REOPEN_GUARD) {
        return;
    }
    let window = match popover(app) {
        Some(window) => window,
        None => match build_popover(app) {
            Ok(window) => window,
            Err(error) => {
                log::warn!("Menu bar popover could not be created: {error}");
                return;
            }
        },
    };
    SHOW_GENERATION.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit_to("main", VISIBILITY_EVENT, serde_json::json!({ "open": true }));
    position_under_icon(app, &window, icon);
    #[cfg(target_os = "macos")]
    panel::show(&window);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Centres the popover under the tray icon, kept inside the icon's screen. With the taskbar
/// at the bottom (Windows) there is no room below, so it opens above the icon instead.
fn position_under_icon<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, icon: Rect) {
    let monitor = app
        .monitor_from_point(
            icon.position.to_physical::<f64>(1.0).x,
            icon.position.to_physical::<f64>(1.0).y,
        )
        .ok()
        .flatten();
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let icon_pos = icon.position.to_physical::<f64>(scale);
    let icon_size = icon.size.to_physical::<f64>(scale);

    let width = POPOVER_WIDTH * scale;
    let height = POPOVER_HEIGHT * scale;
    let mut x = icon_pos.x + icon_size.width / 2.0 - width / 2.0;
    let mut y = icon_pos.y + icon_size.height + POPOVER_GAP * scale;
    if let Some(monitor) = monitor {
        let left = monitor.position().x as f64;
        let right = left + monitor.size().width as f64;
        let bottom = monitor.position().y as f64 + monitor.size().height as f64;
        let margin = 8.0 * scale;
        x = x.clamp(left + margin, (right - width - margin).max(left + margin));
        if y + height > bottom {
            y = icon_pos.y - height - POPOVER_GAP * scale;
        }
    }
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/// Hides the popover and frees its web view if it stays unused.
fn hide_popover(app: &AppHandle) {
    let Some(window) = popover(app) else { return };
    if !window.is_visible().unwrap_or(false) {
        return; // already hidden; its idle-destroy is already scheduled
    }
    let _ = window.hide();
    let _ = app.emit_to("main", VISIBILITY_EVENT, serde_json::json!({ "open": false }));

    let generation = SHOW_GENERATION.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(IDLE_DESTROY_AFTER);
        if SHOW_GENERATION.load(Ordering::SeqCst) != generation {
            return; // shown again since
        }
        // AppKit work belongs on the main thread.
        let main = app.clone();
        let _ = app.run_on_main_thread(move || {
            if SHOW_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let Some(window) = popover(&main) else { return };
            if window.is_visible().unwrap_or(true) {
                return;
            }
            // tao tears the window down as its own window class; hand it back first.
            #[cfg(target_os = "macos")]
            panel::restore(&window);
            let _ = window.destroy();
        });
    });
}

/// Called while the app is exiting: the popover is torn down with everything else, so it
/// must be tao's window class again by then (see `panel::restore`).
pub fn prepare_exit(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(window) = popover(app) {
        panel::restore(&window);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn show_main(app: &AppHandle) {
    hide_popover(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Keeps the right-click menu's song title and Play/Pause label current.
pub fn refresh_menu(app: &AppHandle, info: Option<&NowPlayingInfo>) {
    let Some(menu) = app.try_state::<TrayMenu>() else { return };
    let title = match info {
        Some(info) if info.artist.is_empty() => info.title.clone(),
        Some(info) => format!("{} · {}", info.title, info.artist),
        None => "Nothing playing".to_string(),
    };
    let _ = menu.title.set_text(truncate(&title, 48));
    let playing = info.is_some_and(|info| info.is_playing);
    let _ = menu.toggle.set_text(if playing { "Pause" } else { "Play" });
    let _ = menu.toggle.set_enabled(info.is_some());
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
pub fn hide_tray_popover(app: AppHandle) {
    hide_popover(&app);
}

/// The popover as a non-activating panel, so it opens over full-screen apps.
///
/// A plain window only appears in another app's full-screen Space when it is marked
/// full-screen auxiliary, and focusing it would activate dot(.)music, which makes macOS
/// switch to the app's own Space. A non-activating `NSPanel` can take keyboard focus
/// without activating the app (like Spotlight), so neither happens.
#[cfg(target_os = "macos")]
mod panel {
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{define_class, ClassType, MainThreadOnly};
    use objc2_app_kit::{
        NSPanel, NSResponder, NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior,
        NSWindowStyleMask,
    };
    use objc2_foundation::NSObject;
    use std::sync::atomic::{AtomicPtr, Ordering};
    use tauri::WebviewWindow;

    /// tao's own window class, saved by `convert` so `restore` can put it back.
    static ORIGINAL_CLASS: AtomicPtr<AnyClass> = AtomicPtr::new(std::ptr::null_mut());

    define_class!(
        // Borderless panels refuse key status by default; the popover needs it for
        // keyboard shortcuts and to notice clicks elsewhere (losing focus hides it).
        #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "DotMusicTrayPanel"]
        struct TrayPanel;

        impl TrayPanel {
            #[unsafe(method(canBecomeKeyWindow))]
            fn can_become_key_window(&self) -> bool {
                true
            }
        }
    );

    fn ns_window(window: &WebviewWindow) -> Option<&NSWindow> {
        let ptr = window.ns_window().ok()?.cast::<NSWindow>();
        // SAFETY: Tauri's NSWindow lives as long as the WebviewWindow and is only used here
        // on the main thread.
        unsafe { ptr.as_ref() }
    }

    /// Turns the popover's NSWindow into a non-activating panel. Must run on the main thread.
    pub fn convert(window: &WebviewWindow) {
        let Some(ns_window) = ns_window(window) else { return };
        unsafe {
            let object = ns_window as *const NSWindow as *const AnyObject;
            ORIGINAL_CLASS.store(objc2::ffi::object_getClass(object) as *mut AnyClass, Ordering::SeqCst);
            // NSPanel adds no instance variables to NSWindow, so swapping the class of the
            // existing window is safe (the approach tauri-nspanel uses).
            objc2::ffi::object_setClass(
                ns_window as *const NSWindow as *mut AnyObject,
                TrayPanel::class() as *const AnyClass,
            );
            ns_window.setStyleMask(ns_window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
            ns_window.setLevel(NSStatusWindowLevel);
            ns_window.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
            // Panels hide when their app deactivates by default; ours is never active.
            ns_window.setHidesOnDeactivate(false);
        }
    }

    /// Turns the panel back into tao's window class before the window is destroyed.
    /// tao's teardown expects its own class; closing it as a panel raises an Objective-C
    /// exception that aborts the app. Must run on the main thread.
    pub fn restore(window: &WebviewWindow) {
        let Some(ns_window) = ns_window(window) else { return };
        let original = ORIGINAL_CLASS.load(Ordering::SeqCst);
        if original.is_null() {
            return;
        }
        // The non-activating flag is only valid on panels.
        ns_window.setStyleMask(ns_window.styleMask() & !NSWindowStyleMask::NonactivatingPanel);
        unsafe {
            objc2::ffi::object_setClass(
                ns_window as *const NSWindow as *mut AnyObject,
                original as *const AnyClass,
            );
        }
    }

    /// Shows the panel on the current Space and gives it focus without activating the app.
    pub fn show(window: &WebviewWindow) {
        let Some(ns_window) = ns_window(window) else { return };
        ns_window.orderFrontRegardless();
        ns_window.makeKeyWindow();
    }
}
