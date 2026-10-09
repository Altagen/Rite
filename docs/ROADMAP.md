# RITE Roadmap

This document outlines the planned features for RITE, organized by development phases.

**Product Vision:** Modern terminal with advanced features and native SSH/SFTP support (not just an SSH client).

**Current Focus:** Phase 1 MVP — a complete terminal experience with local shell
and SSH. Two engine items inside it now gate later work: the keyboard shortcut
engine, and pane kinds — which the SFTP pane and the Agent Manager both need.
The **Agent Manager** is the next major feature after them, ahead of Phase 2.

---

## Shipped in 0.2.0

The release is much wider than the phase list below, which predates it:

- **One Rust core, many shells** — `rite-core` + `rite-server` (Axum) behind a wry
  desktop client and a browser UI; Tauri removed (ADR 0004/0009).
- **Server accounts** — login, sessions, roles, admin console (ADR 0010), plus
  registration & enrollment (ADR 0015).
- **Zero-knowledge sharing** — **collections** are the sharing unit, with members
  and per-member roles; the server stores only ciphertext it cannot read
  (ADR 0011/0013/0016). Personal is a real 1-member collection.
- **One storage model, and the desktop decrypts in Rust** (ADR 0018) — a local
  vault holds collections too, with folders and a Board, so there is one model
  rather than two. It has no Personal: that exists on a server only because
  *other* collections can be shared. Locally the keys are wrapped with the master
  key and rite-core does the decrypting, so credentials never reach the webview —
  a machine arrives saying *how* it authenticates, never with what. Hostnames,
  usernames and folder names are encrypted at rest now, which the old
  `connections` table left in plaintext columns.
- **Native client ↔ remote server** — the context multiplexer, cert TOFU and
  client-execute (ADR 0012).
- **SSH hardening** — rsa-sha2 negotiation, connect timeout, SSH-agent auth,
  keyboard-interactive (2FA/PAM), native keepalive, bounded buffers.
- **Wave 1** — pre-connect hook · jump hosts · local port forwarding · snippets ·
  collection **Board** · per-machine **dashboard** (containers/services, agentless
  over SSH).
- **Health-check governance** — passive last-seen plus a server-governed active
  probe (ADR 0017).
- **Dashboard governance** — the dashboard and the Board in **both** shells, with the
  two cards that execute on a host (containers, services) governed per shell by
  `dashboard_policy { webui, clients, minInterval }` and narrowable per device by the
  user (ADR 0019).
- **Instance configuration as code** — the ten settings an administrator would
  click can instead be declared, in a TOML file (`RITE_CONFIG`) or as
  `RITE__key__field` environment variables, and are then locked against the admin
  API rather than merely seeded from it (ADR 0020). Reload on SIGHUP and
  declarative team provisioning are deferred.

**Pane or menu** — the rule that decides where a surface goes. A view that belongs
*to a machine* is a **menu**: the dashboard's containers and services cards are
reached from inside that host's context and mean nothing outside it, which is why a
menu was right for them. A surface with a **context of its own**, independent of any
host, is a **pane** — a first-class leaf in the split tree, openable beside a
terminal, movable, detachable. SFTP browsing and the agent manager are both of the
second kind. Getting this backwards produces a feature nailed to a machine it does
not belong to.

Known gaps at 0.2.0: port forwards are **local (`-L`) only** — remote (`-R`) and
dynamic (SOCKS) are not built. Snippets are per-device (browser storage), not
synced. A local vault is a **new** vault: ADR 0018 changed where machines are
stored and nothing migrates from a pre-0.2.0 one, which is deliberate — Rite has
had no released version to be compatible with.

---

## ✅ Completed (MVP Foundation)

### Security & Encryption
- ✅ Argon2id key derivation
- ✅ ChaCha20-Poly1305 encryption for credentials
- ✅ Master password setup
- ✅ Password strength validation (zxcvbn)
- ✅ Database encryption (SQLite with encrypted fields)
- ✅ Lock/unlock mechanism
- ✅ Auto-lock after inactivity (configurable: 1, 3, 5 min or custom)
- ✅ Clipboard security (auto-clear after 30s)

### Host Management
- ✅ Create/edit/delete connections
- ✅ Host collections/folders
- ✅ Host metadata (colors, icons, notes)
- ✅ Sort by collections (alphabetical)
- ✅ Sort by recent (last_used_at timestamp)
- ✅ Auto-update last_used_at on connection

### SSH Terminal
- ✅ SSH client with russh backend
- ✅ Password authentication
- ✅ Public key authentication
- ✅ Terminal emulation (xterm.js)
- ✅ Multiple terminal tabs
- ✅ Multiple tabs for same connection
- ✅ Terminal scrollback (10,000 lines)
- ✅ Drag & drop tab reordering
- ✅ Terminal responsive resize
- ✅ Read-only terminal after disconnect
- ✅ Search in terminal (Ctrl+F with xterm-addon-search)
- ✅ Per-connection SSH keep-alive configuration

### UI/UX
- ✅ Dark theme with Tailwind CSS
- ✅ Responsive layout
- ✅ Internationalization (i18n) support (FR/EN)
- ✅ Language selector in Settings
- ✅ Collapsible sidebar with auto-reveal
- ✅ Connection list with visual feedback
- ✅ Modal forms for connection CRUD
- ✅ Password strength indicator (master password)

---

## Phase 1: MVP - Complete Terminal Experience
**Goal:** Production-ready terminal with local shell + SSH, core modern features, and solid UX.

### 🎯 Terminal Core (Priority: CRITICAL - New Focus)
- ✅ **Local terminal support** (bash/zsh/fish/sh via PTY)
  - ✅ Shell spawning (portable-pty integration)
  - ✅ Process lifecycle management
  - ✅ Environment variables handling
  - ✅ Shell selector with default preference (star system)
  - [ ] Working directory per tab
- ✅ **Split panes** (horizontal/vertical)
  - ✅ Split current pane
  - ✅ Resize splits with draggable divider
  - ✅ Navigate between panes (click to focus)
  - ✅ Close individual panes
  - ✅ Drag & drop panes to reorganize
  - ✅ Terminal persistence across pane movements
  - ✅ Tab drag & drop to merge terminals
  - ✅ Tab close button with confirmation
- [ ] **Keyboard shortcut engine** — there are four shortcuts today, hardcoded in
  two components with no registry: `Ctrl+F` (search, `Terminal.tsx`), `Ctrl+W`,
  `Ctrl+Shift+H` and `Ctrl+Shift+V` (`TerminalManager.tsx`). Everything under
  UI/UX Polish about configuring, remapping or listing shortcuts depends on this
  existing first, and two defects are already shipping:
  - [ ] One table owning every binding, instead of `if (e.ctrlKey && …)` inline
  - [ ] Fix the macOS asymmetry — only `Ctrl+F` accepts `metaKey`, so `Cmd+W`
        does not close a pane
  - [ ] Resolve `Ctrl+Shift+V`, which splits vertically here but is **paste** in
        gnome-terminal, konsole and xfce4-terminal — it collides with the
        copy/paste work already on this list
- [ ] **Pane kinds** — a leaf in the split tree is always a terminal today.
  `AnyPaneNode` is already a discriminated union (`type: 'terminal' | 'split'`),
  so this is an extension rather than a rewrite, but fourteen call sites test
  `type === 'terminal'` and the helpers are named for it (`getFirstTerminalPane`,
  `getAllPanes`, `getAllSessions` all return `TerminalPaneNode`). Both the SFTP
  pane and the agent manager need the same third kind, so it is done **once,
  before either** — otherwise it gets built twice, or an agent gets bolted into
  the terminal pane.
  - [ ] Leaf-agnostic traversal and focus
  - [ ] A pane kind registry, so a new kind is a registration and not a patch
- [ ] **Command palette** (Ctrl+K / Cmd+K)
  - [ ] Quick actions (new tab, split, settings)
  - [ ] Connection search
  - [ ] Command history search
- [ ] **Terminal customization**
  - [ ] Font family selection
  - [ ] Font size adjustment
  - [ ] Color scheme selector (base themes)
  - [ ] Cursor style configuration

### 🔒 Security Enhancements (Priority: HIGH)
- [ ] Zeroize sensitive memory (passwords, keys)
- ✅ Password strength validation (zxcvbn with visual indicator)
- ✅ Auto-lock after inactivity (configurable timeout: 1, 3, 5 min or custom)
- ✅ Clipboard security (auto-clear after 30 seconds)
- ✅ Host key verification (known_hosts) — trust on first use with SHA256
  fingerprints; strict / warn / accept modes; a **changed** key refused in every
  mode, not just strict; OpenSSH host certificates refused, since Rite knows a
  host by its key and holds no CA
- [ ] Known-hosts management — nothing lists what is trusted or forgets a key
  (the API has only the strict-mode `accept` and `reject` for a pending key, and
  there is no UI at all). So a host whose key legitimately rotated has no clean
  way back: the changed-key dialog deliberately offers no accept, and the only
  path through is Quick SSH, which force-accepts *before* verification runs and
  overwrites the stored key without showing that it changed
- [ ] Session timeout configuration
- [ ] Secure credential storage review

### 🖥️ Terminal Improvements (Priority: HIGH)
- ✅ Search in terminal (Ctrl+F with xterm-addon-search)
- ✅ Quick SSH connect (connect without saving credentials)
- ✅ Manual reconnection button for SSH
- ✅ Keep-alive configuration (per-connection: 15s, 30s, 60s, or custom)
- [ ] Connection timeout configuration
- [ ] Copy/paste improvements (context menu, smart paste)
- [ ] Find next/previous in search
- [ ] Broadcast mode (type in multiple terminals simultaneously)

### 📦 Connection Management (Priority: MEDIUM)
- ✅ Import from ~/.ssh/config (file path on desktop, paste on web)
- [ ] Export connections (encrypted backup)
- [ ] Import connections
- [ ] Host tags (in addition to collections)
- [ ] Advanced search and filter

### 🎨 UI/UX Polish (Priority: MEDIUM)
- [ ] Setup wizard (first run experience)
  - ✅ Choose default shell (integrated in main UI)
  - ✅ Master password setup (already done)
  - [ ] Basic preferences (theme, font)
  - [ ] Optional SSH config import
- [ ] Keyboard shortcuts configuration
  - ✅ Tab close shortcut (Ctrl+W)
  - [ ] Customizable keybindings
  - [ ] Shortcuts cheatsheet (Ctrl+?)
- [ ] Connection status indicators (SSH)
- [ ] Error handling improvements
- ✅ Toast notifications system
- [ ] Tab context menu (rename, duplicate, close others)
- [ ] Quick switcher (Ctrl+Tab for recent tabs)

### 🐛 Bug Fixes & Stability (Priority: HIGH)
- [ ] Comprehensive error handling
- [ ] Graceful disconnect handling
- [ ] Memory leak prevention
- [ ] Performance optimization
- [ ] Logging system (non-sensitive data)

---

## 🤖 Agent Manager (next major feature — ahead of Phase 2)

**Goal:** Stop hunting for AI coding agents. See the ones that exist, resume one
where it stopped, and start a new one already carrying its context — without
copying a session id out of a file by hand.

Prioritised ahead of Phase 2 deliberately. Integrating TUIs like k9s or lazygit
would add almost nothing: they already run in a pane, there is nothing to build
but an icon. This is something no SSH client does, and it sits directly on what
0.2.3 shipped — dashboard cards, the Board, and client-execute (ADR 0012), which
already runs a command on the *local* machine from either shell.

**This is an AI feature, so it gets mocked before it gets built** — in
`design/mock/`, as the dashboard was, so the shape is argued over on screen
rather than in a pull request. An ADR follows the mock, and code follows the ADR.

- [ ] **Mock first** (`design/mock/`) — the agent pane in both shells, before any
      Rust or TypeScript
- [ ] **ADR** — the session model, the per-tool adapter boundary, and what is
      explicitly out of scope
- [ ] **Agent pane**, not a menu: an agent has a context of its own — a working
      directory, a transcript, a lifetime — and belongs to no machine (see *Pane
      or menu* above). Depends on **Pane kinds** in Phase 1.
- [ ] Discover existing sessions — list them with their project, their last
      activity and whether they are still running
- [ ] **Resume** a session in a pane, without the user ever seeing its id
- [ ] **Seed** a new agent with its context automatically, rather than pasting it
- [ ] Per-tool adapter, isolated on purpose — `--resume <uuid>`, the paths under a
      vendor's home directory and the transcript format are **not a stable API**
      and will change without notice. One adapter per tool, written expecting to
      break, with the breakage contained to it. (ADR 0003's lesson, learned the
      hard way: pin the constraint, never the incidental shape.)
- [ ] Decide what *not* to do — this is adjacent to Rite's purpose, and the risk
      is becoming two half-products instead of one good one

## Phase 2: Advanced SSH & File Transfer
**Goal:** Enhanced SSH features and basic SFTP support.

### 🔐 Advanced SSH (Priority: HIGH)
- ✅ SSH agent support (agent auth + live identity picker + opt-in forwarding)
- ✅ Jump hosts / bastion support (ProxyJump, chainable; local vault path)
- ✅ Port forwarding — local `-L` *(remote `-R` and dynamic SOCKS still open)*
- ✅ SSH agent forwarding (opt-in per connection)
- ✅ Auto-reconnect on network failure (opt-in setting; off by default — a reconnect is a new shell)

### 📁 SFTP Core (Priority: MEDIUM)
- [ ] **SFTP pane** — a browser as its own pane kind beside a terminal, not a menu
      hanging off a machine (see *Pane or menu* above). Depends on **Pane kinds**.
      `Protocol::SFTP` already exists in `connection.rs` and in the TypeScript
      `Protocol` union, so a connection can be declared SFTP today with nothing
      behind it — that surface is a promise currently unkept.
- [ ] SFTP client implementation
- [ ] List directory
- [ ] Download files
- [ ] Upload files
- [ ] Delete files/directories
- [ ] Create directories
- [ ] File permissions display

### 🔄 Sync & Backup (Priority: MEDIUM)
- [ ] Export vault (JSON + encrypted)
- [ ] Import vault
- [ ] Recovery key generation (QR code + text)
- [ ] Backup reminder system

### 📊 Monitoring & Logs (Priority: LOW)
- [ ] Connection history
- [ ] Session duration tracking
- [ ] Bandwidth monitoring
- [ ] Error logs (encrypted)

---

## Phase 3: Productivity & Advanced Features
**Goal:** Power-user features and enhanced workflows.

### 📑 Profiles / Termconfs (Priority: HIGH)
- [ ] Profile creation UI
- [ ] Profile launcher (Ctrl+P)
- [ ] Auto-connect tabs on profile launch
- [ ] Startup commands execution
- [ ] Profile tags and organization
- [ ] Save current session as profile
- [ ] Profile import/export

### ⚡ Terminal Enhancements (Priority: MEDIUM)
- ✅ Split-view terminal (horizontal/vertical) *(moved to Phase 1)*
- ✅ Broadcast input to multiple terminals *(moved to Phase 1)*
- ✅ Snippets / command favorites (library, run per-pane or broadcast, multi-line)
  - [ ] Snippet library
  - [ ] Variables in snippets (${VAR})
  - [ ] Quick insert palette
  - [ ] Per-host snippets
- [ ] Session recording
  - [ ] Record terminal session to file
  - [ ] Playback with timing
  - [ ] Export as asciicast format
- [ ] Advanced terminal features
  - [ ] Scrollback buffer search with regex
  - [ ] URL detection and click-to-open
  - [ ] Semantic shell integration (prompts, commands)
  - [ ] Command history persistence

### 📂 SFTP Advanced (Priority: MEDIUM)
- [ ] Drag & drop file upload
- [ ] Drag & drop between SFTP panes
- [ ] File permissions editor (chmod)
- [ ] Integrated file editor
- [ ] File diff viewer
- [ ] Synchronized browsing

### 🎨 Themes & Customization (Priority: LOW)
- [ ] Theme system architecture
- [ ] Community theme support (TOML format)
- [ ] Theme hot-reload
- [ ] Custom fonts from user directory
- [ ] Theme gallery/marketplace UI

### 🔄 Sync Backends (Priority: LOW)
- [ ] Git backend for sync
- [ ] Age encryption for sync files
- [ ] S3-compatible storage
- [ ] WebDAV support
- [ ] Conflict resolution (manual)

---

## Phase 4: Extended Protocol Support
**Goal:** Support for additional protocols and advanced use cases.

### 🌐 Additional Protocols (Priority: LOW)
- [ ] FTP client
- [ ] FTPS support
- [ ] SCP support
- [ ] Telnet (if requested)
- [ ] Mosh (if requested)
- [ ] Serial / UART (if requested)

### 🚀 Advanced Profiles (Priority: LOW)
- [ ] Profile templates
- [ ] Variables in profiles
- [ ] Conditional tabs (environment-based)
- [ ] Pre/post-connect hooks
- [ ] Advanced layouts (grids, custom splits)
- [ ] Workspace mode (auto-save/restore session)

### 👥 Collaboration (Priority: LOW)
- [ ] Shared profiles (team export/import)
- [ ] Profile repositories (Git-based)
- [ ] Team snippet sharing

### 🎯 Power User Features (Priority: LOW)
- ✅ Command palette (Cmd+K / Ctrl+K) *(moved to Phase 1)*
- ✅ Custom keyboard shortcuts *(moved to Phase 1)*
- [ ] Terminal search history
- [ ] Command history sync across devices
- [ ] Labels and pre-hook scripts
- [ ] Custom scripts library
- [ ] Per-host environment variables

---

## Phase 5: Web Version (Long-term)
**Goal:** Browser-based access to RITE.

### 🌍 Backend Server
- [ ] Create `rite-server` package (Axum)
- [ ] REST API (auth, hosts, themes)
- [ ] WebSocket server for terminal I/O
- [ ] SSH tunneling (Browser ↔ Backend ↔ SSH)
- [ ] Multi-user support
- [ ] Session isolation

### 💻 Web Frontend
- [ ] React frontend (reuse desktop code)
- [x] Replace Tauri with HTTP/WebSocket (rite-server + wry client)
- [ ] Browser-compatible terminal
- [ ] Progressive Web App (PWA)
- [ ] LocalStorage/IndexedDB settings

### 🔐 Web Security
- [ ] HTTPS enforcement
- [ ] JWT authentication
- [ ] CORS configuration
- [ ] Rate limiting
- [ ] CSP headers
- [ ] XSS prevention

### 📦 Deployment
- [ ] Docker image
- [ ] Docker Compose with PostgreSQL
- [ ] Kubernetes manifests
- [ ] Deployment guides
- [ ] Reverse proxy configs

---

## CLI Features

### Phase 1-2
- [ ] `rite --version` - Show version
- [ ] `rite config` - Open config directory

### Phase 3+
- [ ] `rite launch <profile>` - Launch a profile
- [ ] `rite profile list` - List profiles
- [ ] `rite profile export/import` - Manage profiles
- [ ] `rite connect <host>` - Quick connect
- [ ] `rite sync` - Manual sync trigger
- [ ] `rite theme list/install` - Theme management

---

## Future Considerations

### Possible Features (Not Committed)
- [ ] Cloud provider integrations (AWS, Azure, DigitalOcean)
- [ ] Terminal multiplexing (tmux/screen integration)
- [ ] Built-in REPL for scripting
- [ ] Plugin system
- [ ] Terminal ligatures support
- [ ] GPU-accelerated rendering
- [ ] Pane presets/layouts (save and restore pane arrangements)
- [ ] Detach panes to floating windows (multi-window support)
- [ ] Terminal zoom mode (focus one pane fullscreen temporarily)
- [ ] Pane synchronization (broadcast to selected panes only)
- [ ] Smart pane focus navigation (vim-like hjkl or arrow keys)
- [ ] Pane history/undo (restore closed panes)
- [ ] Tab groups/workspaces (organize tabs into projects)
- [ ] Session restore on app restart (persist all tabs and panes)
- [ ] Terminal bell notifications (visual + system notifications)
- [ ] Custom tab icons and colors (visual organization)
- [ ] Pane title bars (show pwd, connection name, or custom label)
- [ ] Split pane templates (2x2 grid, 1-3 layout, etc.)
- [ ] Drag tabs between windows (when multi-window is implemented)
- [ ] Terminal screenshot/export (capture pane or full tab as image)
- [ ] Activity indicators (show which panes have new output)
- [ ] Configurable pane borders (thickness, color, style)
- [ ] Quick pane swap (swap positions of two panes)

### Out of Scope
- ❌ Proprietary cloud service
- ❌ Mobile apps (Android/iOS)
- ❌ Windows Hello / biometric authentication
- ❌ FIDO2 / hardware security keys
- ❌ Built-in VPN client

---

## Notes

- **Current priority:** Phase 1 MVP - Transition from "SSH client" to "modern terminal with SSH support"
- **New product direction:** RITE is now a full-featured terminal (local shell + SSH), not just an SSH client
- **Master password consideration:** Current unlock-per-launch may need rethinking for daily terminal usage (deferred to post-MVP)
- Security features are prioritized across all phases
- Features may be reordered based on user feedback and technical dependencies
- Phase numbers are organizational, not strict timelines
- Web version (Phase 5) is a long-term goal, not blocking MVP release

## Phase 1 MVP Priority Order (Updated)

**Critical path for usable terminal:**
1. **Local terminal** (foundation for terminal usage)
2. **Split panes** (essential modern feature)
3. **Command palette** (UX quick wins)
4. **Font/theme customization** (personalization)
5. **Import ~/.ssh/config** (migration path)
6. **Export/backup** (security)
7. **Polish & stability** (error handling, notifications)
