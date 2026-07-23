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

function showModal({title,subtitle,body,confirm='Confirm',onConfirm,wide}){
  const bd=document.createElement('div'); bd.className='backdrop show';
  bd.innerHTML=`<div class="modal" ${wide?'style="max-width:520px"':''}>
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

/* mini terminal content */
function termHTML(host){
  const who=host?`<span class="ok">${host}</span>`:'<span class="ok">local</span>';
  const I=(d,r)=>`<svg class="icon" viewBox="0 0 24 24"${r?' style="transform:rotate(90deg)"':''}><path d="${d}"/></svg>`;
  const grip=`<div class="grip" title="Drag to reorganize pane"><div class="gr"><i></i><i></i></div><div class="gr"><i></i><i></i></div><div class="gr"><i></i><i></i></div></div>`;
  return `<div class="termpane">
    <div class="termpane-hdr">
      <div class="who">${host?'<span class="st"></span>':''}<span class="name">${host?host:'Local Terminal ('+(typeof STATE!=='undefined'?STATE.defaultShell:'fish')+')'}</span>${host?'<span class="muted" style="font-size:12px">Connected</span>':''}</div>
      <div class="termpane-acts">
        ${grip}
        <button title="Split horizontal (Ctrl+Shift+H)">${I('M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4m10-2V6a2 2 0 00-2-2h-4')}</button>
        <button title="Split vertical (Ctrl+Shift+V)">${I('M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4m10-2V6a2 2 0 00-2-2h-4',1)}</button>
        <button title="Detach to new tab">${I('M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14')}</button>
        <button title="Search in terminal (Ctrl+F)">${I('M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z')}</button>
        <button title="Close terminal">${I('M6 18L18 6M6 6l12 12')}</button>
      </div>
    </div>
    <div class="term-body scroll">
      <div class="ln di"># ${host?'ssh '+host:'local shell — /usr/bin/fish'}</div>
      <div class="ln"><span class="pr">${who} ~ ❯</span> uname -a</div>
      <div class="ln di">Linux rite 7.1.3 #1 SMP x86_64 GNU/Linux</div>
      <div class="ln"><span class="pr">${who} ~ ❯</span> ls</div>
      <div class="ln di">Documents  Downloads  projects  .config</div>
      <div class="ln"><span class="pr">${who} ~ ❯</span> <span class="cursor"></span></div>
    </div>
  </div>`;
}
