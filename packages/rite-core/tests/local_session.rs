//! A real local session, driven from Rust: opened, written to, read back, closed.
//!
//! Nothing in the Rust suite could do this before. Every local pane in the product goes
//! through this path, and it was proven only through the browser suites — thin, for the one
//! code path every terminal uses.
//!
//! WHY IT LOOKED IMPOSSIBLE (issue #380). The first attempt polled `claim_session_output`
//! in a loop waiting for the prompt, and never returned. That call is a ONE-SHOT DRAIN: it
//! takes the buffer and switches the reader to streaming mode, so the first call hands back
//! whatever had arrived by then — usually nothing, microseconds after the spawn — and every
//! later call returns empty while the output goes to `terminal_data` events instead. The
//! code was behaving as documented; the test could not pass. So output is collected through
//! the sink here, as `preconnect.rs` does.
//!
//! `multi_thread`, like the pre-connect tests: the PTY reader is a `spawn_blocking` task,
//! and a blocking task cannot be cancelled — dropping a current-thread runtime with one
//! still parked on `read()` is a teardown that waits.
//!
//! Liveness is read from the events, not from `/proc`: `terminal_exit` is emitted only
//! after `child.wait()` returns, so the event IS the proof that the shell process ended.

use rite_core::auth::AuthManager;
use rite_core::db::Database;
use rite_core::events::{SessionEvents, SharedEvents};
use rite_core::terminal::SessionManager;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Spy {
    data: Mutex<Vec<u8>>,
    exits: Mutex<Vec<u32>>,
    closed: Mutex<Vec<String>>,
}

impl SessionEvents for Spy {
    fn terminal_data(&self, _id: &str, data: &[u8]) {
        self.data.lock().unwrap().extend_from_slice(data);
    }
    fn terminal_exit(&self, _id: &str, status: u32) {
        self.exits.lock().unwrap().push(status);
    }
    fn terminal_closed(&self, id: &str) {
        self.closed.lock().unwrap().push(id.to_string());
    }
    fn terminal_error(&self, _: &str, _: &str) {}
    fn connection_dead(&self, _: &str, _: &str) {}
    fn host_key_unknown(&self, _: &str, _: u16, _: &str, _: &str) {}
    fn host_key_added(&self, _: &str, _: u16, _: &str, _: &str) {}
    fn host_key_changed(&self, _: &str, _: u16, _: &str, _: &str) {}
}

impl Spy {
    fn seen(&self) -> String {
        String::from_utf8_lossy(&self.data.lock().unwrap()).into_owned()
    }
}

async fn manager() -> (tempfile::TempDir, SessionManager) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(&dir.path().join("t.db")).await.unwrap();
    let auth = AuthManager::new(db.clone());
    (dir, SessionManager::new(db.clone(), auth))
}

/// Poll a synchronous condition until it holds. A shell answers in milliseconds, so a
/// timeout here is a failure, not a slow machine.
async fn until<F: Fn() -> bool>(f: F, within: Duration) -> bool {
    let deadline = std::time::Instant::now() + within;
    while std::time::Instant::now() < deadline {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

/// A session opens on a shell that really runs what it is sent, and the result comes back.
///
/// The command is `echo rite-$((20+22))` and the assertion is on `rite-42`: a shell echoes
/// the line you typed, so asserting on text that appears in the INPUT would pass without
/// the shell ever running anything.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_local_session_runs_what_it_is_sent() {
    let (_dir, mgr) = manager().await;
    let spy = Arc::new(Spy::default());
    let events: SharedEvents = spy.clone();

    let id = mgr
        .create_local_session(events, Some("/bin/sh".into()), None)
        .await
        .expect("a local session should open");

    assert!(mgr.has_session(&id).await, "the manager did not keep it");

    // Claim first: it drains the buffer and switches the reader to streaming, which is
    // what the spy records. Without this the output never reaches an event.
    let _ = mgr.claim_session_output(&id).await;
    mgr.send_input(&id, b"echo rite-$((20+22))\n".to_vec())
        .await
        .expect("input should reach the session");

    assert!(
        until(|| spy.seen().contains("rite-42"), Duration::from_secs(10)).await,
        "the shell never produced rite-42; it emitted: {:?}",
        spy.seen()
    );
}

/// Closing a session ends its shell: the exit is reported once, as 0, and the manager
/// stops offering it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_a_session_ends_its_shell() {
    let (_dir, mgr) = manager().await;
    let spy = Arc::new(Spy::default());
    let events: SharedEvents = spy.clone();

    let id = mgr
        .create_local_session(events, Some("/bin/sh".into()), None)
        .await
        .expect("a local session should open");

    mgr.close_session(&id).await.expect("close should succeed");

    assert!(
        until(
            || !spy.exits.lock().unwrap().is_empty(),
            Duration::from_secs(10)
        )
        .await,
        "the shell's exit was never reported, so the process may still be running"
    );
    assert_eq!(
        *spy.exits.lock().unwrap(),
        vec![0],
        "the exit status was not reported exactly once, as 0"
    );
    assert_eq!(
        *spy.closed.lock().unwrap(),
        vec![id.clone()],
        "the session that closed was not the one reported"
    );
    assert!(
        !mgr.has_session(&id).await,
        "the manager still offers a session that was closed"
    );
}

/// A split starts where the pane it came from is standing — the 0.2.6 feature, proven
/// against a real shell for the first time.
///
/// `/proc/<pid>/cwd` is how this is read, so it is Linux-only: `shell_cwd` answers `None`
/// elsewhere by design, and a split then opens where it would have.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_split_starts_where_the_pane_it_came_from_is_standing() {
    let (_dir, mgr) = manager().await;
    let spy = Arc::new(Spy::default());
    let events: SharedEvents = spy.clone();

    let first = mgr
        .create_local_session(events.clone(), Some("/bin/sh".into()), None)
        .await
        .expect("the first session should open");

    // Walk the first shell somewhere it did not start, so the inherited value cannot be
    // the directory the test process happens to sit in.
    let elsewhere = std::fs::canonicalize("/tmp").expect("/tmp");
    let _ = mgr.claim_session_output(&first).await;
    mgr.send_input(&first, b"cd /tmp\n".to_vec())
        .await
        .expect("input should reach the first session");

    let mut walked = false;
    for _ in 0..200 {
        if mgr.local_cwd(&first).await.as_ref() == Some(&elsewhere) {
            walked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(walked, "the first shell never reached /tmp");

    let second = mgr
        .create_local_session(events, Some("/bin/sh".into()), Some(&first))
        .await
        .expect("the split should open");

    assert_eq!(
        mgr.local_cwd(&second).await,
        Some(elsewhere),
        "the split did not start where the pane it came from was standing"
    );
}
