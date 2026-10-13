# Rite — UX dev mock

The **living UX prototype** for the Rite client. It is the source-of-truth for
the interface/UX: **prototype every UI/UX change here first**, then transpose it
into the real app (`apps/desktop`). It evolves alongside the app.

## Two shells, two mocks

Rite is *one* frontend with *two* delivery shells that genuinely diverge, so the
prototype is split per shell (shared CSS/JS/data, one HTML entry each):

- **`web.html`** — the **web UI** (browser → one Rite server). No context pill: the
  server is identified by its admin-set **instance name**. Adds the **admin console**
  (Users / Teams / Instance) and the session-persistence setting. No local vault,
  no multi-window. Import is **paste-only** (the server never sees a file path).
- **`desktop.html`** — the **desktop/binary** shell. Multi-context: a **context
  pill** switches between local **vault(s)** and **server(s)**, and the library
  itself follows the context — `VLIB` (a vault: collections without any
  collaboration) vs `SLIB` (a server: collections with members and roles); master-password/lock,
  multi-window, native local terminals. On a server context it shows the same
  *usage* UX as the web (connections, collections, terminals) but **not** the admin
  console — server management is web-only (open the server URL in a browser).

Both share the core model: personal **folders** → **collections** (the shareable
unit) → **machines**, and **no loose machines** (a machine always lives in a
collection; personal = a 1-member collection). So in both, the Library `+` menu is
**New folder / New collection**, and machines/import are actions **inside** a
collection.

Open either directly in a browser (no build, no server):

```
xdg-open design/mock/web.html       # the web UI
xdg-open design/mock/desktop.html   # the desktop shell
```

Everything is mock (no real backend) — clicks toast, dialogs are illustrative,
data lives in memory. It exists to *feel* placement, flows, and dialogs.

**It is checked like the app.** `e2e/tests/mock.spec.ts` (the `mock` Playwright project,
no server, the pages opened from disk) opens both entry pages, requires the same dashboard
cards and a working Board in each, fails on any console error, walks the ADR 0019
precedence table row by row — including what the refusal says — and holds the agent
manager to each state it exists to make speakable. Run it with
`npx playwright test --project=mock`; `task e2e` covers it too, along with the three
places the same rule is checked against the real app: the local vault (`dashboard-probe-gate`),
the web UI (`accounts`) and an attached client (`proxy`). The mock is the source of
truth for UI/UX, and until now nothing told anyone when it broke: that silence is how the
web UI ended up with a dashboard nobody had decided on.

## Divergences (web ↔ desktop)

| | Desktop (binary) | Web UI |
|---|---|---|
| Context identity | context **pill** (vaults / servers) | **instance name** in the header |
| Local vault | yes (master pw, lock, reset) | no |
| Multi-window | yes | no |
| Admin console | **no** — server management lives in the web console | yes (if admin) |
| Session persistence | — | admin setting |
| SSH import | file path or paste | **paste only** |
| Machine dashboard + Board | yes | **yes** — same cards, same markup (ADR 0019) |
| Probing cards (containers, services) | governed by `clients` when attached; the user's own call in a vault | governed by `webui`; off there means off for everyone |
| Agents on a library machine | yes | **yes** — it is an SSH session, like its terminal |
| Agents on your own machine | yes, natively | **no** — needs an attached desktop client |
| Agents in the Rite-Server container | **never** | **never** |

The **machine dashboard and the Board are not divergences** — they are *usage* features and
live in both shells (ADR 0019). Only the two cards that execute something on a host are
governed, and the governance is per shell: `dashboard_policy { webui, clients, minInterval }`
in the admin console's **Instance → Client capabilities**, narrowable (never widenable) by a
per-device user setting in **Settings → Machine status**. Most-restrictive-wins: a "yes" is a
permission, never an instruction. In the web UI a refusal is *enforcement* (the server runs the
commands); in an attached client it is *policy* (the client probes from its own network, and the
server never sees the request). The mock says so in the admin copy rather than leaving it to be
discovered. Both shells load the shared `machine.js` / `machine.css`, so neither entry page can
drift from the other — the drift is how the web UI ended up with an undocumented dashboard.

## The agent manager

**The manager is a view, the agent is a pane**, and that split is the design. The
manager is a chooser — machine, then tool, then conversation — and a chooser has no
context of its own, so it lives where the machine dashboard lives: opened from the
toolbar, closable from the tab strip. An agent *session* does have a context of its
own (a working directory, a transcript, a lifetime), which is exactly the rule that
gives it a pane. Resuming therefore opens a pane **in a new tab** — the gesture
connecting to a machine already uses — so the list you chose from is still where you
left it, and no split appears that you did not ask for.

**An agent pane is a leaf of the ordinary split tree.** It is a terminal, so it gets
the terminal's chrome from the same code (`paneActs` in `rite.js`, the mock's stand-in
for the pane-kind registry) and it splits *with plain terminals in the same tab* — a
`watch docker ps` or a `top` beside the agent that is causing them. Calling it a
terminal and then giving it a tab it could not share would be the same mistake as
rebuilding a chat UI over a vendor's TUI: the word right, the thing wrong. It is
*marked*, not redesigned — one purple edge and a purple header rule, enough to find in
a four-pane tab.

**A tab that holds a view does not look like a tab that holds panes.** The manager, a
collection and a machine dashboard are outlined; tabs holding panes stay filled and
keep the terminal icon. This was not a theory: "Agents" and a resumed agent both wore
the robot, and nothing said which one you could type into.

**Another CLI is two commands** — how to list its conversations, how to resume one.
That is the entire adapter boundary, and it is configurable from the manager's
**Tools** dialog, which shows both commands for every tool. Switching an adapter off
stops Rite looking for it; adding one says honestly that the last probe predates it
rather than claiming the machine does not have it. An adapter is yours, not a
machine's: the binary may be missing on one host and present on the next, and that is
what the probe reports.

**Agents run on a machine, under the account you already have there.** A machine from
your library works in *both* shells, because that is an SSH session and Rite already
has the transport. Your own machine is native on the desktop and needs an attached
client in a browser — listed in both, so the gap is stated instead of silent. And the
Rite-Server container is a **non-goal**, on screen, with its reason: an agent runs
arbitrary code, and in the server's own process it would sit beside every user's
encrypted data. On a target machine Rite grants no access the user did not already
have; inside the container it would grant all of it.

Four things the mock insists on being able to say, because each is an hour lost when
a UI stays quiet instead: a machine **nobody has probed** (not an empty list), a tool
that is **not installed**, a tool that is installed and **cannot read its own
transcripts**, and **when** the answer was read — discovery is one command per
machine, so it is explicit and dated rather than ambient. The conversation **id is
never typed and always reachable**: when an adapter breaks — and it will, `--resume`
and a vendor's home-directory layout are not a stable API — `claude --resume <id>` in
a terminal pane must still work. Rite is never the only way back to your own session.

The manager also opens **already pointed at a machine**, from that machine's dashboard
(`Agents`, beside `Edit` and `Connect`). A menu is a fine switcher and a poor finder:
with a real fleet you look a machine up where you always do — the library — and come at
its agents the way you come at its containers.

## Files
- `web.html` — the web-UI prototype (markup + inline logic).
- `desktop.html` — the desktop-shell prototype.
- `admin.html` — the **admin console** prototype: a dedicated dashboard (Overview /
  Users / Teams / **Collections** / Instance) served at `/admin`, admins-only — a
  **separate surface** from the connection manager so it can be deployed on its own
  (see the `rite-admin-console-split` memory). Includes the planned `Serve web UI` /
  `Serve admin console` toggles. Its **Collections** tab is *governance* only
  (policies, counts, cleanup) — zero-knowledge, so no names/contents.
- `collections.html` — the **user's** collection manager (opened from the header
  "Collections" button): the collections *I'm a member of*, with names/members
  visible because I hold the keys. Master-detail — pick a collection, manage
  members + per-member roles, sharing, colour, rename/delete; Personal is a real
  1-member collection that can't be shared or deleted. The counterpart to admin
  governance: same objects, different need.
- `machine.js` / `machine.css` — the **machine dashboard** (Overview, port forwarding,
  containers, services) and the collection **Board**, shared by both entry pages (ADR 0019).
  Each page supplies `DASH_SHELL` (`'webui'` / `'clients'`) and `probeGoverned()`; the shared
  `probeVerdict()` holds the precedence table so it cannot be re-derived differently twice.
- `rite.js` carries `paneActs()` — the split/detach/snippets/search/close chrome that
  belongs to a **pane**, not to what is inside it. A terminal and an agent session both
  draw from it, so neither can drift into a near-copy of the other.
- `agents.js` / `agents.css` — the **agent manager** (the view) and the **agent pane**,
  shared by both entry pages. Each page supplies `AGENT_SHELL` (`'desktop'` / `'web'`),
  which decides only one thing: whether your own machine can answer, or needs an attached
  client. Everything else — the machine → tool → conversation selector, the refusal on the
  server's own host, what a broken adapter says — is identical in both, on purpose.
- `rite.css` — shared design tokens + components (dark, terminal-forward).
- `rite.js` — shared helpers (toast, modal, mini-terminal) + generic dialogs.
- `full-data.js` — mock data (org directory, teams, collections) + extra icons.

## Model it encodes (see the `rite-ux-target` project memory for the full rationale)
- **Base-first**: local terminal + Quick SSH work with no auth.
- **Context** = a **local vault** (a named `.db` file, multi-vault) or a **server**,
  chosen from the top-left pill (or the "Card view" manager). A context is what you
  enter to reach your **saved connections**.
- **Library** = **collections** (the shareable unit: members + per-member roles
  owner/editor/viewer, ADR 0016) → **machines** (SSH hosts). A collection carries its
  own **nested sub-folders** (path names like `Web servers/EU`, part of its encrypted
  payload — recipients see the curated structure). Personal **organiser folders**
  (never shared, view-only) can group collections above them.
- **Personal = a real 1-member collection** (auto-provisioned, sorted first) — **on a
  server**. It holds machines and nested folders like any collection, but it **can't be
  shared or deleted** — its ⋯ menu is *Rename* only. To share, you create a **new**
  collection and add members.
- **A local vault has collections too, and no Personal.** Same structure (collections →
  folders → machines) so a large local estate can be split up and each collection gets
  its own Board — one Board for an entire estate would be unmanageable. But nothing is
  shareable, so there are **no members, no roles, no sharing UI**, and every collection
  is equal: all renamable, all deletable. Personal exists on a server only because
  *other* collections can be shared; with nothing shareable a 1-member Personal is
  indistinguishable from any other local collection, so it doesn't exist. The **vault**
  plays the role the **server** plays remotely: it is what holds the collections.
  A fresh vault starts **empty** — the library `+` creates the first collection, and
  machines are always created inside one.
- **No loose machines**: a machine always lives in a collection. You can't nest a
  collection in a collection — inside a collection you create **folders**. Import
  `~/.ssh/config` targets a collection.
- **Folder actions** depend on where the folder lives. ⋯ always = *Rename / Delete*. The
  `+` on a folder **inside a collection** offers *New sub-folder / New connection*; on a
  **root folder** (not in a collection) it offers *New sub-folder / New collection here*
  — a root folder isn't owned by a collection, so it can hold one.
- **Opening a collection** (main area) is a **drill-in** view: a breadcrumb
  (collection ▸ folder ▸ …), sub-folder **tiles** you click to enter, and the machines
  at the current folder — so the nesting is unambiguous. *New folder* / *New machine*
  target the folder you're browsing; filtering shows a flat result across all folders.
- **Moving a machine** between folders (its ↦ action, on the card or the sidebar row)
  just re-parents it — pick any folder in the collection (or the root) from the picker;
  no re-creation.
- Folders/collections have **custom colours**; context icons can be **custom images
  (client-side only)**. Distinct icons: folder / collection (layers) / machine
  (server rack) — the ▶ play icon is the *connect* action, not an identity.

## Conventions
- **No local/machine-specific paths or names** (no `/home/<user>`, no real person's
  name) — demo data must stay generic.
- Keep it self-contained (open-with-a-browser), no external assets.
