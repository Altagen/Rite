# RITE Release Process

Release guide for RITE version 0.1.0 and beyond.

## Version Format

RITE uses semantic versioning **WITHOUT** the 'v' prefix:
- ✅ Correct: `0.1.0`, `1.0.0`, `1.2.3`
- ❌ Incorrect: `v0.1.0`, `v1.0.0`

## Conventional Commits

RITE uses [Conventional Commits](https://www.conventionalcommits.org/) to automatically generate changelogs via git-cliff.

### Commit Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Commit Types

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **perf**: Performance improvement
- **refactor**: Code refactoring
- **style**: Formatting changes
- **test**: Adding/modifying tests
- **chore**: Maintenance tasks (build, deps, etc.)
- **ci**: CI/CD changes

### Examples

```bash
git commit -m "feat(ssh): add SSH config import support"
git commit -m "fix(terminal): resolve focus issue on tab switch"
git commit -m "docs: update installation instructions"
git commit -m "chore(deps): update axum to 0.8.1"
```

## Local Build

There is no local equivalent of the release pipeline — releases are built by CI,
from a tag. What you can do locally is build what CI builds:

```bash
task clean         # drop previous build output
task build         # client binary for the current platform, frontend embedded
task build-server-image   # the rite-server container image
task sbom          # CycloneDX SBOM for the client
```

**Note**: The changelog is generated **automatically in CI/CD** via git-cliff. No need to generate it locally.

## CI/CD Workflows

### CI Pipeline (`.github/workflows/ci.yml`)

Runs on every push and pull request to `main` or `develop`:
- Rust tests (`cargo test`)
- Rust linting (`cargo clippy`, `cargo fmt --check`)
- TypeScript type checking (`pnpm typecheck`)
- TypeScript linting (`pnpm lint`)
- Security audit (`cargo audit`)

### Release Pipeline (`.github/workflows/release.yml`)

Triggered automatically when pushing a tag:

```bash
git tag 0.1.0
git push origin 0.1.0
```

The workflow:
1. **Generates the changelog** with git-cliff from the conventional commits, and
   prepends the install header (client tarball, server image, how to verify a
   download) — that header is written by the workflow, not by git-cliff, because
   the image is not a release asset and would otherwise go unmentioned
2. **Creates a draft release** with those notes
3. **Builds the client** in parallel for four targets, uploading each tarball to
   the draft
4. **Builds and pushes** the multi-arch server image to GHCR
5. **Generates the SBOM** (CycloneDX) and consolidates the per-platform checksums
6. **Publishes** the release — the last step, so a failure anywhere above leaves
   a draft rather than a half-populated public release

## Release Artifacts

Every artifact the pipeline produces, and nothing else. There are no `.deb`,
`.rpm`, `.AppImage` or `.dmg` packages — the client ships as a binary in a
tarball, on every platform.

### Client
- **rite-\<version\>-linux-x86_64.tar.gz**
- **rite-\<version\>-linux-aarch64.tar.gz**
- **rite-\<version\>-macos-x86_64.tar.gz** — Intel Macs
- **rite-\<version\>-macos-aarch64.tar.gz** — Apple Silicon

Each contains one file: the `rite` binary, with the frontend embedded.

### Server
- **ghcr.io/\<owner\>/rite-server:\<version\>** and **:latest** — multi-arch
  (linux/amd64, linux/arm64). A container image, so it lives in the registry and
  not in the release's asset list; the notes link to it.

### Security & Compliance
- **sbom-\<version\>.json** — CycloneDX SBOM for the client
- **rite-\<version\>-checksums.txt** — SHA256 for every tarball, in one file

## Task Commands

### Development
```bash
task dev              # Dev server with hot reload
task dev:frontend     # Frontend only
task test             # All tests (Rust + TypeScript)
task lint             # All linters
task fmt              # Format code
```

### Build
```bash
task build                # Client binary for the current platform
task build-server-image   # rite-server container image
```

Cross-building is CI's job; there are no per-target local tasks.

### Release
```bash
task sbom                 # CycloneDX SBOM for the client
task changelog-preview    # Preview unreleased changes
```

### Utilities
```bash
task version              # Show current version
task clean                # Clean all build artifacts
task clean-dist           # Clean dist/ only
task audit                # Security audit (cargo + pnpm)
```

`task check` runs the full pre-push gate — the same one CI runs.

## Release Process

### 1. Prepare Release

Verify all tests pass:
```bash
task test
task lint
```

### 2. Update Version

Bump the version in `Cargo.toml` (`[workspace.package] version`) and the two
`package.json` files (root + `apps/desktop`). Regenerate `Cargo.lock` with
`cargo check`.

Commit:
```bash
git add Cargo.toml Cargo.lock package.json apps/desktop/package.json
git commit -m "chore(release): bump version to 0.2.0"
git push origin main
```

### 3. Create and Push Tag

```bash
git tag 0.1.0
git push origin 0.1.0
```

### 4. Monitor Release

The GitHub Actions workflow runs automatically. Track progress at:
`https://github.com/<org>/Rite/actions`

### 5. Verify Release

Once complete, verify at:
`https://github.com/<org>/Rite/releases/tag/0.1.0`

Artifact checklist:
- [ ] Client tarballs ×4 (linux x86_64 / aarch64, macos x86_64 / aarch64)
- [ ] `sbom-<version>.json`
- [ ] `rite-<version>-checksums.txt`
- [ ] Server image on GHCR, both architectures
- [ ] Notes carry the install header **and** the generated changelog
- [ ] The release is published, not left a draft

## Changelog Preview

To preview changes that will be in the next changelog:

```bash
task changelog-preview
```

This displays unreleased commits formatted according to conventional commits. Useful to verify your commits will be properly categorized in the final changelog.

## Dependencies

### Local Development
The four toolchains and the file that pins each one are listed in the README's
[Prerequisites](../README.md#prerequisites). They are exact pins, not floors, and
CI installs what those files say — so `task check` locally is the check CI runs.
This section does not repeat the list: it drifted once already, claiming Rust
"1.85+" long after the pin moved, while the README stayed right.

Two things that matter at release time and are not prerequisites:

- **The pin is not the MSRV.** `rust-version` in the workspace manifest is the
  oldest Rust a consumer needs; `rust-toolchain.toml` is what we build with, and
  it is higher. Lowering one does not lower the other.
- **One pin cannot read its file.** A Containerfile chooses its base image before
  any file is available, so `Containerfile.server` carries `ARG RUST_VERSION`; the
  release workflow passes the real value from `rust-toolchain.toml`, and the
  default is what a local build gets. **Bumping the Rust pin means editing both
  files** — the `📌 Pins` CI job fails if they disagree, so it is enforced rather
  than remembered.

The ISO-CI container (`Containerfile`) carries all four pins, so a local
`task check` inside it passes if and only if CI passes.

### Optional Tools
- **git-cliff**: For changelog preview (optional locally, required in CI)
- **cargo-audit**: For security audits
- **cargo-cyclonedx**: For SBOM generation

Install optional tools:
```bash
cargo install git-cliff cargo-audit cargo-cyclonedx
```

## Build Times

Reference build times on a standard development machine:
- **Rust compilation**: ~3-4 min (first build), ~30s (incremental)
- **Full release build**: ~5-6 min
- **CI pipeline**: ~8-10 min
- **Release workflow** (all platforms): ~15-20 min

## Troubleshooting

### SBOM Generation Fails
```bash
cargo cyclonedx --format json --manifest-path apps/desktop/shell/Cargo.toml
mv apps/desktop/shell/rite-desktop.cdx.json dist/sbom.json
```

`cargo-cyclonedx` dropped `-p/--package`; a crate is selected by its manifest.
The workflow pins the tool for that reason — an unpinned `cargo install` in the
release path made 0.2.0's behaviour depend on the day it ran, and it broke.

### Build Fails on macOS
Verify Xcode command line tools are installed:
```bash
xcode-select --install
```

## Security

### Checksum Verification
Every tarball is listed in one checksums file:
```bash
sha256sum -c --ignore-missing rite-0.2.1-checksums.txt
```

### SBOM
The SBOM provides a complete dependency list for security auditing and compliance.

## Future Improvements

- [ ] Windows builds (.msi, .exe)
- [ ] Distribution packages (.deb, .rpm, AppImage, .dmg) — the client ships as a
      tarball today; these were documented long before they existed and never did
- [ ] Flatpak/Snap packages
- [ ] Auto-update support
- [ ] Signed binaries (macOS/Windows)
- [ ] Homebrew formula
- [ ] AUR package (Arch Linux)
