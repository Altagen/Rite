# Rite — UX dev mock

The **living UX prototype** for the Rite client. It is the source-of-truth for
the interface/UX: **prototype every UI/UX change here first**, then transpose it
into the real app (`apps/desktop`). It evolves alongside the app.

Open `mock.html` directly in a browser (no build, no server):

```
xdg-open design/mock/mock.html      # or just open the file in your browser
```

Everything is mock (no real backend) — clicks toast, dialogs are illustrative,
data lives in memory. It exists to *feel* placement, flows, and dialogs.

## Files
- `mock.html` — the whole prototype (markup + inline logic).
- `rite.css` — shared design tokens + components (dark, terminal-forward).
- `rite.js` — shared helpers (toast, modal, mini-terminal) + generic dialogs.
- `full-data.js` — mock data (org directory, teams, collections) + extra icons.

## Model it encodes (see the `rite-ux-target` project memory for the full rationale)
- **Base-first**: local terminal + Quick SSH work with no auth.
- **Context** = a **local vault** (a named `.db` file, multi-vault) or a **server**,
  chosen from the top-left pill (or the "Card view" manager). A context is what you
  enter to reach your **saved connections**.
- **Library** = personal **folders** (your organisation, never shared) → **collections**
  (the shareable unit: members + per-member roles owner/editor/viewer, ADR 0016) →
  **machines** (SSH hosts). A collection can carry its own **shared sub-folders**
  (part of its encrypted payload — recipients see the curated structure).
- **No loose machines**: a machine always lives in a collection (personal = a
  1-member collection). Import `~/.ssh/config` targets a collection.
- Folders/collections have **custom colours**; context icons can be **custom images
  (client-side only)**. Distinct icons: folder / collection (layers) / machine
  (server rack) — the ▶ play icon is the *connect* action, not an identity.

## Conventions
- **No local/machine-specific paths or names** (no `/home/<user>`, no real person's
  name) — demo data must stay generic.
- Keep it self-contained (open-with-a-browser), no external assets.
