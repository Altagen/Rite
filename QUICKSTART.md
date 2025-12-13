# RITE Quick Start Guide

## Prerequisites Check

```bash
# Check Rust (need 1.70+)
rustc --version

# Check Node.js (need 20+)
node --version

# Check pnpm (need 8+)
pnpm --version

# Check go-task (need 3+)
task --version
```

If any are missing:
- **Rust**: https://rustup.rs/
- **Node.js**: https://nodejs.org/
- **pnpm**: `npm install -g pnpm`
- **go-task**: https://taskfile.dev/installation/

## First Time Setup

```bash
# 1. Install all dependencies (Rust + Node.js)
pnpm install

# This will:
# - Install npm dependencies for all packages
# - Prepare Tauri
# - Take 2-5 minutes depending on your connection
```

## Running in Development

```bash
# Start the app in development mode
task dev

# This will:
# - Start Vite dev server on http://localhost:5173
# - Compile Rust backend
# - Launch the Tauri window
# - Enable hot-reload for both frontend and backend
```

**First launch might take a few minutes** to compile all Rust dependencies.

## Available Commands

```bash
# Development
task dev              # Run dev server with hot reload
task dev:frontend     # Run frontend only

# Testing
task test             # Run all tests (Rust + TypeScript)
task test-rust        # Run Rust tests only
task test-ts          # Run TypeScript type check

# Linting
task lint             # Run all linters
task lint-rust        # Rust linters (clippy + fmt)
task lint-ts          # TypeScript linter

# Formatting
task fmt              # Format all code
task fmt-rust         # Format Rust code
task fmt-ts           # Format TypeScript code

# Building
task build            # Build for current platform
task prepare-release  # Build with all release artifacts

# Utilities
task clean            # Clean all build artifacts
task audit            # Run security audit
task version          # Show current version

# See all commands
task --list
```

## Testing the Setup

Once the app launches:

1. You should see the RITE interface
2. Try connecting to a server (if configured)
3. Check terminal functionality

## Building for Production

```bash
# Build optimized binary
task build

# Or prepare complete release
task prepare-release

# Find the binary
ls -lh dist/
```

## Troubleshooting

### Error: "Failed to resolve dependencies"
```bash
# Clear cache and reinstall
rm -rf node_modules apps/*/node_modules
pnpm install
```

### Error: "cargo build failed"
```bash
# Update Rust
rustup update stable

# Clean and rebuild
task clean
task dev
```

### Error: "Port 5173 already in use"
```bash
# Kill the process using the port
lsof -ti:5173 | xargs kill -9

# Or change the port in apps/desktop/vite.config.ts
```

### Tauri dependencies missing (Linux)

#### Debian/Ubuntu
```bash
sudo apt install \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl wget file \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

#### Fedora/RHEL
```bash
sudo dnf install \
  webkit2gtk4.1-devel \
  openssl-devel \
  curl wget file \
  gtk3-devel \
  libappindicator-gtk3-devel \
  librsvg2-devel
```

#### Arch Linux
```bash
sudo pacman -S \
  webkit2gtk \
  base-devel \
  curl wget file \
  openssl \
  gtk3 \
  libappindicator-gtk3 \
  librsvg \
  go-task
```

## Development Workflow

### Making Changes

**Frontend (React/TypeScript)**:
- Edit files in `apps/desktop/src/`
- Changes auto-reload (hot module replacement)

**Backend (Rust)**:
- Edit files in `apps/desktop/src-tauri/src/`
- Tauri automatically recompiles on save
- Takes 5-30 seconds depending on changes

**Shared packages**:
- Edit `packages/crypto/` or `packages/protocols/`
- Both backend and tests will rebuild

### Running Tests

```bash
# All tests
task test

# Rust only
task test-rust

# TypeScript only
task test-ts

# Security audit
task audit
```

### Code Formatting

```bash
# Format all code
task fmt

# Format Rust only
task fmt-rust

# Format TypeScript only
task fmt-ts

# Check types
task test-ts
```

### Linting

```bash
# Lint all code
task lint

# Rust only
task lint-rust

# TypeScript only
task lint-ts
```

## Commit Messages

RITE uses [Conventional Commits](https://www.conventionalcommits.org/) for automatic changelog generation:

```bash
# Examples
git commit -m "feat(ssh): add SSH config import"
git commit -m "fix(terminal): resolve focus bug"
git commit -m "docs: update quickstart guide"
git commit -m "chore(deps): update tauri to 2.9.4"
```

See [RELEASE.md](./RELEASE.md) for complete commit format documentation.

## Next Steps

1. **Read the docs**:
   - [README.md](./README.md) - Overview
   - [RELEASE.md](./RELEASE.md) - Release & commit format
   - [ROADMAP.md](./docs/ROADMAP.md) - Features
   - [ARCHITECTURE.md](./docs/ARCHITECTURE.md) - Technical details
   - [SECURITY.md](./docs/SECURITY.md) - Security model

2. **Explore the code**:
   - Start with `apps/desktop/src/App.tsx` (frontend entry)
   - Then `apps/desktop/src-tauri/src/main.rs` (backend entry)
   - Check `packages/crypto/src/lib.rs` for crypto implementation

3. **Join the community** (coming soon):
   - GitHub Discussions
   - Discord server
   - Contribute!

## Current Status

**Working**:
- ✅ SSH connections
- ✅ Terminal emulation (xterm.js)
- ✅ Host management with tags
- ✅ Theme system
- ✅ Password encryption
- ✅ Tab and split pane support

**In Progress**:
- 🚧 SFTP/FTP support
- 🚧 SSH config import
- 🚧 Jump host / bastion

**Planned**:
- See [ROADMAP.md](./docs/ROADMAP.md)

## Getting Help

- **Documentation**: Check `docs/` folder
- **Issues**: Open a GitHub issue
- **Questions**: GitHub Discussions (coming soon)
- **Commands**: Run `task --list` to see all available tasks

Happy coding! 🚀
