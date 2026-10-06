# RITE — ISO-CI validation image
#
# Mirrors the environment of .github/workflows/ci.yml (runs-on: ubuntu-latest)
# so that a local `task check` / build passes iff CI passes.
#
# Build:   podman build -t rite-ci:local -f Containerfile .
# Use:     podman run --rm -it -v "$PWD":/workspace:Z rite-ci:local \
#            bash -lc "pnpm install && task check"
#
# Pinned to reproduce the CI toolchain:
#   - Ubuntu 24.04            (ubuntu-latest)
#   - Rust                   from rust-toolchain.toml, as CI does
#   - Node.js                from .node-version, as CI does
#   - pnpm                   from package.json `packageManager`, as CI does
#   - cargo-audit            (Cargo Audit check)
#   - go-task                (repo uses `task check`)
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_TERM_COLOR=always \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

# --- System dependencies -----------------------------------------------------
# The wry desktop client on Linux needs the GTK3 / WebKit2GTK 4.1 dev headers.
# build-essential + pkg-config + libssl-dev cover the Rust native builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        pkg-config \
        libssl-dev \
        libwebkit2gtk-4.1-dev \
        libgtk-3-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        patchelf \
    && rm -rf /var/lib/apt/lists/*

# --- Rust ---------------------------------------------------------------------
# The version comes from rust-toolchain.toml, the same file CI and a local checkout
# read, so the image cannot bake a different stable from the one everything else uses.
COPY rust-toolchain.toml /tmp/rust-toolchain.toml
RUN RUST_VERSION="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' /tmp/rust-toolchain.toml)" \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain "$RUST_VERSION" \
              --component rustfmt --component clippy \
    && rustc --version && cargo --version

# cargo-audit for the "Cargo Audit" CI check
RUN cargo install cargo-audit --locked

# --- Node.js + pnpm -----------------------------------------------------------
# Both versions come from the repo rather than from this file: .node-version is what
# fnm/nvm read locally and what actions/setup-node reads in CI, and `packageManager`
# in package.json is what corepack reads everywhere. The comment here used to say
# "Node.js 20 + pnpm 8" while the lines installed 24 and 11 — which is exactly the
# kind of drift copied version numbers invite.
COPY .node-version /tmp/.node-version
COPY package.json /tmp/package.json
# The official tarball rather than nodesource: nodesource pins the MAJOR only, so the
# image drifted to the latest 24.x while CI installed the exact version from the same
# file — a divergence introduced by the very step meant to remove one.
RUN NODE_VERSION="$(tr -d '[:space:]' < /tmp/.node-version)" \
    && case "$(dpkg --print-architecture)" in \
         amd64) NODE_ARCH=x64 ;; \
         arm64) NODE_ARCH=arm64 ;; \
         *) echo "unsupported architecture" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
         | tar -xJ -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md \
    && corepack enable \
    && corepack prepare "$(sed -n 's/.*"packageManager" *: *"\([^"]*\)".*/\1/p' /tmp/package.json)" --activate \
    && node --version && pnpm --version

# --- go-task -----------------------------------------------------------------
RUN sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b /usr/local/bin \
    && task --version

# --- Playwright browser runtime deps -----------------------------------------
# The e2e harness (local only — not part of GitHub CI) runs chromium headless.
# GTK/WebKit above pull most of chromium's deps; these are the ones it doesn't
# (NSS/NSPR crypto libs + ALSA). Keeps the e2e run reproducible in the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libnss3 \
        libnspr4 \
        libasound2t64 \
    && rm -rf /var/lib/apt/lists/*

# Mirror GitHub Actions' environment: `CI=true` is set on every runner. pnpm 11 checks it before
# running scripts (verifyDepsBeforeRun) and, without it, aborts a non-interactive node_modules
# reconcile ("no TTY") — so `task check` would fail locally but pass in CI. Setting it here keeps
# the ISO-CI image faithful: a local `task check` passes iff CI passes.
ENV CI=true

WORKDIR /workspace
CMD ["bash"]
