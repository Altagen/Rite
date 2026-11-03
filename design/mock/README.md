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
`npx playwright test --project=mock`; it also clicks **every control the agent surface
added**, because a mock that throws on a click nobody exercised is the same silence in a
smaller place. `task e2e` covers it too, along with the three
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
| Workspace (presets + layouts) | a **file**, or the account's copy when signed in | the account's **sealed copy** — no filesystem to hold a file (ADR 0027) |
| Key authentication | a path in a vault; carried or a path on a server | **carried only** — a path is read on the computer that connects (ADR 0028) |
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

**Six adapters ship, and each says where its two commands came from.** `measured` was
read off the installed binary's own `--help` on 2026-10-31 — Claude Code, Codex, Gemini
and Grok, which are the four installed on the machine this was written on. Hermes is
`vendor docs` and opencode is `community`, meaning a third-party write-up: a guess with
a footnote. The badge exists because a built-in is not more trustworthy than one you
wrote — yours you tested — and without it the dialog teaches the opposite.

Two findings came out of measuring rather than listing, and both are on screen:

- **a handle is not always durable.** Gemini resumes by *position* in the current
  project's list, so the number that resumes a conversation today resumes another one
  next week. ADR 0022 §5 promises the id is never typed and always reachable; for that
  tool the second half is not available, so the row offers "copy the index — it moves"
  instead of a copy that quietly rots. Grok and Hermes match a non-uuid value against
  session *titles* and fail as ambiguous on duplicates, so the uuid is what Rite keeps.
- **"list its conversations" is not one shape.** Claude and Grok are files on disk,
  Gemini is a flag, Codex has no machine-readable listing at all (its `resume` opens an
  interactive picker, which an adapter cannot read), and Hermes keeps sessions in
  **SQLite**. A contract that had said "two paths" instead of "two commands" would
  already be broken. §4 survives the measurement, which is the useful result.

**Detection is the list command**, and nothing else. One command per machine runs each
enabled adapter's listing and keeps what came back: not found, an error with its text,
or conversations. Nothing is inferred from a binary being present — a CLI that is
installed and cannot read its own transcripts is a different answer from one that is
absent, and only running it tells them apart. The error text also separates two
failures that look identical: the machine refused us, or *our own adapter* is wrong for
the build that is installed. The fix is in a different place for each, so the card says
which one it is.

**Agents run on a machine, under the account you already have there.** A machine from
your library works in *both* shells, because that is an SSH session and Rite already
has the transport. Your own machine is native on the desktop and needs an attached
client in a browser — listed in both, so the gap is stated instead of silent. And the
Rite-Server container is a **non-goal**, on screen, with its reason: an agent runs
arbitrary code, and in the server's own process it would sit beside every user's
encrypted data. On a target machine Rite grants no access the user did not already
have; inside the container it would grant all of it.

### Two layouts, both on screen, because the choice is not obvious

The manager draws the same conversations two ways and a switch in its header picks
one. Both are in the mock on purpose: which survives a real fleet is answered by
looking at twenty-one conversations in both, not by arguing about it in a pull
request. They are built from one `agentRows`, and a test holds that the rail's CLIs
are the stacked bands and that each holds the same conversations — a layout must not
win by quietly showing fewer rows.

**Stacked** draws every CLI at once, each a band of cards. **Rail** puts the CLIs in a
narrow column on the left and gives the whole width to one of them at a time. What
the rail buys is the thing that bites at forty conversations: there is no scrolling
past one tool to reach another, because only one is on screen, and switching is one
click away at all times. The cards are the same cards — the rail is a different way
of choosing, not a second way of drawing a conversation.

Three controls keep the stacked view usable as it grows, and they answer three
different questions:

| | |
|---|---|
| **Fold a band** (click its heading) | not right now. The count stays visible while folded, because that is the reason to unfold it |
| **Only** (on a band) | this one and nothing else, in one gesture instead of unticking five |
| **The CLI filter** (in the header) | which CLIs this view draws at all |

None of them is the **Tools** switch, which is a fourth thing: turning an adapter off
there stops Rite *looking* for it, so using it to tidy a screen would silently stop
discovery.

#### The drawer

Selecting a conversation opens a column beside **either** arrangement. It is not half
of a layout, which is the point: its **tab strip is a seam left open**, and what comes
after "In effect" — a note vault, a map of what a project loads, a view of pre-hooks —
arrives as another tab rather than as a redesign. The per-conversation menu is the
other seam, on both layouts.

It holds the facts a chooser legitimately has — where the agent runs, its directory,
its branch, its depth, its handle and the exact command that resumes it — rather than
more transcript. A preview that grew into a transcript reader would be the chat UI
ADR 0022 §8 refuses, reached slowly.

#### What identifies a conversation, since its name does not

Five facts, the same in both layouts because they belong to the conversation and not
to the arrangement:

| | |
|---|---|
| **The opening ask** | what was actually typed. It is the headline and it gets two lines, because a truncated question is the one thing here that cannot be guessed from the rest |
| **The project and its branch** | two conversations about one project are told apart by the branch, and nothing else on the card would do it |
| **The working directory** | truncated from the *left*, because the tail of a path is what separates two projects and `~/Dev/projects/…` hides exactly the useful half |
| **The machine, as a coloured edge** | taken from the folder or collection it sits in — a colour already chosen in the Library, so "the orange ones are the cache boxes" is a fact the user established and the manager only reads |
| **Depth and recency** | a long conversation from yesterday and this morning's two-minute try stop looking alike |

What is **not** on a card: the adapter's provenance, which answers a maintainer's
question and stays in **Tools**; the uuid, which is never typed and is one menu away;
and the agent's last line, which only matters once a conversation is the one being
considered, so it lives in the drawer.

#### Recency, and nothing more

A session's **folder** gives three of the five facts a card carries, with one listing:
the file name is the id, the path encodes the project (Claude slugs it, Grok
URL-encodes it), and the modification time is when the agent last wrote. Measured here:
125 files under `~/.claude/projects`, 55 under `~/.codex/sessions`, 3821 under
`~/.grok/sessions`, 567 under `~/.gemini/tmp`. Hermes is the exception and keeps its
sessions in SQLite, which is why an adapter can still name a command instead of a
folder.

**What a folder cannot tell you is whether anything is running**, and an earlier pass
claimed it did. `state: 'running' | 'idle'` came from nothing: a transcript written
twenty seconds ago by a session that has since exited is byte-for-byte one written by a
session mid-answer. Grok even leaves `.lock` files beside its session files, and they
sit on disk with no Grok running — stale write locks, not liveness. Claude, Codex and
Gemini leave nothing at all.

So **no conversation is marked alive**. The card says when the transcript was last
written, which is a fact, and says nothing it cannot support. A check against the
process table — `pgrep -af claude` does show a resumed session's id on its command line
— stays possible later and stays *optional*: a refinement on a surface that is already
honest, not a third command every adapter owes.

#### Choosing a machine, at two levels

The flat menu this replaces listed every machine one after another. That reads fine
with five and falls apart at the size a fleet reaches — and it flattened a structure the
reader already has in their head, since the Library is collections holding machines.

**Type if you know the name, browse if you do not.** The field searches every collection
the reader holds a key to, so there is no collection to pick first; below it the
collections group their own machines, each under the colour the Library gave it. A
search result always carries its collection, so "which Production?" is answered on the
row rather than one click away.

A themed panel rather than a native `<select>`, for the reason the flat menu already
gave — an OS dropdown paints its own list in its own colours — and because a `<select>`
could not hold a search field.

#### Naming a conversation

A name and a colour, over a session Rite did not create. Rite keeps them and the
vendor's files are never touched — §6's read-only rule is about Rite not becoming a
second source of truth for *their* data, and a label that exists only in Rite is not
their data. The label becomes the headline and **the ask stays underneath**: renaming
must not lose what was asked, which is the one thing on a card nobody can reconstruct.

**Personal, not shared, and that is a decision.** Access to an agent is already settled
by the collection that holds the machine — hold its key, hold the SSH credential, see
that machine's conversations — so nothing here needs a permission of its own. But a
label is not access, and people work with these tools differently enough that one
person's "spike, throw away" is another's "the queue work". A shared rename would take
someone's filing system away from them.

Keyed by the machine's **reference**, the **tool** and the **conversation id**. The
reference and not the name, because an id is meaningless without the store that resolves
it — a mark read out of context says nothing about which host it is about, which is what
makes sealing it worth anything. The tool, because an id is only unique within its tool:
Gemini hands back an *index*, and the index `2` exists on every machine that has a second
conversation in that project. The mock carries that collision so the key is tested rather
than assumed.

#### Where a mark is kept is not a setting

It follows the machine's own record, and nothing else. No preference, no per-machine
switch, no reconciliation — because naming a conversation must not become a configuration
problem, and that requirement outranks the rest.

| The machine is | The mark goes to |
|---|---|
| **This machine**, no vault open | the device, in the clear. No record to hang it on and no key to seal it with |
| in the **local vault** | the vault, sealed with its key. A local vault *is* a vault, so it is the same mechanism, not a second one |
| on a **server** | the account, sealed client-side under the reader's own key, on the `user_library` pattern |

Everything that *can* be sealed is sealed. The account's copy is per reader, so a mark on
a machine in a **shared** collection is still the reader's own, and the server stores
ciphertext it cannot parse — as it does for every other per-user store in the product.
The single exception is the first row, and it is an exception because nothing exists to
seal with, not because a choice was made.

A label is prose a person wrote, and free text is where the sensitive thing ends up:
"the Acme diligence" is a sentence nobody types into a colour picker.

#### All machines

The default scope aggregates every machine already read, newest first. No
single-machine tool on the market has this entry — every one of them reads the home
directory of the host it runs on — and it is the reason the machine had to be a fact
on the card rather than a heading above it. It aggregates what has **already** been
read and never fans a probe out across the library: that would be one SSH round trip
per machine behind a view that opened by itself.

Search covers what identifies a conversation — the ask, the project, the branch, the
machine — and not the transcript, which is a different feature with a different cost.

#### What a tool's state looks like now

A tool that is **not installed** gets no card and no block. It is a word in one line
at the foot: six empty cards per machine is how a surface stops being read. A tool
that is installed and **cannot answer** keeps a block of its own, because it is the
one state with something to do about it — and the error text separates a host that
refused us from an adapter of ours that is wrong for the installed build. Those have
fixes in different places, so the block says which.

### The first condition is satisfied by construction

Agents are managed only on a machine the reader can already sign in to — and **the
library holds nothing else**. Holding a collection's key *is* holding its machines'
credentials, and a collection offered to a team but not joined lives in **Discover**,
which reads `COLL` and not the tree. So no machine in the picker can be barred in
advance, and the condition needs no UI because it cannot be violated.

An earlier pass built an apparatus for two states that do not exist: an offered
collection dropped into the library, and a stored "the host refused this key" that
nothing in Rite records. Both were removed. The lesson is worth keeping — a refusal
that cannot happen is a refusal nobody can act on, and it sends a reader looking for a
key they already hold.

**What is knowable is what the last probe came back with.** A machine Rite could not
sign in to carries one word — **error**, in red, not "no access", which reads as a
permission and is the wrong diagnosis — with the error on the badge's title and the
whole of it when the machine is selected: what failed, that the fix is on the host, and
when it was read. A failure with no date is a failure nobody can act on.

The two markers that remain are not failures at all, and say so in their own words:
**never** on the Rite server host (a non-goal no credential changes) and **no client**
on this machine in a browser (the access exists, the reach does not).

#### Machine status is not shared, and could not be

`/api/healthcheck/probe` is stateless: *"the client hands over host:port (decrypted from
its own blob — the server stays zero-knowledge about which machines these are) and gets
back an up/down verdict per target."* Nothing is stored and the server never learns
which machine it just probed, so one member's result cannot become another's.

That is a consequence of the threat model rather than a gap, and it is also right on the
facts: reachability belongs to the pair *(machine, vantage point)*. A host behind one
member's VPN is down from everyone else's desk. A shared "it is up" would be somebody
else's answer to a different question.

### Two layouts, both on screen, because the choice is not obvious

The manager draws the same conversations two ways and a switch in its header picks
one. Both are in the mock on purpose: which survives a real fleet is answered by
looking at twenty-one conversations in both, not by arguing about it in a pull
request. They are built from one `agentRows`, and a test holds that the rail's CLIs
are the stacked bands and that each holds the same conversations — a layout must not
win by quietly showing fewer rows.

**Stacked** draws every CLI at once, each a band of cards. **Rail** puts the CLIs in a
narrow column on the left and gives the whole width to one of them at a time. What
the rail buys is the thing that bites at forty conversations: there is no scrolling
past one tool to reach another, because only one is on screen, and switching is one
click away at all times. The cards are the same cards — the rail is a different way
of choosing, not a second way of drawing a conversation.

Three controls keep the stacked view usable as it grows, and they answer three
different questions:

| | |
|---|---|
| **Fold a band** (click its heading) | not right now. The count stays visible while folded, because that is the reason to unfold it |
| **Only** (on a band) | this one and nothing else, in one gesture instead of unticking five |
| **The CLI filter** (in the header) | which CLIs this view draws at all |

None of them is the **Tools** switch, which is a fourth thing: turning an adapter off
there stops Rite *looking* for it, so using it to tidy a screen would silently stop
discovery.

#### The drawer

Selecting a conversation opens a column beside **either** arrangement. It is not half
of a layout, which is the point: its **tab strip is a seam left open**, and what comes
after "In effect" — a note vault, a map of what a project loads, a view of pre-hooks —
arrives as another tab rather than as a redesign. The per-conversation menu is the
other seam, on both layouts.

It holds the facts a chooser legitimately has — where the agent runs, its directory,
its branch, its depth, its handle and the exact command that resumes it — rather than
more transcript. A preview that grew into a transcript reader would be the chat UI
ADR 0022 §8 refuses, reached slowly.

#### What identifies a conversation, since its name does not

Five facts, the same in both layouts because they belong to the conversation and not
to the arrangement:

| | |
|---|---|
| **The opening ask** | what was actually typed. It is the headline and it gets two lines, because a truncated question is the one thing here that cannot be guessed from the rest |
| **The project and its branch** | two conversations about one project are told apart by the branch, and nothing else on the card would do it |
| **The working directory** | truncated from the *left*, because the tail of a path is what separates two projects and `~/Dev/projects/…` hides exactly the useful half |
| **The machine, as a coloured edge** | taken from the folder or collection it sits in — a colour already chosen in the Library, so "the orange ones are the cache boxes" is a fact the user established and the manager only reads |
| **Depth and recency** | a long conversation from yesterday and this morning's two-minute try stop looking alike |

What is **not** on a card: the adapter's provenance, which answers a maintainer's
question and stays in **Tools**; the uuid, which is never typed and is one menu away;
and the agent's last line, which only matters once a conversation is the one being
considered, so it lives in the drawer.

#### Recency, and nothing more

A session's **folder** gives three of the five facts a card carries, with one listing:
the file name is the id, the path encodes the project (Claude slugs it, Grok
URL-encodes it), and the modification time is when the agent last wrote. Measured here:
125 files under `~/.claude/projects`, 55 under `~/.codex/sessions`, 3821 under
`~/.grok/sessions`, 567 under `~/.gemini/tmp`. Hermes is the exception and keeps its
sessions in SQLite, which is why an adapter can still name a command instead of a
folder.

**What a folder cannot tell you is whether anything is running**, and an earlier pass
claimed it did. `state: 'running' | 'idle'` came from nothing: a transcript written
twenty seconds ago by a session that has since exited is byte-for-byte one written by a
session mid-answer. Grok even leaves `.lock` files beside its session files, and they
sit on disk with no Grok running — stale write locks, not liveness. Claude, Codex and
Gemini leave nothing at all.

So **no conversation is marked alive**. The card says when the transcript was last
written, which is a fact, and says nothing it cannot support. A check against the
process table — `pgrep -af claude` does show a resumed session's id on its command line
— stays possible later and stays *optional*: a refinement on a surface that is already
honest, not a third command every adapter owes.

#### Choosing a machine, at two levels

The flat menu this replaces listed every machine one after another. That reads fine
with five and falls apart at the size a fleet reaches — and it flattened a structure the
reader already has in their head, since the Library is collections holding machines.

**Type if you know the name, browse if you do not.** The field searches every collection
the reader holds a key to, so there is no collection to pick first; below it the
collections group their own machines, each under the colour the Library gave it. A
search result always carries its collection, so "which Production?" is answered on the
row rather than one click away.

A themed panel rather than a native `<select>`, for the reason the flat menu already
gave — an OS dropdown paints its own list in its own colours — and because a `<select>`
could not hold a search field.

#### Naming a conversation

A name and a colour, over a session Rite did not create. Rite keeps them and the
vendor's files are never touched — §6's read-only rule is about Rite not becoming a
second source of truth for *their* data, and a label that exists only in Rite is not
their data. The label becomes the headline and **the ask stays underneath**: renaming
must not lose what was asked, which is the one thing on a card nobody can reconstruct.

**Personal, not shared, and that is a decision.** Access to an agent is already settled
by the collection that holds the machine — hold its key, hold the SSH credential, see
that machine's conversations — so nothing here needs a permission of its own. But a
label is not access, and people work with these tools differently enough that one
person's "spike, throw away" is another's "the queue work". A shared rename would take
someone's filing system away from them.

Keyed by the machine's **reference**, the **tool** and the **conversation id**. The
reference and not the name, because an id is meaningless without the store that resolves
it — a mark read out of context says nothing about which host it is about, which is what
makes sealing it worth anything. The tool, because an id is only unique within its tool:
Gemini hands back an *index*, and the index `2` exists on every machine that has a second
conversation in that project. The mock carries that collision so the key is tested rather
than assumed.

#### Where a mark is kept is not a setting

It follows the machine's own record, and nothing else. No preference, no per-machine
switch, no reconciliation — because naming a conversation must not become a configuration
problem, and that requirement outranks the rest.

| The machine is | The mark goes to |
|---|---|
| **This machine**, no vault open | the device, in the clear. No record to hang it on and no key to seal it with |
| in the **local vault** | the vault, sealed with its key. A local vault *is* a vault, so it is the same mechanism, not a second one |
| on a **server** | the account, sealed client-side under the reader's own key, on the `user_library` pattern |

Everything that *can* be sealed is sealed. The account's copy is per reader, so a mark on
a machine in a **shared** collection is still the reader's own, and the server stores
ciphertext it cannot parse — as it does for every other per-user store in the product.
The single exception is the first row, and it is an exception because nothing exists to
seal with, not because a choice was made.

A label is prose a person wrote, and free text is where the sensitive thing ends up:
"the Acme diligence" is a sentence nobody types into a colour picker.

#### All machines

The default scope aggregates every machine already read, newest first. No
single-machine tool on the market has this entry — every one of them reads the home
directory of the host it runs on — and it is the reason the machine had to be a fact
on the card rather than a heading above it. It aggregates what has **already** been
read and never fans a probe out across the library: that would be one SSH round trip
per machine behind a view that opened by itself.

Search covers what identifies a conversation — the ask, the project, the branch, the
machine — and not the transcript, which is a different feature with a different cost.

#### What a tool's state looks like now

A tool that is **not installed** gets no card and no block. It is a word in one line
at the foot: six empty cards per machine is how a surface stops being read. A tool
that is installed and **cannot answer** keeps a block of its own, because it is the
one state with something to do about it — and the error text separates a host that
refused us from an adapter of ours that is wrong for the installed build. Those have
fixes in different places, so the block says which.

### The first condition: an account you already have on that host

**No usable SSH access, no agent management.** Not a rail Rite adds on top — it is the
whole of what Rite does here: it signs in as you, with the credential you already
hold, and runs the CLI that is already installed. No account, nothing to sign in with,
nothing to manage. A machine in that state gets no tool cards, no conversations and no
probe button, because there is no host that would answer.

Which is also why this machine, on the desktop, is not an exception to the rule: the
condition is *an account you already have*, and on your own machine you are already
signed in. There is no transport to authorise because there is no transport.

The two ways to lack access get different text, because they have different fixes:

| | on screen | the fix |
|---|---|---|
| **No key to the collection** (`grafana-01`) | offered to you, not shared with you — Rite holds no credential | ask a key-holder (ADR 0016) |
| **The credential stopped working** (`edge-01`) | the key was refused by the host, rotated and never re-enrolled | open a terminal there; when a shell works, so does this |

Neither machine is removed from the picker. A machine that disappears reads as "no
agents here", which is a claim Rite cannot make — and it hides the one thing the user
can act on, which is the access.

**This is the same in both shells, and that is the point of the feature.** The agents
live on the host, not in the thing you are looking at them with: a desktop client and a
browser reach the same machines, over the same SSH session, under the same account. In
the web UI the reachable set is the member's own — two members on one instance see two
different managers — so the manager is never a property of the instance.

Four things the mock insists on being able to say, because each is an hour lost when
a UI stays quiet instead: a machine **nobody has probed** (not an empty list), a tool
that is **not installed**, a tool that is installed and **cannot read its own
transcripts**, and **when** the answer was read — discovery is one command per
machine, so it is explicit and dated rather than ambient. The conversation **id is
never typed and always reachable**: when an adapter breaks — and it will, `--resume`
and a vendor's home-directory layout are not a stable API — `claude --resume <id>` in
a terminal pane must still work. Rite is never the only way back to your own session.

### Splits: a plain divider by default, configurable beyond that

Splitting is a **terminal** feature, not an agent one, so it lives in `rite.js` and
both shells get it. **The split button splits — plainly, with no menu in the way**,
because that is what most people want from a divider and they should not pay for the
minority who want `top` on the right. Everything else sits behind a narrow chevron
beside it:

- **presets** — a name and a command, both the user's. Nothing is built in but the
  plain one;
- **snippets** — the existing library, because "run my saved command in the new pane"
  is the same intent as "open a preset";
- **layouts** — several panes at once, the *five terminals arranged like this* case.
  A layout arranges a whole **tab**, so its own button sits beside the tabs; the
  chevron keeps offering them, because someone who learned the chevron should not have
  to unlearn it.

### One document for how a workspace is set up

The presets and the layouts are **one document** — ADR 0023, amended by ADR 0027,
`docs/LAYOUTS.md`. `[[preset]]` is what the chevron offers, `[[layout]]` is the
morning: what opens, where on the screen (`split`, `size`, `of`, `tab`), and on which
machine.

It sits on one of **two supports**, and the surface decides which:

| Support | Where | Confidentiality |
|---|---|---|
| `~/.config/rite/layouts.toml` | the machine's filesystem | none needed — the reader's own disk |
| a sealed blob | the account, scoped by user | AES-256-GCM under the user's key |

A browser has no filesystem, so there it is the account's copy or nothing. A local vault
has no account to seal to, so there it is the file. Only a desktop window signed into a
server holds both, and `layoutSupport()` in `rite.js` is where that is decided —
`STATE.layoutSource` being this computer's own preference, which is why it is a device one
and does not travel. `STATE.layoutsOn` is the reader's switch, the second of ADR 0027's
three gates; the first is the instance's `layouts_policy`, which a mock has no server to
ask. `WORKSPACE_FILE` still answers "is there a FILE here", which picks the support rather
than deciding the feature exists.

**Settings ▸ Layouts leads with a card per layout** — what it opens, grouped by tab,
resolved against the library this computer actually has — with the two switches above it
and the editor button underneath. It used to be a heading and that button, so
the only answer to "what do I have" was behind a click and below a textarea. Each card
carries an **at startup** checkbox (not a radio: the file lets several open at once),
which splices `startup` into the file.

Every edit made from the UI **splices**: the preset dialog rewrites only the
`[[preset]]` blocks, the switch rewrites one key, and the comments, blank lines and
order someone chose come back untouched. The file editor is the exception and says so —
its textarea *is* the file, so Save stores the whole thing and ↻ Reload is there for
when something else has written since.

This is also where the mock converges on the app's architecture: `rite.js` carries a
tiny **pane-kind registry** (`registerPaneKind`), and `paneTabHTML` renders a tab
without ever branching on what a pane displays. A terminal tab and an agent tab are
the same structure, so a split, a preset or a layout is **one** feature rather than
two implementations of it — exactly what `apps/desktop/src/panes/registry.ts` buys in
the real client.

### A key means two things

Not where a file sits — **who may open a machine** (ADR 0028). Carried in the record, the
key's text is sealed inside it, so every member of the collection can open the machine and
its host sees one identity for all of them. Standing on each computer, the record holds a
path and no secret, so only a member who has that file *there* can open it and the host
records who did.

Carried is the default, being the only support that works everywhere. A path is read by
whichever process opens SSH — the member's own computer in a desktop window, the server's
container in a browser — so a path-record is **desktop-only**, and the mock's form says so
under the choice. A local vault has one support and no choice to offer, so none is drawn.

A key already stored **names itself**: its fingerprint, its algorithm, and *Replace…*. An
empty file input there read as "nothing was saved", which is how the real form behaved
until it was noticed.

### One pastille in the corner, for a vault as for an account

The right-hand end of the bar holds **one control** in both contexts: a round glyph, a
label, a small-caps chip and a chevron, opening a menu. A server session shows who is
signed in — avatar, name, role — with Settings and Sign out inside. A local vault shows
the one thing not already on screen: **whether it is open**. It deliberately does *not*
say the vault's name, because the context pill on the other side of the bar already does,
and the same fact twice on one bar is the duplication the nav exists to remove.

The local workspace used to carry a bare padlock and no way to reach Settings at all, so
the two contexts were two different ideas about what lives in that corner. Locking is now
a menu item, which costs a click a bare button did not — so `vault.lock` is a keyboard
command (`Mod+Shift+L`), named beside the item. Stepping away from the machine is a
keystroke rather than a click and an aim.

### An overlay page carries the nav

Teams, Collections and Notifications are **pages you travel between**, and their bar used
to hold a ✕ and your avatar and nothing else: Collections → Teams meant Close, then
finding the button you had just left. The bar is the emptiest one in the app, so the nav
rides along — **Terminals** / Teams / Collections / Administration + the bell.

The first entry *is* the way back, so **there is no Close any more**: a nav of four
destinations says where you are going, where a ✕ only says "not here". Esc still closes.
The workspace's own bar has no "Terminals" entry — it would name the page you are looking
at — which is the same rule as the one below.

The page you are on is **marked, not dropped**: hiding the current entry would shift the
others under the cursor on every hop. Two deliberate exceptions: the **inbox** page has no
bell (it *is* the inbox), and the **admin console** carries no nav at all — its own left
rail already says Teams and Collections, the organisation's rather than yours, and the
same two words twice on one screen is worse than a Close. Which is also why the console is
the one overlay that keeps its ✕.

### Skills, commands and hooks — read-only, on purpose

The product is the answer to **"what is actually in effect?"**, which no tool gives
you: the account layer (`~/.claude/…`) under the project layer (`.claude/…` in the
working directory), resolved on *that* host under *that* account. People answer it
today by sshing in and reading four files. Rite already knows the machine, the
account and the directory, so it is the one place that can answer it — and answering
it is worth more than owning the files.

Read-only is the **defensive** choice, not the timid one:

- a hook is not configuration, it is **a command that runs later, unattended**.
  Installing one from a convenience panel is the wrong blast radius for a convenience.
- on a **shared account** — a team's `deploy` on a dev VM — a hook one person installs
  runs for everyone who signs in. A tool that makes that *easy* is a lateral-movement
  vector; a tool that makes it *visible* is the opposite. The mock shows exactly that
  case, with the foreign hook marked.
- writing would make Rite a **second source of truth** for files that usually live in
  git or someone's dotfiles. The moment either side is touched by hand, nobody knows
  what runs.

Every row carries its **layer and its path**, because the answer to "why did that
happen?" is a file path — and a copy that loses to the project layer is shown *losing*
rather than hidden, since "why is my skill not applying" is answered by seeing the one
that was shadowed. Nothing read is stored: it is displayed and dropped, which keeps the
feature out of the zero-knowledge path instead of asking it for an exception.

**Editing happens where it already did.** *Open* puts the file in a terminal pane on
that machine, running `$EDITOR` under the account you already use there — no new right,
nothing to keep in sync. Rite navigates; the editor edits. That is the whole of "we
don't want to be the replacement for".

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
- `rite.js` carries the **pane-kind registry** (`registerPaneKind` / `paneTabHTML`),
  the **workspace file** (`parseLayoutFile`, the preset/startup splicers, the layout
  cards shared by Settings and the editor), and `paneActs()` —
  the split/detach/snippets/search/close chrome that belongs to a **pane**, not to what
  is inside it. A terminal and an agent session both draw from it, so neither can drift
  into a near-copy of the other.
- `agents.js` / `agents.css` — the **agent manager** (the view) and the **agent pane**,
  shared by both entry pages. Each page supplies `AGENT_SHELL` (`'desktop'` / `'web'`),
  which decides only one thing: whether your own machine can answer, or needs an attached
  client. Everything else — the machine → tool → conversation selector, the refusal on the
  server's own host, what a broken adapter says — is identical in both, on purpose.
  **Two things the code has settled since, and this file owes them**: the **detail panel**
  beside the list (the mock has a row menu and a mark dialog, no panel — and its order,
  facts and actions above a folded prompt, was decided on a machine holding seventy-three
  conversations), and **delete**, which the mock has nowhere. The rule runs both ways: the
  mock leads when it is ahead, and it is corrected from the code when the code has
  measured something the mock had not.
- `rite.css` — shared design tokens + components (dark, terminal-forward).
- `rite.js` — shared helpers (toast, modal, mini-terminal) + generic dialogs.
- `full-data.js` — mock data (org directory, teams, collections), extra icons, and
  `overlayNavHTML()` — the **one** Teams / Collections / Administration list, so the
  workspace bar and each overlay page's bar cannot disagree about what exists.

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
