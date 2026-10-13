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
  { id: 'claude', name: 'Claude Code', bin: 'claude', on: true,
    list: 'ls ~/.claude/projects/*/*.jsonl', resumeFmt: 'claude --resume {id}' },
  { id: 'codex', name: 'Codex CLI', bin: 'codex', on: true,
    list: 'codex sessions --json', resumeFmt: 'codex resume {id}' },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini', on: true,
    list: 'ls ~/.gemini/tmp', resumeFmt: 'gemini chat --session {id}' },
];
const agentTool = (id) => AGENT_TOOLS.find((t) => t.id === id);
const agentResume = (tool, id) => (tool.resumeFmt || '{id}').replace('{id}', id);

/* Which adapters are switched on. An adapter is yours, not a machine's: the binary
   may be missing on one host and present on the next, and that is what the probe
   reports — so the list is configured once and detection answers per machine. */
const agentEnabled = () => AGENT_TOOLS.filter((t) => t.on);

/* Teaching Rite about another CLI is two commands: how to list its conversations
   and how to resume one. Nothing else about a vendor is depended on — that is the
   whole adapter boundary, kept small because it is written expecting to break. */
function dlgAgentTools() {
  const row = (t) => `<label class="mrow" style="align-items:flex-start" onclick="agentToggleTool('${t.id}',this)">
      <span class="chk ${t.on ? 'on' : ''}" style="margin-top:3px">${t.on ? '✓' : ''}</span>
      <div class="grow"><div class="title" style="font-weight:600">${t.name} <span class="muted mono" style="font-weight:400">${t.bin}</span></div>
        <div class="sub mono" style="font-size:11.5px;color:var(--fg-dim);line-height:1.6">list &nbsp;${t.list}<br>resume &nbsp;${t.resumeFmt}</div></div></label>`;
  showModal({
    title: 'Agent CLIs', subtitle: 'Which tools Rite looks for, and how it talks to each', wide: true, confirm: 'Done',
    body: `<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:14px">${AGENT_TOOLS.map(row).join('')}</div>
      <div class="sec"><span class="eyebrow">Add a CLI</span><span class="line"></span></div>
      <label class="field"><span>Name</span><input class="inp" id="at-name" placeholder="e.g. Aider"></label>
      <label class="field"><span>Binary</span><input class="inp mono" id="at-bin" placeholder="aider"></label>
      <label class="field"><span>Command that lists its conversations</span><input class="inp mono" id="at-list" placeholder="ls ~/.aider/sessions"></label>
      <label class="field"><span>Command that resumes one</span><input class="inp mono" id="at-resume" placeholder="aider --restore {id}"></label>
      <p class="muted" style="font-size:12px;margin:2px 0 0;line-height:1.55"><b>{id}</b> is where the conversation id goes — you never type it, and the adapter never
      asks you to. These two commands are the <i>entire</i> contract with a tool: a vendor changing
      its flags or its file layout breaks this adapter and nothing else.</p>`,
    onConfirm: (m) => {
      const g = (k) => (m.querySelector('#at-' + k).value || '').trim();
      if (!g('name') || !g('bin')) return;             // nothing typed — just close
      AGENT_TOOLS.push({ id: g('bin'), name: g('name'), bin: g('bin'), on: true,
        list: g('list') || `which ${g('bin')}`, resumeFmt: g('resume') || `${g('bin')} {id}` });
      toast(`<span class="accent">${g('name')}</span> added — probe a machine to see if it is installed there`);
      renderMain();
    },
  });
}
function agentToggleTool(id, el) {
  const t = agentTool(id); if (!t) return;
  t.on = !t.on;
  const c = el.querySelector('.chk');
  c.classList.toggle('on', t.on); c.textContent = t.on ? '✓' : '';
  renderMain();
}

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

/* The manager and any resumed agent, in the tab strip.
   They must not look alike, and they used to: both wore the robot and nothing said
   which one held panes. A tab that holds a VIEW now carries `.view` — outlined,
   not filled — and a tab that holds panes keeps the terminal's own look and icon.
   The agent tab shows how many panes are in it, because by then it may hold a
   `top` and a `watch docker ps` as well. */
function agentTabsHTML() {
  const mgr = STATE.agentsView
    ? `<div class="mtab view ${STATE.mainTab === 'agents' ? 'on' : ''}" onclick="STATE.mainTab='agents';renderMain()">${M.agent} Agents
        <span class="x" onclick="event.stopPropagation();closeAgents()">✕</span></div>`
    : '';
  const t = STATE.agentTab;
  const pane = t
    ? `<div class="mtab ${STATE.mainTab === 'agent' ? 'on' : ''}" onclick="STATE.mainTab='agent';renderMain()">${ICON.term} ${t.panes[0].session.project}
        ${t.panes.length > 1 ? `<span class="chip-sm" title="${t.panes.length} panes in this tab">${t.panes.length}</span>` : ''}
        <span class="x" onclick="event.stopPropagation();closeAgentPane()">✕</span></div>`
    : '';
  return mgr + pane;
}
function agentPickScope(id) { STATE.agentScope = id; renderMain(); }

/* Open the manager already pointed at one machine. A menu is a fine switcher and a
   poor finder: with a real fleet you look a machine up where you always do — the
   library — and come at its agents from its dashboard, the way you come at its
   containers. */
function openAgentsOn(name) { STATE.agentScope = name; openAgents(); }

/* The scope picker is a themed menu, not a native <select>: an OS dropdown paints
   its own list in its own colours and lands a white panel in the middle of a dark
   app. It also lets each entry carry its subtitle, which is where the local row in
   a browser says why it cannot answer. */
function agentScopeMenu(e) {
  e.stopPropagation();
  floatMenu(e, agentScopes().map((s) => ({
    icon: s.kind === 'local' ? ICON.term : s.kind === 'server' ? ICON.server : M.machine,
    label: `${s.name}<div class="sub mono" style="font-size:11px;color:var(--muted);font-weight:400">${s.sub}</div>`,
    onclick: () => agentPickScope(s.id),
  })));
}
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
function agentCopyCmd(tool, id) { toast(`Copied — <span class="mono">${agentResume(tool, id)}</span>`); }

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
    const on = new Set(agentEnabled().map((t) => t.id));
    const known = probe.tools.filter((t) => on.has(t.id));
    // An adapter added after the last probe has simply not been looked for yet.
    const unprobed = agentEnabled().filter((t) => !probe.tools.some((p) => p.id === t.id));
    body = known.map((t) => agentToolBlock(sc, t)).join('')
      + unprobed.map((t) => `<div class="dcard atool off"><div class="dcard-h">${M.agent}<span class="dcard-t">${t.name}</span>
          <span style="flex:1"></span><span class="muted" style="font-size:12px">added since the last probe — probe again to look for it</span></div></div>`).join('');
  }

  return `<div class="mdash">
    <div class="mdash-hd">
      <span style="color:var(--purple);display:grid;place-items:center">${M.agent}</span>
      <div class="mdash-id"><div class="mdash-name">Agents</div>
        <div class="mdash-sub">Pick the machine, then the tool, then the conversation.</div></div>
      <span style="flex:1"></span>
      <button class="btn btn-sm" onclick="agentScopeMenu(event)" title="Choose the machine to look on">${M.machine} ${sc.name} ${EXICON.chevD}</button>
      <button class="btn btn-ghost btn-sm" onclick="dlgAgentTools()" title="Which agent CLIs Rite looks for">${EXICON.gear} Tools</button>
      ${probe && readable ? `<span class="muted" style="font-size:12px" title="Discovery is one command over SSH — it is read when you ask, not continuously">read ${probe.at}</span>
        <button class="btn btn-ghost btn-sm" onclick="agentProbeNow()">${M.refresh} Probe again</button>` : ''}
    </div>
    <div class="dgrid">${body}</div>
    <div class="mdash-foot">${IC_INFO}<span>Agents run on the machine you picked, under the SSH account you already use
      there — never inside the Rite server. Resuming opens a pane in a new tab; this list stays where it is.</span></div>
  </div>`;
}

/* ---- resuming: a pane in a new tab, in the ordinary split tree ----
   The agent is a leaf like any other, which is the point of the pane-kind registry:
   it splits with plain terminals in the same tab, so you can keep `watch docker ps`
   or `top` beside the agent that is causing them. The tab holds a list of panes and
   a focused index — the mock's stand-in for the tree the app already has. */
function resumeAgent(scopeId, toolId, sessionId) {
  const sc = agentScope(scopeId);
  const probe = agentProbeOf(scopeId);
  const pt = probe && probe.tools.find((t) => t.id === toolId);
  const s = pt && (pt.sessions || []).find((x) => x.id === sessionId);
  if (!s) return;
  // The user never typed the id, and never will — the adapter builds the command.
  STATE.agentTab = { panes: [{ kind: 'agent', scope: sc, tool: agentTool(toolId), session: s }], focus: 0 };
  STATE.mainTab = 'agent';
  renderMain();
  toast(`${M.agent} <span class="accent">${s.project}</span> resumed on ${sc.name} — new tab`);
}
function agentFocusPane(i) { if (STATE.agentTab) { STATE.agentTab.focus = i; renderMain(); } }
function closeAgentTabPane(i) {
  const t = STATE.agentTab; if (!t) return;
  t.panes.splice(i, 1);
  if (!t.panes.length) return closeAgentPane();
  t.focus = Math.min(t.focus, t.panes.length - 1);
  renderMain();
}
function closeAgentPane() { STATE.agentTab = null; STATE.mainTab = STATE.agentsView ? 'agents' : 'term'; renderMain(); }

/* What lands beside an agent. Every one of these is an ORDINARY terminal pane on
   the same machine — not a third kind of surface — which is exactly why an agent
   had to be a leaf of the normal tree rather than a tab of its own. */
function agentSplitMenu(e) {
  e.stopPropagation();
  const t = STATE.agentTab; if (!t) return;
  const sc = t.panes[0].scope;
  const host = sc.kind === 'local' ? null : sc.sub;
  const add = (p) => { t.panes.push(p); t.focus = t.panes.length - 1; renderMain(); };
  floatMenu(e, [
    { icon: ICON.term, label: `Terminal on ${sc.name}`, onclick: () => add({ kind: 'term', host }) },
    { icon: M.docker, label: 'watch docker ps', onclick: () => add({ kind: 'term', host, name: 'watch docker ps',
        cmd: 'watch -n2 docker ps', lines: ['NAMES     STATUS          PORTS', 'api       Up 3 days       8080->8080', 'worker    Up 3 days', 'redis     Up 8 days       6379->6379'] }) },
    { icon: M.refresh, label: 'top', onclick: () => add({ kind: 'term', host, name: 'top',
        cmd: 'top -b -n1', lines: ['load average: 0.84, 0.61, 0.55', '  PID USER      %CPU  %MEM  COMMAND', ' 4812 deploy     7.4   2.1  node', ' 1190 deploy     2.0   0.8  claude'] }) },
  ]);
}

/* The agent tab: panes side by side, with the same divider a terminal split uses.
   A pane here is the agent or a terminal; both carry the same chrome, because the
   chrome comes from `paneActs` in rite.js rather than from either of them. */
function agentTabHTML() {
  const t = STATE.agentTab;
  if (!t || !t.panes.length) return '';
  const cells = t.panes.map((p, i) => {
    const inner = p.kind === 'agent' ? agentPaneHTML(p, i) : termHTML(p.host, { name: p.name, cmd: p.cmd, lines: p.lines, close: `closeAgentTabPane(${i})` });
    return `${i ? '<div class="pdiv" title="Drag to resize"><i></i></div>' : ''}
      <div class="pane-wrap ${i === t.focus ? 'focused' : ''}" style="flex:1" onclick="agentFocusPane(${i})">${inner}</div>`;
  }).join('');
  return `<div class="psplit">${cells}</div>`;
}


/* The pane shows the REAL CLI, not a chat interface rebuilt over it. What Rite adds
   is the header — machine, tool, project, working directory, state — and the
   lifetime. A reimplemented conversation UI would pin the one thing a vendor
   changes without notice, which is the mistake ADR 0003 already paid for once. */
function agentPaneHTML(p, i) {
  const { scope, tool, session } = p;
  const I = (d) => `<svg class="icon" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const where = scope.kind === 'local' ? 'on this machine' : `on ${scope.name}`;
  // The only button that is the agent's own: the id it never made you type.
  const copyId = `<button title="Conversation id — ${session.id}" onclick="agentCopyId('${session.id}')">${I('M8 4h10a2 2 0 012 2v10M6 8h10a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2z')}</button>`;
  return `<div class="termpane agentpane">
    <div class="termpane-hdr">
      <div class="who">
        <span class="st" style="background:var(--purple)"></span>
        <span class="name">${session.project}</span>
        <span class="chip-sm" style="color:var(--purple)">${tool.name}</span>
        <span class="muted" style="font-size:12px">${where} · ${session.cwd}</span>
      </div>
      <div class="termpane-acts">${paneActs({
        lead: copyId,
        splitH: 'agentSplitMenu(event)',
        splitV: 'agentSplitMenu(event)',
        detach: `openInNewWindow('${session.project}')`,
        detachTitle: 'Detach to a new window',
        snippets: `openSnippets(${scope.kind === 'local' ? 'null' : `'${scope.sub}'`})`,
        close: `closeAgentTabPane(${i})`,
        closeTitle: 'Close agent pane',
      })}</div>
    </div>
    <div class="term-body scroll">
      <div class="ln di"># ${agentResume(tool, session.id)}</div>
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
