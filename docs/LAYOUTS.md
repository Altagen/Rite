# Layouts

A layout is what you open when you sit down: which terminals, in what order, and on
which machines. You keep it in a file, so it travels with you — commit it, copy it to
another computer, send it to a colleague.

```toml
# ~/.config/rite/layouts.toml
[[layout]]
name = "Morning"
startup = true

  [[layout.pane]]
  command = ""                        # this computer, a plain shell

  [[layout.pane]]
  machine = "web-01"                  # a machine from your library, by name
  command = "journalctl -fu app"

  [[layout.pane]]
  machine = "pg-prod"
  command = "top"
```

Open it from the **Layouts** button beside the tabs, from the chevron next to a
pane's divider, or let it open itself at startup.

## Why a file, and not a dialog

A **split preset** is a reflex: the pane you are in, divided, running one command.
It is one line long, you type it in four seconds, and it lives in
**Settings ▸ Split presets**.

A layout is not a bigger preset. It names machines, it has an order, it is the thing
that runs before you have typed anything, and it is worth keeping in version control
next to the rest of your setup. That is a file. **Settings ▸ Layouts** shows you the
file and saves it back; so does your own editor.

## Where the file is

| Platform | Path |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/rite/layouts.toml`, else `~/.config/rite/layouts.toml` |
| macOS | `~/Library/Application Support/rite/layouts.toml` |
| Windows | `%APPDATA%\Rite\layouts.toml` |

In the web UI the file belongs to your account on that server, and
**Settings ▸ Layouts** is the only way to reach it — there is no path to open.

## The format

One `[[layout]]` per arrangement, one `[[layout.pane]]` per terminal. Panes open in
the order they are written, alternating the split direction, so three panes give you
a grid rather than three slivers.

### A layout

| Key | Type | Meaning |
| --- | --- | --- |
| `name` | string, **required** | What the menu shows. |
| `startup` | boolean | `true` opens this layout in a new tab when Rite starts. Several layouts may set it; each gets its own tab. |

### A pane

| Key | Type | Meaning |
| --- | --- | --- |
| `machine` | string | A machine from your library, **by the name you gave it** — not its address. Omit it for this computer. |
| `command` | string | Typed into the pane once it is open. Omit it, or leave it empty, for a plain shell. |
| `name` | string | A label for the pane's header. Defaults to the machine, else the first word of the command. |

A `machine` is resolved against the library of the vault or server you are in. It
needs that vault **open**: your machines are encrypted, and a locked vault has no
names to match against.

## When the file asks for something you don't have

The file is not a contract Rite can enforce. Machines get renamed, a vault stays
locked, the file arrives from another computer. So a pane that cannot be opened as
written is **not an error that cancels the layout**:

- **The machine isn't in your library** — the pane opens as a plain shell and says so
  in the pane, naming what it looked for.
- **The vault is locked** — same: a plain shell, with a note that the machine needed
  an open vault.
- **The machine is there but unreachable** — the pane opens as an SSH pane and
  reports the connection failure, exactly as it would if you had opened it yourself.

You get your workspace, minus what could not be found, and you can see what was
missing. Fix the name, press **↻ Reload**, open the layout again.

## When the file doesn't parse

Nothing new loads, and the layouts already loaded keep working. **Settings ▸ Layouts**
and the Layouts button both say the file has an error, with the line number and what
was wrong with it. Half a file would be worse than none: you would not know which
half you got.

```
⚠ Not loaded. Line 5: a value is a quoted string or true/false, not web-01
```

Only `[[layout]]` and `[[layout.pane]]` tables exist, and a value is either a quoted
string or `true`/`false`. Anything else is refused with its line.

## Related

- **Settings ▸ Split presets** — one command in one pane, the chevron beside the
  divider.
- **Settings ▸ Toolbar** — whether the Layouts button is shown at all.
- [ADR 0020](https://github.com/Altagen/Rite) — why configuration that people keep
  and copy is a TOML file in this project.
