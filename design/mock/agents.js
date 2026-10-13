/* Rite mock — the AI agent manager (shared by both shells, like machine.js).

   Two surfaces, and the split between them is the whole design:

     * the MANAGER is a VIEW, not a pane. It is a chooser — machine, then tool, then
       conversation — and a chooser has no context of its own. It lives where the
       machine dashboard lives, reached from the toolbar and closable from the tab
       strip, so resuming an agent leaves it exactly where you left it.
     * an AGENT SESSION is a PANE. It has a working directory, a transcript and a
       lifetime of its own, which is precisely the rule that decides pane vs menu.
       Resuming opens it in a NEW TAB — the same gesture connecting to a machine
       already uses, never a split the user did not ask for.

   Where an agent may run, and the one place it may not:

     * on a machine in the library, over SSH — works in BOTH shells, because that is
       just a session and Rite already has the transport for it;
     * on your own machine — native in the desktop shell; in a browser it needs an
       attached client, so the web shell says so instead of showing an empty list;
     * inside the Rite-Server container — NEVER. An agent is an arbitrary-code
       engine with write access; in the server's own process it would sit beside
       every user's encrypted blobs, the database and the admin's tokens. On a
       target machine it runs under the SSH account the user already had, so Rite
       grants no privilege it did not already have. This mock states the refusal on
       screen rather than leaving a silence someone fills in six months.

   Discovery costs one SSH round trip per machine, so it is explicit and dated: you
   pick a machine, it is probed, and the result carries the time it was read. A
   stale answer that says when it was taken beats a fresh-looking one that lies.

   Each page supplies: STATE, renderMain/renderSide, M, ICON, toast, floatMenu,
   showModal, machineByName, and AGENT_SHELL — 'desktop' or 'web'. */

/* ---- the tools we adapt to ----
   One adapter per tool, written expecting to break: `--resume <uuid>`, the paths
   under a vendor's home directory and the transcript format are not a stable API.
   The id the user never types is still the id they can always copy — when an
   adapter breaks, `claude --resume <id>` in a terminal pane must still work. Rite
   is never the only way back to your own session. */
const AGENT_TOOLS = [
  { id: 'claude', name: 'Claude Code', cmd: 'claude', resume: (id) => `claude --resume ${id}` },
  { id: 'codex', name: 'Codex CLI', cmd: 'codex', resume: (id) => `codex resume ${id}` },
  { id: 'gemini', name: 'Gemini CLI', cmd: 'gemini', resume: (id) => `gemini chat --session ${id}` },
];
const agentTool = (id) => AGENT_TOOLS.find((t) => t.id === id);

/* ---- what a probe of one machine came back with ----
   Keyed by machine name; a machine that is absent here has simply never been
   probed, which is a state of its own and not an empty list. Every awkward case a
   real fleet produces is represented on purpose: a tool that is not installed, a
   tool that is installed but whose transcripts cannot be read, and a host that
   answers nothing at all. */
const AGENT_PROBES = {
  'web-01': {
    at: '2 min ago',
    tools: [
      {
        id: 'claude', installed: true, version: '2.1.4',
        sessions: [
          { id: '3f1c9e7a-58b4-4c21-9d0e-7a6b2c4f8e11', project: 'acme/api', cwd: '/srv/acme/api',
            title: 'Fix the flaky migration test', last: '12 min ago', state: 'running', turns: 42 },
          { id: 'b7d2e4a1-90c6-4f38-8b15-3e9a0d6c2f77', project: 'acme/api', cwd: '/srv/acme/api',
            title: 'Port the queue worker to the new client', last: '3 h ago', state: 'idle', turns: 18 },
          { id: 'c0a51d93-2e77-4b06-91ff-5d4c8b7e3a20', project: 'acme/web', cwd: '/srv/acme/web',
            title: 'Add the dark theme toggle', last: 'yesterday', state: 'idle', turns: 7 },
        ],
      },
      { id: 'codex', installed: false },
      // Installed, reachable, and still unable to answer — the row says why instead
      // of vanishing. A session that disappears from a list costs an hour.
      { id: 'gemini', installed: true, version: '0.4.2', sessions: [],
        error: '~/.gemini/tmp is not readable by deploy (permission denied)' },
    ],
  },
  'stg-web': {
    at: '1 h ago',
    tools: [
      {
        id: 'claude', installed: true, version: '2.0.9',
        sessions: [
          { id: '9e4f7c02-1a83-4d55-b6e8-02c7f1a94b63', project: 'acme/api', cwd: '/srv/acme/api',
            title: 'Reproduce the staging 502', last: '1 h ago', state: 'idle', turns: 31 },
        ],
      },
      { id: 'codex', installed: false },
      { id: 'gemini', installed: false },
    ],
  },
  // Answers the probe and has nothing — different from never having been asked.
  'lb-01': { at: '5 min ago', tools: [{ id: 'claude', installed: false }, { id: 'codex', installed: false }, { id: 'gemini', installed: false }] },
};

/* Your own machine, in the desktop shell. Local agents run through client-execute,
   not SSH — the only difference the manager shows is the scope's subtitle. */
const AGENT_LOCAL = {
  at: 'just now',
  tools: [
    {
      id: 'claude', installed: true, version: '2.1.4',
      sessions: [
        { id: '41b9c8d7-6e52-4a19-83f0-9c1d5b2e7a44', project: 'rite', cwd: '~/Dev/projects/Rite',
          title: 'Mock the agent manager before building it', last: '4 min ago', state: 'running', turns: 63 },
        { id: '7c2e091a-4d6f-4b83-a50c-18e3f9d4b26a', project: 'rite', cwd: '~/Dev/projects/Rite',
          title: 'Register pane kinds instead of branching', last: '2 days ago', state: 'idle', turns: 95 },
      ],
    },
    { id: 'codex', installed: true, version: '1.3.0', sessions: [] },
    { id: 'gemini', installed: false },
  ],
};

/* ---- scopes: every machine an agent could run on, plus the one it may not ----
   Your own machine is listed in BOTH shells, and that is deliberate: a browser
   cannot spawn a process, so in the web UI the entry exists to carry the one real
   gap — attach a desktop client and it works. Leaving it out would make the gap
   silent, which is how a user concludes the feature is missing rather than
   unattached. */
function agentScopes() {
  const machines = [];
  if (typeof walk === 'function') {
    walk(typeof lib === 'function' ? lib() : LIB, (n) => {
      (n.conns || []).forEach((m) => machines.push({ id: m.name, kind: 'ssh', name: m.name, sub: `${m.user || 'user'}@${m.host || m.name}` }));
    });
  }
  const local = AGENT_SHELL === 'desktop'
    ? { id: '@local', kind: 'local', name: 'This machine', sub: 'alex@thinkpad · runs here, not over SSH' }
    : { id: '@local', kind: 'local', name: 'Your own machine', sub: 'needs an attached desktop client' };
  // The server's own host is offered so the refusal has somewhere to be read. It is
  // listed, and it is the one scope that never resumes anything.
  const server = { id: '@server', kind: 'server', name: 'Rite server host', sub: 'rite.acme.io · the container Rite itself runs in' };
  return [local, ...machines, server];
}
const agentScope = (id) => agentScopes().find((s) => s.id === id) || agentScopes()[0];

/* Where the manager opens. The desktop lands on this machine, which is where its
   user's agents usually are; the browser lands on the first machine that can
   actually answer, since its local entry is an explanation rather than a list. */
function agentDefaultScope() {
  if (AGENT_SHELL === 'desktop') return '@local';
  const machines = agentScopes().filter((s) => s.kind === 'ssh');
  const hasSessions = (s) => (agentProbeOf(s.id)?.tools || []).some((t) => (t.sessions || []).length);
  return (machines.find(hasSessions) || machines.find((s) => agentProbeOf(s.id)) || machines[0] || agentScopes()[0]).id;
}

/* The probe result for a scope, or null when it has never been asked. */
function agentProbeOf(id) {
  if (id === '@local') return AGENT_LOCAL;
  if (id === '@server') return null;             // never probed, and never will be
  return AGENT_PROBES[id] || null;
}

/* ---- the manager, as a view ---- */
function openAgents() {
  STATE.agentsView = true;
  STATE.agentScope = STATE.agentScope || agentDefaultScope();
  STATE.mainTab = 'agents';
  renderSide(); renderMain();
}
function closeAgents() {
  STATE.agentsView = false;
  STATE.mainTab = 'term';
  renderMain();
}

/* The manager and any resumed agent, in the tab strip. The manager is a view you
   can close like a machine dashboard; the agent is a tab of its own, because
   resuming opened one — it did not take the manager's place or split the pane the
   user was already in. */
function agentTabsHTML() {
  const mgr = STATE.agentsView
    ? `<div class="mtab ${STATE.mainTab === 'agents' ? 'on' : ''}" onclick="STATE.mainTab='agents';renderMain()">${M.agent} Agents
        <span class="x" onclick="event.stopPropagation();closeAgents()">✕</span></div>`
    : '';
  const pane = STATE.agentPane
    ? `<div class="mtab ${STATE.mainTab === 'agent' ? 'on' : ''}" onclick="STATE.mainTab='agent';renderMain()">${M.agent} ${STATE.agentPane.session.project}
        <span class="x" onclick="event.stopPropagation();closeAgentPane()">✕</span></div>`
    : '';
  return mgr + pane;
}
function agentPickScope(id) { STATE.agentScope = id; renderMain(); }
function agentProbeNow() {
  const sc = agentScope(STATE.agentScope);
  if (sc.kind === 'server') return;              // nothing to probe: see agentServerNote
  const p = agentProbeOf(sc.id);
  if (p) { p.at = 'just now'; toast(`Probed <span class="accent">${sc.name}</span> for agent sessions`); }
  else toast(`No agent CLI answered on <span class="accent">${sc.name}</span>`);
  renderMain();
}

/* The refusal, written where it is read. Not a "later" — a decision. */
function agentServerNote() {
  return `<div class="dnote" style="border-color:color-mix(in oklab,var(--amber) 35%,transparent)">${IC_INFO}<span>
    <b>Rite never runs an agent inside its own server container.</b> An agent executes
    arbitrary code and writes to disk; in the server's process it would sit beside every
    user's encrypted data, the database and administrator sessions. On a machine from your
    library it runs under the SSH account you already have, so Rite grants no access you did
    not already have — which is why that is the only place agents run.
    <br><br>Add this host to a collection like any other machine if you want agents on it:
    then it is your SSH account doing the work, not the server's.</span></div>`;
}

/* A conversation row. The id is never typed and always reachable: the row is read by
   project and intention, and the id waits behind the menu for the day an adapter
   breaks. */
function agentSessionRow(sc, tool, s) {
  const dot = s.state === 'running' ? 'up' : 'seen';
  return `<div class="arow">
    <span class="pst ${dot}" title="${s.state === 'running' ? 'Working now' : 'Idle — resumable'}"></span>
    <div class="ameta">
      <div class="atitle">${s.title}</div>
      <div class="asub mono">${s.project} · ${s.cwd} · ${s.turns} turns</div>
    </div>
    <span class="aage">${s.last}</span>
    <button class="btn btn-primary btn-sm" onclick="resumeAgent('${sc.id}','${tool.id}','${s.id}')">${ICON.play} Resume</button>
    <button class="btn btn-ghost btn-sm" title="More" onclick="agentRowMenu('${sc.id}','${tool.id}','${s.id}',event)">${EXICON.more}</button>
  </div>`;
}
function agentRowMenu(scopeId, toolId, sessionId, e) {
  const tool = agentTool(toolId);
  floatMenu(e, [
    { icon: ICON.play, label: 'Resume here', onclick: () => resumeAgent(scopeId, toolId, sessionId) },
    { icon: EXICON.split, label: 'Resume in a new window', onclick: () => { resumeAgent(scopeId, toolId, sessionId); openInNewWindow(tool.name); } },
    { icon: M.edit, label: 'Copy conversation id', onclick: () => agentCopyId(sessionId) },
    { icon: ICON.term, label: 'Copy the resume command', onclick: () => agentCopyCmd(tool, sessionId) },
  ]);
}
function agentCopyId(id) { toast(`Conversation id copied — <span class="mono">${id}</span>`); }
function agentCopyCmd(tool, id) { toast(`Copied — <span class="mono">${tool.resume(id)}</span>`); }

/* One tool on one machine. Three outcomes, all of them visible: sessions, not
   installed, or installed and unable to answer. */
function agentToolBlock(sc, probeTool) {
  const tool = agentTool(probeTool.id);
  if (!probeTool.installed) {
    return `<div class="dcard atool off">
      <div class="dcard-h">${M.agent}<span class="dcard-t">${tool.name}</span><span style="flex:1"></span>
        <span class="muted" style="font-size:12px">not installed on ${sc.name}</span></div></div>`;
  }
  const sessions = probeTool.sessions || [];
  let body;
  if (probeTool.error) {
    body = `<div class="anote">${IC_INFO}<span><b>${tool.name} is installed but its sessions could not be read.</b>
      <span class="mono">${probeTool.error}</span> — the tool is there, so this is a permission to fix, not an absence.</span></div>`;
  } else if (!sessions.length) {
    body = `<p class="muted" style="font-size:12.5px;margin:0">No conversation yet on this machine.</p>`;
  } else {
    body = sessions.map((s) => agentSessionRow(sc, tool, s)).join('');
  }
  return `<div class="dcard atool">
    <div class="dcard-h">${M.agent}<span class="dcard-t">${tool.name}</span>
      <span class="chip-sm">${probeTool.version}</span>
      ${sessions.length ? `<span class="muted" style="font-size:12px">${sessions.length} conversation${sessions.length > 1 ? 's' : ''}</span>` : ''}
      <span style="flex:1"></span>
      <button class="btn btn-ghost btn-sm" onclick="dlgNewAgent('${sc.id}','${tool.id}')">${ICON.plus} New</button></div>
    <div class="alist">${body}</div></div>`;
}

/* The view itself: scope first, because discovery is per-machine and costs a round
   trip; then the tools; then their conversations. */
function agentsViewHTML() {
  const sc = agentScope(STATE.agentScope);
  const probe = agentProbeOf(sc.id);
  const opts = agentScopes().map((s) =>
    `<option value="${s.id}" ${s.id === sc.id ? 'selected' : ''}>${s.name}${s.kind === 'ssh' ? ' — ' + s.sub : ''}</option>`).join('');
  // A local scope in a browser can never answer, so it never claims to have been read.
  const readable = sc.kind === 'ssh' || (sc.kind === 'local' && AGENT_SHELL === 'desktop');

  let body;
  if (sc.kind === 'server') {
    body = agentServerNote();
  } else if (sc.kind === 'local' && AGENT_SHELL === 'web') {
    body = `<div class="dnote">${IC_INFO}<span><b>Your own machine is not reachable from a browser.</b>
      Attach the Rite desktop client to this server and its agents appear here. Agents on the
      machines in your library need nothing — they run over SSH, the same way their terminals do.</span></div>`;
  } else if (!probe) {
    body = `<div class="aempty">
      <div class="muted" style="font-size:13px;line-height:1.6;max-width:520px">
        <b>${sc.name} has not been probed yet.</b><br>
        Looking for agent sessions runs one command on the machine, so Rite asks before it does it —
        and tells you when the answer was read, not just what it said.</div>
      <button class="btn btn-primary btn-sm" onclick="agentProbeNow()">${M.refresh} Probe ${sc.name}</button></div>`;
  } else {
    body = probe.tools.map((t) => agentToolBlock(sc, t)).join('');
  }

  return `<div class="mdash">
    <div class="mdash-hd">
      <span style="color:var(--purple);display:grid;place-items:center">${M.agent}</span>
      <div class="mdash-id"><div class="mdash-name">Agents</div>
        <div class="mdash-sub">Pick the machine, then the tool, then the conversation.</div></div>
      <span style="flex:1"></span>
      <div class="sel-input">${M.machine}<select onchange="agentPickScope(this.value)">${opts}</select></div>
      ${probe && readable ? `<span class="muted" style="font-size:12px" title="Discovery is one command over SSH — it is read when you ask, not continuously">read ${probe.at}</span>
        <button class="btn btn-ghost btn-sm" onclick="agentProbeNow()">${M.refresh} Probe again</button>` : ''}
    </div>
    <div class="dgrid">${body}</div>
    <div class="mdash-foot">${IC_INFO}<span>Agents run on the machine you picked, under the SSH account you already use
      there — never inside the Rite server. Resuming opens a pane in a new tab; this list stays where it is.</span></div>
  </div>`;
}

/* ---- resuming: a pane, in a new tab ---- */
function resumeAgent(scopeId, toolId, sessionId) {
  const sc = agentScope(scopeId);
  const probe = agentProbeOf(scopeId);
  const pt = probe && probe.tools.find((t) => t.id === toolId);
  const s = pt && (pt.sessions || []).find((x) => x.id === sessionId);
  if (!s) return;
  // The user never typed the id, and never will — the adapter builds the command.
  STATE.agentPane = { scope: sc, tool: agentTool(toolId), session: s };
  STATE.mainTab = 'agent';
  renderMain();
  toast(`${M.agent} <span class="accent">${s.project}</span> resumed on ${sc.name} — new tab`);
}
function closeAgentPane() { STATE.agentPane = null; STATE.mainTab = STATE.agentsView ? 'agents' : 'term'; renderMain(); }


/* The pane shows the REAL CLI, not a chat interface rebuilt over it. What Rite adds
   is the header — machine, tool, project, working directory, state — and the
   lifetime. A reimplemented conversation UI would pin the one thing a vendor
   changes without notice, which is the mistake ADR 0003 already paid for once. */
function agentPaneHTML(p) {
  const { scope, tool, session } = p;
  const I = (d) => `<svg class="icon" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const grip = `<div class="grip" title="Drag to reorganize pane"><div class="gr"><i></i><i></i></div><div class="gr"><i></i><i></i></div><div class="gr"><i></i><i></i></div></div>`;
  const where = scope.kind === 'local' ? 'on this machine' : `on ${scope.name}`;
  return `<div class="termpane">
    <div class="termpane-hdr">
      <div class="who">
        <span class="st" style="background:var(--purple)"></span>
        <span class="name">${session.project}</span>
        <span class="chip-sm" style="color:var(--purple)">${tool.name}</span>
        <span class="muted" style="font-size:12px">${where} · ${session.cwd}</span>
      </div>
      <div class="termpane-acts">
        ${grip}
        <button title="Conversation id — ${session.id}" onclick="agentCopyId('${session.id}')">${I('M8 4h10a2 2 0 012 2v10M6 8h10a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2z')}</button>
        <button title="Split horizontal (Ctrl+Shift+H)">${I('M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4m10-2V6a2 2 0 00-2-2h-4')}</button>
        <button title="Detach to new window" onclick="openInNewWindow('${session.project}')">${I('M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14')}</button>
        <button title="Close agent pane" onclick="closeAgentPane()">${I('M6 18L18 6M6 6l12 12')}</button>
      </div>
    </div>
    <div class="term-body scroll">
      <div class="ln di"># ${tool.resume(session.id)}</div>
      <div class="ln di">${tool.name} · resumed · ${session.turns} turns · ${session.cwd}</div>
      <div class="ln"><span class="pr">▸</span> ${session.title}</div>
      <div class="ln di">  Reading src/queue/worker.ts…</div>
      <div class="ln di">  Edited 2 files, ran the suite — 41 passed, 1 failed.</div>
      <div class="ln"><span class="pr">❯</span> <span class="cursor"></span></div>
    </div>
  </div>`;
}

/* Starting a new agent asks for the one thing it cannot guess — where it works. The
   context is seeded from there rather than pasted in by hand. */
function dlgNewAgent(scopeId, toolId) {
  const sc = agentScope(scopeId), tool = agentTool(toolId);
  showModal({
    title: `New ${tool.name} agent`, subtitle: `on ${sc.name}`, confirm: 'Start',
    body: `<label class="field"><span>Working directory</span><input class="inp mono" id="na-cwd" value="/srv/acme/api"></label>
      <p class="muted" style="font-size:12px;margin:2px 0 0;line-height:1.55">The agent starts with this directory as its context — the project, its git state and
      the machine it runs on are passed for you. You are not pasting a prompt to tell it where it is.</p>`,
    onConfirm: (m) => { toast(`${tool.name} started in <span class="mono">${m.querySelector('#na-cwd').value}</span> on ${sc.name}`); },
  });
}
