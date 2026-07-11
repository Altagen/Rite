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
#   - Rust stable + rustfmt + clippy   (dtolnay/rust-toolchain@stable)
#   - Node.js 24             (actions/setup-node@v6, node-version 24)
#   - pnpm 11                (pnpm/action-setup, version 11)
#   - cargo-audit            (Cargo Audit check)
#   - go-task                (repo uses `task check`)
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_TERM_COLOR=always \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

# --- System dependencies -----------------------------------------------------
# Tauri on Linux needs the GTK3 / WebKit2GTK 4.1 dev headers; patchelf is used
# by the bundler / build check. build-essential + pkg-config + libssl-dev cover
# the Rust native builds.
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

# --- Rust (stable) -----------------------------------------------------------
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable \
              --component rustfmt --component clippy \
    && rustc --version && cargo --version

# cargo-audit for the "Cargo Audit" CI check
RUN cargo install cargo-audit --locked

# --- Node.js 20 + pnpm 8 -----------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.11.0 --activate \
    && node --version && pnpm --version

# --- go-task -----------------------------------------------------------------
RUN sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b /usr/local/bin \
    && task --version

WORKDIR /workspace
CMD ["bash"]
