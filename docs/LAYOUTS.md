# The workspace file

Two things describe how this machine is set up: the commands your split menu offers,
and what opens when you sit down. They live in one file, so they travel with you —
commit it, copy it to another computer, send it to a colleague.

```toml
# ~/.config/rite/layouts.toml

[[preset]]
name = "Logs"
command = "journalctl -fu app"

[[layout]]
name = "Morning"
startup = true

  [[layout.pane]]
  command = ""                        # the first pane is the whole tab

  [[layout.pane]]
  machine = "web-01"                  # a machine from your library, by name
  preset = "Logs"                     # or command = "…" — one or the other
  split = "right"                     # of the previous pane
  size = "40%"                        # this pane's share of what it cuts
```

Presets are in the chevron beside a pane's divider, and in **Settings ▸ Split
presets**. Layouts are on the **Layouts** button beside the tabs, in **Settings ▸
Layouts**, or they open themselves at startup.

## Why a file

A **preset** is a reflex: the pane you are in, divided, running one command. A
**layout** is the morning: several terminals, on several machines, arranged. They are
two features, with two buttons — but they are the same kind of fact. They belong to
*this machine*, they are worth keeping in version control next to the rest of your
setup, and nothing in them is a secret. That is a file.

Both dialogs show you the file and save it back; so does your own editor. The preset
dialog rewrites only the `[[preset]]` blocks, so your layouts, your comments and your
blank lines survive an edit made with the mouse.

**On a shared server there is no file**, and no substitute — not a row in a settings
table, which would be readable by that server and shared with every other account on
it. Presets and layouts simply do not appear in the web UI of a server with accounts.
A *desktop* client signed in to such a server keeps its own file: the machine names in
it are resolved against whichever vault is open, on your computer, after unlock.

## Where the file is

| Platform | Path |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/rite/layouts.toml`, else `~/.config/rite/layouts.toml` |
| macOS | `~/Library/Application Support/rite/layouts.toml` |
| Windows | `%APPDATA%\rite\layouts.toml` |

`RITE_LAYOUTS_FILE` overrides the path entirely, so the file can live in a dotfiles
repository or beside a project.

## A preset

| Key | Type | Meaning |
| --- | --- | --- |
| `name` | string, **required** | What the chevron shows. |
| `command` | string | What it runs in the new pane. Empty is a plain shell. |

A file that declares **nothing at all** gets the two shipped presets, `Load` (`top`)
and `Disk` (`df -h`) — both work on a machine with nothing installed on it. A file
that declares a layout and no preset is a decision, and it is honoured: your chevron
offers the plain split and your snippets.

## A layout

| Key | Type | Meaning |
| --- | --- | --- |
| `name` | string, **required** | What the menu shows, and the tab's name. |
| `startup` | boolean | `true` opens this layout when Rite starts. Several layouts may set it; each opens its own tabs. |

A layout opens **its own tabs**. It does not divide whatever happens to be on screen,
which is what lets a file with eight panes produce exactly eight panes.

## A pane

| Key | Type | Meaning |
| --- | --- | --- |
| `machine` | string | A machine from your library, **by the name you gave it** — not its address. Omit it for this computer. |
| `command` | string | Typed into the pane once it is open. Omit it, or leave it empty, for a plain shell. |
| `preset` | string | Run a `[[preset]]`'s command instead of repeating it. Not together with `command`. |
| `name` | string | A label for the pane's header, and the name `of` points at. |
| `split` | `right` · `down` · `left` · `up` | Which way this pane is cut out of the area. |
| `of` | string | The pane this one is cut out of, by `name`. Defaults to the previous pane. |
| `size` | percent string | This pane's share of the area being cut, `"10%"` to `"90%"`. Defaults to half. |
| `tab` | string | The tab this pane belongs to. The first mention creates it; the following panes stay in it until another `tab` appears. |

A `machine` is resolved against the library of the vault or server you are in. It
needs that vault **open**: your machines are encrypted, and a locked vault has no
names to match against.

## Arranging the panes

**Say nothing and you get a grid.** A tab whose panes declare no `split` tiles into a
balanced grid, filled left to right then top to bottom — four panes make a 2×2.

**Say where, and the file is followed.** As soon as one pane declares `split`, each
pane is cut out of the previous one, or out of the pane `of` names.

Two rules make the result match what you pictured:

- **`size` is a share of the area being cut, not of the window.** `"50%"` inside a
  column that is itself half the window is a quarter of the screen. Outside 10–90 %
  the file is refused with its line number, because the screen could not honour it.
- **Big cuts first.** A pane is cut out of another *pane*, never out of a group, so a
  column is placed before it is subdivided. That is also the order you would do it in
  with the mouse.

Eight panes, arranged:

```
┌───────────────┬───────────────┐
│ 1  web-01     │ 5  db-01      │
├───────┬───────┼───────────────┤
│ 2 w-02│ 3 w-03│ 6  top        │
├───────┴───────┼───────┬───────┤
│ 4  uptime     │ 7 df  │ 8 free│
└───────────────┴───────┴───────┘
```

```toml
[[layout]]
name = "Warroom"

  [[layout.pane]]            # 1 — the whole tab
  name = "l1"
  machine = "web-01"
  preset = "Logs"

  [[layout.pane]]            # 5 — the big cut: left | right
  name = "r1"
  split = "right"
  of = "l1"
  size = "50%"
  machine = "db-01"
  command = "psql"

  [[layout.pane]]            # 2 — the left column, under the first pane
  name = "l2"
  split = "down"
  of = "l1"
  size = "67%"
  machine = "web-02"
  preset = "Logs"

  [[layout.pane]]            # 4 — its own bottom row, before anything narrows it
  name = "l3"
  split = "down"
  of = "l2"
  command = "uptime"

  [[layout.pane]]            # 3 — and now the middle row, in two
  split = "right"
  of = "l2"
  machine = "web-03"
  preset = "Logs"

  [[layout.pane]]            # 6 — the right column, same way down
  name = "r2"
  split = "down"
  of = "r1"
  size = "67%"
  machine = "db-01"
  command = "top"

  [[layout.pane]]            # 7 — its bottom row
  name = "r3"
  split = "down"
  of = "r2"
  command = "df -h"

  [[layout.pane]]            # 8 — which splits in two
  split = "right"
  of = "r3"
  command = "free -h"
```

Note the order: `uptime` (4) is placed **before** `web-03` (3) narrows the row above
it. Written the other way round, it would be cut out of the half-row rather than out
of the column — the arrangement the file asks for, not the one it pictures.

### How many panes fit

Rite imposes no limit: no maximum, no depth bound. Your screen does. A terminal is
comfortable from about 80 columns by 24 lines, which in shares of the window is:

| Window | A pane needs | Fits at 80×24 |
| --- | --- | --- |
| 1920×1080 | 35 % wide, 43 % tall | 2 × 2 → 4 panes |
| 2560×1440 | 26 % / 31 % | 3 × 3 → 9 panes |
| 3440×1440 | 20 % / 31 % | 5 × 3 → 15 panes |

Eight panes on a 1080p screen work, but something gives: `"25%"` wide by `"50%"` tall
is 57 columns by 27 lines (good for `htop`), while 50 % by 25 % is 114 by 14 (good for
a `tail -f`). Beyond that, the costs are the scrollback each pane keeps and, on one
host, the SSH handshakes — each pane is its own session, and OpenSSH ships with
`MaxSessions 10`. Use `tab` for the rest: panes for what you watch side by side, tabs
for changing context.

## Pre-connect hooks

A machine's pre-connect hook (**the connection's own setting** — VPN up, SSO refresh)
runs before a layout opens that machine, exactly as it does when you click the
machine. It runs **once per machine per layout**, however many panes name it, and if
it fails or you cancel it those panes open as plain shells saying so.

There is no `preconnect` key in this file: the hook belongs to the machine, and a
second place to declare it would eventually disagree with the first.

## When the file asks for something you don't have

The file is not a contract Rite can enforce. Machines get renamed, a vault stays
locked, the file arrives from another computer. So a pane that cannot be opened as
written is **not an error that cancels the layout**:

- **The machine isn't in your library** — the pane opens as a plain shell and says so
  in the pane, naming what it looked for.
- **The vault is locked** — same: a plain shell, with a note that the machine needed
  an open vault.
- **The machine refuses the connection** — the pane opens as a plain shell carrying
  the reason, so the arrangement survives one unreachable host.

You get your workspace, minus what could not be found, and you can see what was
missing. Fix the name, press **↻ Reload**, open the layout again.

## When the file doesn't parse

Nothing new loads, and what is already loaded keeps working. **Settings ▸ Layouts**
and the Layouts button both say the file has an error, with the line number and what
was wrong with it. Half a file would be worse than none: you would not know which
half you got.

```
⚠ Not loaded. Line 5: a value is a quoted string or true/false, not web-01
```

Only `[[preset]]`, `[[layout]]` and `[[layout.pane]]` tables exist, and a value is
either a quoted string or `true`/`false`. Anything else is refused with its line —
including a `split` that is not one of the four words, a `size` outside 10–90 %, an
`of` that names no pane placed before it, and two panes of one layout sharing a name.

## Related

- **Settings ▸ Toolbar** — whether the Layouts button is shown at all.
- ADR 0023 — why presets and layouts are one file on your machine, and why a shared
  server has neither.
- ADR 0020 — why configuration that people keep and copy is TOML in this project.
