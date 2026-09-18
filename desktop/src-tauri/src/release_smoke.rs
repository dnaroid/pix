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
                        return if status.success() {
                            Ok(())
                        } else {
                            Err(format!("Backend verification failed: {status}"))
                        }
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
        })();
        match result {
            Ok(()) => handle.exit(0),
            Err(error) => {
                eprintln!("Pix release smoke: {error}");
                handle.exit(1);
            }
        }
    });
    Ok(())
}
