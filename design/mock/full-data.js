/* Extra mock data + icons for the comprehensive prototype (full.html). */
const EXICON = {
  users:'<svg class="icon" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M2.5 20a6.5 6.5 0 0113 0M16 5.5a3 3 0 010 5.5M21.5 20a6.5 6.5 0 00-4-5.6"/></svg>',
  gear:'<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a1 1 0 00.2 1.1l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1 1 0 00-1.1-.2 1 1 0 00-.6.9V21a2 2 0 11-4 0v-.2a1 1 0 00-.7-.9 1 1 0 00-1.1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1 1 0 00.2-1.1 1 1 0 00-.9-.6H3a2 2 0 110-4h.2a1 1 0 00.9-.7 1 1 0 00-.2-1.1l-.1-.1A2 2 0 116.6 4.6l.1.1a1 1 0 001.1.2H8a1 1 0 00.6-.9V3a2 2 0 114 0v.2a1 1 0 00.6.9 1 1 0 001.1-.2l.1-.1a2 2 0 112.8 2.8l-.1.1a1 1 0 00-.2 1.1V8a1 1 0 00.9.6H21a2 2 0 110 4h-.2a1 1 0 00-.9.6z"/></svg>',
  shield:'<svg class="icon" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
  split:'<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
  search:'<svg class="icon" viewBox="0 0 24 24"><path d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z"/></svg>',
  chevR:'<svg class="icon" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  chevD:'<svg class="icon" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  chevL:'<svg class="icon" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  home:'<svg class="icon" viewBox="0 0 24 24"><path d="M3 12l9-9 9 9M5 10v10h14V10"/></svg>',
  more:'<svg class="icon" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  panel:'<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
  share:'<svg class="icon" viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 13.4l7.6 4.2M15.8 6.4l-7.6 4.2"/></svg>',
  coll:'<svg class="icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
  key:'<svg class="icon" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M17 6l2 2M14 9l2 2"/></svg>',
  trash:'<svg class="icon" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13"/></svg>',
};

/* Org directory + teams (for the member picker / admin surface). */
const ORG = {
  me:'alex',
  users:[
    {u:'alex', role:'admin', label:'alex (you)'},
    {u:'carol', role:'user', label:'carol'},
    {u:'dan', role:'user', label:'dan'},
    {u:'erin', role:'user', label:'erin'},
    {u:'frank', role:'user', label:'frank'},
  ],
  // Teams are keyless rosters: a group of people + a per-member role ('admin' =
  // Manager, in the UI | member). Nothing is encrypted with a team key — sharing is
  // always a collection. A manager just manages who's in the team.
  teams:[
    {name:'Eng',    members:['alex','carol','dan'],  roles:{alex:'admin', carol:'admin', dan:'member'}},
    {name:'Ops',    members:['alex','erin','frank'], roles:{alex:'member', erin:'admin', frank:'member'}},
    {name:'Design', members:['alex','carol','erin'], roles:{alex:'admin', carol:'member', erin:'member'}},
  ],
};

/* Collections in the active context. Nesting = display-only (view hierarchy),
   never permission inheritance (ADR 0016). Each has an explicit member list. */
const COLL = [
  { id:'c-perso', name:'Personal', shared:false, members:['alex'], open:true,
    conns:[ {name:'Homelab', host:'192.168.1.10', user:'alex', port:22},
            {name:'Router', host:'192.168.1.1', user:'admin', port:22} ] },
  { id:'c-infra', name:'Infrastructure', shared:true, members:['alex','carol','dan','erin'], open:true,
    conns:[ {name:'Bastion', host:'bastion.acme.io', user:'alex', port:22} ],
    children:[
      { id:'c-prod', name:'Production', shared:true, members:['alex','carol','erin'],
        offer:{team:'Eng', label:'Production servers'},
        conns:[ {name:'web-01', host:'10.0.0.5', user:'deploy', port:22},
                {name:'web-02', host:'10.0.0.6', user:'deploy', port:22},
                {name:'lb-01', host:'10.0.0.4', user:'deploy', port:22} ] },
      { id:'c-stg', name:'Staging', shared:true, members:['alex','carol','dan'],
        conns:[ {name:'stg-web', host:'10.1.0.5', user:'deploy', port:22} ] },
    ] },
  { id:'c-db', name:'Databases', shared:true, members:['alex','dan'],
    conns:[ {name:'pg-prod', host:'db.acme.io', user:'dba', port:2222},
            {name:'redis', host:'cache.acme.io', user:'ops', port:22} ] },
  // Offered to Eng but I'm not a member yet → I can discover it + request access.
  { id:'c-analytics', name:'Analytics', shared:true, members:['carol','dan'],
    offer:{team:'Eng', label:'Analytics dashboards'},
    conns:[ {name:'grafana', host:'10.2.0.9', user:'viewer', port:22} ] },
];

/* Request → grant loop. A user discovers a collection offered to a team they're in
   and requests access; a key-holder (owner/editor) grants by sealing the itemsKey to
   their public key. The server sees only the metadata (who asked for which collection)
   — never a key. Kept here so every user mock shares one source of truth. */
// Incoming — requests the current user (ORG.me) can grant (collections I hold a key to).
ORG.accessRequests = [
  { user:'dan',   coll:'Production', team:'Eng', when:'2h ago' },
  { user:'frank', coll:'Databases',  team:null,  when:'yesterday' },
];
// Outgoing — discovery labels I've already requested and am waiting on.
ORG.myRequests = ['Analytics dashboards'];
