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
  pill** switches between local **vault(s)** and **server(s)**; master-password/lock,
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

## Divergences (web ↔ desktop)

| | Desktop (binary) | Web UI |
|---|---|---|
| Context identity | context **pill** (vaults / servers) | **instance name** in the header |
| Local vault | yes (master pw, lock, reset) | no |
| Multi-window | yes | no |
| Admin console | **no** — server management lives in the web console | yes (if admin) |
| Session persistence | — | admin setting |
| SSH import | file path or paste | **paste only** |

## Files
- `web.html` — the web-UI prototype (markup + inline logic).
- `desktop.html` — the desktop-shell prototype.
- `admin.html` — the **admin console** prototype: a dedicated dashboard (Overview /
  Users / Teams / Instance) served at `/admin`, admins-only — a **separate surface**
  from the connection manager so it can be deployed on its own (see the
  `rite-admin-console-split` memory). Includes the planned `Serve web UI` /
  `Serve admin console` toggles.
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
- **Personal = a real 1-member collection** (auto-provisioned, sorted first). It holds
  machines and nested folders like any collection, but it **can't be shared or deleted**
  — its ⋯ menu is *Rename* only. To share, you create a **new** collection and add members.
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
