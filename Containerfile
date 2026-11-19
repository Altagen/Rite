# RITE — ISO-CI validation image
#
# Mirrors the environment of .github/workflows/ci.yml (runs-on: ubuntu-26.04)
# so that a local `task check` / build passes iff CI passes.
#
# Build:   podman build -t rite-ci:local -f Containerfile .
# Use:     podman run --rm -it -v "$PWD":/workspace:Z rite-ci:local \
#            bash -lc "pnpm install && task check"
#
# Pinned to reproduce the CI toolchain:
#   - Ubuntu 26.04            (the version every workflow pins. They used to ride
#                              ubuntu-latest, which GitHub moved to 26.04 between
#                              2026-10-19 and 2026-11-19 — two runs of one commit could
#                              land on different distributions. This is the move to the
#                              far side of that rollout, made as one commit with the
#                              workflows; e2e/ci-image-check.mjs fails if the two
#                              disagree (ADR 0001). The release client is built on an
#                              OLDER ubuntu on purpose and STAYS on 22.04: the build
#                              host's glibc is the floor of the shipped binary, and
#                              26.04's 2.43 would refuse to start on the current LTS.)
#   - Rust                   from rust-toolchain.toml, as CI does
#   - Node.js                from .node-version, as CI does
#   - pnpm                   from package.json `packageManager`, as CI does
#   - cargo-audit            (Cargo Audit check)
#   - go-task                (repo uses `task check`)
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_TERM_COLOR=always \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

# --- System dependencies -----------------------------------------------------
# The wry desktop client on Linux needs the GTK3 / WebKit2GTK 4.1 dev headers.
# build-essential + pkg-config + libssl-dev cover the Rust native builds. The last three
# are chromium's: the e2e harness (local only — not part of GitHub CI) runs it headless,
# and GTK/WebKit above pull everything it needs EXCEPT the NSS/NSPR crypto libs and ALSA.
#
# ONE apt INVOCATION AND NOT TWO. Those three had a layer of their own, which meant a
# second `apt-get update` — a second chance for an unreachable archive to fail the build,
# for three packages. One list, one retry loop, one layer.
#
# RETRIED, AND VERIFIED BEFORE INSTALLING. `apt-get update` exits 0 when only SOME
# sources fail, so `update && install` walks straight into empty package lists and
# reports `E: Unable to locate package git` — which reads as a wrong package name and
# sends the next person looking in the list below, not at the network. That is not
# hypothetical: archive.ubuntu.com was unreachable from GitHub's runners on 2026-11-19
# (`connection timed out`, 270s), it failed this build, and the same outage is what made
# `apt-get install` take 34 minutes in the jobs this image replaces.
#
# So: apt retries each fetch, the loop retries the whole update, and a sentinel lookup
# decides whether the lists are usable. Failing here says what happened.
RUN set -eu; \
    printf 'Acquire::Retries "5";\n' > /etc/apt/apt.conf.d/80-retries; \
    i=1; \
    until apt-get update && apt-cache show git >/dev/null 2>&1; do \
        if [ "$i" -ge 5 ]; then \
            echo "apt-get update never produced usable package lists after $i tries —" >&2; \
            echo "the archive is unreachable, not the package names below." >&2; \
            exit 1; \
        fi; \
        echo "package lists incomplete, retrying ($i)"; \
        i=$((i + 1)); \
        sleep 10; \
    done; \
    apt-get install -y --no-install-recommends \
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
        libnss3 \
        libnspr4 \
        libasound2t64; \
    rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/locale

# --- Rust ---------------------------------------------------------------------
# The version comes from rust-toolchain.toml, the same file CI and a local checkout
# read, so the image cannot bake a different stable from the one everything else uses.
COPY rust-toolchain.toml /tmp/rust-toolchain.toml
RUN RUST_VERSION="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' /tmp/rust-toolchain.toml)" \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain "$RUST_VERSION" \
              --component rustfmt --component clippy \
    && rustc --version && cargo --version

# cargo-audit for the "Cargo Audit" CI check.
#
# AND THE SOURCES IT WAS BUILT FROM, DROPPED IN THE SAME LAYER. `cargo install` leaves
# everything it downloaded in $CARGO_HOME/registry — 296 MB of crate sources for a 20 MB
# binary, measured. Deleting them in a later layer would not help: a layer only adds, so
# the weight ships either way. It has to be the same RUN.
#
# `rustup`'s own documentation goes with it: 16 MB of HTML nobody reads in CI, and the
# minimal profile does not exclude it.
RUN cargo install cargo-audit --locked \
    && rm -rf "$CARGO_HOME/registry" "$CARGO_HOME/git" \
    && rm -rf "$RUSTUP_HOME"/toolchains/*/share/doc

# --- Node.js + pnpm -----------------------------------------------------------
# Both versions come from the repo rather than from this file: .node-version is what
# fnm/nvm read locally and what actions/setup-node reads in CI, and `packageManager`
# in package.json is the one place the pnpm version is written. The comment here used to
# say "Node.js 20 + pnpm 8" while the lines installed 24 and 11 — which is exactly the
# kind of drift copied version numbers invite.
COPY .node-version /tmp/.node-version
COPY package.json /tmp/package.json
# The official tarball rather than nodesource: nodesource pins the MAJOR only, so the
# image drifted to the latest 24.x while CI installed the exact version from the same
# file — a divergence introduced by the very step meant to remove one.
#
# AND `npm i -g`, NOT COREPACK, since Node 26: the tarball no longer carries corepack at
# all (24 shipped it, along with pnpm and yarn shims; 26's bin/ holds node, npm and npx
# and nothing else), so `corepack enable` failed with "not found" and took the build with
# it. `packageManager` is still the one place the version is written — it is read here
# and handed to npm instead.
RUN NODE_VERSION="$(tr -d '[:space:]' < /tmp/.node-version)" \
    && case "$(dpkg --print-architecture)" in \
         amd64) NODE_ARCH=x64 ;; \
         arm64) NODE_ARCH=arm64 ;; \
         *) echo "unsupported architecture" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
         | tar -xJ -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md \
    && npm i -g "$(sed -n 's/.*"packageManager" *: *"\([^"]*\)".*/\1/p' /tmp/package.json)" \
    && node --version && pnpm --version

# --- go-task -----------------------------------------------------------------
RUN sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b /usr/local/bin \
    && task --version

# Mirror GitHub Actions' environment: `CI=true` is set on every runner. pnpm 11 checks it before
# running scripts (verifyDepsBeforeRun) and, without it, aborts a non-interactive node_modules
# reconcile ("no TTY") — so `task check` would fail locally but pass in CI. Setting it here keeps
# the ISO-CI image faithful: a local `task check` passes iff CI passes.
ENV CI=true

WORKDIR /workspace
CMD ["bash"]
