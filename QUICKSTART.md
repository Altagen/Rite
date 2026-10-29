# Quick start (developers)

Getting a working checkout, and the handful of commands that matter. Installing a
release is [INSTALL.md](./INSTALL.md); the architecture is
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Prerequisites

Three toolchains, each pinned in the repository. Install the manager and let it read
the pin — a hand-installed version is how a local build stops being CI's build:

| Tool | Manager | Pin |
|------|---------|-----|
| Rust | [rustup](https://rustup.rs/) | `rust-toolchain.toml` |
| Node.js | [fnm](https://github.com/Schniz/fnm), nvm or asdf | `.node-version` |
| pnpm | `corepack enable` | `packageManager` in `package.json` |
| Task | [go-task](https://taskfile.dev/installation/) | — |

pnpm is the one that bites: an older pnpm rewrites `pnpm-lock.yaml` on install and
drops the security overrides declared in `pnpm-workspace.yaml` without saying so.

A Linux build also needs WebKitGTK and GTK headers — `libwebkit2gtk-4.1-dev` and
`libgtk-3-dev` on Debian or Ubuntu, `webkit2gtk4.1-devel` and `gtk3-devel` on Fedora,
`webkit2gtk-4.1` and `gtk3` on Arch.

## Setup

```bash
git clone https://github.com/Altagen/Rite.git
cd Rite
pnpm install
task dev
```

`task dev` builds the frontend, embeds it, and runs the native client — rite-server
in-process behind a wry webview. The first run compiles the Rust workspace and takes a
few minutes; later runs do not.

Two narrower loops:

- `task dev:server` — rite-server alone, serving the built frontend over HTTP/WS
- `task dev:frontend` — Vite on <http://localhost:5173> against the mock backend, no
  Rust in the picture

## Before pushing

```bash
task check
```

`cargo fmt --check`, clippy, `cargo test`, both dependency audits, `tsc` and eslint — the
same checks CI runs, in the same order. The audits go through `scripts/audit.sh`, which
fails when a check could not run, found a yanked crate, or never started; `cargo audit`
exits 0 in all three cases.

Anything touching the UI, the server's policies or the SSH path wants the end-to-end
gate as well. It builds what it tests, starts an SSH harness in a container, and runs
the Playwright suite plus the standalone checks:

```bash
sh e2e/gate.sh
```

Its last step tears down a local deployment and removes `deploy/admin_password.txt`,
so do not run it against an instance you are using. `task e2e` and `task e2e:play` are
the subsets.

## Where things live

```
apps/desktop/src/        React frontend — App.tsx is the entry
apps/desktop/shell/      the wry client (binary `rite`), embeds rite-server
packages/rite-core/      UI-agnostic core: auth, connections, terminals, SSH
packages/rite-server/    Axum HTTP/WS API + the embedded frontend
packages/crypto/         Argon2id, sealed boxes, the vault format
e2e/                     Playwright suite and the standalone checks
docs/                    architecture, server, layouts, security, release, roadmap
```

No component calls the server. They call `Backend.*`
(`apps/desktop/src/utils/backend.ts`), which dispatches to one HTTP module
(`utils/httpRoutes.ts`), one WebSocket module (`utils/transport.ts`), or the mock the
Vite loop runs against — those three files hold every `fetch` and every socket in the
app. A feature that needs a new route adds it there, in `packages/rite-server/src/lib.rs`,
and in the mock.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint in
CI — the changelog is generated from them:

```
feat(ssh): import a host list from an ssh config
fix(terminal): keep focus on the pane that was clicked
docs(server): say which settings an instance may declare
```

[docs/RELEASE.md](docs/RELEASE.md) has the full format and the release process.

## When it will not build

**`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`** — `node_modules` was built by a
different Node than the one in your shell. `fnm use` (or your manager's equivalent),
then `pnpm install`.

**`cargo build` fails after a toolchain change** — `rustup update`, then `task clean`.

**Port 5173 in use** — another Vite is running: `lsof -ti:5173 | xargs kill`.

**`libwebkit2gtk-4.1.so.0: cannot open shared object file`** — the system libraries
above are missing, or only the `-dev` package is installed on a machine that also needs
the runtime one.
