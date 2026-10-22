# RITE Roadmap

**This file is what is LEFT to do, by category — nothing else.** An item lives here
until the code does it, and then it is deleted rather than ticked. If you cannot find
something here, it is done.

Which means this file dates nothing. "What shipped, and when" is the tags and the
release notes, generated from the commits by git-cliff — a record nobody writes by
hand and so a record that cannot drift. This one used to carry a `Shipped in 0.2.0`
section and 119 completed items, and by 0.2.4 it was wrong on twenty-four of them:
whole sections of finished work still reading as pending, which made the remaining
scope look twice its real size.

**Product Vision:** Modern terminal with advanced features and native SSH/SFTP support (not just an SSH client).

**Current Focus:** Phase 1 MVP — a complete terminal experience with local shell and
SSH. Nothing below waits on an engine any more: pane kinds and the keyboard binding
table are in place, so the SFTP pane and the Agent Manager can be built when their
turn comes rather than after a refactor.

The **Agent Manager** is the next major feature, ahead of Phase 2. Its shape is
settled in ADR 0022 and prototyped in `design/mock/agents.js`: the manager is a view,
an agent session is a pane, and agents run on a machine from your library, never
inside the server container. What is left is the code.

---



## Phase 1: MVP - Complete Terminal Experience
**Goal:** Production-ready terminal with local shell + SSH, core modern features, and solid UX.

### 🎯 Terminal Core (Priority: CRITICAL - New Focus)
  - [ ] Working directory per tab

  Adding a kind is now three steps: extend `LeafPaneNode` in
  `apps/desktop/src/types/pane.ts`, write the kind under
  `apps/desktop/src/panes/kinds/`, and add its line to the registry's record. The
  record is keyed by the union's own discriminant, so forgetting that line is a
  compile error rather than a pane that renders as nothing — and with a second kind
  added and nothing else touched, that missing line is the *only* thing the compiler
  asks for.
- [ ] **Command palette** (Ctrl+K / Cmd+K)
  - [ ] Quick actions (new tab, split, settings)
  - [ ] Connection search
  - [ ] Command history search
- [ ] **Terminal customization**
  - [ ] Font family selection — a value in the profile, not a picker (see Layouts)
  - [ ] Font size adjustment
  - [ ] Color scheme selector — two themes, app and terminal, as token sets (see Layouts)
  - [ ] Cursor style configuration — same: a profile value (`cursorBlink` is hard-coded today)

### 🔒 Security Enhancements (Priority: HIGH)
- [ ] Zeroize sensitive memory — **keys done**, passwords not: `MasterKey` is
      `ZeroizeOnDrop` and the server's vault key is `Zeroizing<[u8; 32]>`, but an SSH
      password travels as a `String` and is dropped without being wiped
- [ ] **Throttle logins by address, not only by username** — decided and deferred, see
      ADR 0026. The counter keys on the username, so five failures against one account
      lock it; a single common password tried against a thousand *different* usernames
      meets a fresh counter every time and nothing ever locks. That is password spraying,
      and it is the attack a multi-account server actually meets.
      - [ ] A per-instance **trusted-proxy** setting first (ADR 0020 key, so it renders
            inert in the console when declared in the file). Reading `X-Forwarded-For`
            without it is worse than no counter: an attacker forges a fresh address per
            request and the throttle never fires, or forges a colleague's and locks them
            out
      - [ ] The default trusts nothing and falls back to the socket — which means the
            address counter does **not** cover the recommended reverse-proxy deployment
            until an administrator fills the setting in. Stated here because it is a
            trade-off, not an oversight
      - [ ] Address and name keep separate counters and separate verdicts
      - [ ] Registration and token redemption carry the same gap and move with it
      - Not in 0.2.4: a misconfigured address throttle is less safe than none, and it adds
        a security setting an administrator has to understand. Shipping that in the days
        before a release is how the regression reaches a real instance
- [ ] Known-hosts management — nothing lists what is trusted or forgets a key
  (the API has only the strict-mode `accept` and `reject` for a pending key, and
  there is no UI at all). So a host whose key legitimately rotated has no clean
  way back: the changed-key dialog deliberately offers no accept, and the only
  path through is Quick SSH, which force-accepts *before* verification runs and
  overwrites the stored key without showing that it changed
- [ ] Secure credential storage review

### 🖥️ Terminal Improvements (Priority: HIGH)
- [ ] Connection timeout configuration — the timeout exists (20s, `CONNECT_TIMEOUT`)
      and is not configurable, which is the whole of this item
- [ ] Copy/paste improvements (context menu, smart paste)
- [ ] Broadcast mode — **half done**: a snippet can be broadcast to every open pane,
      but there is no mode where what you type keeps going to all of them

### 📦 Connection Management (Priority: MEDIUM)
- [ ] Export connections (encrypted backup)
- [ ] Import connections — an ssh_config import exists; this is about reading back a
      Rite export, which has no object until `Export connections` above exists
- [ ] Host tags (in addition to collections)
- [ ] Advanced search and filter

### 🎨 UI/UX Polish (Priority: MEDIUM)
- [ ] Setup wizard — the shell choice and the master password are already in the main
      UI; what is missing is a first-run path offering preferences and an import
  - [ ] Basic preferences (theme, font)
- [ ] Shortcuts cheatsheet (`Mod+?`) — the binding table and its editor exist; this is
      a reader for that table, not a second list to keep in step
- [ ] Error handling improvements
- [ ] Tab context menu (rename, duplicate, close others)
- [ ] Quick switcher (Ctrl+Tab for recent tabs)

### 🎨 Styling: one place for it (Priority: HIGH)

The CSP served to browsers is strict on every axis but one: `style-src` carries
`'unsafe-inline'`, because the app writes 42 inline `style={{}}` across about fifteen
components — pane geometry, collection colours, computed widths. That directive is the
symptom; the cause is that styling has no single home, so a value that belongs to the
design lands in a component instead.

Not a security fix, which is why it is not in 0.2.4: what `'unsafe-inline'` permits is
CSS injection, and `script-src 'self'` with `object-src 'none'` hold the sharp edges.
It is a refactor, and the dependency runs the other way — tighten the CSP once the
styles have somewhere to live.

- [ ] Inventory the 42 sites and sort them: geometry computed at runtime (a split's
      percentage) against values that are really design tokens (a collection's colour)
- [ ] Design tokens as CSS custom properties, set once, consumed by class
- [ ] Runtime geometry through a CSS variable on the element rather than a style string
- [ ] Then drop `'unsafe-inline'` from `style-src` in `packages/rite-server/src/lib.rs`
      and let the tls-proxy suite prove nothing regressed

### 🌍 The server's refusals, as codes (Priority: LOW)

`rite-server` answers in English prose and the client shows it as it arrives, so a French
member meets English wherever a server refusal surfaces — a sign-in failure, a rate limit, a
rejected address. The client's own 1200 strings are translated; these twenty-eight are not.

Deferred deliberately, not forgotten (the decision and its reasoning: `docs/SERVER.md`, "The
server speaks English, for now"). Doing it properly means a stable error code per refusal
that the client looks up in its locales, which changes the API contract ADR 0008 has clients
negotiate against. Cheap later, expensive to get wrong now, and nobody is reading them yet.

`e2e/server-errors-check.mjs` keeps them consistent in the meantime.

- [ ] A stable code per refusal, carried beside the prose so old clients keep working
- [ ] Locale entries for each, in both languages
- [ ] The client prefers the code and falls back to the prose
- [ ] Reopen trigger: a deployment whose members do not read English, or a refusal that has
      to carry structured data a client should act on rather than display

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

- [ ] **PTY + exec in `rite-core`** — there is PTY+shell (interactive) and exec
      without a PTY (one-shot); an agent wants both. Not the typed-after-a-delay
      shortcut: a shell discards queued input while it sets the tty up, so an early
      send is *gone*, which the split-preset work already proved and fixed once.
- [ ] **`local_terminal.rs`** — argv-direct spawn (it goes through `cmd.arg("-c")`)
      and `cwd` support, which does not exist. Desktop-local case only.
- [ ] **Agent pane**, not a menu: an agent has a context of its own — a working
      directory, a transcript, a lifetime — and belongs to no machine (see *Pane
      or menu* above). **Pane kinds** in Phase 1 are done, so this is a registration
      under `apps/desktop/src/panes/kinds/` rather than a change to the split tree.
- [ ] Discover existing sessions — list them with their project, their last
      activity and whether they are still running
- [ ] **Resume** a session in a pane, without the user ever seeing its id
- [ ] **Seed** a new agent with its context automatically, rather than pasting it
- [ ] Per-tool adapter, isolated on purpose — `--resume <uuid>`, the paths under a
      vendor's home directory and the transcript format are **not a stable API**
      and will change without notice. One adapter per tool, written expecting to
      break, with the breakage contained to it. (ADR 0003's lesson, learned the
      hard way: pin the constraint, never the incidental shape.)
- [ ] **Compare what is in effect across machines** — "this project loads three skills
      on web-01 and two on my laptop" is the same read, answered twice. Still
      read-only, and the natural next step once the single-machine view is real.
- [ ] **The management layer, deliberately after the basics** — stored pre-prompts,
      per-project conventions (a `CLAUDE.md` and its equivalents), pre-arranged agent
      set-ups. This is where a real advantage over running the CLI yourself would sit,
      and it is explicitly *not* in the first mock: the basics come first, and what
      "plus" means gets argued once the basics are on screen.
- [ ] Decide what *not* to do — this is adjacent to Rite's purpose, and the risk
      is becoming two half-products instead of one good one

## Phase 2: Advanced SSH & File Transfer
**Goal:** Enhanced SSH features and basic SFTP support.


### 📁 SFTP Core (Priority: MEDIUM)
- [ ] **SFTP pane** — a browser as its own pane kind beside a terminal, not a menu
      hanging off a machine (see *Pane or menu* above). **Pane kinds** are done, so
      this registers a kind instead of touching the split tree.
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
- [ ] Connection history — **half done**: `lastUsedAt` is tracked and shown, but
      nothing keeps a list of past sessions
- [ ] Session duration tracking
- [ ] Bandwidth monitoring
- [ ] Error logs (encrypted)

---

## Phase 3: Productivity & Advanced Features
**Goal:** Power-user features and enhanced workflows.

### 📑 Layouts (was: Profiles / Termconfs) (Priority: HIGH)

Shipped in 0.2.4 as a FILE rather than as a profile manager:
`~/.config/rite/layouts.toml` holds presets and layouts together, and Settings leads
with the cards it parses. The rename is not cosmetic — "profile" implied a record the
app owns and a UI to manage it, and what shipped is a file you own and can version,
which is why import/export and creation have no separate work left.

- [ ] Layout launcher shortcut — there is a Layouts button and a menu, no `Mod+P`
- [ ] Layout tags and organization — the file has order and nothing else
- [ ] Save the current arrangement AS a layout — the file is written by hand or by the
      editor in Settings; nothing captures what is on screen into it

#### The profile, later: one file for the whole setup

A profile is not a layout with extras. It is **everything that makes this machine
look and behave the way you left it, as code, in one file**: the font, the
application's theme, the terminal's theme, and the layouts and presets that
`layouts.toml` already holds. One file to version, one file to carry to another
machine, one file to read when something looks wrong.

`layouts.toml` is the first stone and it is laid (ADR 0023). What is missing is not
file format but the thing underneath: **the appearance has to be drivable by
configuration before a file can drive it**, and today it is not — the CSS lives
across the components (see Styling above). A profile written now could set a layout
and lie about everything else.

So the order is fixed, and it is the reason this waits:

1. Styling: design tokens as CSS custom properties, set in one place (above)
2. A theme is then a set of token values — the application's and the terminal's,
   which are two sets and not one
3. The font joins them: a value, not a component's inline style
4. Only then does the file grow past layouts, and the three items in Terminal Core
   below — font family, colour scheme, cursor style — stop being three settings
   screens and become what the file says

Which is why those three are deliberately NOT built as one-off pickers. A font
dropdown that writes to browser storage is work that has to be undone the day the
profile exists, and it would teach the wrong shape in the meantime.

### ⚡ Terminal Enhancements (Priority: MEDIUM)
  - [ ] Variables in snippets (${VAR})
  - [ ] Quick insert palette
  - [ ] Per-host snippets
- [ ] Session recording
  - [ ] Record terminal session to file
  - [ ] Playback with timing
  - [ ] Export as asciicast format
- [ ] Advanced terminal features
  - [ ] Scrollback buffer search with regex
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
- [ ] Workspace mode (auto-save/restore session)

### 👥 Collaboration (Priority: LOW)
- [ ] Shared profiles (team export/import)
- [ ] Profile repositories (Git-based)
- [ ] Team snippet sharing

### 🎯 Power User Features (Priority: LOW)
- [ ] Terminal search history
- [ ] Command history sync across devices
- [ ] Labels and pre-hook scripts
- [ ] Custom scripts library
- [ ] Per-host environment variables

---

## Phase 5: Web Version (Long-term)
**Goal:** Browser-based access to RITE.


### 💻 Web Frontend
- [ ] Progressive Web App (PWA)


### 📦 Deployment
- [ ] Kubernetes manifests

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

**Critical path for usable terminal**, with what is done taken out of it — the local
terminal, split panes and the ssh_config import have all shipped:

1. **Command palette** (UX quick wins)
2. **Font/theme customization** — as profile values, not as pickers; see Layouts
3. **Export/backup** (security)
4. **Polish & stability** (error handling, notifications)
