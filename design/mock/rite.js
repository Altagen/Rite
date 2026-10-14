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

/* Dialogs come in two shapes, and the shape says what the dialog does.

   A DECISION dialog commits something when you press its button — add a server,
   reset a vault — so it keeps a footer: Cancel on the left, the verb on the right.
   Cancel there means something: nothing has happened yet.

   A PREFERENCES dialog applies every change the moment you make it. There is
   nothing to confirm and nothing to cancel, so a footer "Close" is just a second
   answer to the question the ✕ already answers — and a "Cancel" beside it is a
   lie, because the changes are already saved. Those dialogs pass `confirm:null`
   and get no footer at all.

   The ✕ is in the same corner either way. It is the one control whose meaning
   never changes, so it is never the one that moves. */
function showModal({title,subtitle,body,confirm='Confirm',onConfirm,wide,width}){
  const bd=document.createElement('div'); bd.className='backdrop show';
  const mw=width?`style="max-width:${width}"`:(wide?'style="max-width:520px"':'');
  const foot = confirm===null ? ''
    : `<div class="foot"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" data-ok>${confirm}</button></div>`;
  bd.innerHTML=`<div class="modal" ${mw}>
    <button class="modal-x" data-close title="Close" aria-label="Close">✕</button>
    <header><h3>${title}</h3>${subtitle?`<p>${subtitle}</p>`:''}</header>
    <div class="body">${body}</div>
    ${foot}
  </div>`;
  document.body.appendChild(bd);
  const close=()=>bd.remove();
  bd.addEventListener('click',e=>{if(e.target===bd)close();});
  bd.querySelectorAll('[data-x],[data-close]').forEach(b=>{b.onclick=close;});
  const ok=bd.querySelector('[data-ok]');
  if(ok) ok.onclick=()=>{ if(!onConfirm||onConfirm(bd)!==false) close(); };
  document.addEventListener('keydown',function esc(e){
    if(e.key!=='Escape')return;
    document.removeEventListener('keydown',esc);
    if(document.body.contains(bd))close();
  });
  const first=bd.querySelector('input,select'); if(first)setTimeout(()=>first.focus(),30);
  // Enter confirms only where there is something to confirm.
  if(ok) bd.querySelectorAll('input').forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')ok.click();}));
  // live strength meter
  const pw=bd.querySelector('[data-pw]'), meter=bd.querySelector('.strength>i');
  if(pw&&meter)pw.addEventListener('input',()=>{const s=Math.min(100,pw.value.length*12);meter.style.width=s+'%';meter.style.background=s<40?'#f7768e':s<70?'#e5b567':'#9ece6a';});
  return bd;
}

/* ================= preferences chrome =================

   A rail, not a scroll. Settings had grown past the point where scrolling could find
   anything: the only way to know whether a setting existed was to read all of them.
   The rail names every section at once and renders one of them.

   The SECTIONS differ per shell and per context — the browser has no focus mode and
   no local shell; a master password and a danger zone only mean something once there
   is a vault to hold one — so each shell owns its own list and declares when a
   section applies. A section that does not apply is ABSENT, not greyed out: a
   disabled row still implies you are missing out on something.

   There is no footer. Everything here applies the moment you change it, so there is
   nothing to confirm and nothing to cancel — the ✕ closes it. See showModal(). */
function prefRow(title,sub,control){
  return `<div class="settings-row"><div><b>${title}</b>${sub?`<div class="muted" style="font-size:12px">${sub}</div>`:''}</div>${control}</div>`;
}
function prefGet(path){ return path.split('.').reduce((o,k)=>o&&o[k],STATE); }
function prefToggle(path,extra){
  return `<div class="toggle ${prefGet(path)?'on':''}" onclick="this.classList.toggle('on');STATE.${path}=this.classList.contains('on');${extra||''}"><i></i></div>`;
}
let PREF_AT=null;
function prefsHTML(prefs){
  const shown=prefs.filter(s=>!s.when||s.when());
  if(!shown.length) return '';
  if(!shown.some(s=>s.id===PREF_AT)) PREF_AT=shown[0].id;
  const sec=shown.find(s=>s.id===PREF_AT);
  return `<div class="prefs">
    <nav class="prefs-nav">${shown.map(s=>`<button class="${s.id===PREF_AT?'on':''}${s.danger?' danger':''}" data-pref="${s.id}">${s.label}</button>`).join('')}</nav>
    <div class="prefs-pane">${sec.body()}</div></div>`;
}
function openPrefs(prefs,at){
  if(at)PREF_AT=at;
  const bd=showModal({title:'Settings',width:'760px',confirm:null,body:prefsHTML(prefs)});
  const body=bd.querySelector('.body');
  body.style.padding='14px 20px 18px';
  body.addEventListener('click',e=>{
    const b=e.target.closest('[data-pref]'); if(!b)return;
    PREF_AT=b.dataset.pref; body.innerHTML=prefsHTML(prefs);
  });
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
registerPaneKind('term', (p,i) => termHTML(p.host, { name:p.name, cmd:p.cmd, lines:p.lines, warn:p.warn, close:`closePaneAt(${i})` }));

/* What a split can open. `plain` is first and is the default action: the preset list
   is for the minority who want `top` on the right, not a tax on everyone else.
   Name and command are both the user's — nothing here is built in but the plain one. */
let SPLIT_PRESETS = [
  { id:'plain',    name:'Terminal',   command:'', builtin:true },
  { id:'p-load',   name:'Load',       command:'top' },
  { id:'p-disk',   name:'Disk',       command:'df -h' },
];
/* ================= Layouts: a file =================

   A split preset and a layout were in the same dialog because they are the same two
   fields. They are not the same feature, and sharing a form made that hard to see.

   A preset is a reflex: the pane you are in, divided, running one command. It belongs
   next to the divider, it is one line long, and a list in the preferences is the right
   home for it.

   A layout is the start of a working day: what opens, where, and on which machine. It
   names machines, it has an order, it can be the thing that runs when Rite starts, and
   it is the kind of thing people keep in version control and copy between computers.
   That is a FILE — `layouts.toml`, read on startup, edited here or in your own editor.
   Settings ▸ Layouts shows the file, not a form pretending the file is not there.

   A layout names a machine; the library may not have it. The file is not a contract
   the app can enforce — a machine gets renamed, a vault stays locked, the file comes
   from another computer. So an unresolvable pane is not an error that cancels the
   layout: it opens a PLAIN SHELL and says so in the pane. You get your workspace,
   minus what could not be found, and you can see exactly what was missing. */
const LAYOUT_PATH = '~/.config/rite/layouts.toml';
let LAYOUT_FILE = `# Layouts — what opens, where, and on which machine.
# Rite reads this file at startup. Settings ▸ Layouts edits it; so does your editor.

[[layout]]
name = "Morning"
startup = true            # open this layout when Rite starts

  [[layout.pane]]
  command = ""            # no machine = this computer, a plain shell

  [[layout.pane]]
  machine = "web-01"      # a machine from your library, by name
  command = "journalctl -fu app"

  [[layout.pane]]
  machine = "pg-prod"
  command = "top"

[[layout]]
name = "Deploy watch"

  [[layout.pane]]
  machine = "web-01"
  command = "journalctl -fu app"

  [[layout.pane]]
  machine = "lb-01"
  command = "tail -f /var/log/nginx/access.log"

  [[layout.pane]]
  command = "df -h"
`;

/* A deliberately small TOML subset: [[layout]], [[layout.pane]], and quoted or
   boolean values. The real one uses a TOML parser (ADR 0020 already made TOML the
   house format for config-as-code); what matters in the mock is the shape of the
   file and what a BAD file looks like.

   A file that does not parse loads NOTHING, and the dialog names the line. Half a
   file is worse than no file: you would not know which half you got. */
function parseLayoutFile(text){
  const layouts=[]; let cur=null, pane=null;
  const fail=(line,message)=>({layouts:[],error:{line,message}});
  const lines=(text||'').split('\n');
  for(let i=0;i<lines.length;i++){
    const line=lines[i].replace(/#.*$/,'').trim();
    if(!line) continue;
    if(line==='[[layout]]'){ cur={id:'l'+(layouts.length+1),name:'',startup:false,panes:[]}; layouts.push(cur); pane=null; continue; }
    if(line==='[[layout.pane]]'){
      if(!cur) return fail(i+1,'[[layout.pane]] before any [[layout]]');
      pane={machine:null,command:'',name:''}; cur.panes.push(pane); continue; }
    if(line.startsWith('[')) return fail(i+1,`unknown table ${line} — only [[layout]] and [[layout.pane]] exist`);
    const m=line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if(!m) return fail(i+1,`not a key or a table header: ${line}`);
    const key=m[1]; const rawv=m[2].trim(); let v;
    if(/^".*"$/.test(rawv)) v=rawv.slice(1,-1);
    else if(rawv==='true'||rawv==='false') v=(rawv==='true');
    else return fail(i+1,`a value is a quoted string or true/false, not ${rawv||'nothing'}`);
    if(pane){
      if(key==='machine') pane.machine=String(v);
      else if(key==='command') pane.command=String(v);
      else if(key==='name') pane.name=String(v);
      else return fail(i+1,`a pane takes machine, command and name — not ${key}`);
    } else if(cur){
      if(key==='name') cur.name=String(v);
      else if(key==='startup') cur.startup=!!v;
      else return fail(i+1,`a layout takes name and startup — not ${key}`);
    } else return fail(i+1,`${key} is outside any [[layout]]`);
  }
  const nameless=layouts.findIndex(l=>!l.name);
  if(nameless>=0) return fail(0,`layout #${nameless+1} has no name`);
  const empty=layouts.find(l=>!l.panes.length);
  if(empty) return fail(0,`layout "${empty.name}" has no [[layout.pane]]`);
  return {layouts,error:null};
}

let PANE_LAYOUTS=[], LAYOUT_ERROR=null;
function reloadLayouts(){
  const r=parseLayoutFile(LAYOUT_FILE);
  // A broken file keeps the layouts you had running; it does not empty the menu
  // under you. It only stops NEW ones from loading, and says why.
  if(!r.error) PANE_LAYOUTS=r.layouts;
  LAYOUT_ERROR=r.error;
  return r;
}
reloadLayouts();

/* A machine by name, anywhere in the collection tree. */
function findMachine(name){
  let hit=null;
  (function rec(list){ (list||[]).forEach(c=>{
    (c.conns||[]).forEach(m=>{ if(!hit && m.name===name) hit=m; });
    if(c.children) rec(c.children); }); })(typeof COLL==='undefined'?[]:COLL);
  return hit;
}

/* Where a pane of a layout actually opens. Everything that can go wrong ends the
   same way — a plain shell plus a sentence in the pane saying what was asked for. */
function layoutTarget(p){
  if(!p.machine) return { host:null, warn:null };
  const ctx = (typeof STATE==='undefined') ? null : STATE.ctx;
  // The browser shell has no context pill: it is always signed in to one server, so
  // no context at all means "the library is reachable", not "there is no library".
  const openVault = !ctx || ctx.type==='server' || (ctx.type==='vault' && !ctx.locked);
  if(!openVault) return { host:null,
    warn:`<b>${p.machine}</b> needs an open vault — your machines are encrypted, so this pane opened a plain shell.` };
  const m=findMachine(p.machine);
  if(!m) return { host:null,
    warn:`<b>${p.machine}</b> isn't in your library — renamed, or from another computer. This pane opened a plain shell.` };
  return { host:m.name, warn:null };
}

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
  let fellBack=0;
  l.panes.forEach(p=>{
    const tgt=layoutTarget(p);
    if(tgt.warn) fellBack++;
    t.panes.push({ kind:'term', host:tgt.host, warn:tgt.warn,
      name:p.name || (tgt.host||null) || (p.command? p.command.split(/\s+/)[0] : null),
      cmd:p.command||'', lines:p.command?['(running — this is an ordinary terminal pane)']:null });
  });
  t.focus=t.panes.length-1; renderMain();
  toast(fellBack
    ? `Layout <span class="accent">${l.name}</span> — ${l.panes.length} panes, ${fellBack} fell back to a plain shell`
    : `Layout <span class="accent">${l.name}</span> — ${l.panes.length} panes opened`);}

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
  items.push({ icon:EXICON.gear, label:'Split presets…', onclick:()=>dlgSplitPrefs() });
  floatMenu(e, items);
}

/* The Layouts button, in the tab strip.

   A layout arranges a WHOLE TAB — five terminals set up a particular way — so it
   belongs beside the tabs and not only inside one pane's split menu, which is where
   it first appeared. That menu keeps offering them: someone who learned the chevron
   should not have to unlearn it. This is the obvious place, not the only one.

   No layouts configured → no button. An empty dropdown beside the tabs is a
   permanent invitation to find out that it is empty; the split menu's
   "Configure splits…" is where a first layout comes from. */
function layoutsBtnHTML(){
  if(typeof STATE!=='undefined' && STATE.toolbar && STATE.toolbar.layouts===false) return '';
  if(!PANE_LAYOUTS.length && !LAYOUT_ERROR) return '';
  const bad=!!LAYOUT_ERROR;
  return `<button class="mtab-new" title="${bad?'Layouts — your layouts.toml has an error':'Layouts — open a saved arrangement in this tab'}"
    onclick="layoutsMenu(event)"${bad?' style="color:var(--amber)"':''}>${EXICON.panel}${EXICON.chevD}</button>`;
}
function layoutsMenu(e){
  e.stopPropagation();
  const items = PANE_LAYOUTS.map(l=>({ icon:EXICON.panel,
    label:`${l.name}<div class="sub" style="font-size:11px;color:var(--muted);font-weight:400">${l.panes.length} panes · ${l.panes.map(p=>p.name).join(' · ')}</div>`,
    onclick:()=>applyLayout(l.id) }));
  if(LAYOUT_ERROR) items.unshift({ icon:'⚠',
    label:`<span style="color:var(--amber)">layouts.toml has an error</span><div class="sub" style="font-size:11px;color:var(--muted);font-weight:400">${LAYOUT_ERROR.line?`line ${LAYOUT_ERROR.line} · `:''}${LAYOUT_ERROR.message}</div>`,
    onclick:()=>dlgLayouts() });
  items.push({ icon:EXICON.gear, label:'Layouts file…', onclick:()=>dlgLayouts() });
  floatMenu(e, items);
}

/* ===== Split presets: the small dialog =====
   One command, one pane, one line each. No layouts here any more: a preset you can
   type in four seconds and a file you keep in version control are not two halves of
   one screen. This dialog saves as you go, so it has no footer (see showModal). */
function splitPrefsBody(){
  const preset = (p,i) => `<div class="snip-row">
    <div class="snip-meta"><div class="snip-name">${p.name}${p.builtin?' <span class="snip-count">always there</span>':''}</div>
      <code class="snip-cmd">${p.command||'a plain shell — no command'}</code></div>
    ${p.builtin?'':`<button class="btn btn-ghost btn-sm" data-sp-edit="${i}" title="Edit">Edit</button>
    <button class="btn btn-ghost btn-sm" data-sp-del="${i}" title="Remove">✕</button>`}</div>`;
  return `<p class="muted" style="font-size:12px;margin:0 0 10px">Splitting a pane opens a <b>plain terminal</b> — that is the button.
    A preset is the same divider running one named command, offered by the chevron beside it.
    Arranging a whole tab is a <b>layout</b>, and layouts live in a file: ${'' /* keep the two apart */}
    <button class="btn btn-ghost btn-sm" style="padding:1px 7px" onclick="this.closest('.backdrop').remove();dlgLayouts()">Layouts…</button></p>
    <div class="snip-list">${SPLIT_PRESETS.map(preset).join('')}</div>
    <div class="snip-add">
      <label class="field"><span>Name</span><input class="inp" id="sp-name" placeholder="Containers"></label>
      <label class="field"><span>Command</span><input class="inp mono" id="sp-cmd" placeholder="df -h"></label>
      <div class="snip-add-foot"><button class="btn btn-primary btn-sm" data-sp-add>${EDITING.preset>=0?'Save preset':'Add preset'}</button></div></div>`;
}
/* Add AND edit. The first version could only add and remove, so fixing a typo in a
   command meant deleting the entry and retyping the other field. `EDITING.preset` is
   the index being changed, or -1 for the add form; both are the same two fields. */
let EDITING={preset:-1};
function dlgSplitPrefs(){
  EDITING={preset:-1};
  const bd=showModal({title:'Split presets',subtitle:'What the chevron beside the divider offers',wide:true,confirm:null,body:splitPrefsBody()});
  const body=bd.querySelector('.body');
  const redraw=()=>{body.innerHTML=splitPrefsBody();
    if(EDITING.preset>=0){const p=SPLIT_PRESETS[EDITING.preset];
      body.querySelector('#sp-name').value=p.name; body.querySelector('#sp-cmd').value=p.command;}};
  body.addEventListener('click',e=>{
    const t=e.target.closest('[data-sp-del],[data-sp-add],[data-sp-edit]');
    if(!t)return;
    if(t.dataset.spEdit!==undefined){EDITING.preset=+t.dataset.spEdit;}
    else if(t.dataset.spDel!==undefined){SPLIT_PRESETS.splice(+t.dataset.spDel,1);EDITING.preset=-1;}
    else if(t.dataset.spAdd!==undefined){
      const n=(body.querySelector('#sp-name').value||'').trim(), c=(body.querySelector('#sp-cmd').value||'').trim();
      if(!n){toast('Give the preset a name');return;}
      if(EDITING.preset>=0){Object.assign(SPLIT_PRESETS[EDITING.preset],{name:n,command:c});EDITING.preset=-1;}
      else SPLIT_PRESETS.push({id:'p'+Math.random().toString(36).slice(2,7),name:n,command:c});}
    redraw();});
  return bd;
}

/* ===== Layouts: the file, shown as the file =====

   Not a form over a file. A form would have to invent a widget for every key the
   file grows, and the file is the thing people copy between computers, mail to a
   colleague and commit — so the file is what the dialog shows. Save parses it; a
   bad file is refused with its line number and the layouts you had keep working.

   What it opens is listed underneath, resolved against the library you actually
   have, because the interesting question is not "is my TOML valid" but "will this
   open what I think it opens, on this computer, today". */
function layoutsBody(){
  const rows = PANE_LAYOUTS.map(l=>{
    const panes = l.panes.map(p=>{
      const tgt=layoutTarget(p);
      const where = p.machine
        ? (tgt.host? `<span class="ok">${p.machine}</span>` : `<span style="color:var(--amber)">${p.machine} → plain shell</span>`)
        : '<span class="muted">this computer</span>';
      return `<div style="display:flex;gap:8px;font-size:12px;padding:2px 0">
        <span style="flex:0 0 150px">${where}</span>
        <code class="mono" style="color:var(--fg-dim);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.command||'(plain shell)'}</code></div>`;
    }).join('');
    return `<div class="snip-row" style="display:block">
      <div class="snip-name" style="margin-bottom:4px">${l.name}
        <span class="snip-count">${l.panes.length} panes</span>
        ${l.startup?'<span class="snip-count" style="color:var(--accent);border-color:color-mix(in oklab,var(--accent) 40%,transparent)">at startup</span>':''}
        <button class="btn btn-ghost btn-sm" style="float:right;padding:1px 8px" data-lay-open="${l.id}">Open now</button></div>
      ${panes}</div>`;
  }).join('');
  const err = LAYOUT_ERROR
    ? `<div class="lay-err">⚠ <b>Not loaded.</b> ${LAYOUT_ERROR.line?`Line ${LAYOUT_ERROR.line}: `:''}${LAYOUT_ERROR.message}<br>
       <span class="muted">The layouts already loaded keep working until the file parses again.</span></div>`
    : `<p class="lay-ok">✓ ${PANE_LAYOUTS.length} layout${PANE_LAYOUTS.length===1?'':'s'} loaded.</p>`;
  return `<p class="muted" style="font-size:12.5px;margin:0 0 10px;line-height:1.55">
      A layout is what you open when you sit down: which terminals, in what order, on which machines.
      It is a file, so you can keep it in version control and carry it between computers.
      A machine this computer doesn't have opens a <b>plain shell</b> with a note in the pane — the layout still opens.</p>
    <div class="lay-path">${EXICON.coll} <code>${LAYOUT_PATH}</code>
      <span class="grow" style="flex:1"></span>
      <button class="btn btn-ghost btn-sm" data-lay-editor>Open in my editor</button>
      <button class="btn btn-ghost btn-sm" data-lay-reload title="Re-read the file from disk">↻ Reload</button></div>
    <textarea class="lay-file" id="lay-file" spellcheck="false">${LAYOUT_FILE.replace(/</g,'&lt;')}</textarea>
    <div style="display:flex;align-items:center;gap:10px;margin-top:9px">
      <button class="btn btn-primary btn-sm" data-lay-save>Save file</button>
      <a href="#" onclick="toast('docs/LAYOUTS.md');return false" class="muted" style="font-size:12px">What can go in this file →</a></div>
    ${err}
    <div class="sec" style="margin-top:16px"><span class="eyebrow">What it opens</span><span class="line"></span></div>
    <div class="snip-list">${rows||'<p class="muted" style="font-size:13px;margin:2px 0 10px">Nothing loaded.</p>'}</div>`;
}
function dlgLayouts(){
  const bd=showModal({title:'Layouts',subtitle:'What opens when you sit down',width:'620px',confirm:null,body:layoutsBody()});
  const body=bd.querySelector('.body');
  const redraw=()=>{body.innerHTML=layoutsBody();};
  body.addEventListener('click',e=>{
    const t=e.target.closest('[data-lay-save],[data-lay-reload],[data-lay-editor],[data-lay-open]');
    if(!t)return;
    if(t.dataset.layEditor!==undefined){ toast(`${LAYOUT_PATH} — opened in your editor`); return; }
    if(t.dataset.layOpen!==undefined){ bd.remove(); applyLayout(t.dataset.layOpen); return; }
    if(t.dataset.layReload!==undefined){ reloadLayouts(); redraw();
      toast(LAYOUT_ERROR?'File re-read — it still has an error':'File re-read'); if(typeof renderMain==='function')renderMain(); return; }
    // Save: the textarea is the file. Parse first, keep the old layouts if it fails.
    LAYOUT_FILE=body.querySelector('#lay-file').value;
    const r=reloadLayouts(); redraw();
    toast(r.error?`<span style="color:var(--amber)">Saved, but not loaded — line ${r.error.line||'?'}</span>`:'Saved — layouts reloaded');
    if(typeof renderMain==='function')renderMain();
  });
  return bd;
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
  // A layout asked for a machine we could not open. The pane works — it just is not
  // the pane that was asked for, and nothing else on screen would ever say so.
  if(opts.warn) banner=`<div class="pane-warn"><span>⚠</span><span>${opts.warn}</span></div>`;
  if(lost && auto) banner+=`<div style="background:color-mix(in oklab,var(--amber) 12%,transparent);border:1px solid color-mix(in oklab,var(--amber) 35%,transparent);border-radius:8px;padding:8px 11px;margin:0 0 8px;font-size:12.5px;line-height:1.5">⚠ Connection lost — <b>automatically reconnected</b>. This is a new shell: your previous history, on-screen output and any running job were lost.</div>`;
  else if(lost) banner+=`<div style="background:color-mix(in oklab,var(--red) 10%,transparent);border:1px solid color-mix(in oklab,var(--red) 35%,transparent);border-radius:8px;padding:8px 11px;margin:0 0 8px;font-size:12.5px;line-height:1.5">⚠ <b>Connection lost.</b> Reconnecting opens a <b>new shell</b> (history & on-screen output are lost) — use <b>Reconnect ↗</b> when you're ready.</div>`;
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
