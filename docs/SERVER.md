# Running a Rite server

`rite-server` is the shared/team shell (ADR 0004/0010). It serves the same API +
WebSocket + frontend as the desktop client, but with **accounts** instead of a
single local vault. This guide covers self-hosting one.

## Modes

| `RITE_ACCOUNTS` | Behaviour |
| --- | --- |
| unset | Single-context dev/test server, no login. Not for exposure. |
| `1` | **Server mode**: real accounts, login, sessions, roles (admin/user). |

Environment:

| Variable | Meaning |
| --- | --- |
| `RITE_ADDR` | Bind address, e.g. `0.0.0.0:1421` (default `127.0.0.1:1421`) |
| `RITE_ACCOUNTS=1` | Enable server mode |
| `RITE_TLS_CERT`, `RITE_TLS_KEY` | PEM cert/key → built-in TLS (HTTPS) |
| `RITE_ALLOW_INSECURE_HTTP=1` | Allow plaintext HTTP on a non-loopback address (see below) |

## TLS is required off-loopback (secure by default)

The password never travels in the clear — the client hashes it (Argon2id) before
sending — but **sessions and API traffic still need TLS** on a network. So:

| Situation | Result |
| --- | --- |
| Accounts + loopback (`127.0.0.1`) + no TLS | ✅ allowed (local only) |
| Accounts + TLS (`RITE_TLS_*`) | ✅ allowed |
| Accounts + non-loopback + no TLS + no opt-out | ❌ **refuses to start** |
| …+ `RITE_ALLOW_INSECURE_HTTP=1` | ✅ allowed, with a warning |

## Option A — direct TLS (a small home server)

Generate a self-signed certificate (valid 1 year, no passphrase):

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout rite-key.pem -out rite-cert.pem \
  -subj "/CN=rite.local" \
  -addext "subjectAltName=DNS:rite.local,IP:192.168.1.10"
```

Put your server's hostname/IP in `subjectAltName` so clients can verify it. Then:

```bash
RITE_ACCOUNTS=1 \
RITE_ADDR=0.0.0.0:1421 \
RITE_TLS_CERT=$PWD/rite-cert.pem \
RITE_TLS_KEY=$PWD/rite-key.pem \
rite-server
```

Browse to `https://rite.local:1421`. Because the cert is self-signed, browsers
show a one-time warning — accept it, or import `rite-cert.pem` into your trust
store to silence it. For a public server, use a real certificate (Let's Encrypt),
usually via Option B.

## Option B — reverse proxy (recommended for production)

Let a proxy terminate TLS (real certs, HTTP/2, auto-renewal) and run rite-server
as plain HTTP behind it. Acknowledge the plaintext hop with
`RITE_ALLOW_INSECURE_HTTP=1` (the proxy provides the TLS):

```bash
RITE_ACCOUNTS=1 RITE_ADDR=127.0.0.1:1421 RITE_ALLOW_INSECURE_HTTP=1 rite-server
```

Caddy (auto HTTPS via Let's Encrypt):

```
rite.example.com {
    reverse_proxy 127.0.0.1:1421
}
```

nginx (with your own cert), proxying WebSockets too:

```nginx
server {
    listen 443 ssl;
    server_name rite.example.com;
    ssl_certificate     /etc/letsencrypt/live/rite.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rite.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:1421;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # WebSocket (/ws)
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## Container

The published image runs rite-server. Mount a volume for the vault and pass the
env vars:

```bash
podman run -d --name rite \
  -p 1421:1421 \
  -e RITE_ACCOUNTS=1 \
  -e RITE_ADDR=0.0.0.0:1421 \
  -e RITE_ALLOW_INSECURE_HTTP=1 \
  -v rite-data:/home/rite/.local/share/rite \
  ghcr.io/altagen/rite-server:latest
```

Put it behind a TLS proxy (Option B) for anything reachable from a network.

## First run

On first launch with no accounts, open the server in a browser: it shows
**Create the server administrator**. That first account is the admin; afterwards
the admin manages accounts from the users panel. (A non-interactive env-based
admin bootstrap for headless/automated deploys is planned — for now, do the
one-time browser first-run.)
