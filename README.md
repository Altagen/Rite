<div align="center">
  <img src="assets/rite.png" alt="RITE Logo" width="200"/>

  <h1>RITE</h1>

  <p>Rust &amp; TypeScript Interface for Terminal Environment</p>

  <p>
    <a href="https://github.com/Altagen/Rite/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Altagen/Rite/ci.yml?label=CI" alt="CI" /></a>
    <a href="https://github.com/Altagen/Rite/releases/latest"><img src="https://img.shields.io/github/v/release/Altagen/Rite" alt="Latest Release" /></a>
    <a href="LICENSE-MIT"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg" alt="License" /></a>
  </p>
</div>

A modern, secure terminal client for SSH and more.

---

## Features

- **Secure by default** — Argon2id KDF, ChaCha20-Poly1305 AEAD, zeroized memory
- **Encrypted vault** — Local database encrypted at rest
- **SSH client** *(in development)* — Native SSH with xterm.js terminal emulation
- **Host management** *(in development)* — Organize servers with tags and groups

See the [Roadmap](docs/ROADMAP.md) for planned features (theme system, SFTP, jump hosts, profiles, sync, and more).

---

## Tech Stack

- **Backend**: Rust + Tauri 2.x
- **Frontend**: React + TypeScript + TailwindCSS
- **Terminal**: xterm.js
- **Database**: SQLite (encrypted)
- **Crypto**: Argon2id, ChaCha20-Poly1305, age
- **SSH**: russh (pure Rust)
- **Package Manager**: pnpm (monorepo)
- **Build System**: Task (go-task)

## Platform Support

| Platform | Status |
|----------|--------|
| Linux x86_64 | ✅ Primary target |
| Linux ARM64 | ✅ Supported |
| macOS Intel | ✅ Supported |
| macOS Apple Silicon | ✅ Supported |
| Windows | ❌ Not planned |

---

## Getting Started

### Prerequisites

- **Rust**: 1.70+ — [Install Rust](https://rustup.rs/)
- **Node.js**: 18+ — [Install Node.js](https://nodejs.org/)
- **pnpm**: 8+ — [Install pnpm](https://pnpm.io/installation)
- **Task**: [Install go-task](https://taskfile.dev/installation/)

### Development Setup

```bash
git clone https://github.com/Altagen/Rite.git
cd Rite
pnpm install
task dev
```

`task dev` starts the Vite dev server and the Tauri app with hot-reload.

### Building for Production

```bash
task build
```

See [RELEASE.md](docs/RELEASE.md) for the release process.

---

## Configuration

### User Data Directories

- **Linux**: Config `~/.config/rite/`, Data `~/.local/share/rite/`
- **macOS**: Config & Data `~/Library/Application Support/rite/`

### Files

| Path | Purpose |
|------|---------|
| `~/.config/rite/config.toml` | User configuration |
| `~/.config/rite/themes/` | Custom themes |
| `~/.local/share/rite/vault.db` | Encrypted database |

---

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
│   ├── ARCHITECTURE.md
│   ├── RELEASE.md
│   ├── ROADMAP.md
│   └── SECURITY.md
├── Cargo.toml            # Rust workspace
├── pnpm-workspace.yaml
└── Taskfile.yaml
```

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — Technical architecture
- [Security](docs/SECURITY.md) — Security policy and practices
- [Roadmap](docs/ROADMAP.md) — Feature roadmap
- [Release](docs/RELEASE.md) — Release process and conventional commits

---

## Contributing

Issues and bug reports are welcome on [GitHub](https://github.com/Altagen/Rite/issues).

For security vulnerabilities, please **do not** open a public issue. See [SECURITY.md](./docs/SECURITY.md).

## License

RITE is dual-licensed under:
- MIT License — see [LICENSE-MIT](./LICENSE-MIT)
- Apache License 2.0 — see [LICENSE-APACHE](./LICENSE-APACHE)

You may choose either license for your use.
