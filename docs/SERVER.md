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
| `RITE_ADMIN_USER`, `RITE_ADMIN_PASSWORD` | Non-interactive first-run admin (headless deploys) |
| `RITE_ADMIN_PASSWORD_FILE` | Read the admin password from a file/secret instead of the env |

## TLS is required off-loopback (secure by default)

The password never travels in the clear — the client hashes it (Argon2id) before
sending — but **sessions and API traffic still need TLS** on a network. So:

| Situation | Result |
| --- | --- |
| Accounts + loopback (`127.0.0.1`) + no TLS | ✅ allowed (local only) |
| Accounts + TLS (`RITE_TLS_*`) | ✅ allowed |
| Accounts + non-loopback + no TLS + no opt-out | ❌ **refuses to start** |
| …+ `RITE_ALLOW_INSECURE_HTTP=1` | ✅ allowed, with a warning |

## The server ships as a container

There is no server binary to download: the release carries the **client** as four
tarballs, and rite-server lives in the registry as `ghcr.io/altagen/rite-server`.
So every path below starts from a compose file, and `deploy/` holds three ready
to run.

Each one expects an admin password next to it:

```bash
echo -n 'a-strong-password' > deploy/admin_password.txt
```

## 1. Try it locally — no certificate at all

```bash
docker compose -f deploy/compose.yml up
```

Open `http://127.0.0.1:1421`. Nothing to install, nothing to trust, and the
published port is bound to `127.0.0.1` so it is not reachable from the network.

This is the fastest way to see Rite, and the right one for evaluating it. It is
plain HTTP, so it stays on your machine.

## 2. Local HTTPS — two ways, both valid

Use this when you want to exercise the web UI over TLS, or point a desktop client
at it. Either way the compose file is the same and reads two paths; only the way
you produce the certificate changes.

```bash
mkdir -p deploy/tls
```

### Without mkcert — self-signed, and the browser will say so

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout deploy/tls/key.pem -out deploy/tls/cert.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

docker compose -f deploy/compose.tls.yml up
```

**Expect a browser warning**, and know what it is before you see it:
*"Your connection is not private"* (Chrome, `NET::ERR_CERT_AUTHORITY_INVALID`) or
*"Warning: Potential Security Risk Ahead"* (Firefox). Rite is not broken and TLS
is not failing — the traffic is encrypted exactly as it would be with any other
certificate. The browser simply has no reason to believe this one, because it was
signed by nobody it knows. Click through, and it remembers.

Three things that warning implies, so none of them is a surprise later:

- **It is per origin and per browser profile.** A second browser, a private
  window, or a different port asks again.
- **It is not only cosmetic.** `curl https://localhost:1421/api/health` fails
  until you pass `-k`, and so will anything scripted against it.
- **Desktop clients do not care.** They pin the certificate's fingerprint the
  first time they see it (TOFU, ADR 0012) rather than asking an authority, so a
  self-signed certificate is a normal, supported setup for them — not a
  compromise.

If you are testing and the warning does not bother you, stop here. That is a
legitimate choice for a machine only you reach.

### With mkcert — optional, and genuinely trusted

`mkcert` removes the warning properly rather than teaching you to click past it.
It creates a local certificate authority **and installs it in your system and
browser trust stores**, which is the tedious part, automated:

```bash
mkcert -install                       # once per machine
mkcert -cert-file deploy/tls/cert.pem -key-file deploy/tls/key.pem localhost 127.0.0.1

docker compose -f deploy/compose.tls.yml up
```

`https://localhost:1421` now loads with no warning, and `curl` works without
`-k`. The certificate is trusted on this machine and nowhere else, which is
exactly what you want for local work.

**Neither of these belongs on a server other people reach.** Not because
self-signed is unsafe in itself, but because a deployment that greets its users
with a warning teaches them to dismiss warnings.

## 3. A server other people reach — a proxy with automatic certificates

```bash
RITE_DOMAIN=rite.example.com docker compose -f deploy/compose.caddy.yml up -d
```

Caddy obtains a real certificate over ACME, renews it on its own, and redirects
HTTP to HTTPS. rite-server speaks plain HTTP on a private compose network the
proxy alone can reach — that hop is what `RITE_ALLOW_INSECURE_HTTP=1`
acknowledges, and it never leaves the host. The domain must already point here,
with ports 80 and 443 free; ACME uses 80.

Traefik, nginx or an ingress with cert-manager do the same job; the only thing
rite-server needs from any of them is the `Upgrade` / `Connection` headers so the
WebSocket at `/ws` survives the hop. Caddy's `reverse_proxy` does it by default:

```nginx
# nginx, if you prefer it
location / {
    proxy_pass http://127.0.0.1:1421;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;   # WebSocket (/ws)
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

One consequence of terminating TLS upstream: `hostKey` in `server_mode` is
`null`. rite-server is not holding the certificate, so it cannot publish its
fingerprint for out-of-band pinning; desktop clients pin the proxy's certificate
by TOFU instead.

## Configuring the instance as code

Ten settings govern how an instance behaves. Declare any of them in a TOML file, point
`RITE_CONFIG` at it, and they stop being something an administrator has to click:

```toml
instance_name     = "Acme Corp"
open_registration = false
allow_quick_ssh   = false
default_shell     = "bash"

[dashboard_policy]        # ADR 0019
webui       = false       # the web UI may not run the probing cards
clients     = true        # attached desktop clients may
minInterval = 60

[collection_policy]       # ADR 0016
allowCreate = true
maxMembers  = 25
```

The full list: `instance_name`, `session_persistence`, `default_shell`,
`allow_quick_ssh`, `open_registration`, `allow_invitations`, `confirm_role_change`,
`healthcheck_policy`, `collection_policy`, `dashboard_policy`. A key outside that list
stops the server, named — a typo should be heard at start-up, not discovered months later
as a setting that never applied.

Any key can also be set from the environment, which wins over the file:

```
RITE__instance_name=Acme Corp
RITE__dashboard_policy__webui=false        # one field of a policy, leaving the rest
RITE__instance_name__FILE=/run/secrets/name   # read the value from a mounted secret
```

A double underscore separates levels, because the keys themselves contain single ones.

### What declaring something costs you

**A declared setting is locked.** The console shows it, inert, naming the file or variable
that set it, and the admin API answers `409` rather than accepting a change the next
restart would undo. Changing it means editing the configuration and restarting the server.

**A setting you leave out is untouched.** It stays in the console, live, exactly as before.
This is the whole of the trade: you draw the line by choosing what to declare. Put the
governance policies in the file so they are reviewable in git, and leave
`open_registration` out if you are the sort of operator who opens it for an afternoon.

**Nothing is written back.** A value an administrator set earlier stays in the database,
shadowed while the configuration declares the key, and returns unchanged if the key leaves
the file.

### What a restart is still needed for

The settings above take effect when the server starts. So do the boot values — the listen
address, the served surfaces, accounts mode, and TLS material: `RITE_TLS_CERT` and
`RITE_TLS_KEY` are read when the socket is bound, and no amount of re-reading a settings
file swaps a certificate chain underneath it. Where a proxy terminates TLS, certificate
renewal belongs to the proxy and never reaches rite-server at all.

## First run

On first launch with no accounts, open the server in a browser: it shows
**Create the server administrator**. That first account is the admin; afterwards
the admin manages accounts from the users panel.

For **headless/automated deploys**, the administrator is created at boot instead —
every compose file in `deploy/` already does this:

```yaml
environment:
  RITE_ADMIN_USER: admin
  RITE_ADMIN_PASSWORD_FILE: /run/secrets/rite_admin_password
secrets:
  - rite_admin_password
```

On a fresh server this creates the admin (the server derives the same Argon2id
auth hash the browser would, so a later browser login just works). Prefer
`RITE_ADMIN_PASSWORD_FILE` (a mounted secret) over `RITE_ADMIN_PASSWORD` — env
vars leak via `ps` / `inspect`. It only acts when there are no accounts yet;
change the password after the first login.

Pair it with `RITE_CONFIG` (above) and the deployment comes up **configured**, not merely
administrable: the administrator exists, the policies are the ones in your repository, and
nobody has opened a browser.
