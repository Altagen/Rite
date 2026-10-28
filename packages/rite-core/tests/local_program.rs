//! `LocalSession::run_program`: one program in a PTY, its arguments untouched.
//!
//! The third way a local PTY can be used, beside an interactive shell and a shell script
//! (ADR 0022 §7.2). An agent session is a vendor's CLI resumed with a conversation id and
//! a project path, and both come from a filesystem rather than from a person typing — so
//! the argv has to reach `execvp` as it was built. `run_command` cannot carry it: it
//! prepends `set -e` and hands the string to `sh -c`, which re-reads every space and
//! quote in it as syntax.
//!
//! These tests therefore assert the ABSENCE of a shell, which needs a discriminator
//! rather than a happy path. `printf '[%s]\n'` repeats its format once per argument, so an
//! argument carrying a space prints as one bracketed field if nothing re-split it, and as
//! two if something did.
//!
//! `multi_thread` for the reason `local_session.rs` gives: the PTY reader is a
//! `spawn_blocking` task and a blocking task cannot be cancelled.

use rite_core::events::{SessionEvents, SharedEvents};
use rite_core::local_terminal::LocalSession;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Spy {
    data: Mutex<Vec<u8>>,
    exits: Mutex<Vec<u32>>,
    errors: Mutex<Vec<String>>,
}

impl SessionEvents for Spy {
    fn terminal_data(&self, _id: &str, data: &[u8]) {
        self.data.lock().unwrap().extend_from_slice(data);
    }
    fn terminal_exit(&self, _id: &str, status: u32) {
        self.exits.lock().unwrap().push(status);
    }
    fn terminal_closed(&self, _id: &str) {}
    fn terminal_error(&self, _id: &str, err: &str) {
        self.errors.lock().unwrap().push(err.to_string());
    }
    fn connection_dead(&self, _: &str, _: &str) {}
    fn host_key_unknown(&self, _: &str, _: u16, _: &str, _: &str) {}
    fn host_key_added(&self, _: &str, _: u16, _: &str, _: &str) {}
    fn host_key_changed(&self, _: &str, _: u16, _: &str, _: &str) {}
}

/// Everything the program wrote: the buffer it filled before anyone claimed it, plus what
/// streamed after. Claimed exactly once, as the frontend does — a second call returns
/// empty, which is the trap `local_session.rs` documents.
async fn ran(argv: &[&str], cwd: Option<std::path::PathBuf>) -> (String, Option<u32>) {
    let spy = Arc::new(Spy::default());
    let events: SharedEvents = spy.clone();
    let session =
        LocalSession::run_program(events, argv.iter().map(|s| s.to_string()).collect(), cwd)
            .await
            .expect("the program should start");

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut buffered = Vec::new();
    while std::time::Instant::now() < deadline {
        buffered.extend_from_slice(&session.claim_initial_output());
        if !spy.exits.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut all = String::from_utf8_lossy(&buffered).into_owned();
    all.push_str(&String::from_utf8_lossy(&spy.data.lock().unwrap()));
    let status = spy.exits.lock().unwrap().first().copied();
    (all, status)
}

/// An argument carrying a space arrives as ONE argument.
///
/// Through `sh -c` the same argv would print `[two]` and `[words]` on separate lines. The
/// apostrophe is the second half of the discriminator: a shell re-reading it would not
/// split, it would hang waiting for the quote to close.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_argument_is_not_re_split_by_a_shell() {
    let (out, status) = ran(
        &["/usr/bin/printf", "[%s]\n", "two words", "it's", "a|b"],
        None,
    )
    .await;

    assert_eq!(status, Some(0), "printf should exit 0; it wrote {out:?}");
    assert!(
        out.contains("[two words]"),
        "the space was re-read as a separator: {out:?}"
    );
    assert!(
        out.contains("[it's]"),
        "the apostrophe was re-read as a quote: {out:?}"
    );
    assert!(
        out.contains("[a|b]"),
        "the pipe was re-read as a pipe: {out:?}"
    );
    assert!(
        !out.contains("[two]"),
        "something split the argument: {out:?}"
    );
}

/// The program starts in the directory it was given — including one with a space in its
/// name, which is the case a shell between would have broken.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_program_starts_where_it_was_told() {
    let dir = tempfile::tempdir().unwrap();
    let here = dir.path().join("a project");
    std::fs::create_dir(&here).unwrap();
    // The spawn resolves symlinks (/tmp is one on some systems), so compare against what
    // the kernel will actually report rather than against the path as written.
    let expected = here.canonicalize().unwrap();

    let (out, status) = ran(&["/usr/bin/pwd"], Some(here)).await;

    assert_eq!(status, Some(0), "pwd should exit 0; it wrote {out:?}");
    assert!(
        out.contains(expected.to_str().unwrap()),
        "started somewhere else; pwd said {out:?}, expected {expected:?}"
    );
}

/// A directory that is gone is ignored rather than fatal, exactly as `spawn` treats it: an
/// agent resumed into a project that moved should start and be wrong about where.
///
/// This one pins the OUTCOME and cannot pin the guard, and the difference is recorded
/// rather than papered over: removing `filter(|d| d.is_dir())` leaves it green on Linux,
/// because portable-pty accepts an unusable `cwd` and the child starts in this process's
/// directory anyway (measured against 0.9). The guard exists for Windows, which this
/// suite does not run. So the assertion is the one that holds on every platform.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_directory_that_is_gone_does_not_lose_the_session() {
    let gone = std::path::PathBuf::from("/nonexistent-rite-project-a9f3");
    let (out, status) = ran(&["/usr/bin/pwd"], Some(gone)).await;

    assert_eq!(
        status,
        Some(0),
        "the session should still have started; it wrote {out:?}"
    );
}

/// A program that does not exist fails the call.
///
/// This is the one that earns the separate code path. The shell resolution the other two
/// kinds use walks a fallback list and ends at `/bin/sh`, so borrowing it here would have
/// answered a missing `claude` binary with an anonymous shell prompt — a session that
/// looks alive and is not the thing that was asked for.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_program_that_is_not_installed_is_an_error_not_a_shell() {
    let spy = Arc::new(Spy::default());
    let events: SharedEvents = spy.clone();
    let result = LocalSession::run_program(
        events,
        vec!["/usr/bin/rite-no-such-agent-cli".to_string()],
        None,
    )
    .await;

    assert!(result.is_err(), "a missing program must not open a session");
}

/// An empty argv is refused rather than spawning whatever comes first.
///
/// Belt and braces, deliberately: `run_program` rejects it by name, and removing that
/// rejection leaves the test green because `CommandBuilder::new("")` then fails the spawn.
/// Two refusals for one mistake is right here — the explicit one gives a message a caller
/// can act on ("A program needs a name") instead of an OS error about an empty path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_argv_is_refused() {
    let spy = Arc::new(Spy::default());
    let events: SharedEvents = spy.clone();
    assert!(
        LocalSession::run_program(events.clone(), vec![], None)
            .await
            .is_err(),
        "no argv, no program"
    );
    assert!(
        LocalSession::run_program(events, vec![String::new()], None)
            .await
            .is_err(),
        "an empty name is not a program"
    );
}

/// The terminal variables a program is entitled to, and not the fish workarounds.
///
/// `TERM_PROGRAM=vscode` is a lie the shell path tells on purpose, because fish trusts it
/// and stops probing the terminal. An agent CLI reads that same variable to decide how to
/// render, so passing it on would make every agent believe it runs inside an editor.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_program_is_told_about_the_terminal_but_not_lied_to() {
    let (out, status) = ran(&["/usr/bin/env"], None).await;

    assert_eq!(status, Some(0), "env should exit 0; it wrote {out:?}");
    assert!(
        out.contains("TERM=xterm-256color"),
        "TERM is missing: {out:?}"
    );
    assert!(
        out.contains("COLORTERM=truecolor"),
        "COLORTERM is missing: {out:?}"
    );
    assert!(
        !out.contains("TERM_PROGRAM"),
        "the fish workaround reached an arbitrary program: {out:?}"
    );
    assert!(
        !out.contains("fish_"),
        "a fish variable reached an arbitrary program: {out:?}"
    );
}
