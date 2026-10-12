# e2e — how the suite is run, and where it runs

One command:

```sh
sh e2e/gate.sh        # or: task e2e
```

It builds the frontend bundle and the debug server **first** (neither suite builds
anything, and a stale artefact reports "passed" for the previous commit), brings the SSH
harness up, runs the standalone checks, then Playwright.

## Nothing is installed on your machine

The suite needs a host it can really open an SSH session to, and the dashboard specs need
that host to answer `docker ps` and `systemctl`. That means a user account, an sshd and two
commands on `PATH` — all of it inside a throwaway container:

```sh
sh e2e/harness-up.sh      # rite-ci:local, host network, repo mounted at /workspace
podman rm -f rite-sshd    # undoes all of it
```

`sshd-setup.sh` and `dashboard-stubs.sh` are what that script runs **inside** the container.
Do not run them directly on your machine — they need root and they mean it. If the five
`wave1-dashboard` specs fail, the harness is what you are missing.

The image comes from the repo's Containerfile:

```sh
podman build -t rite-ci:local -f Containerfile .
```

## The browser suite in that same image

```sh
sh e2e/harness-up.sh      # from the host, as above
task e2e:iso
```

It builds the frontend and the debug server in `rite-ci:local` and runs Playwright
there, under the Node that `.node-version` pins and the system libraries CI mirrors. The
whole suite passes inside the container in the same time it takes on the host, and the
host's `node_modules` comes back untouched — one named volume per workspace tree
shadows it, because those trees are symlink farms into `.pnpm` and an install under a
different layout rewrites the host's links.

The image carries chromium's dependencies but not chromium: that is ~500 MB per
revision for a suite GitHub CI does not run yet, so `~/.cache/ms-playwright` is
mounted read-only from the host instead. `npx playwright install chromium` fills it if
it is empty.

**The harness stays on the host**, and so does the turnkey acceptance step: both of
them run `podman` themselves, and this is already inside a container. That — not the
browser — is the reason `e2e/gate.sh` is not one container from end to end.

## The pieces, if you want one of them

| Command | What it covers |
|---|---|
| `sh e2e/run-checks.sh` | Rust ↔ browser crypto parity, then the server policies (RBAC, enrollment, collections, health-check, dashboard) — each against a fresh accounts server |
| `npx playwright test --project=mock` | the UX mock in `design/mock`, opened from disk — no server |
| `npx playwright test --project=chromium` | the local-vault suite (needs the harness) |
| `npx playwright test --project=accounts` | server mode on :1422 — **serial**, each test builds on the last, so `-g` on a single one will fail at setup |
| `npx playwright test --project=proxy` | an attached client through the mux (:1424 → :1423) |

## Two things that will bite you

- **The `accounts` and `proxy` projects are stateful and serial.** Running one test with
  `-g` skips the bootstrap it depends on and fails with a 401 that looks like a bug.
- **Rebuild the frontend after changing it.** `pnpm e2e` serves `apps/desktop/dist` as it
  finds it. `e2e/gate.sh` does this for you; running Playwright directly does not.
