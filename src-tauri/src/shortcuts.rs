//! Keys that work when no dot(.)music window can take them.
//!
//! With the main window minimised (or hidden) the app can still be the active one, but a
//! web page only sees keys while its window is the key window. A local event monitor sees
//! every key the app receives, so F brings the window back with the player open. A local
//! monitor only gets this app's own events: no Accessibility or Input Monitoring needed.

use tauri::{AppHandle, Emitter, Manager};

/// Tells the main window to open Now Playing.
const OPEN_PLAYER_EVENT: &str = "open-now-playing";

/// Shows the main window (as a normal window) with the player open in it.
pub fn open_player(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit_to("main", OPEN_PLAYER_EVENT, ());
}

pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::install(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSEventModifierFlags};
    use std::ptr::NonNull;
    use tauri::{AppHandle, Manager};

    /// Must run on the main thread (during setup).
    pub fn install(app: &AppHandle) {
        let app = app.clone();
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit hands the monitor a valid event for the duration of the call.
            let ns_event = unsafe { event.as_ref() };
            if is_plain_f(ns_event) && no_window_takes_keys(&app) {
                super::open_player(&app);
                return std::ptr::null_mut(); // handled: no beep
            }
            event.as_ptr()
        });
        // SAFETY: the block returns the event it was given or null, as AppKit requires.
        let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler) };
        // The monitor lives as long as the app.
        std::mem::forget(monitor);
    }

    fn is_plain_f(event: &NSEvent) -> bool {
        let modifiers = NSEventModifierFlags::Command | NSEventModifierFlags::Control | NSEventModifierFlags::Option;
        if event.modifierFlags().intersects(modifiers) {
            return false;
        }
        event
            .charactersIgnoringModifiers()
            .is_some_and(|chars| chars.to_string().eq_ignore_ascii_case("f"))
    }

    /// No window of ours would get the key: the main window is minimised or hidden and
    /// nothing else (the menu bar player, immersive mode) is the key window.
    fn no_window_takes_keys(app: &AppHandle) -> bool {
        let Some(mtm) = MainThreadMarker::new() else { return false };
        if NSApplication::sharedApplication(mtm).keyWindow().is_some() {
            return false;
        }
        app.get_webview_window("main").is_some_and(|w| {
            w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true)
        })
    }
}
