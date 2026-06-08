//! Bridge integration smoke test.
//!
//! Spawns the real pix-desktop-sidecar and verifies the JSONL round-trip:
//! a `get_state` request must return a `{success:true, data:{sessionId,
//! sessionFile, model, ...}}` response. We deliberately avoid anything
//! that hits a real LLM provider so the test stays hermetic.

use std::path::PathBuf;
use std::time::Duration;

use pix_tui::bridge::{spawn_bridge, BridgeEvent};
use serial_test::serial;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[serial]
async fn bridge_roundtrip_get_state() -> anyhow::Result<()> {
    // Skip when the sidecar dist is not built (CI bootstrap path).
    let cwd = std::env::temp_dir().join("pix-tui-bridge-smoke");
    std::fs::create_dir_all(&cwd)?;

    let bridge = tokio::time::timeout(Duration::from_secs(15), spawn_bridge(Some(cwd.clone())))
        .await
        .map_err(|_| anyhow::anyhow!("timed out spawning bridge"))??;
    let client = bridge.client.clone();

    // Wait for "sidecar ready" on stderr before sending commands.
    let mut events = bridge.events;
    let mut saw_ready = false;
    let state = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let Some(ev) = events.recv().await else {
                break;
            };
            match ev {
                BridgeEvent::Stderr(line) if line.contains("sidecar ready") => {
                    saw_ready = true;
                }
                BridgeEvent::Stderr(_) => {}
                BridgeEvent::Ready => {
                    saw_ready = true;
                }
                BridgeEvent::Exit(code) => {
                    anyhow::bail!("sidecar exited early (code={code:?})");
                }
                BridgeEvent::Event { .. } => {}
            }
            if saw_ready {
                break;
            }
        }
        let state = client.get_state().await?;
        anyhow::Ok::<serde_json::Value>(state)
    })
    .await
    .map_err(|_| anyhow::anyhow!("timed out waiting for ready/get_state"))??;

    assert!(
        state.get("sessionId").and_then(|v| v.as_str()).is_some(),
        "missing sessionId in response: {state}"
    );
    assert!(
        state.get("model").is_some(),
        "missing model in response: {state}"
    );

    bridge.handle.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[serial]
async fn bridge_roundtrip_undo_last_turn() -> anyhow::Result<()> {
    let cwd = std::env::temp_dir().join("pix-tui-bridge-undo-smoke");
    std::fs::create_dir_all(&cwd)?;

    let bridge = tokio::time::timeout(Duration::from_secs(15), spawn_bridge(Some(cwd.clone())))
        .await
        .map_err(|_| anyhow::anyhow!("timed out spawning bridge"))??;
    let client = bridge.client.clone();
    let mut events = bridge.events;

    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let Some(ev) = events.recv().await else {
                anyhow::bail!("bridge event stream closed before ready");
            };
            match ev {
                BridgeEvent::Stderr(line) if line.contains("sidecar ready") => break,
                BridgeEvent::Exit(code) => anyhow::bail!("sidecar exited early (code={code:?})"),
                _ => {}
            }
        }
        anyhow::Ok(())
    })
    .await
    .map_err(|_| anyhow::anyhow!("timed out waiting for sidecar ready"))??;

    let prompt_result = tokio::time::timeout(
        Duration::from_secs(20),
        client.prompt("say hi in one word".to_string()),
    )
    .await;

    if let Ok(Ok(_)) = prompt_result {
        let _ = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let Some(ev) = events.recv().await else {
                    break;
                };
                match ev {
                    BridgeEvent::Event { type_, .. } if type_ == "assistant_message_end" => break,
                    BridgeEvent::Exit(_) => break,
                    _ => {}
                }
            }
        })
        .await;
    }

    let undo = tokio::time::timeout(Duration::from_secs(10), client.undo_last_turn())
        .await
        .map_err(|_| anyhow::anyhow!("undo_last_turn timed out"))?;

    match prompt_result {
        Ok(Ok(_)) => undo.map(|_| ())?,
        Ok(Err(_)) | Err(_) => assert!(
            undo.is_err(),
            "undo_last_turn unexpectedly succeeded after failed prompt"
        ),
    }

    bridge.handle.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[serial]
async fn bridge_roundtrip_new_session() -> anyhow::Result<()> {
    let cwd = std::env::temp_dir().join("pix-tui-bridge-new-session-smoke");
    std::fs::create_dir_all(&cwd)?;

    let bridge = tokio::time::timeout(Duration::from_secs(15), spawn_bridge(Some(cwd.clone())))
        .await
        .map_err(|_| anyhow::anyhow!("timed out spawning bridge"))??;
    let client = bridge.client.clone();
    let mut events = bridge.events;

    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let Some(ev) = events.recv().await else {
                anyhow::bail!("bridge event stream closed before ready");
            };
            match ev {
                BridgeEvent::Stderr(line) if line.contains("sidecar ready") => break,
                BridgeEvent::Exit(code) => anyhow::bail!("sidecar exited early (code={code:?})"),
                _ => {}
            }
        }
        anyhow::Ok(())
    })
    .await
    .map_err(|_| anyhow::anyhow!("timed out waiting for sidecar ready"))??;

    let result = tokio::time::timeout(Duration::from_secs(10), client.new_session(None))
        .await
        .map_err(|_| anyhow::anyhow!("new_session timed out"))??;

    assert!(
        !result
            .get("cancelled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        "new_session was cancelled: {result}"
    );

    let state = if result.get("sessionId").is_some() || result.get("session_id").is_some() {
        result
    } else {
        tokio::time::timeout(Duration::from_secs(10), client.get_state())
            .await
            .map_err(|_| anyhow::anyhow!("get_state after new_session timed out"))??
    };

    assert!(
        state.get("sessionId").and_then(|v| v.as_str()).is_some()
            || state.get("session_id").and_then(|v| v.as_str()).is_some(),
        "missing sessionId in response: {state}"
    );

    bridge.handle.shutdown().await?;
    Ok(())
}

#[test]
fn sidecar_locator_finds_dist() {
    // Best-effort: the locator must succeed from the repo root or its
    // ancestors when the sidecar has been built. We accept either case.
    let found = std::env::var("PIX_SIDECAR_PATH").ok().map(PathBuf::from);
    if let Some(path) = found {
        assert!(
            path.is_file(),
            "PIX_SIDECAR_PATH does not point to a file: {path:?}"
        );
        return;
    }
    match pix_tui::bridge::sidecar::locate_sidecar_main() {
        Ok(path) => assert!(path.is_file(), "located path does not exist: {path:?}"),
        Err(e) => panic!("locate_sidecar_main failed; build the sidecar first: {e}"),
    }
}
