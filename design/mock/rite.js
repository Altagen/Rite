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
  // Settings ▸ Layouts carries a switch that WRITES the workspace file, and the file
  // is the state — so the section is redrawn from the new parse rather than left
  // showing what was clicked.
  wireStartupToggles(body,()=>{body.innerHTML=prefsHTML(prefs);});
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

/* ================= The workspace file =================

   ONE file describes how this machine is set up: `[[preset]]` is what the split menu
   offers, `[[layout]]` is the morning — what opens, where on the screen, and on which
   machine. Both belong to the MACHINE and neither is a secret, which is why they are a
   file and not a row in an account's settings table: you version it, you copy it
   between computers, and a shared server never sees it (ADR 0023).

   That last clause is the whole divergence. The desktop shell IS a machine, so it has
   the file. The browser talks to a server, where the file does not exist and has no
   substitute — so `web.html` has no Layouts section, no Split presets section and no
   Layouts button, rather than empty ones.

   A preset is a reflex: the pane you are in, divided, running one command. One line
   long, edited in a small dialog that splices its blocks back into the file.

   A layout is the start of a working day. It names machines, it has an order, and it
   can be the thing that runs when Rite starts. Settings ▸ Layouts therefore LEADS with
   a card per layout — what it opens, resolved against the library this computer
   actually has — and the file editor is one button underneath. The section used to be
   a title and a button that sent you somewhere else, which put the only answer to
   "what do I have" behind a click and below a textarea.

   A layout names a machine; the library may not have it. The file is not a contract
   the app can enforce — a machine gets renamed, a vault stays locked, the file comes
   from another computer. So an unresolvable pane is not an error that cancels the
   layout: it opens a PLAIN SHELL and says so in the pane. You get your workspace,
   minus what could not be found, and you can see exactly what was missing. */
const LAYOUT_PATH = '~/.config/rite/layouts.toml';
let LAYOUT_FILE = `# Your workspace: the commands the split menu offers, and what opens in the morning.
# Rite reads this file at startup. Settings ▸ Layouts edits it; so does your editor.

[[preset]]
name = "Load"
command = "top"

[[preset]]
name = "Disk"
command = "df -h"

[[layout]]
name = "Morning"
startup = true            # open this layout when Rite starts

  [[layout.pane]]
  command = ""            # no machine = this computer, a plain shell
                          # the first pane of a tab is the whole area

  [[layout.pane]]
  machine = "web-01"      # a machine from your library, by name
  command = "journalctl -fu app"
  name = "logs"           # the pane header, and what "of" points at
  split = "right"         # right, down, left, up — of the previous pane
  size = "40%"            # this pane's share of what it cuts

  [[layout.pane]]
  machine = "pg-prod"
  preset = "Load"         # or command = "..." — one or the other
  split = "down"
  of = "logs"             # cut out of that pane, not the previous one

[[layout]]
name = "Deploy watch"

  [[layout.pane]]
  machine = "web-01"
  command = "journalctl -fu app"

  [[layout.pane]]
  machine = "lb-01"
  command = "tail -f /var/log/nginx/access.log"

  [[layout.pane]]
  tab = "disks"           # a tab of its own, opened beside the first
  command = "df -h"
`;

/* A deliberately small TOML subset: [[preset]], [[layout]], [[layout.pane]], quoted
   strings and booleans. The real one is `apps/desktop/src/store/layoutsFormat.ts`,
   held to these messages by `e2e/layout-file-check.mjs`; what matters here is the
   shape of the file, what a BAD file looks like, and where it gets reported.

   A file that does not parse loads NOTHING and names the line. Half a file is worse
   than no file: you would not know which half you got. A file of nothing but comments
   is a fresh install, not an error. */
const SPLIT_WORDS = ['right','down','left','up'];
/* Drop a trailing comment, but not a `#` inside a quoted value — `command = "git log
   --format=%h#%s"` is one command, not a command and a comment. */
function stripComment(line){
  let quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'&&line[i-1]!=='\\') quoted=!quoted;
    else if(c==='#'&&!quoted) return line.slice(0,i);
  }
  return line;
}
/* `"45%"` as a share of the area being cut. A percentage, because that is the unit
   the screen already works in. Outside 10–90% there is no answer to give — the drag
   handle clamps there — so such a file is REFUSED rather than quietly clamped: a
   screen that does not match the file is worse than a rejection. */
function parseShare(v){
  const m=/^([0-9]+(?:\.[0-9]+)?)\s*%$/.exec(String(v).trim());
  if(!m) return null;
  const share=Number(m[1])/100;
  return (share>=0.1&&share<=0.9)? share : null;
}
function parseLayoutFile(text){
  const presets=[], layouts=[];
  let preset=null, cur=null, pane=null;
  /* Which line each key came from, so a check made once the whole file is read can
     still point at one. */
  const lineOf=new Map();
  const at=(o,k)=>(lineOf.get(o)||{})[k]||0;
  const mark=(o,k,n)=>{const seen=lineOf.get(o)||{};seen[k]=n;lineOf.set(o,seen);};
  const fail=(line,message)=>({presets:[],layouts:[],error:{line,message}});
  const lines=(text||'').split('\n');
  for(let i=0;i<lines.length;i++){
    const line=stripComment(lines[i]).trim();
    if(!line) continue;
    if(line==='[[preset]]'){ preset={id:'p'+(presets.length+1),name:'',command:''}; presets.push(preset); cur=null; pane=null; continue; }
    if(line==='[[layout]]'){ cur={id:'l'+(layouts.length+1),name:'',startup:false,panes:[]}; layouts.push(cur); preset=null; pane=null; continue; }
    if(line==='[[layout.pane]]'){
      if(!cur) return fail(i+1,'[[layout.pane]] before any [[layout]]');
      pane={command:''}; cur.panes.push(pane); continue; }
    if(line.startsWith('[')) return fail(i+1,`unknown table ${line} — only [[preset]], [[layout]] and [[layout.pane]] exist`);
    const m=line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if(!m) return fail(i+1,`not a key or a table header: ${line}`);
    const key=m[1]; const rawv=m[2].trim(); let v;
    if(rawv.length>=2&&rawv.startsWith('"')&&rawv.endsWith('"')) v=rawv.slice(1,-1).replace(/\\(["\\])/g,'$1');
    else if(rawv==='true'||rawv==='false') v=(rawv==='true');
    // `size = 45%` is the mistake this subset invites, so it gets its own sentence
    // instead of the generic one about quoting.
    else if(/^[0-9]+(\.[0-9]+)?%?$/.test(rawv)) return fail(i+1,`a value is quoted — write ${key} = "${rawv.endsWith('%')?rawv:rawv+'%'}"`);
    else return fail(i+1,`a value is a quoted string or true/false, not ${rawv||'nothing'}`);
    if(pane){
      mark(pane,key,i+1);
      if(key==='machine') pane.machine=String(v);
      else if(key==='command') pane.command=String(v);
      else if(key==='name') pane.name=String(v);
      else if(key==='preset') pane.preset=String(v);
      else if(key==='of') pane.of=String(v);
      else if(key==='tab') pane.tab=String(v);
      else if(key==='split'){
        if(!SPLIT_WORDS.includes(String(v))) return fail(i+1,`a split is right, down, left or up — not ${v}`);
        pane.split=String(v); }
      else if(key==='size'){
        const share=parseShare(v);
        if(share===null) return fail(i+1,`a size is a percentage between 10% and 90%, not ${String(v)||'nothing'}`);
        pane.size=share; }
      else return fail(i+1,`a pane takes machine, command, name, preset, split, of, size and tab — not ${key}`);
    } else if(preset){
      mark(preset,key,i+1);
      if(key==='name') preset.name=String(v);
      else if(key==='command') preset.command=String(v);
      else return fail(i+1,`a preset takes name and command — not ${key}`);
    } else if(cur){
      mark(cur,key,i+1);
      if(key==='name') cur.name=String(v);
      else if(key==='startup') cur.startup=!!v;
      else return fail(i+1,`a layout takes name and startup — not ${key}`);
    } else return fail(i+1,`${key} is outside any [[preset]] or [[layout]]`);
  }
  /* Checks that can only be made once the whole file is read: a preset may be declared
     AFTER the layout that cites it, and an anchor is only wrong in the company of the
     other panes. */
  const namelessPreset=presets.find(p=>!p.name.trim());
  if(namelessPreset) return fail(at(namelessPreset,'command'),'a preset has no name');
  const nameless=layouts.findIndex(l=>!l.name.trim());
  if(nameless>=0) return fail(0,`layout #${nameless+1} has no name`);
  const empty=layouts.find(l=>!l.panes.length);
  if(empty) return fail(0,`layout "${empty.name}" has no [[layout.pane]]`);
  for(const l of layouts){
    const seen=new Set();
    for(const p of l.panes){
      const n=(p.name||'').trim();
      if(n){
        if(seen.has(n)) return fail(at(p,'name'),`two panes are named "${n}" — "of" could not tell them apart`);
        seen.add(n); }
      if(p.preset!==undefined){
        const cited=presets.find(x=>x.name.trim()===p.preset.trim());
        if(!cited) return fail(at(p,'preset'),`no [[preset]] is named "${p.preset}"`);
        if(at(p,'command')) return fail(at(p,'command'),'a pane takes preset or command, not both');
        p.command=cited.command; }
    }
    // The tabs and the anchors have to hold, and it is the same walk, so it reports
    // here rather than failing later with no line to name.
    const planned=planTabs(l,at);
    if(planned.error) return {presets:[],layouts:[],error:planned.error};
  }
  return {presets,layouts,error:null};
}

/* A layout opens its own TABS: the first pane of a tab IS that tab, not a split of
   whatever happened to be on screen. That is what lets an eight-pane file produce
   eight panes, and why `startup` can be honoured before anything else exists.

   Grouping them is what the cards show, and it is the same walk that validates `of` —
   so it is written once and called from both.

   The mock stops at the grouping. The real planner also compiles the CUTS (a balanced
   grid when no pane says `split`, the file's own order when one does), which this
   prototype cannot show: `paneTabHTML` lays panes out in one flex row, not a split
   tree. That geometry lives in `layoutsFormat.ts` with its own checks, and inventing a
   second version of it here would be a copy nobody could trust. */
function planTabs(layout,at){
  at=at||(()=>0);
  const tabs=[]; const byName=new Map(); let currentTab=null;
  for(const pane of layout.panes){
    if((pane.tab||'').trim()) currentTab=pane.tab.trim();
    let plan=byName.get(currentTab);
    if(!plan){ plan={tab:currentTab,panes:[]}; byName.set(currentTab,plan); tabs.push(plan); }
    plan.panes.push(pane);
  }
  for(const plan of tabs){
    const first=plan.panes[0];
    for(const key of ['split','of','size'])
      if(first[key]!==undefined) return {tabs,error:{line:at(first,key),
        message:`the first pane of a tab is the whole area — it has no ${key}`}};
    for(let i=1;i<plan.panes.length;i++){
      const pane=plan.panes[i];
      if(pane.of===undefined) continue;
      const wanted=pane.of.trim();
      const found=plan.panes.findIndex((p,j)=>j<i&&(p.name||'').trim()===wanted);
      if(found<0){
        const elsewhere=layout.panes.some(p=>(p.name||'').trim()===wanted);
        return {tabs,error:{line:at(pane,'of'),message:elsewhere
          ? `"${wanted}" is in another tab, or comes later — "of" points at a pane already placed in this tab`
          : `no pane placed before this one is named "${wanted}"`}};
      }
    }
  }
  return {tabs,error:null};
}
function planLayout(layout){ return planTabs(layout).tabs; }

/* The pane header a layout asks for, when it does not name one itself. */
function paneLabel(p){
  return (p.name||'').trim() || (p.machine||'').trim()
    || ((p.command||'').trim().split(/\s+/)[0] || '');
}

let PANE_LAYOUTS=[], LAYOUT_ERROR=null, SPLIT_PRESETS=[];
/* The plain split: always offered, never editable, not in anyone's file. It is what
   the split BUTTON does, and listing it is what makes the menu a superset of the
   button rather than a different feature. */
const PLAIN_PRESET={ id:'plain', name:'Terminal', command:'', builtin:true };
/* The two shipped presets are a FALLBACK, not a default written into a file: they
   appear only while the file declares nothing at all. A file with a layout and no
   preset is a decision, and a fallback that overrode it would be a bug. */
const DEFAULT_PRESETS=[{id:'sp-load',name:'Load',command:'top'},{id:'sp-disk',name:'Disk',command:'df -h'}];
function reloadLayouts(){
  // No file, nothing to load — not an empty file, and not a default standing in for
  // one. The browser shell lands here (see `hasWorkspaceFile`), which is why its
  // split chevron offers the plain divider and its snippets, and nothing else.
  if(!hasWorkspaceFile()){
    PANE_LAYOUTS=[]; SPLIT_PRESETS=[]; LAYOUT_ERROR=null;
    return {presets:[],layouts:[],error:null};
  }
  const r=parseLayoutFile(LAYOUT_FILE);
  // A broken file keeps the layouts and presets you had; it does not empty the menu
  // under you. It only stops NEW ones from loading, and says why.
  if(!r.error){
    PANE_LAYOUTS=r.layouts;
    SPLIT_PRESETS=r.presets.length? r.presets : (r.layouts.length? [] : DEFAULT_PRESETS.slice());
  }
  LAYOUT_ERROR=r.error;
  return r;
}
/* Read once here so a page that only includes rite.js still has something, and again
   from each entry page's boot — `WORKSPACE_FILE` is declared in the page, which is a
   later <script> than this one, so this first read cannot see it. */
reloadLayouts();

/* Does this shell have a workspace file at all? The desktop is a machine, so yes; the
   browser talks to a server, where there is no file and nothing stands in for one
   (ADR 0023) — the two sections and the button are ABSENT there, not empty. Each entry
   page answers for itself, and the desktop's answer is the default. */
function hasWorkspaceFile(){ return typeof WORKSPACE_FILE==='undefined' ? true : !!WORKSPACE_FILE; }

/* ===== Two edits made from the UI, spliced into the file =====

   The file is hand-written and commented, so an edit from a dialog or a switch
   REWRITES ONE THING and leaves every other line as it was typed. Regenerating the
   document from the parse would be easier and would silently throw away the comments,
   the blank lines and the order someone chose.

   The file editor is the exception, and deliberately: its textarea IS the file, so
   Save stores the whole thing. Press ↻ Reload there before typing if something else
   has written since you opened it. */
function quoteVal(s){ return `"${String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`; }
/* The preset dialog's whole library becomes the file's first [[preset]] block; the
   other preset blocks go away. Comments written INSIDE a preset block are the one
   thing this loses — they belong to the rows being replaced. */
function replacePresetBlocks(text,presets){
  const lines=(text||'').split('\n');
  const isHeader=l=>stripComment(l).trim().startsWith('[');
  const isPresetHeader=l=>stripComment(l).trim()==='[[preset]]';
  const block=presets.map(p=>['[[preset]]',`name = ${quoteVal(p.name)}`,`command = ${quoteVal(p.command)}`].join('\n')).join('\n\n');
  const out=[]; let written=false, i=0;
  // Everything before the first table header is the file's own preamble and stays put.
  while(i<lines.length&&!isHeader(lines[i])) out.push(lines[i++]);
  for(;i<lines.length;i++){
    if(!isPresetHeader(lines[i])){
      if(!written&&isHeader(lines[i])){ if(block) out.push(block,''); written=true; }
      out.push(lines[i]); continue;
    }
    if(!written){ if(block) out.push(block,''); written=true; }
    i++;
    while(i<lines.length&&!isHeader(lines[i])) i++;
    i--; // land on the header that ended the block, so the loop's step reaches it
  }
  if(!written&&block){
    // No table at all: the preamble is the whole file, so the presets go after it.
    if(out.length&&out[out.length-1].trim()!=='') out.push('');
    out.push(block,'');
  }
  return out.join('\n');
}
/* The startup switch. The target is the layout's POSITION in the file, not its name:
   two layouts may legitimately share a name, and the position is what the parse
   returns. Off REMOVES the line rather than writing `startup = false`, so the file
   stays free of a key that states the default. An index no layout occupies returns the
   text unchanged — the file may have been edited under the dialog, and rewriting the
   wrong layout would be worse than doing nothing. */
function setLayoutStartup(text,index,startup){
  const lines=(text||'').split('\n');
  const isHeader=l=>stripComment(l).trim().startsWith('[');
  const keyOf=l=>{const m=/^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(stripComment(l).trim());return m?m[1]:undefined;};
  const indentOf=l=>(/^\s*/.exec(l||'')||[''])[0];
  let seen=-1, start=-1;
  for(let i=0;i<lines.length;i++){
    if(stripComment(lines[i]).trim()!=='[[layout]]') continue;
    seen++;
    if(seen===index){ start=i; break; }
  }
  if(start<0) return text||'';
  let end=start+1;
  while(end<lines.length&&!isHeader(lines[end])) end++; // stops at the first pane
  const body=lines.slice(start+1,end);
  const out=lines.slice();
  const at=body.findIndex(l=>keyOf(l)==='startup');
  if(at>=0){
    if(startup) out[start+1+at]=indentOf(lines[start+1+at])+'startup = true';
    else out.splice(start+1+at,1);
    return out.join('\n');
  }
  if(!startup) return text||'';
  const nameAt=body.findIndex(l=>keyOf(l)==='name');
  const insertAt=nameAt>=0? start+2+nameAt : start+1;
  out.splice(insertAt,0,indentOf(lines[insertAt-1])+'startup = true');
  return out.join('\n');
}

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
function splitWith(presetId){ const t=curTab();
  // `plain` is not in the file, so it is looked up before it: the split BUTTON must
  // keep working on a shell that has no workspace file at all.
  const p = presetId==='plain' ? PLAIN_PRESET : SPLIT_PRESETS.find(x=>x.id===presetId);
  if(p) addPane(paneFromPreset(p,t&&t.host));
}
/* Open a layout. `command` is already resolved — a pane citing a `preset` had the
   preset's command folded in at parse — so nothing here looks a preset up again.

   The real app opens one TAB per named tab of the plan. The mock has a single terminal
   tab, so it opens every pane into the one on screen and the toast says how many tabs
   that collapsed, rather than pretending the file's tabs do not exist. */
function applyLayout(id){ const l=PANE_LAYOUTS.find(x=>x.id===id); const t=curTab(); if(!l||!t) return;
  let fellBack=0;
  const plans=planLayout(l);
  plans.forEach(plan=>plan.panes.forEach(p=>{
    const tgt=layoutTarget(p);
    if(tgt.warn) fellBack++;
    t.panes.push({ kind:'term', host:tgt.host, warn:tgt.warn,
      name:paneLabel(p)||null,
      cmd:p.command||'', lines:p.command?['(running — this is an ordinary terminal pane)']:null });
  }));
  t.focus=t.panes.length-1; renderMain();
  const tabs=plans.length>1?` · ${plans.length} tabs in one here`:'';
  toast(fellBack
    ? `Layout <span class="accent">${l.name}</span> — ${l.panes.length} panes, ${fellBack} fell back to a plain shell${tabs}`
    : `Layout <span class="accent">${l.name}</span> — ${l.panes.length} panes opened${tabs}`);}

/* Everything a split can be, behind the chevron. The plain one is also here, first,
   so the menu is a superset of the button rather than a different feature. */
function splitMenu(e){
  e.stopPropagation();
  const t=curTab(); const host=t&&t.host;
  const items = [PLAIN_PRESET].concat(SPLIT_PRESETS).map(p=>({ icon:ICON.term,
    label:`${p.name}${p.command?`<div class="sub mono" style="font-size:11px;color:var(--muted);font-weight:400">${p.command}</div>`:''}`,
    onclick:()=>splitWith(p.id) }));
  items.push({ icon:EXICON.split, label:'Snippets…', onclick:()=>openSnippets(host||null) });
  PANE_LAYOUTS.forEach(l=>items.push({ icon:EXICON.panel,
    label:`${l.name}<div class="sub" style="font-size:11px;color:var(--muted);font-weight:400">${l.panes.length} panes</div>`,
    onclick:()=>applyLayout(l.id) }));
  // Nothing to configure where there is no file to write it to (ADR 0023).
  if(hasWorkspaceFile()) items.push({ icon:EXICON.gear, label:'Split presets…', onclick:()=>dlgSplitPrefs() });
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
  // No second test for "is there a file": a shell without one loads no layouts and no
  // error, so the line below already hides the button — and one rule in one place is
  // what keeps the two from disagreeing.
  if(!PANE_LAYOUTS.length && !LAYOUT_ERROR) return '';
  const bad=!!LAYOUT_ERROR;
  return `<button class="mtab-new" title="${bad?'Layouts — your layouts.toml has an error':'Layouts — open a saved arrangement in this tab'}"
    onclick="layoutsMenu(event)"${bad?' style="color:var(--amber)"':''}>${EXICON.panel}${EXICON.chevD}</button>`;
}
function layoutsMenu(e){
  e.stopPropagation();
  const items = PANE_LAYOUTS.map(l=>({ icon:EXICON.panel,
    label:`${l.name}<div class="sub" style="font-size:11px;color:var(--muted);font-weight:400">${l.panes.length} panes · ${l.panes.map(paneLabel).join(' · ')}</div>`,
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
   one screen. This dialog saves as you go, so it has no footer (see showModal).

   Every edit here SPLICES the file's [[preset]] blocks and leaves the layouts, the
   comments and the blank lines exactly as typed — the presets and the layouts share
   one file, so a list of fields may not regenerate the document. */
function presetsFromDialog(presets){
  LAYOUT_FILE=replacePresetBlocks(LAYOUT_FILE,presets);
  reloadLayouts();
  if(typeof renderMain==='function') renderMain();
}
function splitPrefsBody(){
  const preset = (p,i) => `<div class="snip-row">
    <div class="snip-meta"><div class="snip-name">${p.name}${p.builtin?' <span class="snip-count">always there</span>':''}</div>
      <code class="snip-cmd">${p.command||'a plain shell — no command'}</code></div>
    ${p.builtin?'':`<button class="btn btn-ghost btn-sm" data-sp-edit="${i}" title="Edit">Edit</button>
    <button class="btn btn-ghost btn-sm" data-sp-del="${i}" title="Remove">✕</button>`}</div>`;
  return `<p class="muted" style="font-size:12px;margin:0 0 10px">Splitting a pane opens a <b>plain terminal</b> — that is the button.
    A preset is the same divider running one named command, offered by the chevron beside it.
    Arranging a whole tab is a <b>layout</b>, and both live in <code>${LAYOUT_PATH}</code>: ${'' /* keep the two apart */}
    <button class="btn btn-ghost btn-sm" style="padding:1px 7px" onclick="this.closest('.backdrop').remove();dlgLayouts()">Layouts…</button></p>
    <div class="snip-list">${[PLAIN_PRESET].concat(SPLIT_PRESETS).map((p,i)=>preset(p,i-1)).join('')}</div>
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
    else if(t.dataset.spDel!==undefined){
      const next=SPLIT_PRESETS.slice(); next.splice(+t.dataset.spDel,1);
      presetsFromDialog(next); EDITING.preset=-1;}
    else if(t.dataset.spAdd!==undefined){
      const n=(body.querySelector('#sp-name').value||'').trim(), c=(body.querySelector('#sp-cmd').value||'').trim();
      if(!n){toast('Give the preset a name');return;}
      const next=SPLIT_PRESETS.map(x=>({...x}));
      if(EDITING.preset>=0){Object.assign(next[EDITING.preset],{name:n,command:c});EDITING.preset=-1;}
      else next.push({id:'p'+Math.random().toString(36).slice(2,7),name:n,command:c});
      presetsFromDialog(next);}
    redraw();});
  return bd;
}

/* ===== The layout cards =====

   What the file opens, grouped the way it will open it, resolved against the library
   THIS computer has. Two places show them from this one function: Settings ▸ Layouts,
   which leads with them, and the file editor, which lists them under the textarea.

   `toggle` is the only difference, and it is a data-loss rule rather than a style: in
   Settings the switch writes `startup` straight into the file, which is safe because
   nothing there holds an unsaved copy of it. The EDITOR passes no toggle — it has a
   draft in a textarea, and a switch that rewrote the file under an unsaved edit would
   throw that edit away. There the badge stays what it has always been: a statement,
   not a control. */
function layoutCardsHTML(opts){
  opts=opts||{};
  const where=p=>{
    if(!p.machine) return '<span class="muted">this computer</span>';
    const tgt=layoutTarget(p);
    return tgt.host? `<span class="ok">${p.machine}</span>`
      : `<span style="color:var(--amber)">${p.machine} → plain shell</span>`;
  };
  const paneRow=p=>`<div style="display:flex;gap:8px;font-size:12px;padding:2px 0">
    <span style="flex:0 0 150px">${where(p)}</span>
    <code class="mono" style="color:var(--fg-dim);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.command||'(plain shell)'}</code>
    <span class="muted" style="flex:0 0 auto">${paneLabel(p)}</span></div>`;
  return PANE_LAYOUTS.map((l,index)=>{
    /* A checkbox and not a radio: the file lets several layouts open at startup, each
       in its own tabs, and that is useful — one for what you watch, one for what you
       work on. A radio would be a narrower file format pretending to be a widget. */
    const startup = opts.toggle
      ? `<label class="lay-startup"><input type="checkbox" data-lay-startup="${index}"${l.startup?' checked':''}> at startup</label>`
      : (l.startup?'<span class="snip-count" style="color:var(--accent);border-color:color-mix(in oklab,var(--accent) 40%,transparent)">at startup</span>':'');
    /* Grouped as it will open: a layout may name tabs, and a pane listed under the
       wrong one would be the opposite of what this list is for. */
    const body = planLayout(l).map(plan=>
      (plan.tab?`<div class="eyebrow" style="margin:4px 0 1px">Tab “${plan.tab}”</div>`:'')
      + plan.panes.map(paneRow).join('')).join('');
    return `<div class="snip-row" style="display:block" data-lay-card="${index}">
      <div class="snip-name" style="margin-bottom:4px;display:flex;align-items:center;gap:6px">
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.name}</span>
        <span class="snip-count">${l.panes.length} panes</span>
        ${startup}</div>
      ${body}</div>`;
  }).join('');
}
/* The parse error, where you look first. "No layouts" and "your file has a typo on
   line 12" are very different facts and used to look identical in Settings — a title
   and a button, with the difference hidden behind the button. */
function layoutErrorHTML(){
  if(!LAYOUT_ERROR) return '';
  return `<div class="lay-err">⚠ <b>Not loaded.</b> ${LAYOUT_ERROR.line?`Line ${LAYOUT_ERROR.line}: `:''}${LAYOUT_ERROR.message}<br>
    <span class="muted">The layouts already loaded keep working until the file parses again.</span></div>`;
}
/* Settings ▸ Layouts: the cards, then the file.

   It was a title and an "Open the layouts file…" button, so the only answer to "what
   do I have" was behind a click and below a textarea. The cards lead; the button is
   for EDITING, which is a rarer thing to want than looking. */
function layoutsSettingsHTML(){
  const cards=layoutCardsHTML({toggle:true});
  return `<h4>Layouts</h4><p class="lede">What opens when you sit down: which terminals, in what order, on which machines.
      Kept as a file so you can version it and carry it between computers.</p>
    ${layoutErrorHTML()}
    ${cards? `<div class="snip-list" data-lay-cards>${cards}</div>`
      : (LAYOUT_ERROR?'':'<p class="muted" style="font-size:12.5px;margin:2px 0 10px" data-lay-empty>No layouts yet. Open the file and describe what should open when you sit down.</p>')}
    <div style="display:flex;align-items:center;gap:10px;margin-top:12px">
      <button class="btn btn-sm" onclick="dlgLayouts()">Open the layouts file…</button>
      <code class="muted" style="font-size:11.5px">${LAYOUT_PATH}</code></div>
    <p class="muted" style="font-size:12px;margin:10px 0 0;line-height:1.5">Tick “at startup” and the layout opens itself when Rite starts —
      several may, each in its own tabs. The switch writes <code>startup</code> into the file.</p>`;
}
/* The startup switch, wherever it is drawn. One checkbox, one key, spliced — and a
   re-render, because the file is the state and the box only reflected it. */
function wireStartupToggles(root,after){
  root.addEventListener('change',e=>{
    const t=e.target.closest('[data-lay-startup]');
    if(!t) return;
    const index=+t.dataset.layStartup;
    const name=(PANE_LAYOUTS[index]||{}).name||'';
    LAYOUT_FILE=setLayoutStartup(LAYOUT_FILE,index,t.checked);
    reloadLayouts();
    if(typeof after==='function') after();
    if(typeof renderMain==='function') renderMain();
    toast(t.checked?`<span class="accent">${name}</span> opens when Rite starts`:`<span class="accent">${name}</span> no longer opens at startup`);
  });
}

/* ===== Layouts: the file, shown as the file =====

   Not a form over a file. A form would have to invent a widget for every key the file
   grows, and the file is the thing people copy between computers, mail to a colleague
   and commit — so the file is what the editor shows. Save parses it; a bad file is
   refused with its line number and the layouts you had keep working.

   This is the one place that stores the WHOLE text, which is why the startup switch is
   absent here and why ↻ Reload exists: another surface may have spliced the file since
   you opened this one. */
function layoutsBody(){
  const cards=layoutCardsHTML({});
  const err = LAYOUT_ERROR? layoutErrorHTML()
    : `<p class="lay-ok">✓ ${PANE_LAYOUTS.length} layout${PANE_LAYOUTS.length===1?'':'s'} loaded, ${SPLIT_PRESETS.length} preset${SPLIT_PRESETS.length===1?'':'s'}.</p>`;
  return `<p class="muted" style="font-size:12.5px;margin:0 0 10px;line-height:1.55">
      One file for how this machine is set up: <code>[[preset]]</code> is what the chevron beside a divider offers,
      <code>[[layout]]</code> is what you open when you sit down — which terminals, in what order, on which machines.
      A machine this computer doesn't have opens a <b>plain shell</b> with a note in the pane; the layout still opens.</p>
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
    <div class="snip-list">${cards||'<p class="muted" style="font-size:13px;margin:2px 0 10px">Nothing loaded.</p>'}</div>`;
}
function dlgLayouts(){
  const bd=showModal({title:'Layouts',subtitle:'What opens when you sit down',width:'620px',confirm:null,body:layoutsBody()});
  const body=bd.querySelector('.body');
  const redraw=()=>{body.innerHTML=layoutsBody();};
  body.addEventListener('click',e=>{
    const t=e.target.closest('[data-lay-save],[data-lay-reload],[data-lay-editor]');
    if(!t)return;
    if(t.dataset.layEditor!==undefined){ toast(`${LAYOUT_PATH} — opened in your editor`); return; }
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
