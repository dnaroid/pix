//! Play a short alert independently of the macOS notification center.

#[tauri::command]
pub fn desktop_play_notification_sound(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSBeep, NSSound};
        use objc2_foundation::NSString;

        return app
            .run_on_main_thread(|| {
                // NSSound playback is asynchronous, including when the WebView is
                // hidden. A native cue avoids WebKit background/audio unlock limits.
                let played = NSSound::soundNamed(&NSString::from_str("Pop"))
                    .map(|sound| sound.play())
                    .unwrap_or(false);
                if !played {
                    NSBeep();
                }
            })
            .map_err(|error| error.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Pix notification sounds are supported on macOS only".into())
    }
}
