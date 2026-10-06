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
