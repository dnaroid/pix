//! Exercise native Tauri/WebView initialization and resource resolution in a moved, installed app.
//! The harness supplies an isolated profile. All filesystem/process work stays off the UI thread.
use crate::backend_runtime::BackendRuntime;
use std::{
    env,
    process::Stdio,
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

const RELEASE_SMOKE_SUCCESS_EXIT_CODE: i32 = 86;

pub fn start_if_requested(app: &tauri::App) -> Result<(), String> {
    if !env::args_os().any(|arg| arg == "--release-smoke-test") {
        return Ok(());
    }
    if env::var("PIX_RELEASE_SMOKE").as_deref() != Ok("1")
        || env::var("PI_OFFLINE").as_deref() != Ok("1")
    {
        return Err("Run release smoke through the isolated, offline release harness".into());
    }
    let handle = app.handle().clone();
    thread::spawn(move || {
        let result = (|| {
            let directory = handle
                .path()
                .resource_dir()
                .map_err(|error| error.to_string())?;
            let runtime = BackendRuntime::resolve(&directory)?;
            let mut child = runtime
                .verification_command()?
                .stdin(Stdio::null())
                .spawn()
                .map_err(|error| error.to_string())?;
            let deadline = Instant::now() + Duration::from_secs(150);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if status.success() {
                            break;
                        }
                        return Err(format!("Backend verification failed: {status}"));
                    }
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(25))
                    }
                    outcome => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!(
                            "Backend verification timed out or failed: {outcome:?}"
                        ));
                    }
                }
            }
            Ok(())
        })();
        match result {
            // Release smoke owns this process. Exit directly so the verified
            // result is observable cross-platform; AppHandle::exit only asks
            // the event loop to terminate and the eventual process code can
            // still become 0.
            Ok(()) => std::process::exit(RELEASE_SMOKE_SUCCESS_EXIT_CODE),
            Err(error) => {
                eprintln!("Pix release smoke: {error}");
                std::process::exit(1);
            }
        }
    });
    Ok(())
}
