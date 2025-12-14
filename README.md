# RITE

**R**ust & **T**ypeScript **I**nterface for **T**erminal **E**nvironment

A modern, secure, and extensible terminal client for SSH, SFTP, FTP, and more.

> ⚠️ **Early Development**: RITE is in active development. Many features are not yet implemented. See the [Roadmap](./docs/ROADMAP.md) for planned features.

## Features

### Current (Phase 1 - In Progress)
- ✅ Modular architecture with protocol abstraction
- ✅ Strong cryptography (Argon2id + ChaCha20-Poly1305)
- ✅ Password strength validation
- ✅ Theme system with user-customizable themes
- ✅ Secure memory handling (zeroization)
- 🚧 SSH client
- 🚧 Terminal emulation (xterm.js)
- 🚧 Host management with tags and groups

### Planned
- SSH/SFTP/FTP support
- Terminal tabs and split-view
- Jump host / bastion support
- Profile system ("termconfs") for reproducible environments
- Self-hosted sync with end-to-end encryption
- Import from `~/.ssh/config`
- Community themes and customization

See the full [Roadmap](./docs/ROADMAP.md) for details.

## Security First

RITE is built with security as a core principle:
- **Zero-knowledge architecture**: Sync servers never see your credentials
- **Argon2id KDF**: Industry-standard password hashing
- **ChaCha20-Poly1305 AEAD**: Modern authenticated encryption
- **Local-only by default**: No mandatory cloud services
- **Encrypted at rest**: Database and sync files encrypted

Read more in [SECURITY.md](./docs/SECURITY.md).

## Architecture

- **Backend**: Rust (via Tauri) for cryptography, protocols, and system operations
- **Frontend**: React + TypeScript + TailwindCSS for the UI
- **Terminal**: xterm.js for terminal emulation
- **Database**: SQLite for local storage

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for technical details.

## Getting Started

### Prerequisites

- **Rust**: 1.70+ ([Install Rust](https://rustup.rs/))
- **Node.js**: 18+ ([Install Node.js](https://nodejs.org/))
- **pnpm**: 8+ ([Install pnpm](https://pnpm.io/installation))

### Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/rite.git
   cd rite
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Install go-task** (build system)
   ```bash
   # Arch Linux
   sudo pacman -S go-task

   # macOS
   brew install go-task

   # Other: https://taskfile.dev/installation/
   ```

4. **Run in development mode**
   ```bash
   task dev
   ```

   This will:
   - Start the Vite dev server (frontend)
   - Compile the Rust backend
   - Launch the Tauri app with hot-reload

### Building for Production

```bash
# Build for current platform
task build

# Or build release with all artifacts
task prepare-release
```

See [RELEASE.md](./RELEASE.md) for complete release documentation.

## Project Structure

```
rite/
├── apps/
│   └── desktop/          # Tauri desktop application
│       ├── src-tauri/    # Rust backend
│       └── src/          # React frontend
├── packages/
│   ├── crypto/           # Cryptography module (Rust)
│   └── protocols/        # Protocol implementations (Rust)
├── docs/
│   ├── ROADMAP.md        # Feature roadmap
│   ├── SECURITY.md       # Security documentation
│   └── ARCHITECTURE.md   # Technical architecture
├── Cargo.toml            # Rust workspace
├── package.json          # npm workspace
└── pnpm-workspace.yaml
```

## Configuration

### User Data Directories

- **Linux**:
  - Config: `~/.config/rite/`
  - Data: `~/.local/share/rite/`
- **macOS** (future):
  - Config: `~/Library/Application Support/rite/`
  - Data: `~/Library/Application Support/rite/`

### Files

- `~/.config/rite/config.toml` - User configuration
- `~/.config/rite/themes/` - Custom themes
- `~/.config/rite/profiles/` - Terminal profiles (Phase 3+)
- `~/.local/share/rite/vault.db` - Encrypted database

## Contributing

We welcome contributions! Contribution guidelines coming soon.

### Development Workflow

1. Create a feature branch
2. Make your changes
3. Run tests: `task test`
4. Format code: `task fmt`
5. Lint code: `task lint`
6. Submit a pull request

See [RELEASE.md](./RELEASE.md) for commit message format (conventional commits).

### Code of Conduct

Be respectful and constructive. Detailed CoC coming soon.

## Testing

```bash
# Run all tests (Rust + TypeScript)
task test

# Run Rust tests only
task test-rust

# Run TypeScript type check only
task test-ts

# Security audit
task audit
```

See `task --list` for all available commands.

## Platform Support

### Current
- ✅ Linux (primary target)
- 🚧 macOS (planned, should work on both Intel and Apple Silicon)

### Future
- ❓ Windows (not planned, but dependencies are compatible)

### Out of Scope
- ❌ Mobile (Android/iOS)

## Comparison with Other Tools

| Feature | RITE | Termius | PuTTY | iTerm2 |
|---------|------|---------|-------|--------|
| SSH | 🚧 | ✅ | ✅ | ✅ |
| SFTP | Planned | ✅ | ✅ | ❌ |
| Self-hosted sync | ✅ | ❌ | ❌ | ❌ |
| E2E encryption | ✅ | ✅ | ❌ | ❌ |
| Profiles/Termconfs | Planned | Limited | ❌ | ✅ |
| Open source | ✅ | ❌ | ✅ | ❌ |
| Cross-platform | Linux/macOS | All | Windows | macOS |
| Community themes | ✅ | Limited | ❌ | ✅ |

## License

RITE is dual-licensed under:
- MIT License
- Apache License 2.0

You may choose either license for your use.

See [LICENSE-MIT](./LICENSE-MIT) and [LICENSE-APACHE](./LICENSE-APACHE) for details.

## Acknowledgments

- **Tauri** for the excellent Rust-based desktop framework
- **russh** for pure-Rust SSH implementation
- **xterm.js** for the terminal emulator
- **age** for modern file encryption
- The Rust and TypeScript communities

## Roadmap

See [ROADMAP.md](./docs/ROADMAP.md) for the full feature plan.

## Security

For security vulnerabilities, please DO NOT open a public issue. Contact us at [security email].

See [SECURITY.md](./docs/SECURITY.md) for our security policy and best practices.

## FAQ

### Why build another terminal client?

Existing solutions either:
- Lack self-hosted sync (Termius requires their cloud)
- Don't support profiles/environments (PuTTY)
- Are platform-specific (iTerm2)

RITE aims to be open-source, cross-platform, and privacy-focused.

### Why Rust + TypeScript?

- **Rust**: Security, performance, and memory safety for backend
- **TypeScript**: Rich UI ecosystem and rapid development for frontend
- **Tauri**: Best of both worlds with small binaries and native performance

### Will there be a mobile version?

Not planned. RITE focuses on desktop workflows. Tauri mobile exists but is immature.

### Can I use RITE without sync?

Yes! Local-only mode is the default. Sync is entirely optional.

### How is this different from tmux/screen?

RITE is a _client_ for connecting to remote servers. tmux/screen are _multiplexers_ running on the server. They complement each other.

### Can I contribute themes?

Absolutely! Themes are just TOML files with comments. See [Theme Guide](./docs/THEMES.md) (coming soon).

## Status

Current version: **0.1.0-alpha**

This is early-stage software. Expect breaking changes and incomplete features.

## Links

- [GitHub Repository](https://github.com/yourusername/rite)
- [Issue Tracker](https://github.com/yourusername/rite/issues)
- [Discussions](https://github.com/yourusername/rite/discussions)
- [Documentation](./docs/)

---

**Built with ❤️ and Rust**
