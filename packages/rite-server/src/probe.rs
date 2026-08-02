//! Machine health-check probing (ADR 0017, active phase). The probe runs from the
//! server — the web UI can't open a raw socket — so it is governed by the server's
//! health-check policy and rate-limited by the caller.
//!
//! Zero-knowledge caveat: the server can't tell whether a target is one the user
//! legitimately owns, because the host lives inside the client's encrypted blob.
//! So the guardrails are policy on/off, restrict-users, per-user anti-flood, and a
//! hard timeout — the targets themselves are *not* IP-filtered, because a bastion's
//! whole job is reaching internal infra (blocking private ranges would break it).

use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

/// How a target's reachability is probed. TCP-connect is the safe default (a
/// completed handshake means "up"); SSH-handshake additionally reads the daemon's
/// identification banner to confirm it's really SSH; ICMP needs raw-socket
/// privileges and is reported unsupported here (situational — left to the host).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeMethod {
    TcpConnect,
    SshHandshake,
    Icmp,
}

impl ProbeMethod {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "tcp-connect" => Some(Self::TcpConnect),
            "ssh-handshake" => Some(Self::SshHandshake),
            "icmp" => Some(Self::Icmp),
            _ => None,
        }
    }
}

/// Outcome of a probe. `Up`/`Down` are reachability verdicts; `Unsupported` means the
/// method can't run in this environment (e.g. ICMP without privileges) and is kept
/// distinct from `Down` so the UI never paints a reachable host as offline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeStatus {
    Up,
    Down,
    Unsupported,
}

impl ProbeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Unsupported => "unsupported",
        }
    }
}

pub struct ProbeResult {
    pub status: ProbeStatus,
    pub latency_ms: Option<u64>,
}

impl ProbeResult {
    fn down() -> Self {
        Self {
            status: ProbeStatus::Down,
            latency_ms: None,
        }
    }
    fn unsupported() -> Self {
        Self {
            status: ProbeStatus::Unsupported,
            latency_ms: None,
        }
    }
}

/// Probe one target with a hard timeout. Never returns an error — an unreachable host
/// is a normal `Down` verdict, not a failure of the endpoint.
pub async fn probe(host: &str, port: u16, method: ProbeMethod, timeout: Duration) -> ProbeResult {
    match method {
        ProbeMethod::Icmp => icmp_ping(host, timeout).await,
        ProbeMethod::TcpConnect => tcp_connect(host, port, timeout, false).await,
        ProbeMethod::SshHandshake => tcp_connect(host, port, timeout, true).await,
    }
}

/// Best-effort ICMP via the system `ping` (no raw-socket privileges needed — the setuid/
/// unprivileged `ping` does the work). Exit code only: 0 ⇒ up, non-zero ⇒ down, and if `ping`
/// isn't present at all we honestly report `Unsupported` rather than a false "down".
async fn icmp_ping(host: &str, timeout: Duration) -> ProbeResult {
    // `Command` doesn't invoke a shell, so `host` can't inject; but a leading '-' could be
    // read as a flag — reject those defensively (a real hostname/IP never starts with '-').
    if host.starts_with('-') || host.is_empty() {
        return ProbeResult::down();
    }
    let start = Instant::now();
    let secs = timeout.as_secs().max(1);
    let run = tokio::process::Command::new("ping")
        .arg("-c")
        .arg("1")
        .arg("-w")
        .arg(secs.to_string())
        .arg(host)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match tokio::time::timeout(timeout + Duration::from_secs(1), run).await {
        Ok(Ok(status)) if status.success() => ProbeResult {
            status: ProbeStatus::Up,
            latency_ms: Some(start.elapsed().as_millis() as u64),
        },
        Ok(Ok(_)) => ProbeResult::down(),          // ping ran, host didn't answer
        Ok(Err(_)) => ProbeResult::unsupported(),  // ping binary missing / couldn't spawn
        Err(_) => ProbeResult::down(),             // our own timeout tripped
    }
}

async fn tcp_connect(host: &str, port: u16, timeout: Duration, read_banner: bool) -> ProbeResult {
    let start = Instant::now();
    let addr = format!("{host}:{port}");
    let mut stream = match tokio::time::timeout(timeout, TcpStream::connect(&addr)).await {
        Ok(Ok(s)) => s,
        // Timed out, DNS/connection refused, or unreachable — all "down".
        _ => return ProbeResult::down(),
    };
    if read_banner {
        // An SSH daemon sends "SSH-2.0-…" (or "SSH-1.…") immediately on connect,
        // before any bytes from us. Read the first chunk and confirm the id string;
        // a plain-TCP listener that isn't SSH stays silent and reads as down.
        let mut buf = [0u8; 64];
        let ok = matches!(
            tokio::time::timeout(timeout, stream.read(&mut buf)).await,
            Ok(Ok(n)) if n >= 4 && buf.starts_with(b"SSH-")
        );
        if !ok {
            return ProbeResult::down();
        }
    }
    ProbeResult {
        status: ProbeStatus::Up,
        latency_ms: Some(start.elapsed().as_millis() as u64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn tcp_connect_reports_up_for_a_live_port() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        let r = probe(
            "127.0.0.1",
            addr.port(),
            ProbeMethod::TcpConnect,
            Duration::from_secs(2),
        )
        .await;
        assert_eq!(r.status, ProbeStatus::Up);
        assert!(r.latency_ms.is_some());
    }

    #[tokio::test]
    async fn tcp_connect_reports_down_for_a_dead_port() {
        // Bind then drop, so the port is (almost certainly) closed.
        let addr = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap()
        };
        let r = probe(
            "127.0.0.1",
            addr.port(),
            ProbeMethod::TcpConnect,
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(r.status, ProbeStatus::Down);
    }

    #[tokio::test]
    async fn ssh_handshake_confirms_the_banner() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let _ = sock.write_all(b"SSH-2.0-OpenSSH_9.6\r\n").await;
            }
        });
        let r = probe(
            "127.0.0.1",
            addr.port(),
            ProbeMethod::SshHandshake,
            Duration::from_secs(2),
        )
        .await;
        assert_eq!(r.status, ProbeStatus::Up);
    }

    #[tokio::test]
    async fn ssh_handshake_rejects_a_non_ssh_port() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let _ = sock.write_all(b"HTTP/1.1 400 Bad Request\r\n").await;
            }
        });
        let r = probe(
            "127.0.0.1",
            addr.port(),
            ProbeMethod::SshHandshake,
            Duration::from_secs(2),
        )
        .await;
        assert_eq!(r.status, ProbeStatus::Down);
    }

    #[tokio::test]
    async fn icmp_pings_localhost_or_is_unsupported() {
        // Loopback always answers when `ping` runs; if the binary is absent we report
        // Unsupported. Either way it must never be a false Down.
        let r = probe("127.0.0.1", 22, ProbeMethod::Icmp, Duration::from_secs(2)).await;
        assert!(matches!(r.status, ProbeStatus::Up | ProbeStatus::Unsupported));
    }

    #[tokio::test]
    async fn icmp_rejects_a_flag_like_host() {
        let r = probe("-oProxyCommand=x", 0, ProbeMethod::Icmp, Duration::from_secs(1)).await;
        assert_eq!(r.status, ProbeStatus::Down);
    }
}
