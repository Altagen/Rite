//! End-to-end transport test for the real SSH client path (`terminal.rs`).
//!
//! `terminal.rs` carries every interactive session yet had no test. Here we
//! stand up an in-process russh **server** on loopback and drive it through the
//! genuine [`SshSession::connect`] client — the same code the desktop shell and
//! rite-server run — so a regression in connect / auth / PTY / shell / data
//! round-trip / resize / close, or in host-key (MITM) rejection, fails CI.
//!
//! It exercises our client against russh's own server (not OpenSSH), so it
//! guards *our* logic, not cross-implementation interop.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rite_core::connection::{AuthMethod, Connection, ConnectionMetadata, Protocol};
use rite_core::db::Database;
use rite_core::events::{SessionEvents, SharedEvents};
use rite_core::known_hosts;
use rite_core::terminal::SshSession;

use russh::server::{
    Auth, ChannelOpenHandle, Config as ServerConfig, Handler, Msg, Server, Session,
};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;

const USER: &str = "tester";
const PASS: &str = "s3cret";
const BANNER: &[u8] = b"RITE-TEST-BANNER\r\n";

// ---------------------------------------------------------------------------
// Minimal in-process SSH server
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct TestServer;

impl Server for TestServer {
    type Handler = TestHandler;
    fn new_client(&mut self, _peer: Option<SocketAddr>) -> TestHandler {
        TestHandler
    }
}

struct TestHandler;

impl Handler for TestHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == USER && password == PASS {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    // Accept any key whose signature verifies (russh checks the signature before
    // calling this). Lets the RSA-hash-negotiation path be exercised end-to-end.
    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &russh::keys::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        // Emulate a shell's initial output (MOTD / prompt).
        session.data(channel, BANNER.to_vec())?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Deterministic echo with a marker so the round-trip is unambiguous.
        let mut out = b"echo:".to_vec();
        out.extend_from_slice(data);
        session.data(channel, out)?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _channel: ChannelId,
        _cols: u32,
        _rows: u32,
        _pw: u32,
        _ph: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// Bind an ephemeral loopback port and run the test SSH server on it.
/// Returns the port the client should dial.
async fn spawn_test_server() -> u16 {
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let config = Arc::new(ServerConfig {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(50),
        ..Default::default()
    });

    let socket = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = socket.local_addr().unwrap().port();

    tokio::spawn(async move {
        let mut server = TestServer;
        let _ = server.run_on_socket(config, &socket).await;
    });

    port
}

// ---------------------------------------------------------------------------
// Event sink spy — accumulates all session output bytes
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Spy {
    out: Arc<Mutex<Vec<u8>>>,
    host_key_changed: Arc<Mutex<bool>>,
}

impl SessionEvents for Spy {
    fn terminal_data(&self, _session_id: &str, data: &[u8]) {
        self.out.lock().unwrap().extend_from_slice(data);
    }
    fn terminal_exit(&self, _session_id: &str, _exit_status: u32) {}
    fn terminal_closed(&self, _session_id: &str) {}
    fn terminal_error(&self, _session_id: &str, _error: &str) {}
    fn connection_dead(&self, _session_id: &str, _reason: &str) {}
    fn host_key_unknown(&self, _host: &str, _port: u16, _key_type: &str, _fingerprint: &str) {}
    fn host_key_added(&self, _host: &str, _port: u16, _key_type: &str, _fingerprint: &str) {}
    fn host_key_changed(&self, _host: &str, _port: u16, _old_fp: &str, _new_fp: &str) {
        *self.host_key_changed.lock().unwrap() = true;
    }
}

/// Poll `haystack` until it contains `needle`, or the deadline passes.
async fn wait_for(haystack: &Arc<Mutex<Vec<u8>>>, needle: &[u8], timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        {
            let g = haystack.lock().unwrap();
            if g.windows(needle.len()).any(|w| w == needle) {
                return true;
            }
        }
        if start.elapsed() > timeout {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn test_db() -> (tempfile::TempDir, Arc<sqlx::SqlitePool>) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(&dir.path().join("test.db")).await.unwrap();
    let pool = Arc::new(db.pool().clone());
    (dir, pool)
}

fn test_connection(port: u16) -> Connection {
    Connection {
        id: "test-conn".into(),
        name: "test".into(),
        protocol: Protocol::SSH,
        hostname: "127.0.0.1".into(),
        port,
        username: USER.into(),
        auth_method: AuthMethod::Password {
            password: PASS.into(),
        },
        metadata: ConnectionMetadata {
            color: None,
            icon: None,
            folder: None,
            notes: None,
        },
        ssh_keep_alive_override: None,
        ssh_keep_alive_interval: None,
        created_at: 0,
        updated_at: 0,
        last_used_at: None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The full happy path: TCP connect → password auth → PTY → shell → receive the
/// server banner → send input and see it echoed → resize → close. This is the
/// contract the whole product rides on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_connects_authenticates_and_round_trips() {
    let port = spawn_test_server().await;
    let (_dir, pool) = test_db().await;

    let spy = Arc::new(Spy::default());
    let out = spy.out.clone();
    let events: SharedEvents = spy;

    // force_accept_host_key = true → Quick-SSH TOFU path (host key saved, no prompt).
    let session = SshSession::connect(
        test_connection(port),
        AuthMethod::Password {
            password: PASS.into(),
        },
        events,
        pool,
        None,
        true,
        None,
    )
    .await
    .expect("SSH session should connect and authenticate");

    // Switch to streaming and fold any already-buffered bytes into the spy, so
    // the assertion is race-free whether the banner arrived before or after.
    let buffered = session.claim_initial_output().await;
    out.lock().unwrap().extend_from_slice(&buffered);

    assert!(
        wait_for(&out, BANNER, Duration::from_secs(5)).await,
        "should receive the shell banner"
    );

    session
        .send_input(b"ping\n")
        .await
        .expect("send_input should succeed");
    assert!(
        wait_for(&out, b"echo:ping", Duration::from_secs(5)).await,
        "server should echo our input back through the channel"
    );

    session
        .resize(120, 40)
        .await
        .expect("resize should succeed");
    session.close().await.expect("close should succeed");
}

/// Security-critical: if a known host presents a *different* key, the connection
/// must be rejected (potential MITM) regardless of verification mode.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_rejects_changed_host_key() {
    let port = spawn_test_server().await;
    let (_dir, pool) = test_db().await;

    // Seed known_hosts with a DIFFERENT key for this host:port, simulating a
    // previously-trusted server whose key has since changed.
    let bogus = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
        .unwrap()
        .public_key()
        .clone();
    known_hosts::add_host_key(&pool, "127.0.0.1", port, &bogus)
        .await
        .unwrap();

    let spy = Arc::new(Spy::default());
    let changed = spy.host_key_changed.clone();
    let events: SharedEvents = spy;

    // force_accept_host_key = false → the real verification path (defaults to strict).
    let result = SshSession::connect(
        test_connection(port),
        AuthMethod::Password {
            password: PASS.into(),
        },
        events,
        pool,
        None,
        false,
        None,
    )
    .await;

    assert!(
        result.is_err(),
        "connection to a host whose key changed must be rejected"
    );
    assert!(
        *changed.lock().unwrap(),
        "a host_key_changed event must be emitted for the UI"
    );
}

/// Public-key auth with an **RSA** key — path coverage for the rsa-sha2 branch:
/// decode → `best_supported_rsa_hash()` → sign → authenticate, with no panic.
/// (russh's own server accepts both ssh-rsa and rsa-sha2, so this can't by itself
/// prove SHA-1 is refused; the OpenSSH >= 8.8 rejection is guarded by code review.
/// The point is that the RSA auth path stays working through terminal.rs.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_authenticates_with_rsa_key() {
    let port = spawn_test_server().await;
    let (dir, pool) = test_db().await;

    // Throwaway RSA key written as an OpenSSH private key on disk (the format
    // terminal.rs loads from `key_path`).
    let rsa = russh::keys::PrivateKey::random(
        &mut rand::rng(),
        russh::keys::Algorithm::Rsa { hash: None },
    )
    .expect("RSA keygen");
    let pem = rsa
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .expect("serialize RSA key");
    let key_path = dir.path().join("id_rsa");
    tokio::fs::write(&key_path, pem.as_bytes()).await.unwrap();

    let mut conn = test_connection(port);
    conn.auth_method = AuthMethod::PublicKey {
        key_path: key_path.to_string_lossy().into_owned(),
        passphrase: None,
    };

    let spy = Arc::new(Spy::default());
    let out = spy.out.clone();
    let events: SharedEvents = spy;

    let session = SshSession::connect(
        conn.clone(),
        conn.auth_method.clone(),
        events,
        pool,
        None,
        true,
        None,
    )
    .await
    .expect("RSA public-key auth should succeed with rsa-sha2 negotiation");

    let buffered = session.claim_initial_output().await;
    out.lock().unwrap().extend_from_slice(&buffered);
    assert!(
        wait_for(&out, BANNER, Duration::from_secs(5)).await,
        "should receive the shell banner after RSA auth"
    );
    session.close().await.expect("close should succeed");
}

/// A dead endpoint must surface a clean error rather than hang or panic. Here the
/// port is not listening, so connect fails fast (refused); the 20s timeout in
/// `SshSession::connect` covers the slower filtered/drop-SYN case.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_fails_cleanly_on_refused_connection() {
    // Bind then drop a listener to obtain a port that is almost certainly free.
    let dead_port = {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        l.local_addr().unwrap().port()
    };
    let (_dir, pool) = test_db().await;

    let spy = Arc::new(Spy::default());
    let events: SharedEvents = spy;

    let result = SshSession::connect(
        test_connection(dead_port),
        AuthMethod::Password {
            password: PASS.into(),
        },
        events,
        pool,
        None,
        true,
        None,
    )
    .await;

    assert!(
        result.is_err(),
        "connecting to a dead endpoint must return an error, not hang"
    );
}

// ---------------------------------------------------------------------------
// Keyboard-interactive (2FA / OTP / PAM) — a server that rejects the password
// method and drives auth via a single masked prompt.
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct KbdServer {
    label: &'static str,
    expect: &'static str,
}

impl Server for KbdServer {
    type Handler = KbdHandler;
    fn new_client(&mut self, _peer: Option<SocketAddr>) -> KbdHandler {
        KbdHandler {
            label: self.label,
            expect: self.expect,
        }
    }
}

struct KbdHandler {
    label: &'static str,
    expect: &'static str,
}

impl Handler for KbdHandler {
    type Error = russh::Error;

    // Reject the password method so the client falls through to keyboard-interactive.
    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::reject())
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        response: Option<russh::server::Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        match response {
            // First contact: issue the challenge with one masked prompt.
            None => Ok(Auth::Partial {
                name: "".into(),
                instructions: "Second factor".into(),
                prompts: std::borrow::Cow::Owned(vec![(
                    std::borrow::Cow::Owned(self.label.to_string()),
                    false,
                )]),
            }),
            // The client answered: accept iff it matches.
            Some(mut resp) => {
                let ans = resp
                    .next()
                    .map(|b| String::from_utf8_lossy(b.as_ref()).into_owned())
                    .unwrap_or_default();
                if ans == self.expect {
                    Ok(Auth::Accept)
                } else {
                    Ok(Auth::reject())
                }
            }
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, BANNER.to_vec())?;
        Ok(())
    }
}

async fn spawn_kbd_server(label: &'static str, expect: &'static str) -> u16 {
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let config = Arc::new(ServerConfig {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(50),
        ..Default::default()
    });
    let socket = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = socket.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut server = KbdServer { label, expect };
        let _ = server.run_on_socket(config, &socket).await;
    });
    port
}

/// A prompt provider that always returns canned answers (stands in for the UI).
struct StaticProvider {
    answers: Vec<String>,
}

#[async_trait::async_trait]
impl rite_core::events::InteractiveAuth for StaticProvider {
    async fn keyboard_interactive(
        &self,
        _name: &str,
        _instructions: &str,
        _prompts: &[rite_core::events::KbdPrompt],
    ) -> Option<Vec<String>> {
        Some(self.answers.clone())
    }
}

/// A one-time-code prompt (not password-labelled) is collected from the provider
/// and sent back — the 2FA second-factor path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_completes_keyboard_interactive_via_provider() {
    let port = spawn_kbd_server("Verification code:", "123456").await;
    let (_dir, pool) = test_db().await;

    let spy = Arc::new(Spy::default());
    let out = spy.out.clone();
    let events: SharedEvents = spy;
    let provider: rite_core::events::SharedInteractive = Arc::new(StaticProvider {
        answers: vec!["123456".into()],
    });

    let session = SshSession::connect(
        test_connection(port),
        AuthMethod::Password {
            password: PASS.into(),
        },
        events,
        pool,
        None,
        true,
        Some(provider),
    )
    .await
    .expect("keyboard-interactive should complete via the provider");

    let buffered = session.claim_initial_output().await;
    out.lock().unwrap().extend_from_slice(&buffered);
    assert!(
        wait_for(&out, BANNER, Duration::from_secs(5)).await,
        "should reach the shell after answering the challenge"
    );
    session.close().await.expect("close should succeed");
}

/// A masked "Password:" prompt is auto-answered from the connection's password —
/// no provider, so the user is never asked for what Rite already holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_autoanswers_keyboard_interactive_password() {
    let port = spawn_kbd_server("Password:", PASS).await;
    let (_dir, pool) = test_db().await;

    let spy = Arc::new(Spy::default());
    let out = spy.out.clone();
    let events: SharedEvents = spy;

    let session = SshSession::connect(
        test_connection(port),
        AuthMethod::Password {
            password: PASS.into(),
        },
        events,
        pool,
        None,
        true,
        None, // no UI provider — the password prompt must be auto-answered
    )
    .await
    .expect("a keyboard-interactive password prompt should be auto-answered");

    let buffered = session.claim_initial_output().await;
    out.lock().unwrap().extend_from_slice(&buffered);
    assert!(
        wait_for(&out, BANNER, Duration::from_secs(5)).await,
        "should reach the shell after the auto-answered password"
    );
    session.close().await.expect("close should succeed");
}
