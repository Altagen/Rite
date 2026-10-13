/* Shared mock data + dialogs + helpers for the Rite UX prototypes. */
const DATA = {
  vaults: [
    { id:'v1', name:'Perso', file:'~/.local/share/rite/perso.db', badge:'v1', locked:true, conns:[
      {name:'Homelab', host:'192.168.1.10', user:'alex', port:22},
      {name:'NAS', host:'nas.local', user:'admin', port:22},
    ]},
    { id:'v2', name:'Client Acme', file:'~/work/acme-vault.db', badge:'v2', locked:false, conns:[
      {name:'Prod web', host:'10.0.0.5', user:'deploy', port:22},
      {name:'Prod db', host:'10.0.0.6', user:'dba', port:2222},
      {name:'Bastion', host:'bastion.acme.io', user:'alex', port:22},
    ]},
  ],
  servers: [
    { id:'s1', name:'Rite Team', url:'https://rite.acme.io', badge:'s1', online:true, conns:[
      {name:'CI runner', host:'ci.acme.io', user:'runner', port:22},
      {name:'Staging', host:'stg.acme.io', user:'deploy', port:22},
    ]},
    { id:'s2', name:'Perso VPS', url:'https://vps.example.com', badge:'s2', online:true, conns:[
      {name:'edge-01', host:'vps.example.com', user:'root', port:22},
    ]},
  ],
};

const ICON = {
  plus:'<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  term:'<svg class="icon" viewBox="0 0 24 24"><path d="M4 5h16v14H4z" opacity=".0"/><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  bolt:'<svg class="icon" viewBox="0 0 24 24"><path d="M13 2L4.5 13H11l-1 9 8.5-11H12l1-9z"/></svg>',
  lock:'<svg class="icon" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>',
  server:'<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  win:'<svg class="icon" viewBox="0 0 24 24"><path d="M9 9h11v11H9zM4 4h11v3M4 4v11h3"/></svg>',
  folder:'<svg class="icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
  chevron:'<svg class="icon" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  play:'<svg class="icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
};

function toast(html){
  let t=document.querySelector('.toast'); if(!t){t=document.createElement('div');t.className='toast';document.body.appendChild(t);}
  t.innerHTML=html; t.classList.add('show'); clearTimeout(t._to); t._to=setTimeout(()=>t.classList.remove('show'),2600);
}

function showModal({title,subtitle,body,confirm='Confirm',onConfirm,wide,width}){
  const bd=document.createElement('div'); bd.className='backdrop show';
  const mw=width?`style="max-width:${width}"`:(wide?'style="max-width:520px"':'');
  bd.innerHTML=`<div class="modal" ${mw}>
    <header><h3>${title}</h3>${subtitle?`<p>${subtitle}</p>`:''}</header>
    <div class="body">${body}</div>
    <div class="foot"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" data-ok>${confirm}</button></div>
  </div>`;
  document.body.appendChild(bd);
  const close=()=>bd.remove();
  bd.addEventListener('click',e=>{if(e.target===bd)close();});
  bd.querySelector('[data-x]').onclick=close;
  bd.querySelector('[data-ok]').onclick=()=>{ if(!onConfirm||onConfirm(bd)!==false) close(); };
  const first=bd.querySelector('input,select'); if(first)setTimeout(()=>first.focus(),30);
  bd.querySelectorAll('input').forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')bd.querySelector('[data-ok]').click();}));
  // live strength meter
  const pw=bd.querySelector('[data-pw]'), meter=bd.querySelector('.strength>i');
  if(pw&&meter)pw.addEventListener('input',()=>{const s=Math.min(100,pw.value.length*12);meter.style.width=s+'%';meter.style.background=s<40?'#f7768e':s<70?'#e5b567':'#9ece6a';});
  return bd;
}

/* ================= Snippets (Wave-1) =================
   Reusable commands you run in a session — on one pane, or broadcast to every
   open pane. A personal library (cross-shell). Running = sending the command +
   Enter to the session's stdin (no core needed: reuses send_terminal_input). */
let SNIPPETS = [
  { id:'s1', name:'Tail syslog',        command:'sudo tail -f /var/log/syslog' },
  { id:'s2', name:'Disk usage',         command:'df -h' },
  { id:'s3', name:'Running containers', command:'docker ps' },
  { id:'s4', name:'Failed units',       command:'systemctl --failed' },
  // Multiline: each line runs after the previous one (no && needed).
  { id:'s5', name:'Deploy check',       command:'git pull\nnpm ci\nnpm run build\nsystemctl restart app' },
];
// Non-empty command lines of a snippet (the units run one after another).
function snipLines(s){return (s.command||'').split('\n').map(x=>x.trim()).filter(Boolean);}
function snipBody(host){
  const rows = SNIPPETS.map((s,i)=>{const L=snipLines(s);const preview=L[0]||'';const extra=L.length>1?` <span class="muted">+${L.length-1}</span>`:'';
    return `<div class="snip-row">
    <div class="snip-meta"><div class="snip-name">${s.name}${L.length>1?` <span class="snip-count" title="${L.length} commands, run one after another">${L.length} cmds</span>`:''}</div><code class="snip-cmd">${preview}${extra}</code></div>
    <button class="btn btn-ghost btn-sm" data-snip-run="${i}" title="Run on this pane">Run</button>
    <button class="btn btn-ghost btn-sm" data-snip-all="${i}" title="Broadcast to every open pane">${'⇉'}</button>
    <button class="btn btn-ghost btn-sm" data-snip-del="${i}" title="Delete">✕</button>
  </div>`;}).join('') || `<p class="muted" style="font-size:13px;margin:2px 0 12px">No snippets yet — add one below.</p>`;
  return `<p class="muted" style="font-size:12px;margin:0 0 10px">Run a saved command on <b>${host?host:'this pane'}</b> (Run) or on <b>every open pane</b> (⇉). Multiple lines run <b>one after another</b> (no <code style="font-family:ui-monospace,monospace">&amp;&amp;</code> needed). Runs client-side — just typed into the session.</p>
    <div class="snip-list">${rows}</div>
    <div class="snip-add">
      <label class="field"><span>Name</span><input class="inp" id="snip-name" placeholder="Deploy check"></label>
      <label class="field"><span>Command <span class="muted" style="font-weight:400">· one per line</span></span><textarea class="inp mono" id="snip-cmd" rows="3" spellcheck="false" style="resize:vertical;min-height:66px;line-height:1.6" placeholder="git pull&#10;npm ci&#10;npm run build"></textarea></label>
      <div class="snip-add-foot"><button class="btn btn-primary btn-sm" data-snip-add>Add snippet</button></div>
    </div>`;
}
function openSnippets(host){
  const bd=showModal({title:'Snippets',subtitle:host?('run on '+host):'run on this pane',wide:true,confirm:'Done',body:snipBody(host)});
  const body=bd.querySelector('.body');
  const ran=(s,where)=>{const n=snipLines(s).length;return `Ran <span class="accent">${s.name}</span>${n>1?` (${n} commands)`:''} on ${where}`;};
  body.addEventListener('click',e=>{const t=e.target.closest('[data-snip-run],[data-snip-all],[data-snip-del],[data-snip-add]');if(!t)return;
    if(t.dataset.snipRun!==undefined){const s=SNIPPETS[+t.dataset.snipRun];toast(ran(s,host||'this pane'));}
    else if(t.dataset.snipAll!==undefined){const s=SNIPPETS[+t.dataset.snipAll];toast(ran(s,'every open pane'));}
    else if(t.dataset.snipDel!==undefined){SNIPPETS.splice(+t.dataset.snipDel,1);body.innerHTML=snipBody(host);}
    else if(t.dataset.snipAdd!==undefined){const n=(body.querySelector('#snip-name').value||'').trim(),c=(body.querySelector('#snip-cmd').value||'').replace(/\n+$/,'');
      if(!n||!c.trim()){toast('Give the snippet a name and at least one command');return;}
      SNIPPETS.push({id:'s'+Math.random().toString(36).slice(2,7),name:n,command:c});body.innerHTML=snipBody(host);}
  });
}

/* ---- shared dialogs (same across the 3 directions) ---- */
function dlgUnlock(vault,done){
  showModal({title:`Unlock “${vault.name}”`,subtitle:vault.file,
    body:`<label class="field"><span>Master password</span><input class="inp" type="password" placeholder="••••••••••" autofocus></label>`,
    confirm:'Unlock',onConfirm:()=>{vault.locked=false;toast(`<span class="accent">${vault.name}</span> unlocked`);done&&done();}});
}
function dlgNewVault(done){
  showModal({title:'New local vault',subtitle:'A named encrypted database on this machine.',
    body:`<label class="field"><span>Name</span><input class="inp" placeholder="e.g. Client Beta"></label>
      <label class="field"><span>File location</span>
        <div style="display:flex;gap:8px"><input class="inp" value="~/.local/share/rite/beta.db"><button class="btn btn-sm" onclick="toast('File picker…')">Browse…</button></div></label>
      <label class="field"><span>Master password</span><input class="inp" data-pw type="password" placeholder="Create a strong password"><div class="strength"><i></i></div></label>`,
    confirm:'Create & open',onConfirm:(m)=>{const n=m.querySelector('input').value||'New vault';toast(`Vault <span class="accent">${n}</span> created`);done&&done(n);}});
}
function dlgAddServer(done){
  showModal({title:'Add a server',subtitle:'A Rite server holds team & personal connections (its own login).',
    body:`<label class="field"><span>Server URL</span><input class="inp" placeholder="https://rite.example.com"></label>
      <label class="field"><span>Label (optional)</span><input class="inp" placeholder="Team"></label>`,
    confirm:'Add',onConfirm:(m)=>{const u=m.querySelectorAll('input')[0].value||'server';toast(`Server <span class="accent">${u}</span> added`);done&&done();}});
}
function dlgOpenVaultFile(done){
  showModal({title:'Open a vault file',subtitle:'Pick an existing .db, or create a new one.',
    body:`<div class="card" style="padding:6px">
      ${['~/.local/share/rite/perso.db','~/work/acme-vault.db','~/archive/2024.db'].map(f=>`<div class="row" onclick="this.closest('.backdrop').remove();toast('Opening <span class=accent>'+'${f.split('/').pop()}'+'</span>')">${ICON.folder}<div class="grow"><div class="title mono" style="font-size:13px">${f.split('/').pop()}</div><div class="sub">${f}</div></div>${ICON.chevron}</div>`).join('')}
    </div><div style="margin-top:10px"><button class="btn btn-sm" onclick="toast('Native file picker…')">${ICON.folder} Browse the filesystem…</button></div>`,
    confirm:'Close',onConfirm:()=>{done&&done();}});
}
function dlgQuickSSH(){
  showModal({title:'⚡ Quick SSH',subtitle:'Connect once — nothing is saved.',
    body:`<label class="field"><span>Host</span><input class="inp" placeholder="user@host  or  host"></label>
      <div style="display:flex;gap:10px"><label class="field" style="flex:1"><span>Port</span><input class="inp" value="22"></label>
      <label class="field" style="flex:2"><span>Password</span><input class="inp" type="password" placeholder="••••••"></label></div>`,
    confirm:'Connect',onConfirm:()=>{toast('Opening SSH session…');}});
}
function openInNewWindow(name){toast(`${ICON.win} <span class="accent">${name}</span> opened in a new window`);}

/* ================= panes: kinds, splits, layouts =================

   The mock's version of apps/desktop/src/panes/registry.ts. One renderer per kind,
   registered by name, so the tab renderer below never branches on what a pane
   displays — and an agent pane and a terminal pane genuinely live in one tree
   instead of each owning a tab.

   The split itself is a TERMINAL feature, not an agent one. Most people want a
   plain divider, so a plain divider is what the split button does; everything else
   lives behind the chevron beside it, and all of it is the user's to configure. */
const PANE_KINDS = {};
function registerPaneKind(type, render){ PANE_KINDS[type] = render; }
registerPaneKind('term', (p,i) => termHTML(p.host, { name:p.name, cmd:p.cmd, lines:p.lines, close:`closePaneAt(${i})` }));

/* What a split can open. `plain` is first and is the default action: the preset list
   is for the minority who want `top` on the right, not a tax on everyone else.
   Name and command are both the user's — nothing here is built in but the plain one. */
let SPLIT_PRESETS = [
  { id:'plain',    name:'Terminal',   command:'', builtin:true },
  { id:'p-load',   name:'Load',       command:'top' },
  { id:'p-disk',   name:'Disk',       command:'df -h' },
];
/* A layout opens several panes at once — the "five terminals arranged like this"
   case. It is a list of presets by value, so editing a preset never silently
   rewrites a layout someone relies on. */
let PANE_LAYOUTS = [
  { id:'l-deploy', name:'Deploy watch', panes:[
      { name:'shell',      command:'' },
      { name:'logs',       command:'journalctl -fu app' },
      { name:'disk',       command:'df -h' } ] },
];

/* The tab the controls act on: whichever one is on screen. The mock has two (the
   terminal tab and a resumed agent's), and every pane control is drawn inside one
   of them, so "the visible one" is never ambiguous. */
function curTab(){ return (typeof STATE==='undefined') ? null : (STATE.mainTab==='agent' ? STATE.agentTab : STATE.termTab); }
function focusPaneAt(i){ const t=curTab(); if(t){ t.focus=i; renderMain(); } }
function closePaneAt(i){ const t=curTab(); if(!t) return;
  t.panes.splice(i,1);
  if(!t.panes.length){ if(STATE.mainTab==='agent') return closeAgentPane(); STATE.termTab=null; return renderMain(); }
  t.focus=Math.min(t.focus,t.panes.length-1); renderMain(); }
function addPane(p){ const t=curTab(); if(!t) return;
  t.panes.push(Object.assign({ kind:'term', host:t.host||null }, p));
  t.focus=t.panes.length-1; renderMain(); }

/* A preset becomes a pane. An empty command is a plain shell — the common case —
   so it carries no name and no canned output either. */
function paneFromPreset(preset,host){
  if(!preset.command) return { kind:'term', host };
  return { kind:'term', host, name:preset.name, cmd:preset.command,
    lines:['(running — this is an ordinary terminal pane)'] };
}
function splitWith(presetId){ const t=curTab(); const p=SPLIT_PRESETS.find(x=>x.id===presetId);
  if(p) addPane(paneFromPreset(p,t&&t.host));
}
function applyLayout(id){ const l=PANE_LAYOUTS.find(x=>x.id===id); const t=curTab(); if(!l||!t) return;
  l.panes.forEach(p=>t.panes.push(Object.assign({kind:'term',host:t.host||null},paneFromPreset(p,t.host))));
  t.focus=t.panes.length-1; renderMain();
  toast(`Layout <span class="accent">${l.name}</span> — ${l.panes.length} panes opened`);}

/* Everything a split can be, behind the chevron. The plain one is also here, first,
   so the menu is a superset of the button rather than a different feature. */
function splitMenu(e){
  e.stopPropagation();
  const t=curTab(); const host=t&&t.host;
  const items = SPLIT_PRESETS.map(p=>({ icon:ICON.term,
    label:`${p.name}${p.command?`<div class="sub mono" style="font-size:11px;color:var(--muted);font-weight:400">${p.command}</div>`:''}`,
    onclick:()=>splitWith(p.id) }));
  items.push({ icon:EXICON.split, label:'Snippets…', onclick:()=>openSnippets(host||null) });
  PANE_LAYOUTS.forEach(l=>items.push({ icon:EXICON.panel,
    label:`${l.name}<div class="sub" style="font-size:11px;color:var(--muted);font-weight:400">${l.panes.length} panes</div>`,
    onclick:()=>applyLayout(l.id) }));
  items.push({ icon:EXICON.gear, label:'Configure splits…', onclick:()=>dlgSplitPrefs() });
  floatMenu(e, items);
}

/* Where the name and the command are the user's. Presets and layouts are the same
   two fields twice, so they are edited in one place rather than two half-places. */
function splitPrefsBody(){
  const preset = (p,i) => `<div class="snip-row">
    <div class="snip-meta"><div class="snip-name">${p.name}${p.builtin?' <span class="snip-count">always there</span>':''}</div>
      <code class="snip-cmd">${p.command||'a plain shell — no command'}</code></div>
    ${p.builtin?'':`<button class="btn btn-ghost btn-sm" data-sp-del="${i}" title="Remove">✕</button>`}</div>`;
  const layout = (l,i) => `<div class="snip-row">
    <div class="snip-meta"><div class="snip-name">${l.name} <span class="snip-count">${l.panes.length} panes</span></div>
      <code class="snip-cmd">${l.panes.map(p=>p.name).join(' · ')}</code></div>
    <button class="btn btn-ghost btn-sm" data-sl-del="${i}" title="Remove">✕</button></div>`;
  return `<p class="muted" style="font-size:12px;margin:0 0 10px">Splitting a pane opens a <b>plain terminal</b> — that is the button.
    These are what the chevron beside it offers as well: a named command, or a whole layout at once.</p>
    <div class="sec"><span class="eyebrow">Split presets</span><span class="line"></span></div>
    <div class="snip-list">${SPLIT_PRESETS.map(preset).join('')}</div>
    <div class="snip-add">
      <label class="field"><span>Name</span><input class="inp" id="sp-name" placeholder="Containers"></label>
      <label class="field"><span>Command</span><input class="inp mono" id="sp-cmd" placeholder="df -h"></label>
      <div class="snip-add-foot"><button class="btn btn-primary btn-sm" data-sp-add>Add preset</button></div></div>
    <div class="sec"><span class="eyebrow">Layouts</span><span class="line"></span></div>
    <div class="snip-list">${PANE_LAYOUTS.map(layout).join('')||'<p class="muted" style="font-size:13px;margin:2px 0 10px">No layout yet.</p>'}</div>
    <div class="snip-add">
      <label class="field"><span>Name</span><input class="inp" id="sl-name" placeholder="Deploy watch"></label>
      <label class="field"><span>Panes <span class="muted" style="font-weight:400">· one per line, <code>name = command</code></span></span><textarea class="inp mono" id="sl-panes" rows="4" spellcheck="false" style="resize:vertical;line-height:1.6" placeholder="shell =&#10;load = top&#10;disk = df -h"></textarea></label>
      <div class="snip-add-foot"><button class="btn btn-primary btn-sm" data-sl-add>Add layout</button></div></div>`;
}
function dlgSplitPrefs(){
  const bd=showModal({title:'Splits',subtitle:'What a divider can open',wide:true,confirm:'Done',body:splitPrefsBody()});
  const body=bd.querySelector('.body');
  body.addEventListener('click',e=>{const t=e.target.closest('[data-sp-del],[data-sp-add],[data-sl-del],[data-sl-add]');if(!t)return;
    if(t.dataset.spDel!==undefined){SPLIT_PRESETS.splice(+t.dataset.spDel,1);}
    else if(t.dataset.slDel!==undefined){PANE_LAYOUTS.splice(+t.dataset.slDel,1);}
    else if(t.dataset.spAdd!==undefined){
      const n=(body.querySelector('#sp-name').value||'').trim(), c=(body.querySelector('#sp-cmd').value||'').trim();
      if(!n){toast('Give the preset a name');return;}
      SPLIT_PRESETS.push({id:'p'+Math.random().toString(36).slice(2,7),name:n,command:c});}
    else if(t.dataset.slAdd!==undefined){
      const n=(body.querySelector('#sl-name').value||'').trim();
      const panes=(body.querySelector('#sl-panes').value||'').split('\n').map(x=>x.trim()).filter(Boolean)
        .map(line=>{const k=line.indexOf('=');return k<0?{name:line,command:''}:{name:line.slice(0,k).trim(),command:line.slice(k+1).trim()};});
      if(!n||!panes.length){toast('A layout needs a name and at least one pane');return;}
      PANE_LAYOUTS.push({id:'l'+Math.random().toString(36).slice(2,7),name:n,panes});}
    body.innerHTML=splitPrefsBody();});
}

/* The tab renderer, one for every kind. */
function paneTabHTML(tab){
  if(!tab||!tab.panes.length) return '';
  return `<div class="psplit">${tab.panes.map((p,i)=>{
    const render = PANE_KINDS[p.kind] || PANE_KINDS.term;
    return `${i?'<div class="pdiv" title="Drag to resize"><i></i></div>':''}
      <div class="pane-wrap ${i===tab.focus?'focused':''}" style="flex:1" onclick="focusPaneAt(${i})">${render(p,i)}</div>`;
  }).join('')}</div>`;
}

/* The chrome every pane carries, whatever it displays.
   Split, detach, snippets, search and close belong to the PANE, not to what is
   inside it — so a terminal and an agent session get them from here rather than
   each drawing its own near-copy. That is the mock's version of what the pane-kind
   registry does in the app: the surroundings are written once, the content is
   registered. Each option is an onclick string, or empty for an inert mock button. */
function paneActs(o) {
  o = o || {};
  const I = (d, r) => `<svg class="icon" viewBox="0 0 24 24"${r ? ' style="transform:rotate(90deg)"' : ''}><path d="${d}"/></svg>`;
  const b = (title, icon, click) => `<button title="${title}"${click ? ` onclick="${click}"` : ''}>${icon}</button>`;
  const grip = `<div class="grip" title="Drag to reorganize pane"><div class="gr"><i></i><i></i></div><div class="gr"><i></i><i></i></div><div class="gr"><i></i><i></i></div></div>`;
  return `${o.lead || ''}${grip}
    ${b('Split horizontal (Ctrl+Shift+H)', I('M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4m10-2V6a2 2 0 00-2-2h-4'), o.splitH || "splitWith('plain')")}
    ${b('Split vertical (Ctrl+Shift+D)', I('M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4m10-2V6a2 2 0 00-2-2h-4', 1), o.splitV || "splitWith('plain')")}
    <button class="split-more" title="Split with… — a preset, a snippet or a whole layout" onclick="splitMenu(event)">${I('M6 9l6 6 6-6')}</button>
    ${b(o.detachTitle || 'Detach to new tab', I('M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14'), o.detach)}
    ${b('Snippets — run a saved command here', I('M8 9l-3 3 3 3M16 9l3 3-3 3M13 6l-2 12'), o.snippets)}
    ${b('Search in pane (Ctrl+F)', I('M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z'), o.search)}
    ${b(o.closeTitle || 'Close terminal', I('M6 18L18 6M6 6l12 12'), o.close)}`;
}

/* mini terminal content. `opts` lets a caller give the pane a name and a body of its
   own — a `top` or a `watch docker ps` beside an agent is still an ordinary terminal
   pane, not a third kind of thing. */
function termHTML(host, opts){
  opts = opts || {};
  const who=host?`<span class="ok">${host}</span>`:'<span class="ok">local</span>';
  // Reconnect state — SSH panes only. The mock's demoDisconnected flag simulates a
  // dropped session; STATE.autoReconnect decides auto-reconnect (a banner) vs a
  // manual "Reconnect" button. Either way the user is told they were disconnected.
  const lost = !!host && typeof STATE!=='undefined' && STATE.demoDisconnected;
  const auto = typeof STATE!=='undefined' && STATE.autoReconnect;
  let status;
  if(!host) status='';
  else if(!lost) status='<span class="muted" style="font-size:12px">Connected</span>';
  else if(auto) status='<span style="font-size:12px;font-weight:600;color:var(--amber)">Reconnected</span>';
  else status='<span style="font-size:12px;font-weight:600;color:var(--red)">Disconnected</span>';
  const reconnectBtn = (lost && !auto)
    ? `<button onclick="reconnectPane()" title="Reconnect — opens a new shell" style="display:flex;align-items:center;gap:5px;padding:3px 10px;border-radius:7px;border:1px solid color-mix(in oklab,var(--accent) 40%,transparent);background:color-mix(in oklab,var(--accent) 12%,transparent);color:var(--accent);font-weight:600;font-size:12px;cursor:pointer">⟳ Reconnect</button>`
    : '';
  let banner='';
  if(lost && auto) banner=`<div style="background:color-mix(in oklab,var(--amber) 12%,transparent);border:1px solid color-mix(in oklab,var(--amber) 35%,transparent);border-radius:8px;padding:8px 11px;margin:0 0 8px;font-size:12.5px;line-height:1.5">⚠ Connection lost — <b>automatically reconnected</b>. This is a new shell: your previous history, on-screen output and any running job were lost.</div>`;
  else if(lost) banner=`<div style="background:color-mix(in oklab,var(--red) 10%,transparent);border:1px solid color-mix(in oklab,var(--red) 35%,transparent);border-radius:8px;padding:8px 11px;margin:0 0 8px;font-size:12.5px;line-height:1.5">⚠ <b>Connection lost.</b> Reconnecting opens a <b>new shell</b> (history & on-screen output are lost) — use <b>Reconnect ↗</b> when you're ready.</div>`;
  const body = opts.lines
    ? `${banner}<div class="ln di"># ${opts.cmd || ''}</div>${opts.lines.map((l)=>`<div class="ln di">${l}</div>`).join('')}<div class="ln"><span class="pr">${who} ~ ❯</span> <span class="cursor"></span></div>`
    : (lost && auto)
    ? `${banner}<div class="ln"><span class="pr">${who} ~ ❯</span> <span class="cursor"></span></div>`
    : `${banner}<div class="ln di"># ${host?'ssh '+host:'local shell — /usr/bin/fish'}</div>
      <div class="ln"><span class="pr">${who} ~ ❯</span> uname -a</div>
      <div class="ln di">Linux rite 7.1.3 #1 SMP x86_64 GNU/Linux</div>
      <div class="ln"><span class="pr">${who} ~ ❯</span> ls</div>
      <div class="ln di">Documents  Downloads  projects  .config</div>
      <div class="ln"><span class="pr">${who} ~ ❯</span> ${lost?'<span class="muted">(disconnected)</span>':'<span class="cursor"></span>'}</div>`;
  const name = opts.name || (host ? host : 'Local Terminal (' + (typeof STATE!=='undefined'?STATE.defaultShell:'fish') + ')');
  return `<div class="termpane">
    <div class="termpane-hdr">
      <div class="who">${host?'<span class="st"></span>':''}<span class="name">${name}</span>${status}</div>
      <div class="termpane-acts">${paneActs({
        lead: reconnectBtn,
        snippets: `openSnippets(${host?`'${host}'`:'null'})`,
        close: opts.close || '',
      })}</div>
    </div>
    <div class="term-body scroll">
      ${body}
    </div>
  </div>`;
}
