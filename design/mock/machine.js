/* Rite mock — machine dashboard + collection Board (shared by both shells, ADR 0019).
   These are *usage* features, not shell features: the same markup serves the desktop
   webview and the browser. Kept in its own file so neither entry page can quietly
   drift from the other — that drift is exactly how the web UI ended up with an
   undocumented dashboard in the first place.

   Each page supplies: STATE, renderSide/renderMain, M (icons), ICON, pastille,
   machineByName, jumpChain, connectMachine, dlgNewConn, floatMenu, isLocal, and
   DASH_SHELL — 'webui' in a browser, 'clients' in the desktop. */
/* Port forwarding (Wave-1): saved per-machine tunnels, started/stopped live. MVP =
   LOCAL forward (127.0.0.1:localPort → remoteHost:remotePort over SSH, as seen from
   the host). Remote & dynamic (SOCKS) reserved in the UI, built later — all ride the
   same direct-tcpip channel + a local TCP listener (the channel-generic transport). */
/* ===== Machine dashboard (Wave-1, Control-Center encarts): selecting a machine
   opens its OWN view in the main area — an overview plus contextual cards Rite
   detects for that host (Containers, Services, Port forwards). One machine, one
   place. Cards act inline (start/stop, exec-in, restart) — deep-dive later. ===== */
const DEMO_CONTAINERS=[
  {name:'web',     image:'nginx:1.27',     state:'running', ports:'0.0.0.0:80->80', pinned:true,  cpu:'0.4%', mem:'82 MiB',  created:'3 days ago'},
  {name:'api',     image:'acme/api:2.4.1', state:'running', ports:'8080->8080',      pinned:true,  cpu:'2.1%', mem:'318 MiB', created:'3 days ago'},
  {name:'worker',  image:'acme/api:2.4.1', state:'running', ports:'',                pinned:false, cpu:'1.3%', mem:'204 MiB', created:'3 days ago'},
  {name:'redis',   image:'redis:7-alpine', state:'running', ports:'6379->6379',      pinned:false, cpu:'0.2%', mem:'12 MiB',  created:'8 days ago'},
  {name:'migrate', image:'acme/api:2.4.1', state:'exited',  ports:'',                pinned:false, cpu:'—',    mem:'—',       created:'3 days ago'},
];
const DEMO_SERVICES=[
  {name:'nginx.service',       desc:'A high performance web server', active:'active',   sub:'running', mem:'14.2 M',  since:'3 days ago'},
  {name:'app.service',         desc:'Acme API',                      active:'active',   sub:'running', mem:'186.4 M', since:'3 days ago'},
  {name:'postgresql.service',  desc:'PostgreSQL RDBMS',              active:'active',   sub:'running', mem:'512.0 M', since:'8 days ago'},
  {name:'certbot.timer',       desc:"Renew Let's Encrypt certs",     active:'active',   sub:'waiting', mem:'—',       since:'8 days ago'},
  {name:'backup.service',      desc:'Nightly backup',                active:'failed',   sub:'failed',  mem:'—',       since:'2h ago'},
  {name:'docker.service',      desc:'Docker Application Container',   active:'active',   sub:'running', mem:'96.8 M',  since:'8 days ago'},
  {name:'ufw.service',         desc:'Uncomplicated firewall',        active:'inactive', sub:'dead',    mem:'—',       since:'—'},
];
function svState(s){return s.active==='active'?'up':s.active==='failed'?'down':'seen';}
function ctList(cn){return (cn.containers||DEMO_CONTAINERS).filter(c=>(cn.ctMode||'live')==='live'||c.pinned);}
function svcList(cn){const all=cn.services||DEMO_SERVICES;const f=cn.svcFilter||'all';return all.filter(s=>f==='all'||(f==='failed'&&s.active==='failed')||(f==='active'&&s.active==='active'));}

/* ---- dashboard cards (rendered inline in the machine view) ----
   Each card can be Expanded (⤢) to span the full width and show a richer table with
   extra columns; and the whole set is configurable (Customize → show/hide). ---- */
const IC_EXP='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
const IC_COL='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4v2a2 2 0 0 1-2 2H4M20 8h-2a2 2 0 0 1-2-2V4M4 16h2a2 2 0 0 1 2 2v2M16 20v-2a2 2 0 0 1 2-2h2"/></svg>';
const IC_INFO='<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/></svg>';
function dashWide(cn,id){return (cn.dashWide||[]).includes(id);}
function dashToggleWide(name,id){const cn=machineByName(name);cn.dashWide=cn.dashWide||[];const i=cn.dashWide.indexOf(id);if(i<0)cn.dashWide.push(id);else cn.dashWide.splice(i,1);renderMain();}
function dcExp(cn,id){const w=dashWide(cn,id);return `<button class="dcard-x" onclick="dashToggleWide('${cn.name}','${id}')" title="${w?'Collapse':'Expand for more detail'}">${w?IC_COL:IC_EXP}</button>`;}

function pfCard(cn){cn.forwards=cn.forwards||[];
  const rows=cn.forwards.map((f,i)=>{const on=!!f.active;return `<div class="lrow">
    <span class="pf-badge">L</span>
    <span class="pf-route">127.0.0.1:${f.localPort} <span class="pf-arrow">${M.forward}</span> ${f.remoteHost}:${f.remotePort}</span>
    <span class="pst ${on?'up':'seen'}" title="${on?'Listening':'Stopped'}"></span>
    <button class="btn btn-ghost btn-sm" onclick="pfToggleFor('${cn.name}',${i})">${on?'Stop':'Start'}</button>
    <button class="btn btn-ghost btn-sm" onclick="pfDelFor('${cn.name}',${i})" title="Remove">✕</button>
  </div>`;}).join('')||`<p class="muted" style="font-size:12.5px">No forwards yet.</p>`;
  const live=cn.forwards.filter(f=>f.active).length;
  return `<div class="dcard ${dashWide(cn,'forwards')?'wide':''}">
    <div class="dcard-h">${M.forward}<span class="dcard-t">Port forwarding</span>${live?`<span class="chip-sm">${live} live</span>`:''}<span style="flex:1"></span><button class="btn btn-ghost btn-sm" onclick="dlgPortForward(machineByName('${cn.name}'))">Manage…</button>${dcExp(cn,'forwards')}</div>
    <div class="lrow-list">${rows}</div></div>`;}

/* Containers — compact list (normal) or a full table with CPU/Mem/Created (wide). */
function ctTable(cn){const rows=ctList(cn).map((c,i)=>{const up=c.state==='running';return `<tr>
    <td><span class="pst ${up?'up':'seen'}" title="${c.state}"></span></td>
    <td class="u-name">${c.name} ${c.pinned?'<span class="lpin" title="Pinned">★</span>':''}</td>
    <td class="u-desc mono">${c.image}</td>
    <td class="u-num">${c.ports||'—'}</td>
    <td class="u-num">${c.state}</td>
    <td class="u-num">${c.cpu||'—'}</td>
    <td class="u-num">${c.mem||'—'}</td>
    <td class="u-desc">${c.created||'—'}</td>
    <td class="right"><div class="u-act"><button class="btn btn-ghost btn-sm" ${up?'':'disabled'} onclick="ctExec('${cn.name}',${i})">Shell</button><button class="btn btn-ghost btn-sm" onclick="ctLog('${cn.name}',${i})">Logs</button><button class="btn btn-ghost btn-sm" onclick="ctRestart('${cn.name}',${i})" title="Restart">↻</button></div></td></tr>`;}).join('');
  return `<div class="dtwrap"><table class="dtable"><thead><tr><th></th><th>Name</th><th>Image</th><th>Ports</th><th>State</th><th>CPU</th><th>Mem</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;}
function ctCard(cn){cn.ctMode=cn.ctMode||'live';const rt=cn.runtime||'docker';const wide=dashWide(cn,'containers');
  const list=ctList(cn).map((c,i)=>{const up=c.state==='running';return `<div class="lrow">
    <span class="pst ${up?'up':'seen'}" title="${c.state}"></span>
    <div class="lmeta"><div class="lname">${c.name} ${c.pinned?'<span class="lpin" title="Pinned — 1-click">★</span>':''}</div><code class="lsub">${c.image}${c.ports?' · '+c.ports:''}</code></div>
    <button class="btn btn-ghost btn-sm" ${up?'':'disabled'} onclick="ctExec('${cn.name}',${i})" title="Exec a shell inside">Shell</button>
    <button class="btn btn-ghost btn-sm" onclick="ctLog('${cn.name}',${i})" title="Logs">Logs</button>
    <button class="btn btn-ghost btn-sm" onclick="ctRestart('${cn.name}',${i})" title="Restart">↻</button>
  </div>`;}).join('')||`<p class="muted" style="font-size:12.5px">No ${cn.ctMode==='live'?'containers':'pinned containers'}.</p>`;
  const body=ctList(cn).length&&wide?ctTable(cn):list;
  return `<div class="dcard ${wide?'wide':''}">
    <div class="dcard-h">${M.docker}<span class="dcard-t">Containers</span><span class="chip-sm">${rt}</span><span style="flex:1"></span>
      <div class="seg"><button class="seg-b ${cn.ctMode==='live'?'on':''}" onclick="ctSetMode('${cn.name}','live')">Live</button><button class="seg-b ${cn.ctMode==='pinned'?'on':''}" onclick="ctSetMode('${cn.name}','pinned')">Pinned</button></div>${dcExp(cn,'containers')}</div>
    <div class="lrow-list">${body}</div>
    <p class="muted" style="font-size:11.5px;margin:8px 0 0"><code style="font-family:ui-monospace,monospace">${rt} ps</code> over SSH · agentless. Shell = <code style="font-family:ui-monospace,monospace">${rt} exec -it &lt;name&gt; sh</code>.</p></div>`;}

/* Services — compact list (normal) or a full table with State/Memory/Since (wide). */
function svcTable(cn){const rows=svcList(cn).map((s,i)=>{const on=s.active==='active';return `<tr>
    <td><span class="pst ${svState(s)}" title="${s.active} · ${s.sub}"></span></td>
    <td class="u-name">${s.name}</td>
    <td class="u-desc">${s.desc}</td>
    <td><span class="${s.active==='failed'?'accent-red':''}">${s.active} (${s.sub})</span></td>
    <td class="u-num">${s.mem||'—'}</td>
    <td class="u-desc">${s.since||'—'}</td>
    <td class="right"><div class="u-act"><button class="btn btn-ghost btn-sm" onclick="svcAction('${cn.name}',${i},'restart')" title="Restart">↻</button><button class="btn btn-ghost btn-sm" onclick="svcAction('${cn.name}',${i},'toggle')">${on?'Stop':'Start'}</button><button class="btn btn-ghost btn-sm" onclick="svcAction('${cn.name}',${i},'journal')">Journal</button></div></td></tr>`;}).join('');
  return `<div class="dtwrap"><table class="dtable"><thead><tr><th></th><th>Unit</th><th>Description</th><th>State</th><th>Memory</th><th>Since</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;}
function svcCard(cn){cn.svcFilter=cn.svcFilter||'all';const all=cn.services||DEMO_SERVICES;const failed=all.filter(s=>s.active==='failed').length;const wide=dashWide(cn,'services');
  const list=svcList(cn).map((s,i)=>{const on=s.active==='active';return `<div class="lrow">
    <span class="pst ${svState(s)}" title="${s.active} · ${s.sub}"></span>
    <div class="lmeta"><div class="lname">${s.name}</div><code class="lsub">${s.desc} · <span class="${s.active==='failed'?'accent-red':''}">${s.active} (${s.sub})</span></code></div>
    <button class="btn btn-ghost btn-sm" onclick="svcAction('${cn.name}',${i},'restart')" title="Restart">↻</button>
    <button class="btn btn-ghost btn-sm" onclick="svcAction('${cn.name}',${i},'toggle')">${on?'Stop':'Start'}</button>
    <button class="btn btn-ghost btn-sm" onclick="svcAction('${cn.name}',${i},'journal')" title="Journal">Journal</button>
  </div>`;}).join('')||`<p class="muted" style="font-size:12.5px">No matching units.</p>`;
  const body=svcList(cn).length&&wide?svcTable(cn):list;
  return `<div class="dcard ${wide?'wide':''}">
    <div class="dcard-h">${M.service}<span class="dcard-t">Services</span>${failed?`<span class="chip-sm" style="color:var(--red);border-color:var(--red)">${failed} failed</span>`:''}<span style="flex:1"></span>
      <div class="seg"><button class="seg-b ${cn.svcFilter==='all'?'on':''}" onclick="svcSetFilter('${cn.name}','all')">All</button><button class="seg-b ${cn.svcFilter==='active'?'on':''}" onclick="svcSetFilter('${cn.name}','active')">Active</button><button class="seg-b ${cn.svcFilter==='failed'?'on':''}" onclick="svcSetFilter('${cn.name}','failed')">Failed</button></div>${dcExp(cn,'services')}</div>
    <div class="lrow-list">${body}</div></div>`;}

/* ---- inline card actions (mutate + re-render the dashboard) ---- */
function ctSetMode(name,m){const cn=machineByName(name);if(cn){cn.ctMode=m;renderMain();}}
function ctExec(name,i){const c=ctList(machineByName(name))[i];toast(`Opening a shell in <span class="accent">${c.name}</span> — docker exec -it ${c.name} sh`);}
function ctLog(name,i){const c=ctList(machineByName(name))[i];toast(`Tailing logs of <span class="accent">${c.name}</span>`);}
function ctRestart(name,i){const c=ctList(machineByName(name))[i];toast(`Restarting <span class="accent">${c.name}</span>…`);}
function svcSetFilter(name,f){const cn=machineByName(name);if(cn){cn.svcFilter=f;renderMain();}}
function svcAction(name,i,act){const cn=machineByName(name);const s=svcList(cn)[i];if(!s)return;
  if(act==='restart')toast(`Restarting <span class="accent">${s.name}</span>…`);
  else if(act==='journal')toast(`Tailing journal of <span class="accent">${s.name}</span>`);
  else if(act==='toggle'){const wasOn=s.active==='active';s.active=wasOn?'inactive':'active';s.sub=wasOn?'dead':'running';toast(`${wasOn?'Stopped':'Started'} <span class="accent">${s.name}</span>`);renderMain();}}
function pfToggleFor(name,i){const cn=machineByName(name);const f=(cn.forwards||[])[i];if(!f)return;f.active=!f.active;toast(f.active?`Forwarding <span class="accent">127.0.0.1:${f.localPort}</span> → ${f.remoteHost}:${f.remotePort}`:`Stopped forward on :${f.localPort}`);renderSide();renderMain();}
/* Confirm before removing a forward — the ✕ is small and easy to hit by accident. */
function pfConfirmDel(cn,i,after){const f=(cn.forwards||[])[i];if(!f)return;
  const route=`127.0.0.1:${f.localPort} → ${f.remoteHost}:${f.remotePort}`;
  showModal({title:'Remove this forward?',subtitle:route,confirm:'Remove',
    body:`<p style="font-size:13px;margin:0">This stops and removes the port forward <span class="mono">${route}</span>${f.active?' — it is <b>active</b> right now':''}. You can add it again anytime.</p>`,
    onConfirm:()=>{(cn.forwards||[]).splice(i,1);after&&after();}});}
function pfDelFor(name,i){const cn=machineByName(name);pfConfirmDel(cn,i,()=>{renderSide();renderMain();});}

/* ===== ADR 0019 — may the cards that reach out to a host run here? =====
   Two parties answer and the most restrictive one wins: the server policy
   (dashboard_policy, per shell) and this device's own setting. A "yes" is only ever a
   permission, never an instruction. A standalone vault has no server to consult, so
   only the user's setting applies — it is their vault, their network, their machines.
   Overview, port forwarding and the Board touch no host and are never gated. */
const PROBE_CARDS=['containers','services'];
function probeVerdict(){
  // Each page answers whether a server governs here at all: always in a browser, only in a
  // server context in the desktop (a vault — or the base workspace — has nobody to consult).
  if(typeof probeGoverned==='function'&&probeGoverned()){
    const p=STATE.dashPolicy||{webui:true,clients:true};
    const serverAllows=(DASH_SHELL==='webui'?p.webui:p.clients)!==false;
    if(!serverAllows)return {allowed:false,by:'server'};
  }
  return STATE.machineProbes===false?{allowed:false,by:'you'}:{allowed:true};
}
/* Why the cards are not there, in words the reader can act on. A blank panel for no
   stated reason reads as a broken one, and that is how it gets reported. */
function probeBlockedNote(){
  const v=probeVerdict();if(v.allowed)return '';
  const why=v.by==='server'
    ? (DASH_SHELL==='webui'
        ? 'This server turns container and service checks off for the web UI, so they run for nobody here.'
        : 'Your server turns container and service checks off for this client.')
    : 'Container and service checks are off in your settings — turn them back on under Machine status.';
  return `<div class="dnote">${IC_INFO}<span><b>Containers and Services are not shown.</b> ${why} Everything else on this dashboard is unaffected: refusing to probe is not refusing the feature.</span></div>`;
}

/* ---- the machine dashboard (main area) ---- */
function openMachine(name){STATE.machineView=name;STATE.mainTab='machine';renderSide();renderMain();}
function overviewCard(cn){const chain=jumpChain(cn);const wide=dashWide(cn,'overview');
  const rows=[
    ['Address',`${cn.user||'user'}@${cn.host||cn.name}:${cn.port||22}`],
    ['Auth',cn.authType?cn.authType:'password'],
    chain.length?['Jump',chain.join(' › ')]:null,
    ['Last used',cn.last||'—'],
  ].filter(Boolean).map(([k,v])=>`<div class="ov-row"><span class="ov-k">${k}</span><span class="ov-v mono">${v}</span></div>`).join('');
  return `<div class="dcard ${wide?'wide':''}"><div class="dcard-h">${M.machine}<span class="dcard-t">Overview</span><span style="flex:1"></span>${dcExp(cn,'overview')}</div><div class="ov ${wide?'ov2':''}">${rows}</div></div>`;}

/* Which cards show + in what order (Customize). Auto-detected cards can be hidden. */
const DASH_CARDS=[['overview','Overview'],['forwards','Port forwarding'],['containers','Containers'],['services','Services']];
const DASH_FN={overview:overviewCard,forwards:pfCard,containers:ctCard,services:svcCard};
function dashVisible(cn){const probes=probeVerdict().allowed;
  return DASH_CARDS.map(([id])=>id).filter(id=>!((cn.dashHidden||[]).includes(id))&&(probes||!PROBE_CARDS.includes(id)));}
function machineDashboard(cn){
  const cards=dashVisible(cn).map(id=>DASH_FN[id](cn)).join('')||`<p class="muted" style="font-size:13px;grid-column:1/-1;padding:8px 2px">All cards hidden — use <b>Customize</b> to add some.</p>`;
  return `<div class="mdash">
    <div class="mdash-hd">
      <span style="color:${cn.color||'var(--teal)'};display:grid;place-items:center">${M.machine}</span>
      <div class="mdash-id"><div class="mdash-name">${cn.name}${cn.jump?`<span class="jhop" title="via ${jumpChain(cn).join(' › ')}">${M.jump}</span>`:''}</div><div class="mdash-sub mono">${cn.user||'user'}@${cn.host||cn.name}:${cn.port||22}</div></div>
      ${pastille(cn)}
      <span style="flex:1"></span>
      <button class="btn btn-ghost btn-sm" onclick="dlgDashCustomize(machineByName('${cn.name}'))" title="Choose which cards appear"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"/><circle cx="15" cy="6" r="2" fill="var(--card)"/><circle cx="7" cy="12" r="2" fill="var(--card)"/><circle cx="12" cy="18" r="2" fill="var(--card)"/></svg> Customize</button>
      <button class="btn btn-ghost btn-sm" onclick="dlgNewConn('',machineByName('${cn.name}'))">${M.edit} Edit</button>
      <button class="btn btn-primary btn-sm" onclick="connectMachine('${cn.user||'user'}@${cn.host||cn.name}','${cn.name}')">${ICON.play} Connect</button>
    </div>
    <div class="dgrid">${cards}${probeBlockedNote()}</div>
    <div class="mdash-foot">${IC_INFO}<span>Cards are what Rite <b>detects</b> on this host — surfaced automatically, agentless (over the SSH session, through the jump host if any). Use <b>Customize</b> to choose cards, and the <b>expand</b> icon on a card for a fuller, wider view.</span></div>
  </div>`;}
/* Customize which cards appear on this machine's dashboard (per-machine, persisted on cn). */
function dlgDashCustomize(cn){cn.dashHidden=cn.dashHidden||[];
  const v=probeVerdict();
  const body=`<p class="muted" style="font-size:12px;margin:0 0 12px">Choose which cards appear on <b>${cn.name}</b>'s dashboard. Containers & Services are detected live over SSH; hide what you don't need.</p>
    <div class="dcust">${DASH_CARDS.map(([id,label])=>{const off=!v.allowed&&PROBE_CARDS.includes(id);
      return `<label class="dcust-row ${off?'off':''}"><span>${label}${off?`<span class="dcust-why">${v.by==='server'?'not allowed here':'off in your settings'}</span>`:''}</span><span class="toggle ${cn.dashHidden.includes(id)?'':'on'}" data-card="${id}"><i></i></span></label>`;}).join('')}</div>`;
  const m=showModal({title:'Customize dashboard',subtitle:cn.name,confirm:'Done',body});
  m.querySelectorAll('[data-card]').forEach(t=>t.onclick=()=>{const id=t.dataset.card;t.classList.toggle('on');const i=cn.dashHidden.indexOf(id);
    if(t.classList.contains('on')){if(i>=0)cn.dashHidden.splice(i,1);}else if(i<0)cn.dashHidden.push(id);renderMain();});}

function pfBody(cn){
  const rows=(cn.forwards||[]).map((f,i)=>{const on=!!f.active;return `<div class="pf-row">
    <span class="pf-badge">L</span>
    <span class="pf-route">127.0.0.1:${f.localPort} <span class="pf-arrow">${M.forward}</span> ${f.remoteHost}:${f.remotePort}</span>
    <span class="pst ${on?'up':'seen'}" title="${on?'Listening':'Stopped'}"></span>
    <button class="btn btn-ghost btn-sm" data-pf-toggle="${i}">${on?'Stop':'Start'}</button>
    <button class="btn btn-ghost btn-sm" data-pf-del="${i}" title="Remove">✕</button>
  </div>`;}).join('')||`<p class="muted" style="font-size:13px;margin:2px 0 12px">No forwards yet — add one below.</p>`;
  return `<div class="pf-list">${rows}</div>
    <div class="pf-seg-row"><span class="pf-seg on">Local</span><span class="pf-seg" title="Coming soon">Remote</span><span class="pf-seg" title="Coming soon">Dynamic (SOCKS)</span></div>
    <div class="pf-add">
      <label class="field" style="width:96px"><span>Local port</span><input class="inp" id="pf-lp" placeholder="5432"></label>
      <span class="pf-arrow" style="margin-top:20px">${M.forward}</span>
      <label class="field" style="flex:1;min-width:150px"><span>Remote host</span><input class="inp" id="pf-rh" placeholder="db.internal or localhost"></label>
      <label class="field" style="width:96px"><span>Remote port</span><input class="inp" id="pf-rp" placeholder="5432"></label>
      <button class="btn btn-primary btn-sm" data-pf-add style="margin-top:18px">Add</button>
    </div>
    <p class="muted" style="font-size:12px;margin:6px 0 0">A <b>local</b> forward: anything reaching <code style="font-family:ui-monospace,monospace">127.0.0.1:localport</code> is tunnelled over SSH to <code style="font-family:ui-monospace,monospace">remotehost:remoteport</code> as seen from <b>${cn.name}</b>. Remote &amp; dynamic (SOCKS) coming soon.</p>`;
}
function dlgPortForward(cn){cn.forwards=cn.forwards||[];
  const bd=showModal({title:'Port forwarding',subtitle:`${cn.name} — ${cn.user||'user'}@${cn.host||cn.name}`,wide:true,confirm:'Done',body:pfBody(cn)});
  const body=bd.querySelector('.body');
  body.addEventListener('click',e=>{const t=e.target.closest('[data-pf-toggle],[data-pf-del],[data-pf-add]');if(!t)return;
    if(t.dataset.pfDel!==undefined){pfConfirmDel(cn,+t.dataset.pfDel,()=>{body.innerHTML=pfBody(cn);renderSide();renderMain();});return;}
    if(t.dataset.pfToggle!==undefined){const f=cn.forwards[+t.dataset.pfToggle];f.active=!f.active;toast(f.active?`Forwarding <span class="accent">127.0.0.1:${f.localPort}</span> → ${f.remoteHost}:${f.remotePort}`:`Stopped forward on :${f.localPort}`);}
    else if(t.dataset.pfAdd!==undefined){const lp=(body.querySelector('#pf-lp').value||'').trim(),rh=(body.querySelector('#pf-rh').value||'').trim(),rp=(body.querySelector('#pf-rp').value||'').trim();
      if(!lp||!rh||!rp){toast('Fill local port, remote host and remote port');return;}
      cn.forwards.push({type:'local',localPort:lp,remoteHost:rh,remotePort:rp,active:true});toast(`Forwarding <span class="accent">127.0.0.1:${lp}</span> → ${rh}:${rp}`);}
    body.innerHTML=pfBody(cn);renderSide();renderMain();});
}
/* ===== Board (Wave-1): a shared, member-editable space per collection. Typed
   cards — Link (button → Grafana/runbook), Note (markdown), Action (run a snippet /
   open a TUI / connect), Live (a small dynamic list). ZK: it's collection data,
   encrypted for members. Zero infra integration — one primitive, many uses. ===== */
function mdMini(t){return (t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/`(.+?)`/g,'<code style="font-family:ui-monospace,monospace">$1</code>').replace(/\n/g,'<br>');}
/* Categories offered in the add form (plus any already present on the board). */
const BOARD_CATS=['Monitoring','Docs','Ops','Links','General'];
const B_ICON={link:'🔗',note:'📝',action:'⚡',live:'📡'};
const B_LABEL={link:'Link',note:'Note',action:'Action',live:'Live'};
function catOf(c){return c.cat||'General';}
function boardCats(coll){const s=new Set(BOARD_CATS);(coll.board||[]).forEach(c=>s.add(catOf(c)));return [...s];}
/* One-line preview text used on tiles/rows (markdown stripped, links show the URL). */
function boardPreview(c){
  if(c.type==='link')return c.url||'';
  if(c.type==='note')return (c.text||'').replace(/[*`]/g,'').replace(/\n+/g,' ');
  if(c.type==='action')return c.desc||('Runs: '+(c.label||'action'));
  if(c.type==='live')return (c.rows||[]).map(r=>r.text).join(' · ')||'—';
  return '';
}
/* Gallery tile — compact, clickable → detail modal. */
function boardTile(c,i){const emoji=c.type==='link'?(c.emoji||'🔗'):B_ICON[c.type];
  return `<div class="btile" data-b-open="${i}" title="Open">
    <div class="btile-h"><span class="btype">${B_LABEL[c.type]}</span><button class="btn btn-ghost btn-sm bx" data-b-del="${i}" title="Remove card">✕</button></div>
    <div class="btile-b"><span class="btile-emoji">${emoji}</span><div class="btile-meta"><div class="btitle">${c.title}</div><div class="btile-prev">${boardPreview(c)}</div></div></div>
  </div>`;}
/* List row — dense, clickable → detail modal. */
function boardRow(c,i){const emoji=c.type==='link'?(c.emoji||'🔗'):B_ICON[c.type];
  return `<div class="brow" data-b-open="${i}" title="Open">
    <span class="brow-emoji">${emoji}</span><span class="btype">${B_LABEL[c.type]}</span>
    <span class="brow-title">${c.title}</span><span class="brow-prev mono">${boardPreview(c)}</span>
    <button class="btn btn-ghost btn-sm bx" data-b-del="${i}" title="Remove card">✕</button>
  </div>`;}
/* Just the grouped sections (the part that redraws on filter/view change). */
function boardSections(coll){
  const view=coll.boardView||'gallery', filter=coll.boardCat||'all';
  const picked=coll.board.map((c,i)=>({c,i})).filter(x=>filter==='all'||catOf(x.c)===filter);
  const groups={};picked.forEach(x=>{(groups[catOf(x.c)]=groups[catOf(x.c)]||[]).push(x);});
  return Object.keys(groups).map(name=>{
    const items=groups[name].map(x=>view==='list'?boardRow(x.c,x.i):boardTile(x.c,x.i)).join('');
    return `<div class="bsec"><div class="bsec-h">${name}<span class="bsec-n">${groups[name].length}</span></div>
      <div class="${view==='list'?'blist':'bgal'}">${items}</div></div>`;
  }).join('')||`<p class="muted" style="font-size:13px;padding:8px 2px">No cards${filter!=='all'?' in this category':' yet'} — add a Link, Note, Action or Live view.</p>`;
}
function boardBody(coll){coll.board=coll.board||[];
  const view=coll.boardView||'gallery', filter=coll.boardCat||'all', cats=boardCats(coll);
  const sections=boardSections(coll);
  const chips=['all',...cats].map(cn=>`<button class="bchip ${filter===cn?'on':''}" data-b-cat="${cn}">${cn==='all'?'All':cn}</button>`).join('');
  // Fixed-height column: intro + toolbar stay put; only .bsecs scrolls/redraws on
  // filter/view change, so the modal never resizes (feels like filtering, not a new view).
  return `<div class="bmodal">
    <p class="muted" style="font-size:12px;margin:0 0 12px">${isLocal()
      ? `A space for <b>${coll.name}</b> — links, notes, one-click actions and live views. Encrypted in your vault. Click a card to open it.`
      : `A shared space for <b>${coll.name}</b> — links, notes, one-click actions and live views. Encrypted, members-only; write access can edit. Click a card to open it.`}</p>
    <div class="bbar">
      <div class="bchips">${chips}</div><span style="flex:1"></span>
      <div class="seg"><button class="seg-b ${view==='gallery'?'on':''}" data-b-view="gallery">Gallery</button><button class="seg-b ${view==='list'?'on':''}" data-b-view="list">List</button></div>
      <button class="btn btn-ghost btn-sm" data-b-add>+ Add card</button>
    </div>
    <div class="bsecs">${sections}</div>
  </div>`;
}
function dlgBoard(coll){coll.board=coll.board||[];coll.boardView=coll.boardView||'gallery';coll.boardCat=coll.boardCat||'all';
  const bd=showModal({title:`${coll.name} · Board`,subtitle:isLocal()?'local vault':(coll.shared?`${coll.members.length} members`:'personal'),width:'min(940px,94vw)',confirm:'Done',body:boardBody(coll)});
  const body=bd.querySelector('.body');
  const refresh=()=>{body.innerHTML=boardBody(coll);};       // full (chips/cats may change)
  const redraw=()=>{                                          // inner-only: filter/view feel
    const secs=body.querySelector('.bsecs');if(secs)secs.innerHTML=boardSections(coll);
    body.querySelectorAll('.bchip').forEach(el=>el.classList.toggle('on',el.dataset.bCat===(coll.boardCat||'all')));
    body.querySelectorAll('.seg-b[data-b-view]').forEach(el=>el.classList.toggle('on',el.dataset.bView===(coll.boardView||'gallery')));
  };
  body.addEventListener('click',e=>{const t=e.target.closest('[data-b-add],[data-b-del],[data-b-open],[data-b-view],[data-b-cat]');if(!t)return;
    if(t.dataset.bDel!==undefined){coll.board.splice(+t.dataset.bDel,1);refresh();}
    else if(t.dataset.bAdd!==undefined){boardAddMenu(coll,refresh,e);}
    else if(t.dataset.bView!==undefined){coll.boardView=t.dataset.bView;redraw();}
    else if(t.dataset.bCat!==undefined){coll.boardCat=t.dataset.bCat;redraw();}
    else if(t.dataset.bOpen!==undefined){dlgBoardCard(coll,+t.dataset.bOpen,refresh);}
  });
}
/* Detail modal — a card opened larger: full note, full URL before opening, etc. */
function dlgBoardCard(coll,i,refreshParent){const c=coll.board[i];if(!c)return;
  let inner='';
  if(c.type==='link'){inner=`<div class="bd-link"><span class="bd-emoji">${c.emoji||'🔗'}</span><div style="min-width:0"><div class="bd-url-lbl muted">Link destination</div><a class="bd-url" href="${c.url}" target="_blank" rel="noopener">${c.url}</a></div></div>
    <div class="bd-actions"><button class="btn btn-primary" data-b-go>${M.forward||''} Open link</button></div>`;}
  else if(c.type==='note'){inner=`<div class="bd-note">${mdMini(c.text)||'<span class="muted">Empty note.</span>'}</div>`;}
  else if(c.type==='action'){inner=`${c.desc?`<div class="bd-url-lbl muted">What it does</div><div class="bd-desc mono">${c.desc}</div>`:''}<div class="bd-actions"><button class="btn btn-primary" data-b-go>${c.label||'Run'}</button></div>`;}
  else if(c.type==='live'){inner=`<div class="blive" style="margin-top:2px">${(c.rows||[]).map(r=>`<div class="blive-row ${r.up?'':'down'}"><span class="pst ${r.up?'up':'down'}"></span><span class="mono" style="font-size:12px">${r.text}</span></div>`).join('')||'<span class="muted">No rows.</span>'}</div>`;}
  const body=`<div class="bd-wrap">${inner}</div>
    <div class="bd-foot"><button class="btn btn-ghost btn-sm" data-b-edit>${M.edit||''} Edit</button><span style="flex:1"></span><button class="btn btn-ghost btn-sm" data-b-rm style="color:var(--red)">Remove card</button></div>`;
  const m=showModal({title:`${B_ICON[c.type]} ${c.title}`,subtitle:`${B_LABEL[c.type]} · ${catOf(c)}`,width:'min(560px,92vw)',confirm:'Done',body});
  const go=m.querySelector('[data-b-go]');if(go)go.onclick=()=>{if(c.type==='link')toast(`Opening <span class="accent">${c.url}</span>`);else toast(`Ran <span class="accent">${c.title}</span>`);};
  const ed=m.querySelector('[data-b-edit]');if(ed)ed.onclick=()=>{m.remove();boardCardForm(coll,c.type,refreshParent,i);};
  const rm=m.querySelector('[data-b-rm]');if(rm)rm.onclick=()=>{coll.board.splice(i,1);m.remove();refreshParent&&refreshParent();};
}
function boardAddMenu(coll,refresh,e){floatMenu(e,[
  {icon:'🔗',label:'Link — a styled button',onclick:()=>boardCardForm(coll,'link',refresh)},
  {icon:'📝',label:'Note — short markdown',onclick:()=>boardCardForm(coll,'note',refresh)},
  {icon:'⚡',label:'Action — run / open / connect',onclick:()=>boardCardForm(coll,'action',refresh)},
  {icon:'📡',label:'Live — a small dynamic list',onclick:()=>boardCardForm(coll,'live',refresh)},
].map(x=>({icon:`<span style="font-size:15px">${x.icon}</span>`,label:x.label,onclick:x.onclick})));}
/* Create OR edit a card. editIdx (a board index) ⇒ prefill + replace in place;
   this is how you re-title, re-categorise or move a card between categories. */
function boardCardForm(coll,type,refresh,editIdx){
  const ex=(editIdx!=null)?coll.board[editIdx]:null;
  const A=s=>(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); // attribute-safe
  const T=s=>(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); // textarea-safe
  const defCat=ex?catOf(ex):((coll.boardCat&&coll.boardCat!=='all')?coll.boardCat:'General');
  const catList=boardCats(coll).map(c=>`<option value="${A(c)}">`).join('');
  const catField=`<label class="field"><span>Category</span><input class="inp" id="b-cat" list="b-cats" value="${A(defCat)}" placeholder="Ops"><datalist id="b-cats">${catList}</datalist></label>`;
  const forms={
    link:`<label class="field"><span>Title</span><input class="inp" id="b-title" value="${A(ex?.title)}" placeholder="Grafana"></label>
      <label class="field"><span>URL</span><input class="inp" id="b-url" value="${A(ex?.url)}" placeholder="https://grafana.acme.io"></label>
      <div style="display:flex;gap:10px"><label class="field" style="width:90px"><span>Emoji</span><input class="inp" id="b-emoji" value="${A(ex?.emoji)}" placeholder="📊"></label>${catField}</div>`,
    note:`<label class="field"><span>Title</span><input class="inp" id="b-title" value="${A(ex?.title)}" placeholder="Deploy window"></label>
      <label class="field"><span>Text <span class="muted" style="font-weight:400">· **bold**, \`code\`</span></span><textarea class="inp" id="b-text" rows="4" placeholder="Deploys **Tue/Thu 14:00**. Freeze on Fridays.">${T(ex?.text)}</textarea></label>${catField}`,
    action:`<label class="field"><span>Title</span><input class="inp" id="b-title" value="${A(ex?.title)}" placeholder="Restart API"></label>
      <div style="display:flex;gap:10px"><label class="field" style="width:130px"><span>Button label</span><input class="inp" id="b-label" value="${A(ex?.label)}" placeholder="Restart"></label>${catField}</div>
      <label class="field"><span>What it does <span class="muted" style="font-weight:400">· run a snippet / open a TUI / connect</span></span><input class="inp mono" id="b-desc" value="${A(ex?.desc)}" placeholder="systemctl restart app on web-01"></label>`,
    live:`<label class="field"><span>Title</span><input class="inp" id="b-title" value="${A(ex?.title)}" placeholder="Failed units (web-01)"></label>
      <label class="field"><span>Source</span><select class="inp" id="b-src"><option value="failed">systemd — failed units</option><option value="containers">Containers — docker ps</option></select></label>${catField}`,
  };
  showModal({title:ex?`Edit ${type} card`:`New ${type} card`,subtitle:`on ${coll.name}'s board`,confirm:ex?'Save':'Add',body:forms[type],onConfirm:(m)=>{const g=s=>m.querySelector(s);const title=(g('#b-title').value||'').trim()||type;
    let card={id:ex?ex.id:'b'+Math.random().toString(36).slice(2,6),type,title,cat:(g('#b-cat')?.value||'').trim()||'General'};
    if(type==='link'){card.url=(g('#b-url').value||'').trim()||'https://example.com';card.emoji=(g('#b-emoji').value||'').trim()||'🔗';}
    else if(type==='note'){card.text=(g('#b-text').value||'').trim();}
    else if(type==='action'){card.label=(g('#b-label').value||'').trim()||'Run';card.desc=(g('#b-desc').value||'').trim();}
    else if(type==='live'){card.rows=ex?.rows||(g('#b-src').value==='containers'?[{up:true,text:'web · nginx:1.27'},{up:true,text:'api · acme/api:2.4.1'},{up:false,text:'migrate · exited'}]:[{up:false,text:'backup.service — failed'},{up:true,text:'nginx.service — active'}]);}
    if(editIdx!=null)coll.board[editIdx]=card;else coll.board.push(card);refresh&&refresh();}});
}