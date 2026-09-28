//! Tests for the pre-connect hook (`SessionManager::run_preconnect`).
//!
//! A pre-connect command is the gate in front of an SSH connection: `wg-quick up`,
//! `tailscale up`, `aws sso login`, `kinit`. The UI opens SSH only when it exits 0,
//! so the exit status it reports — and the fail-fast behaviour that produces it —
//! are the feature's whole contract. It runs in a local one-shot PTY, so no SSH
//! server is involved here.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rite_core::auth::AuthManager;
use rite_core::db::Database;
use rite_core::events::{SessionEvents, SharedEvents};
use rite_core::terminal::SessionManager;

/// Records what the pre-connect session reported: its output and its exit status.
#[derive(Default)]
struct Spy {
    out: Arc<Mutex<Vec<u8>>>,
    exit: Arc<Mutex<Option<u32>>>,
}

impl SessionEvents for Spy {
    fn terminal_data(&self, _session_id: &str, data: &[u8]) {
        self.out.lock().unwrap().extend_from_slice(data);
    }
    fn terminal_exit(&self, _session_id: &str, exit_status: u32) {
        *self.exit.lock().unwrap() = Some(exit_status);
    }
    fn terminal_closed(&self, _session_id: &str) {}
    fn terminal_error(&self, _session_id: &str, _error: &str) {}
    fn connection_dead(&self, _session_id: &str, _reason: &str) {}
    fn host_key_unknown(&self, _host: &str, _port: u16, _key_type: &str, _fingerprint: &str) {}
    fn host_key_added(&self, _host: &str, _port: u16, _key_type: &str, _fingerprint: &str) {}
    fn host_key_changed(&self, _host: &str, _port: u16, _old_fp: &str, _new_fp: &str) {}
}

/// Wait for the command to report an exit status, or give up.
async fn wait_for_exit(spy: &Spy, timeout: Duration) -> Option<u32> {
    let start = std::time::Instant::now();
    loop {
        if let Some(code) = *spy.exit.lock().unwrap() {
            return Some(code);
        }
        if start.elapsed() > timeout {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Everything the session produced. Like an SSH session, a local one buffers its
/// output until the frontend claims it, so a test has to claim too — otherwise it
/// only sees whatever was streamed after the claim.
async fn output(mgr: &SessionManager, session_id: &str, spy: &Spy) -> String {
    let buffered = mgr.claim_session_output(session_id).await;
    let mut all = buffered;
    all.extend_from_slice(&spy.out.lock().unwrap());
    String::from_utf8_lossy(&all).into_owned()
}

async fn manager() -> (tempfile::TempDir, SessionManager) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(&dir.path().join("t.db")).await.unwrap();
    let auth = AuthManager::new(db.clone());
    (dir, SessionManager::new(db.clone(), auth))
}

/// A command that succeeds reports exit 0 — the status the UI gates the SSH
/// connection on — and its output reaches the modal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preconnect_reports_success_and_output() {
    let (_dir, mgr) = manager().await;
    let spy = Arc::new(Spy::default());
    let events: SharedEvents = spy.clone();

    let id = mgr
        .run_preconnect(events, "echo preconnect-ran".to_string())
        .await
        .expect("pre-connect should start");

    assert_eq!(
        wait_for_exit(&spy, Duration::from_secs(10)).await,
        Some(0),
        "a successful hook must report exit 0"
    );
    let out = output(&mgr, &id, &spy).await;
    assert!(
        out.contains("preconnect-ran"),
        "the command's output must reach the UI, got: {out}"
    );
}

/// A failing command reports a non-zero status, so the UI aborts instead of
/// opening SSH into a tunnel that was never brought up.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preconnect_reports_failure() {
    let (_dir, mgr) = manager().await;
    let spy = Arc::new(Spy::default());
    let events: SharedEvents = spy.clone();

    mgr.run_preconnect(events, "exit 7".to_string())
        .await
        .expect("pre-connect should start");

    assert_eq!(
        wait_for_exit(&spy, Duration::from_secs(10)).await,
        Some(7),
        "a failing hook must surface its exit status"
    );
}

/// Fail-fast: a multi-line hook stops at the first failing line rather than
/// carrying on. Without it a half-applied hook would report success from its last
/// line and SSH would open on an unprepared machine.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preconnect_stops_at_the_first_failing_command() {
    let (_dir, mgr) = manager().await;
    let spy = Arc::new(Spy::default());
    let events: SharedEvents = spy.clone();

    let id = mgr
        .run_preconnect(
            events,
            "echo first-ran\nfalse\necho SHOULD-NOT-RUN".to_string(),
        )
        .await
        .expect("pre-connect should start");

    let code = wait_for_exit(&spy, Duration::from_secs(10)).await;
    assert!(
        matches!(code, Some(c) if c != 0),
        "the hook must fail, got {code:?}"
    );

    let out = output(&mgr, &id, &spy).await;
    assert!(out.contains("first-ran"), "the first line should have run");
    assert!(
        !out.contains("SHOULD-NOT-RUN"),
        "nothing after the failing line may run, got: {out}"
    );
}
