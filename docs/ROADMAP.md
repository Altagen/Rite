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
  - [x] A new tab starting where the workspace document says — a split already does
        (`/proc/<pid>/cwd` on Linux, the shell's own answer elsewhere); a new tab did not.
        Shipped in 0.2.8 as `newTabCwd`: one absolute path, or nothing — and nothing
        means the standing pane, or the home directory with no pane to follow. Reached
        that shape only after a four-choice first pass the owner cut; the sub-item below
        records why, because the reasoning that produced the four choices reads
        convincing and was wrong.

        - [x] `newTabCwd` in `[terminal]` of the workspace document, beside `copyMode`
              (ADR 0023 addendum). A keyword, or an absolute path. The parser's whitelist
              is strict — `[terminal] takes copyMode or newTabCwd, not <key>` — which is
              what makes adding a key a deliberate edit. 0.2.8: the table turned out to
              be undocumented entirely, `copyMode` included, so `docs/LAYOUTS.md` gained
              it and a check parses the documented example against the parser.
        - [x] **A directory carried end to end.** `inheritCwdFrom` transports a SESSION
              ID, not a path, so the frontend, the HTTP route, the server and
              `create_local_session` all needed the other shape. `LocalStart` in the core
              is that shape: `Wherever`, `Inherit(&SessionId)`, `In(PathBuf)` — an enum
              rather than two `Option`s, because "both at once" is a request nobody had
              decided the meaning of, and as a pair the precedence would have to be agreed
              by every caller.
        - [x] **ONE VALUE, TWO STATES — the shape the owner settled on.** A path and every
              new tab starts there; nothing and a new tab follows the standing pane, or
              opens in the home directory when no pane stands. A split is unchanged: it has
              always followed the pane it divides.

              The first pass shipped four choices — absent, `inherit`, `home`, a folder —
              with `inherit` argued as "a value and not a behaviour change, because people
              disagree about which they want for a tab". The owner read the result and cut
              it: *« soit on met un path et le shell se lance toujours dans le path, soit il
              est grisé et il est hérité de la pane d'avant, et s'il n'y avait pas de pane
              avant bah c'est le home directory »*. Nobody disagrees about following the
              pane they are standing in; the disagreement was invented by offering the
              choice.

              WHAT THAT COST, and it is the point: `inherit` and `home` stopped being values
              the parser takes, the absent key stopped meaning "wherever Rite stands" — a
              shipped behaviour change, and the directory it named was nobody's — and the
              dropdown became one field. `home` survives as a WIRE word only: the client
              asks for the home directory when no pane stands, and the machine that starts
              the shell is the only side that can resolve it.

              A FOCUSED SSH PANE IS NOT A PANE TO FOLLOW. Its directory is on another
              computer, so its id would have the server find no local session and start the
              shell wherever Rite stands — silently. `Workspace.tsx` follows a pane only
              when `connectionId === 'local'`, and the home directory answers otherwise.
        - [x] **A switch in Settings that writes the document**, rather than a second
              place holding the same value — which is why it is offered and `copyMode`
              beside it is only reported: nothing writes that one back. Under Terminals,
              beside which shell starts, because where a new tab starts and which shell it
              starts are one decision about one button.

              A SWITCH AND A GREYED FIELD, the owner's shape: *« une case à cocher (par
              défaut ce que je t'ai dit) et si on la coche => on arrive dans le path
              prédéfini qui est grisé quand la case n'est pas cochée »*. It replaced a bare
              path field whose empty state said what it does only in its hint. The switch
              holds no value of its own — it is whether the key is set — and turning it off
              removes the key. It is `SettingsToggle` and not a native checkbox: WebKitGTK
              draws one here and the browser another, and the same bundle showing two
              different controls is the one thing these two surfaces must never do.

              The web UI gets no row, and that was weighed rather than assumed: the
              container has one directory that matters (`useradd --home-dir /home/rite`,
              with the data volume mounted beneath it) and everything else belongs to root,
              so the field would offer a choice between the default it already has and
              directories the member cannot write. Not a security argument — a member with
              a shell can `cd` anywhere they can read — but a control with one useful
              value. If a project volume is ever mounted there, this switch is the shape to
              add.

              The field is gated on `newTabCwdApplies` — the same function `newTabCwdStart`
              applies a path through, not a second reading of `runsHere`, so a control that
              writes a value this client ignores cannot exist. `shellControls` earned that
              lesson: a switch for something that cannot happen says there is a choice.
        - [x] **NOTHING IS IMPOSED ON THE WEB UI, and nothing is read there.** Settled by
              the owner in 0.2.8, against what this item said twice before: a machine
              reached over SSH from the web UI has its own paths, so a directory the
              instance forced would describe none of them. A browser's own local terminal
              is the instance's shell in the container, where a path a desktop wrote means
              nothing either. So the browser arm of `utils/newTabCwd.ts` names no path, and
              `named_start_dir` in `rite-server` answers `None` for every input in accounts
              mode — the gate is inside the rule rather than beside its call, so a second
              call site cannot be added without it.

              A BROWSER ASKS FOR NOTHING AT ALL, pane or no pane. 0.2.8 briefly extended
              "follow the standing pane" to the web UI as well, reasoning that a pane there
              is one of the instance's own sessions and so nothing foreign; the owner
              refused it — *« dans la webui on n'était même pas censé l'avoir ce paramètre,
              c'est censé être par défaut le shell de base tout le temps, pas hérité »*.
              Every terminal there opens in the image's `WORKDIR /home/rite`. A split
              still follows its pane, in both UIs, because that is the gesture's own
              meaning and not this setting.

              THIS ITEM HAS BEEN WRONG TWICE, which is worth recording. Written during
              0.2.6, it had a desktop client in a server context opening its terminals on
              the server, and concluded the instance should impose the path there too. ADR
              0031 reversed that premise in 0.2.7 — a local terminal is the client's own,
              always — and the item was rewritten to reuse `instanceChoosesShell`, keeping
              the instance's authority over a browser. 0.2.8 dropped the authority itself:
              a forced path is not a safeguard when every machine behind it has different
              paths. What remains is a refusal, which needs no setting.
        - [x] ~~Two instance settings, and their row in the admin console.~~ Dropped with
              the item above: there is nothing for an administrator to decide. The
              refusal is the whole server-side behaviour, and it is unconditional.

        A path that is gone needs no new rule, but not for the reason first written here:
        `CommandBuilder::cwd` on a missing directory does NOT fail the spawn on Linux
        (portable-pty 0.9 returns `Ok` and the child starts in the calling process's
        directory — measured). `spawn_inner` filters on `.is_dir()` anyway, which is
        load-bearing on Windows, where `CreateProcessW` refuses. Either way a bad value
        starts where the shell would have. Never a lost pane.

  Adding a kind is now three steps: extend `LeafPaneNode` in
  `apps/desktop/src/types/pane.ts`, write the kind under
  `apps/desktop/src/panes/kinds/`, and add its line to the registry's record. The
  record is keyed by the union's own discriminant, so forgetting that line is a
  compile error rather than a pane that renders as nothing — and with a second kind
  added and nothing else touched, that missing line is the *only* thing the compiler
  asks for.
- [ ] Command palette: searching more than commands. The palette itself ships (Mod+K,
      every command that has a handler, availability answering itself), and these are the
      two sources it does not reach yet
  - [ ] Connection search
  - [ ] Command history search
- [ ] **Terminal customization**
  - [ ] Font family selection — a value in the profile, not a picker (see Layouts)
  - [ ] Font size adjustment
  - [ ] Color scheme selector — two themes, app and terminal, as token sets (see Layouts)
  - [ ] Cursor style configuration — same: a profile value (`cursorBlink` is hard-coded today)

### 🔒 Security Enhancements (Priority: HIGH)
- [ ] **A one-time bootstrap token, as an alternative to the password file.** A headless
      first start needs the plaintext password *once*, because the bootstrap derives the
      admin's vault key from it (ADR 0011) — a hash would make an account whose vault
      cannot exist. So `deploy/compose.bootstrap.yml` — the opt-in override, no longer
      wired into the deployment files — holds a live admin password at rest until someone
      empties it, and the mitigations today are its mode, a warning in the log, and the
      fact that nobody who skips the override has a secret at all. The better shape: the server prints a single-use token on stdout at
      first start, that token authorises exactly one `create the administrator` call, and
      it dies with it — no secret at rest, and the operator chooses the password. It
      changes the bootstrap contract (what a fresh instance accepts, and from whom), so it
      needs an ADR before any code
- [ ] **Wipe an SSH password and passphrase from memory after use.** Two different
      protections get confused here, so both are written down.
      - **Never logged — DONE, for both.** `AuthMethod` has a hand-written `Debug`
        (`connection.rs`), written because the derived one printed the password and the
        passphrase. Nothing about that is pending.
      - **Zeroized in memory — done for KEYS only.** `MasterKey` is `ZeroizeOnDrop` and
        the server's held vault key is `Zeroizing<[u8; 32]>`, wiped on lock, logout and
        idle, with tests. An SSH password and a key passphrase are `Option<String>` and
        are dropped without being wiped.
      - **The browser half cannot be done at all**, and that bounds the item: a JavaScript
        string is immutable and the garbage collector copies it where it likes, so a
        password typed in the web UI cannot be wiped by anyone. Whatever is built here
        covers the Rust side, and saying otherwise would promise more than the platform
        allows.
      - Cost, measured rather than guessed: `password` appears 28 times in
        `connection.rs` alone and the value crosses serde, the vault, the HTTP API and the
        TypeScript boundary — so a zeroizing wrapper means custom serde, not a type swap.
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
      - Deferred on purpose, not forgotten: a misconfigured address throttle is less safe
        than none, and it adds a security setting an administrator has to understand.
        Shipping that in the days before a release is how the regression reaches a real
        instance — so it waits for a release it opens, not one it closes
- [ ] Known-hosts management — nothing lists what is trusted or forgets a key
  (the API has only the strict-mode `accept` and `reject` for a pending key, and
  there is no UI at all). So a host whose key legitimately rotated has no clean
  way back: the changed-key dialog deliberately offers no accept, and the only
  path through is Quick SSH, which force-accepts *before* verification runs and
  overwrites the stored key without showing that it changed
- [ ] Secure credential storage review

### 🖥️ Terminal Improvements (Priority: HIGH)
- [ ] Smart paste — a multi-line paste asking before it runs. The gesture itself is
      settled (four modes, the workspace document chooses; ADR 0023 addendum)

### 📦 Connection Management (Priority: MEDIUM)
- [ ] A per-member override for a key PATH, in `deviceStore` (ADR 0028 §3 defers it). The
      record's path is the contract today, which is what makes the guarantee legible — but
      colleagues name their key files differently, so one of them will have to move a file.
      The override weakens nothing (the key is still required); it costs a second place to
      look when a connection fails, which is why it waits for a real complaint
- [ ] Export connections (encrypted backup)
- [ ] Import connections — an ssh_config import exists; this is about reading back a
      Rite export, which has no object until `Export connections` above exists
- [ ] Host tags (in addition to collections)
- [ ] Advanced search and filter

### 🎨 UI/UX Polish (Priority: MEDIUM)
- [ ] Setup wizard — the shell choice and the master password are already in the main
      UI; what is missing is a first-run path offering preferences and an import
  - [ ] Basic preferences (theme, font)
- [ ] Error handling improvements
- [ ] Quick switcher (Ctrl+Tab for recent tabs)

### 🎨 Styling: one place for it (Priority: HIGH)

The CSP served to browsers is strict on every axis but one: `style-src` carries
`'unsafe-inline'`, because the app writes inline `style={{}}` across the components. That
directive is the symptom; the cause is that styling has no single home, so a value that
belongs to the design lands in a component instead.

Not a security fix, which is why it waits: what `'unsafe-inline'` permits is
CSS injection, and `script-src 'self'` with `object-src 'none'` hold the sharp edges.

**Inventoried 2026-10-28: 43 sites across 23 components**, and the sort came out as four
groups rather than the two expected. The distinction that matters is not
token-versus-geometry, it is *what could ever live in a stylesheet*:

| | sites | |
|---|---|---|
| Runtime geometry | 14 | a split's percentage, a popup's coordinates, `paddingLeft` from a tree depth, `pointerEvents` during a drag |
| Static CSS, inline for no reason | 13 | `padding: '4px'`, `resize: 'vertical'`, `userSelect: 'none'`, `rotate(90deg)` |
| A colour the user chose | 14 | a collection's, a machine's, a member's avatar, the swatch grids |
| A context's badge | 1 | `backgroundImage` from a hash |
| **A design token, written as a hex** | **1** | `LibrarySidebar.tsx:841` |

Only the second group belongs in a stylesheet. The third is the hard one and it is the
one a theme has to coexist with: those values are per-element user data, not design, so
no amount of tokenising moves them — the most that can be done is to give them one
mechanism instead of fourteen hand-written ones.

The fifth is one site and it is the whole argument for doing this before a theme exists.
A folder's Delete button carries `color: '#f7768e'`, which is `--destructive`
(`348.8 89% 71.6%`) converted to hex, exactly. Nothing marks it as the same value, so the
day the palette changes that one button keeps the old red — a theme would not be broken
by it, it would be *revealed* by it. One drift found in 43 sites is also the honest
measure of the risk: low, and real.

**And the last step as written here was wrong.** A design token passed through an
attribute is still an attribute, and `'unsafe-inline'` in `style-src` covers `<style>`
elements and `style` attributes alike — so no refactor of the 43 sites drops it. What
would is splitting the directive: `style-src-elem 'self'` for the sheets, with
`'unsafe-inline'` kept on `style-src-attr` for the attributes. An absent directive falls
back to `style-src`, so an engine that does not know them enforces exactly what it
enforces today: the split cannot regress, it can only fail to gain. `style-src-attr` is
available everywhere since late 2022; `style-src-elem` is baseline 2025 and unverified on
WebKitGTK. Whether the sheets survive `'self'` is a question about what the bundle injects
at runtime — xterm.js builds style elements of its own — so it gets measured in the
tls-proxy suite rather than asserted.

- [x] Inventory the sites and sort them — the table above
- [ ] The 13 static sites into classes, and the hex back onto its token: no behaviour
      change, identical output
- [ ] One mechanism for the 14 user-chosen colours instead of fourteen
- [ ] Runtime geometry through a CSS variable on the element rather than a style string —
      worth doing for readability, but it buys nothing on the CSP
- [ ] `style-src-elem 'self'` beside the kept `style-src-attr 'unsafe-inline'` in
      `packages/rite-server/src/lib.rs`, with the tls-proxy suite proving the sheets and
      xterm still load — independent of the four items above, and the only one that
      actually tightens anything

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

### 🧱 Toolchain moves, each waiting on a date rather than a decision (Priority: LOW)

Both are measured and ready. They sit here because engaging them early costs more
than waiting, not because anything is unresolved.

- [ ] **Ubuntu 24.04 → 26.04**, in `Containerfile` and every workflow's `runs-on`, in one
      commit. Already measured: the image builds from `ubuntu:26.04` with
      `libwebkit2gtk-4.1-dev` 2.52.6 and `libgtk-3-dev` 3.24.52 — no forced gtk4 move — and
      the full Rust gate passes in it (14 test binaries, 217 tests, `cargo audit` with the
      same single allowed warning). Waiting on GitHub finishing its `ubuntu-latest`
      rollout to 26.04, which runs to 2026-11-19, so the pin and the label agree instead of
      leapfrogging. `e2e/ci-image-check.mjs` fails if the two sides are moved apart.
      The release client matrix stays on `ubuntu-22.04`: the build host's glibc is the
      floor of the shipped binary, and 26.04's 2.43 would refuse to start on the current
      LTS.
- [ ] **TypeScript 5.9 → 7.0, with @types/node 24 → 26**, one PR, scheduled for 0.3.0. Two
      majors: expect real diagnostics changes across the frontend, which is a body of work
      rather than a bump. Tracked in #255.

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
- [x] **`local_terminal.rs`** — **done**, both halves. `cwd` arrived in 0.2.6 for splits;
      the argv-direct spawn is `LocalProgram::{Shell, Script, Argv}` with
      `LocalSession::run_program(events, argv, cwd)`, so a resume command reaches `execvp`
      as written instead of being re-parsed by `sh -c`. An argv does not borrow the
      shell's fallback resolution, which would have answered a missing CLI with an
      anonymous `/bin/sh` prompt. Nothing reaches it from the UI yet — it is groundwork,
      and six tests are its only caller. ADR 0022 §7.2 and its addendum.
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

Shipped in 0.2.4 as a DOCUMENT rather than as a profile manager: presets and layouts
live together in `~/.config/rite/layouts.toml`, or in a copy sealed on a server account
(ADR 0027), and Settings leads with the cards it parses. The rename is not cosmetic —
"profile" implied a record the app owns and a UI to manage it, and what shipped is
configuration you own and can version, which is why import/export and creation have no
separate work left.

- [ ] Layout launcher shortcut — there is a Layouts button and a menu, no `Mod+P`
- [ ] Layout tags and organization — the file has order and nothing else
- [ ] Save the current arrangement AS a layout — the file is written by hand or by the
      editor in Settings; nothing captures what is on screen into it

- [ ] A conflict guard on the account's layouts, if last-write-wins becomes a nuisance
      (ADR 0027). The cheap parades in order of cost: show the last-saved time in the
      editor — **done**, it comes back with the blob; then refuse a `PUT` carrying a stale
      `updatedAt`; only then anything resembling a merge

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
- [ ] `rite config` - Print the data directory. Printing, not opening: `xdg-open` is not
      guaranteed to be installed, and a default that assumes a tool is not a default

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
- [ ] Pane synchronization by selection — the mode ships scoped to a tab's panes, as
      tmux's `synchronize-panes` is; choosing arbitrary panes across tabs is the rest
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

1. **Font/theme customization** — as profile values, not as pickers; see Layouts
2. **Export/backup** (security)
3. **Polish & stability** (error handling, notifications)
