//! Trackpad haptic feedback.

/// Plays a Force Touch trackpad haptic (the player-style wheel's notch "click").
/// macOS only delivers it while a finger is on a Force Touch trackpad with
/// "Force Click and haptic feedback" enabled; elsewhere this is a no-op.
#[tauri::command]
pub(crate) fn perform_haptic(app: tauri::AppHandle, pattern: Option<String>) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{
            NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime,
            NSHapticFeedbackPerformer,
        };
        let pattern = match pattern.as_deref() {
            Some("level") => NSHapticFeedbackPattern::LevelChange,
            Some("generic") => NSHapticFeedbackPattern::Generic,
            _ => NSHapticFeedbackPattern::Alignment,
        };
        // AppKit feedback performers belong to the main thread.
        let _ = app.run_on_main_thread(move || {
            NSHapticFeedbackManager::defaultPerformer()
                .performFeedbackPattern_performanceTime(pattern, NSHapticFeedbackPerformanceTime::Now);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, pattern);
}
