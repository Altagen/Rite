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
git commit -m "chore(deps): update tauri to 2.9.4"
```

## Local Build

To test the release locally:

```bash
# Clean previous builds
task clean

# Build complete release
task prepare-release
```

This generates in `./dist/`:
- `RITE_<version>_amd64.deb` - Debian/Ubuntu package
- `RITE-<version>-1.x86_64.rpm` - Fedora/RHEL package
- `rite-<version>-linux-x86_64.tar.gz` - Binary tarball (binary only)
- `sbom.json` - Software Bill of Materials
- `*.sha256` - SHA256 checksums for all artifacts

**Note**: The changelog (`CHANGELOG.md`) is generated **automatically in CI/CD** via git-cliff. No need to generate it locally.

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
1. **Generates changelog** automatically with git-cliff from conventional commits
2. **Creates GitHub Release** with the changelog
3. **Builds multi-platform** in parallel:
   - **Linux x86_64**: .deb, .rpm, .AppImage, tar.gz
   - **macOS x86_64**: .dmg
   - **macOS ARM64**: .dmg
4. **Generates SBOM** (CycloneDX)
5. **Generates SHA256 checksums**
6. **Uploads all artifacts** to GitHub Release

## Release Artifacts

### Linux
- **RITE_<version>_amd64.deb** (~5.4 MB) - Debian/Ubuntu
- **RITE-<version>-1.x86_64.rpm** (~5.4 MB) - Fedora/RHEL
- **rite-<version>-linux-x86_64.tar.gz** (~5.2 MB) - Binary archive (binary only)
- **rite-<version>-linux-x86_64.AppImage** - Portable AppImage (optional)

### macOS
- **RITE_<version>_x64.dmg** - Intel Macs
- **RITE_<version>_aarch64.dmg** - Apple Silicon

### Security & Compliance
- **sbom-<version>.json** - CycloneDX SBOM
- **<artifact>.sha256** - Checksum for each artifact

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
task build                 # Build for current platform
task build-linux-amd64     # Build Linux x86_64
task build-macos-amd64     # Build macOS x86_64
task build-macos-arm64     # Build macOS ARM64
```

### Release
```bash
task prepare-release       # Build and prepare all artifacts locally
task sbom                  # Generate SBOM only
task checksums             # Generate checksums only
task changelog-preview     # Preview unreleased changes
```

### Utilities
```bash
task version              # Show current version
task clean                # Clean all build artifacts
task clean-dist           # Clean dist/ only
task install              # Install RITE locally (Linux)
task audit                # Security audit
```

## Release Process

### 1. Prepare Release

Verify all tests pass:
```bash
task test
task lint
```

### 2. Update Version

Edit `apps/desktop/src-tauri/tauri.conf.json`:
```json
{
  "version": "0.1.0"
}
```

Commit:
```bash
git add apps/desktop/src-tauri/tauri.conf.json
git commit -m "chore(release): bump version to 0.1.0"
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
- [ ] Linux .deb
- [ ] Linux .rpm
- [ ] Linux .tar.gz (binary only)
- [ ] macOS .dmg (x86_64)
- [ ] macOS .dmg (ARM64)
- [ ] SBOM JSON
- [ ] All checksums
- [ ] Changelog automatically generated

## Changelog Preview

To preview changes that will be in the next changelog:

```bash
task changelog-preview
```

This displays unreleased commits formatted according to conventional commits. Useful to verify your commits will be properly categorized in the final changelog.

## Dependencies

### Local Development
- **Rust**: 1.70+
- **Node.js**: 20+
- **pnpm**: 8+
- **go-task**: 3+

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
If `task sbom` fails:
```bash
cd apps/desktop/src-tauri
cargo cyclonedx --format json
mv rite.cdx.json ../../../dist/sbom.json
```

### Build Fails on macOS
Verify Xcode command line tools are installed:
```bash
xcode-select --install
```

### AppImage Build Fails
AppImage is optional. The workflow continues even if it fails. Users can use .deb, .rpm, or tar.gz instead.

## Security

### Checksum Verification
Users can verify download integrity:
```bash
sha256sum -c RITE_0.1.0_amd64.deb.sha256
```

### SBOM
The SBOM provides a complete dependency list for security auditing and compliance.

## Future Improvements

- [ ] Windows builds (.msi, .exe)
- [ ] Linux ARM64 builds
- [ ] Flatpak/Snap packages
- [ ] Auto-update support
- [ ] Signed binaries (macOS/Windows)
- [ ] Homebrew formula
- [ ] AUR package (Arch Linux)
