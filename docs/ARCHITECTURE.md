# RITE Architecture

This document describes the technical architecture and design decisions for RITE.

## Table of Contents
- [Overview](#overview)
- [Monorepo Structure](#monorepo-structure)
- [Technology Stack](#technology-stack)
- [Architecture Layers](#architecture-layers)
- [Protocol Abstraction](#protocol-abstraction)
- [Security Architecture](#security-architecture)
- [Theme System](#theme-system)
- [Profiles / Termconfs](#profiles--termconfs)
- [Sync Architecture](#sync-architecture)
- [Data Flow](#data-flow)

## Overview

RITE is a desktop terminal client built with:
- **Backend**: Rust (via Tauri) for system operations, crypto, and protocol handling
- **Frontend**: React + TypeScript for UI
- **Terminal**: xterm.js for terminal emulation

**Key Principles**:
- **Security First**: End-to-end encryption, zero-knowledge sync
- **Modularity**: Pluggable protocols, sync backends, and themes
- **Performance**: Rust for heavy lifting, React for reactive UI
- **Offline-First**: Local-only mode with optional sync

## Monorepo Structure

```
rite/
├── apps/
│   └── desktop/              # Tauri desktop application
│       ├── src-tauri/        # Rust backend
│       │   ├── src/
│       │   │   ├── main.rs          # Tauri entry point
│       │   │   ├── commands.rs      # Tauri commands (IPC)
│       │   │   ├── state.rs         # App state management
│       │   │   └── theme.rs         # Theme loader
│       │   ├── Cargo.toml
│       │   └── tauri.conf.json
│       └── src/              # React frontend
│           ├── main.tsx
│           ├── App.tsx
│           ├── components/
│           ├── stores/       # Zustand state
│           └── lib/          # Utilities
├── packages/
│   ├── crypto/               # Cryptography module (Rust)
│   │   ├── src/lib.rs       # Argon2id, ChaCha20, etc.
│   │   └── Cargo.toml
│   └── protocols/            # Protocol implementations (Rust)
│       ├── src/
│       │   ├── lib.rs       # Protocol traits
│       │   ├── ssh.rs       # SSH/SFTP
│       │   └── ftp.rs       # FTP (future)
│       └── Cargo.toml
├── docs/
│   ├── ROADMAP.md
│   ├── SECURITY.md
│   └── ARCHITECTURE.md (this file)
├── Cargo.toml                # Rust workspace
├── package.json              # pnpm workspace
└── pnpm-workspace.yaml
```

## Technology Stack

### Backend (Rust)
| Purpose | Library | Version | Notes |
|---------|---------|---------|-------|
| Framework | `tauri` | 2.x | Desktop app framework |
| Async Runtime | `tokio` | 1.x | Async I/O |
| KDF | `argon2` | 0.5.x | Password hashing |
| Encryption | `chacha20poly1305` | 0.10.x | AEAD cipher |
| File Encryption | `age` | 0.10.x | Export/sync encryption |
| SSH | `russh` | 0.45.x | Pure Rust SSH |
| Database | `sqlx` | 0.8.x | SQLite async driver |
| Logging | `tracing` | 0.1.x | Structured logging |
| Memory Safety | `zeroize` | 1.x | Secure memory clearing |

### Frontend (TypeScript)
| Purpose | Library | Version | Notes |
|---------|---------|---------|-------|
| Framework | `react` | 18.x | UI framework |
| Build Tool | `vite` | 6.x | Fast dev server |
| State | `zustand` | 5.x | Lightweight state mgmt |
| Terminal | `xterm.js` | 5.x | Terminal emulator |
| Styling | `tailwindcss` | 3.x | Utility CSS |
| UI Components | `shadcn/ui` | - | Composable components |

## Architecture Layers

```
┌─────────────────────────────────────────────────┐
│           Frontend (React + TypeScript)         │
│  ┌─────────┬──────────┬──────────┬──────────┐  │
│  │   UI    │ Terminal │  Theme   │  State   │  │
│  │Components│ (xterm)  │  System  │(Zustand) │  │
│  └─────────┴──────────┴──────────┴──────────┘  │
└────────────────────┬────────────────────────────┘
                     │ IPC (Tauri Commands)
┌────────────────────▼────────────────────────────┐
│             Backend (Rust + Tauri)              │
│  ┌─────────┬──────────┬──────────┬──────────┐  │
│  │Commands │  State   │  Theme   │   DB     │  │
│  │  (IPC)  │Management│  Loader  │ (SQLite) │  │
│  └─────────┴──────────┴──────────┴──────────┘  │
│  ┌─────────────────────────────────────────┐   │
│  │         Protocol Layer (Traits)         │   │
│  │  ┌──────┬──────┬──────┬──────┬──────┐  │   │
│  │  │ SSH  │ SFTP │ FTP  │Local │Future│  │   │
│  │  └──────┴──────┴──────┴──────┴──────┘  │   │
│  └─────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────┐   │
│  │          Crypto Layer                   │   │
│  │  ┌──────────┬──────────┬──────────┐    │   │
│  │  │ Argon2id │ ChaCha20 │   Age    │    │   │
│  │  └──────────┴──────────┴──────────┘    │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

## Protocol Abstraction

### Design Goal
Support multiple protocols (SSH, FTP, SFTP, Local, future: Telnet, Mosh, Serial) through a unified interface.

### Trait Hierarchy

```rust
// Base protocol trait
trait Protocol {
    fn protocol_type(&self) -> ProtocolType;
    async fn connect(&mut self, config: &ConnectionConfig) -> Result<()>;
    async fn disconnect(&mut self) -> Result<()>;
    fn is_connected(&self) -> bool;
    async fn send(&mut self, data: &[u8]) -> Result<()>;
    async fn receive(&mut self) -> Result<Vec<u8>>;
}

// Terminal protocols (SSH, Telnet, Local)
trait TerminalProtocol: Protocol {
    async fn request_pty(&mut self, term: &str, width: u32, height: u32) -> Result<()>;
    async fn resize_pty(&mut self, width: u32, height: u32) -> Result<()>;
    async fn exec(&mut self, command: &str) -> Result<()>;
    async fn shell(&mut self) -> Result<()>;
}

// File transfer protocols (SFTP, FTP, SCP)
trait FileTransferProtocol: Protocol {
    async fn list_dir(&mut self, path: &str) -> Result<Vec<FileEntry>>;
    async fn download(&mut self, remote: &str, local: &Path) -> Result<()>;
    async fn upload(&mut self, local: &Path, remote: &str) -> Result<()>;
    async fn delete(&mut self, path: &str) -> Result<()>;
    async fn mkdir(&mut self, path: &str) -> Result<()>;
}
```

### Benefits
- **Extensibility**: Add new protocols without modifying core
- **Testability**: Mock protocols for testing
- **Future-proof**: Profiles/termconfs work with any protocol

## Security Architecture

See [SECURITY.md](./SECURITY.md) for full details.

### Key Components

```
User Password
     ↓
┌────────────────────────────────────┐
│  Argon2id (m=64MB, t=3, p=4)      │
│  + unique salt                     │
└────────────────┬───────────────────┘
                 ↓
         Master Key (256-bit)
                 ↓
         ┌───────┴───────┐
         ↓               ↓
   ┌─────────┐    ┌──────────────┐
   │ DB Enc  │    │  Sync Enc    │
   │ChaCha20 │    │  (age)       │
   └─────────┘    └──────────────┘
         ↓               ↓
    SQLite DB      Encrypted Blob
```

### Data at Rest
- **Vault DB**: `~/.local/share/rite/vault.db`
  - Sensitive fields encrypted with ChaCha20-Poly1305
  - Master key stored in memory only (zeroized on lock)
- **Config**: `~/.config/rite/config.toml`
  - Plaintext settings (non-sensitive)
- **Themes**: `~/.config/rite/themes/*.toml`
  - User themes, plaintext

## Theme System

### Architecture

```
Load Theme Request
       ↓
┌──────────────────────┐
│  Theme Loader        │
│  (Rust backend)      │
└──────┬───────────────┘
       │
       ├─→ Try: ~/.config/rite/themes/NAME.toml
       │   ├─ Success → Parse & Return
       │   └─ Fail ↓
       │
       └─→ Fallback: Embedded Default Theme
               └─→ Return
```

### Theme Format (TOML)
```toml
[metadata]
name = "Theme Name"
author = "Author Name"
version = "1.0.0"

[colors]
# Background colors
background = "#1e1e2e"
foreground = "#cdd6f4"
cursor = "#f5e0dc"
selection = "#585b70"

# ANSI colors
black = "#45475a"
red = "#f38ba8"     # Errors, important alerts
green = "#a6e3a1"   # Success messages
# ... more ANSI colors

[terminal]
font_family = "JetBrains Mono"
font_size = 14
line_height = 1.2

[ui]
accent = "#89b4fa"   # Primary accent color
border = "#313244"
hover = "#585b70"
```

### Benefits
- Community themes as simple TOML files
- Comments for documentation
- Consistent with profiles (also TOML)
- Hot-reload support (future)
- Fallback ensures app never breaks
- Small binary (only 1 embedded theme)

## Profiles / Termconfs

**Phase**: Phase 3+

### Concept
Reproducible terminal environments, similar to devcontainers.

### Configuration Format (TOML)
```toml
[profile]
name = "Production Servers"
description = "All prod via bastion"
tags = ["production", "aws"]

[[tabs]]
name = "Bastion"
host_id = "bastion-prod"
auto_connect = true

[[tabs]]
name = "Web Server"
host_id = "web-01"
jump_host = "bastion-prod"
startup_commands = [
    "cd /var/www",
    "tail -f /var/log/nginx/access.log"
]

[[tabs]]
name = "Local Scripts"
type = "local"
working_dir = "~/scripts"
startup_commands = ["echo 'Ready'"]
```

### Architecture

```
Profile File (TOML)
       ↓
┌──────────────────────┐
│  Profile Loader      │
│  (Rust backend)      │
└──────┬───────────────┘
       ↓
  Profile Object
       ↓
┌──────────────────────┐
│  Frontend            │
│  - Create tabs       │
│  - Connect hosts     │
│  - Run commands      │
└──────────────────────┘
```

### Use Cases
- **DevOps**: Open all staging servers at once
- **SRE**: Monitoring dashboards + log tails
- **Development**: Local + remote dev environment
- **Teams**: Share profiles via Git

## Sync Architecture

**Phase**: Phase 2+

### Pluggable Backends

```rust
trait SyncBackend {
    async fn push(&self, encrypted_data: &[u8]) -> Result<()>;
    async fn pull(&self) -> Result<Vec<u8>>;
    async fn check_updates(&self) -> Result<bool>;
    async fn list_versions(&self) -> Result<Vec<Version>>;
}

// Implementations
impl SyncBackend for LocalOnly { ... }      // No sync
impl SyncBackend for GitBackend { ... }     // Git repo
impl SyncBackend for S3Backend { ... }      // S3-compatible
impl SyncBackend for WebDavBackend { ... }  // WebDAV
```

### Zero-Knowledge Flow

```
Device A                          Backend                   Device B
───────                           ───────                   ────────
1. Unlock vault
   (master password)

2. Encrypt vault
   with age
   (using master key)

3. Push encrypted ─────────→  Store blob  ←──────────  5. Pull encrypted
   blob                       (can't decrypt)                blob

                                                        6. Decrypt with
                                                           master password

                                                        7. Unlock vault
```

**Server sees**: Opaque encrypted blob
**Server cannot**: Read credentials, hosts, SSH keys

### Conflict Resolution
- **Phase 2**: Last-write-wins (simple)
- **Phase 3**: Manual merge UI
- **Future**: CRDTs for automatic merging

## Data Flow

### SSH Connection Flow

```
Frontend (React)                Backend (Rust)               Remote
─────────────────               ──────────────               ──────
1. User clicks
   "Connect to host"
        │
        ├─→ invoke('ssh_connect',
        │          {host_id})
        │                              2. Load host config
        │                                 from DB
        │
        │                              3. Decrypt credentials
        │                                 (if encrypted)
        │
        │                              4. SshClient::connect()
        │                                      │
        │                                      ├─→ TCP connect ─────→ SSH Server
        │                                      │                      │
        │                                      │   ←────────────────  Accept
        │                                      │
        │                              5. Authenticate
        │                                 (password or key) ─────────→ Verify
        │                                      │                      │
        │                                      │   ←────────────────  OK
        │                                      │
        │   ←──────── Success ──────  6. Return success
        │
7. Create xterm.js
   terminal instance
        │
8. Start I/O loop ←──────────────→ Bidirectional data ←──→ SSH Session
```

### Theme Loading Flow

```
Frontend                    Backend                    Filesystem
────────                    ───────                    ──────────
1. User selects theme
        │
        ├─→ invoke('load_theme',
        │          {name: 'catppuccin'})
        │                         2. Check user themes dir
        │                            ~/.config/rite/themes/
        │                                   │
        │                                   ├─→ catppuccin.json
        │                                   │   exists?
        │                                   │
        │                         3. Read file ─────────→ Read
        │                                   │
        │                                   │   ←─────────  Contents
        │                                   │
        │                         4. Parse JSON
        │                            (validate)
        │   ←───── Theme ───────  5. Return Theme object
        │
6. Apply theme to
   - xterm.js colors
   - UI CSS variables
```

## Build & Distribution

### Development
```bash
# Install dependencies
pnpm install

# Run in dev mode (hot reload)
pnpm dev
```

### Production Build
```bash
# Build frontend + backend
pnpm build

# Output (Linux)
apps/desktop/src-tauri/target/release/rite

# Package
# Creates tar.gz with binary + assets
```

### Release Artifacts
- **Linux**: `rite-{version}-linux-x64.tar.gz`
- **macOS**: `rite-{version}-darwin-arm64.tar.gz` (Apple Silicon)
- **macOS**: `rite-{version}-darwin-x64.tar.gz` (Intel)

No auto-updater (by design - user manages updates).

## Performance Considerations

### Terminal Rendering
- **xterm.js**: Handles rendering (GPU-accelerated in browser)
- **Scrollback**: Limited to 50k-100k lines (configurable)
- **Throttling**: Backend throttles output to prevent UI freeze

### Database
- **SQLite**: Lightweight, embedded
- **Indexes**: On host names, tags for fast search
- **Async**: All DB ops async (via `sqlx`)

### Memory
- **Zeroize**: Sensitive data cleared from memory ASAP
- **Mlock** (future): Prevent swapping to disk

## Testing Strategy

### Unit Tests
- Crypto functions (encryption, KDF)
- Protocol implementations (mocked connections)
- Theme parsing
- Profile parsing

### Integration Tests
- Tauri commands (invoke from test)
- Database operations
- End-to-end crypto (encrypt → decrypt)

### Security Tests
- Password strength validation
- Zeroization (memory cleared)
- SQL injection prevention
- Path traversal prevention

### Manual Tests
- SSH connection to real server
- Theme hot-reload
- Profile launch
- Sync across devices

## Future Architecture Considerations

### Plugin System
**Challenge**: Rust + TypeScript plugins are hard
**Possible Solution**: WASM plugins for protocols?
**Status**: Phase 4+, not committed

### GPU Terminal Rendering
**Challenge**: xterm.js is already fast
**Possible Solution**: Switch to Alacritty's renderer?
**Status**: Future consideration

### Distributed Sync
**Challenge**: CRDTs for automatic conflict resolution
**Possible Solution**: Automerge or similar
**Status**: Phase 4+

## References

- [Tauri Architecture](https://tauri.app/concepts/architecture/)
- [russh Documentation](https://docs.rs/russh)
- [xterm.js Documentation](https://xtermjs.org/)
- [age Specification](https://age-encryption.org/v1)
