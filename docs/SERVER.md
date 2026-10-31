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

**None of them asks you to prepare anything.** Start one, open it, and the first visit
offers **Create the server administrator** — the same first run as a desktop vault, and no
secret rests anywhere. That screen asks for a password and nothing else: the account is
`admin`, shown but not editable. One account an instance cannot be opened without, named
by convention rather than by whoever gets there first.

### Where a terminal on this server starts

In `/home/rite`, the home of the unprivileged user the image runs as, and where the data
volume mounts. It is the image's working directory and a terminal inherits it — nothing
makes a shell go to `$HOME` on its own.

It is not configurable, and that is the decision rather than an omission. A member
reaching a machine over SSH from the web UI lands on that machine's paths, which this
server has never seen, so a directory it imposed would describe none of them. A client
naming one would be choosing where a shared server spawns a shell, and is refused.

`/home/rite` is where EVERY terminal opens here, not just the first: the web UI asks for
no directory at all, so none of them inherits one. A split is the exception, and it is the
gesture's own meaning rather than a setting — it divides a pane and opens where that pane
is standing, which is one of this server's own sessions on this server's own filesystem.

The desktop is the other case: its terminals run on your own machine whatever context is
active (ADR 0031), so `[terminal] newTabCwd` in your workspace document can name a path —
see `docs/LAYOUTS.md`. Nothing in that document is read here.

Before 0.2.8 the image set no working directory, so a terminal opened in `/`.

### The administrator, without a browser

For a headless start — the instance comes up with the account already created — add one
override to whichever file you are using:

```bash
install -m 600 /dev/null deploy/admin_password.txt
printf '%s' 'a-strong-password' > deploy/admin_password.txt
docker compose -f deploy/compose.yml -f deploy/compose.bootstrap.yml up
```

The account is `admin` here too: the override reads `RITE_ADMIN_USER` and falls back to
`admin`. Setting that variable is the one way to choose another name — the browser path
does not offer it.

That is ADR 0020's point: configured, not merely administrable. What it costs is a live
admin password at rest on this host, so three things are worth knowing.

**The mode matters.** A plain `echo >` creates the file with whatever the umask gives,
which on most systems is readable by every account on the machine. Compose mounts it as a
secret, so inside the container it is a file under `/run/secrets` rather than an
environment variable — `docker inspect`, `/proc/<pid>/environ` and a crash report do not
carry it. The exposure left is the one on the host, and the mode is what closes it.

**Empty it once the administrator has signed in** — `: > deploy/admin_password.txt`. The
server reads it at every start and only acts on it while no account exists, so afterwards
it is a live admin password that does nothing. A server that finds one on an instance that
already has accounts says so in its log. (`rm` works too, as long as you stop passing
`-f deploy/compose.bootstrap.yml`: compose refuses to start when a secret's source is
missing.)

**Why a password and not a hash.** The bootstrap creates a **vault**, and the vault key is
derived from the password (ADR 0011). A hash would make an account that can sign in and
whose vault cannot exist. So a browser-free bootstrap means the server sees the password
once — that is the whole reason this file exists in this shape.

### Why a path, and not a variable

`RITE_ADMIN_PASSWORD_FILE` names a **path**, and a path is what every secret manager
already produces. The `admin_password.txt` beside these files is only what that path points
at on a laptop with no secret manager at all:

| Where the secret lives | What the server is given |
| --- | --- |
| a compose or Swarm secret | `/run/secrets/rite_admin_password` (tmpfs, never on disk) |
| a Kubernetes Secret, mounted as a volume | one file per key, on a memory-backed volume |
| Vault, through the agent or the CSI driver | a rendered file at a path you choose |
| a systemd unit with `LoadCredential=` | `$CREDENTIALS_DIRECTORY/<name>` |
| nothing — a laptop | `./admin_password.txt`, which is the case above with no manager |

So the server supports all of them by supporting none of them specifically. Nothing in it
knows what Kubernetes is.

The variable form, `RITE_ADMIN_PASSWORD`, exists as a fallback and is **the one to avoid**:
an environment is readable through `docker inspect` and `/proc/<pid>/environ`, it is
inherited by every child process, and it lands in crash reports. That is why the `_FILE`
convention exists across container images at all — Postgres, MySQL and the rest read their
passwords the same way, for the same reason.

So, the two paths:

| What you run | What you prepare | First start |
| --- | --- | --- |
| `-f compose.yml` | nothing | the browser creates the administrator; nothing secret on disk |
| `-f compose.yml -f compose.bootstrap.yml` | the password file | the administrator already exists |

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

Sixteen settings govern how an instance behaves. Declare any of them in a TOML file,
point `RITE_CONFIG` at it, and they stop being something an administrator has to click:

```toml
instance_name     = "Acme Corp"
open_registration = false
allow_quick_ssh   = false
default_shell     = "bash"

# What a terminal on this server opens, and whether a member may deviate. The console
# offers only the shells this server has installed; `allow_shell_choice` is off by
# default, which makes `default_shell` the only shell.
allow_shell_choice = false

# How an unknown SSH host key is treated — one policy for everyone, since every
# connection runs here. `strict` refuses it; `warn` and `accept` do not.
host_key_verification_mode = "strict"

# How long a connect and its handshake may take, per hop, before the attempt fails with
# a message. The default is 20 seconds, which suits a network that answers; raise it for
# a hop behind a satellite link or a jump host that authenticates against a slow
# directory, lower it on a bastion that should fail fast. 1 to 300.
ssh_connect_timeout = 20

# What may rest in a member's own vault (ADR 0024). One switch over every secret a
# record can keep — an SSH password, a key passphrase, a carried key — because
# forbidding one while allowing another hardens nothing. Both bind the client and not
# the data: a record is sealed before it reaches the instance, so nothing here can
# check it afterwards. Off, each secret is asked for at every connection instead.
allow_secret_storage = true
allow_secret_reveal  = true

[dashboard_policy]        # ADR 0019
webui       = false       # the web UI may not run the probing cards
clients     = true        # attached desktop clients may
minInterval = 60

[collection_policy]       # ADR 0016
allowCreate = true
maxMembers  = 25

[layouts_policy]          # ADR 0027
webui   = true            # a browser reads the account's sealed copy
clients = true            # a desktop window reads that copy, or a local file
```

The full list: `instance_name`, `session_persistence`, `default_shell`,
`allow_shell_choice`, `host_key_verification_mode`, `allow_quick_ssh`,
`allow_secret_storage`, `allow_secret_reveal`, `open_registration`,
`allow_invitations`, `confirm_role_change`, `healthcheck_policy`, `collection_policy`,
`dashboard_policy`, `layouts_policy`, `ssh_connect_timeout`. A key outside that list stops the server, named — a typo should be
heard at start-up, not discovered months later as a setting that never applied. So does a
value outside what a key accepts: `host_key_verification_mode = "trust-me"` is refused at
start-up rather than falling back to strict while the console shows the typo.

Any key can also be set from the environment, which wins over the file:

```
RITE__instance_name=Acme Corp
RITE__dashboard_policy__webui=false        # one field of a policy, leaving the rest
RITE__instance_name__FILE=/run/secrets/name   # read the value from a mounted secret
```

A double underscore separates levels, because the keys themselves contain single ones.

**Do not quote values.** Nothing here is interpreted by a shell, so quotes are not needed
even for values containing spaces — `RITE__instance_name=Acme Corp` is correct as written.

Compose strips surrounding quotes for you, both in `environment:` (YAML does it) and in an
`env_file:`, so copying the examples above into a compose setup works either way. `docker
run --env-file` and `podman run --env-file` do **not**: there the quotes become part of the
value. What that looks like depends on the setting:

| In the file | Through compose | Through `run --env-file` |
|---|---|---|
| `RITE__instance_name=Acme Corp` | `Acme Corp` | `Acme Corp` |
| `RITE__instance_name="Acme Corp"` | `Acme Corp` | `"Acme Corp"` — quotes included |
| `RITE__open_registration=true` | on | on |
| `RITE__open_registration="true"` | on | **refuses to start**: ``RITE__open_registration: `"true"` is not a boolean`` |

Booleans and numbers have a grammar, so a stray quote stops the server with the variable and
the value named. Text has none, so the quotes simply ride along and the instance ends up
called `"Acme Corp"`. Leaving them out is correct everywhere.

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

For **headless/automated deploys**, the administrator is created at boot instead. That is
`deploy/compose.bootstrap.yml`, an override you add to whichever deployment file you are
using — the deployment files themselves ask for nothing:

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
vars leak via `ps` / `inspect`. It only acts when there are no accounts yet, and it says
so in the log when it finds a password on an instance that already has them.

Pair it with `RITE_CONFIG` (above) and the deployment comes up **configured**, not merely
administrable: the administrator exists, the policies are the ones in your repository, and
nobody has opened a browser.

## The console is smaller on the desktop client, on purpose

*The decision and its alternatives: ADR 0025 — the client holds the people, the web console holds the policy.*

Sign in to a server from the desktop client as an administrator and the button reads
**Organization**, not **Admin**. Two sections are missing from its left rail: **Overview**
and **Instance**.

This is a **product decision, not a security boundary**, and the distinction matters:

- The API does **not** care which shell you are using. A desktop client holding an admin
  session can still `PATCH /api/admin/instance`; nothing refuses it. The real guard is the
  account's **role**, enforced server-side on every admin route, and it is the same guard
  for a browser and for the client.
- What differs is what the interface *offers*. Instance administration — the name, open
  registration, the host-key policy, what may rest in a vault, the health-check and
  dashboard policies — is heavy, instance-wide, and rarely done. It belongs on the surface
  you reach deliberately, which is the web console. The same split as Bitwarden and
  Vaultwarden: the client is for using the thing, the web console for governing it.
- Everything an administrator does *often* is in the client: users, invitations, teams,
  collections. Those are not web-only.

So "Organization" is the honest name for what the client shows — the organisation's people
and groups — where "Admin" would promise the instance settings that are not there. The rail
says as much in a note at its foot, pointing at the server's URL.

If you need the instance settings, open the server's address in a browser and sign in
there. Nothing has to be enabled for that; it is the same server and the same account.

**A consequence worth knowing**: with `RITE_SERVE_WEBUI=off` the web console is the whole
surface, and with `RITE_SERVE_ADMIN=off` there is no console at all. Turning both off
leaves an instance that serves terminals and cannot be administered through any interface —
`RITE_CONFIG` is then the only way to change it, which is a legitimate shape for a
deployment managed entirely as code.

## The server speaks English, for now

The client ships English and French and lets a member switch. `rite-server` does not: its
refusals cross the wire as English prose — `invalid credentials`, `too many attempts — try
again later` — and the client shows them as they arrive. So a French member meets English
in the handful of places a server refusal surfaces.

**This is a decision, not an oversight.** Translating them properly means the server
returning a stable error *code* per refusal — `invalid_credentials`,
`remote_requires_https` — which the client looks up in its locales, with the prose moving
out of Rust entirely. That is the right design. It is also a change to the API contract,
touching every handler that refuses, and ADR 0008 makes that contract something clients
negotiate against. With no users on the thing yet, it is cheap to change later and
expensive to get wrong now.

What did not wait is consistency. The messages had been written one at a time and drifted:
eight addressed the caller in the second person, two throttles said the same thing with
different punctuation, and one word was British in an American file.
`e2e/server-errors-check.mjs` holds the shape from now on — no message addresses its
caller, each is a lower-case fragment rather than a sentence (the client frames it), and an
afterthought is joined with an em dash rather than a comma.

**Reopen this** when there is a deployment whose members do not read English, or when a
refusal needs to carry structured data a client should act on rather than display. Either
one changes the premise; until then the server speaks one language, consistently.
