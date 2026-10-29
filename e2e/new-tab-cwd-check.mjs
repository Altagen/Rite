/**
 * Where a new tab's shell starts, and whose machine decides.
 *
 * `[terminal] newTabCwd` is parsed by `store/layoutsFormat.ts` and covered by
 * `e2e/layout-file-check.mjs`. What the value MEANS for the client reading it is a
 * different question, and this holds it: the document travels with the account, a browser
 * reads the same blob a desktop wrote, and a browser's local terminal is the instance's
 * shell in the instance's container (ADR 0031).
 *
 * The rule's discriminator is `isNativeShell()`, a global the wry shell injects and
 * Chromium does not have, so every Playwright suite exercises the browser arm and the
 * desktop arm would ship untested. Same reason `local-shell-source-check.mjs` exists.
 *
 * Three of these checks read source rather than call a function. The word `home` is spelled
 * in TypeScript and in Rust with nothing to import between them, and the accounts refusal
 * lives in Rust where no browser suite reaches — so what is asserted is that the two sides
 * still say the same thing.
 *
 * Run: node e2e/new-tab-cwd-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NEW_TAB_CWD_HOME,
  NEW_TAB_CWD_INHERIT,
} from '../apps/desktop/src/store/layoutsFormat.ts';
import { newTabCwdApplies, newTabCwdStart } from '../apps/desktop/src/utils/newTabCwd.ts';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
};

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SERVER = read('packages/rite-server/src/lib.rs');
const SETTINGS = read('apps/desktop/src/components/Settings.tsx');

console.log('where a new tab starts:');

check('a silent document starts the shell where it would have', () => {
  // `null` and not the shipped default, deliberately: today's behaviour has to stay
  // reachable by a document that never mentioned the key.
  assert.deepEqual(newTabCwdStart({ asked: null, runsHere: true, from: 's1' }), {});
});

check('inherit asks for the pane that has focus', () => {
  assert.deepEqual(newTabCwdStart({ asked: NEW_TAB_CWD_INHERIT, runsHere: true, from: 's1' }), {
    inheritCwdFrom: 's1',
  });
});

check('inherit with no pane to inherit from asks for nothing', () => {
  // The first tab of a session: there is nothing to leave behind, and an id nobody owns
  // would be refused by the server as another account's.
  assert.deepEqual(newTabCwdStart({ asked: NEW_TAB_CWD_INHERIT, runsHere: true }), {});
});

check('a directory is named, and the keyword for one travels unchanged', () => {
  assert.deepEqual(newTabCwdStart({ asked: '/srv/work', runsHere: true, from: 's1' }), {
    cwd: '/srv/work',
  });
  // `home` goes over the wire as the word: the client cannot know its own home directory,
  // and the machine that starts the shell can.
  assert.deepEqual(newTabCwdStart({ asked: NEW_TAB_CWD_HOME, runsHere: true }), {
    cwd: NEW_TAB_CWD_HOME,
  });
});

check('a browser reads the value and asks for nothing', () => {
  // The whole point. Its local terminal is the instance's shell in the instance's
  // container, so a directory a desktop wrote means nothing there — and a client naming
  // one would be choosing where a shared server spawns a shell. Nothing is imposed
  // either: a machine reached over SSH from the web UI has paths this document never
  // described.
  for (const asked of [NEW_TAB_CWD_INHERIT, NEW_TAB_CWD_HOME, '/srv/work']) {
    assert.deepEqual(newTabCwdStart({ asked, runsHere: false, from: 's1' }), {}, asked);
  }
});

check('at most one answer is ever asked for', () => {
  // A session to inherit from and a directory to start in are two answers to one
  // question. A request carrying both would leave the precedence to be agreed twice.
  for (const asked of [null, NEW_TAB_CWD_INHERIT, NEW_TAB_CWD_HOME, '/srv/work']) {
    for (const from of ['s1', undefined]) {
      for (const runsHere of [true, false]) {
        const keys = Object.keys(newTabCwdStart({ asked, runsHere, from }));
        assert.ok(keys.length <= 1, `${asked} / ${from} / ${runsHere} asked for ${keys}`);
      }
    }
  }
});

console.log('\nthe two sides spell the keyword the same way:');

check('the server resolves the same word the document takes', () => {
  // Duplicated across two languages, where there is nothing to import. If one side is
  // renamed, the document's `home` silently stops being a directory anyone starts in.
  assert.ok(
    SERVER.includes(`"${NEW_TAB_CWD_HOME}" => std::env::var_os("HOME")`),
    `rite-server does not resolve "${NEW_TAB_CWD_HOME}" against $HOME`,
  );
});

check('a shared instance names no directory at all', () => {
  // The gate is INSIDE the rule, not beside its call: a second call site could otherwise
  // be added without it. A browser sends nothing, and this is what makes that safe rather
  // than merely polite.
  const fn = /fn named_start_dir\([^)]*\) -> Option<std::path::PathBuf> \{\n([\s\S]*?)\n\}/.exec(
    SERVER,
  );
  assert.ok(fn, 'named_start_dir is gone or no longer answers with a path');
  assert.ok(
    /if accounts \{\s*return None;/.test(fn[1]),
    'named_start_dir no longer refuses every directory in accounts mode',
  );
  assert.ok(
    SERVER.includes('named_start_dir(raw, state.accounts)'),
    'the caller no longer passes the instance mode into the rule',
  );
});

check('the directory reaches the request the client sends', () => {
  // Three files, one field name. `inheritCwdFrom` was dropped in silence once already,
  // by a missing serde rename — a split that quietly stopped inheriting.
  assert.ok(
    read('apps/desktop/src/utils/backend.ts').includes('cwd: start?.cwd'),
    'backend.ts no longer sends the named directory',
  );
  assert.ok(
    read('apps/desktop/src/utils/httpRoutes.ts').includes('cwd: a.cwd'),
    'the HTTP route no longer posts the named directory',
  );
  assert.ok(
    /#\[serde\(rename_all = "camelCase"\)\]\nstruct LocalReq/.test(SERVER),
    'LocalReq lost the rename that makes the client field names arrive',
  );
});

console.log('\nthe question is asked in one place:');

check('nothing else decides what newTabCwd means', () => {
  // The rule has one home, because `localShellSource.ts` earned that lesson: a bare
  // `isServerCtx` at each site is what let two of five places be converted and three
  // forgotten, and the owner found it in two minutes of use.
  const workspace = read('apps/desktop/src/components/Workspace.tsx');
  assert.ok(workspace.includes('newTabCwdStart({'), 'Workspace no longer asks the rule');
  // And asks it about the DOCUMENT. Passing a constant here would leave every assertion
  // above passing while the setting reached nothing — the rule is pure, so it cannot tell
  // what it was handed.
  assert.ok(
    /asked: newTabCwd,/.test(workspace),
    'Workspace no longer passes the document value into the rule',
  );
  assert.ok(
    /useLayouts\(\(s\) => s\.newTabCwd\)/.test(workspace),
    'Workspace no longer reads the value from the workspace document',
  );
  const inline = workspace
    .split('\n')
    .filter((line) => /newTabCwd\s*===|=== NEW_TAB_CWD/.test(line));
  assert.deepEqual(inline, [], `Workspace compares the value itself: ${inline.join(' / ')}`);
});

check('the store writes the value into the document and nowhere else', () => {
  // ADR 0023: the file IS the value. A second place holding it is how the file comes to
  // win or lose depending on which was touched last — the reason `copyMode` is reported
  // in Settings rather than offered there.
  const store = read('apps/desktop/src/store/layouts.ts');
  assert.ok(
    /setTerminalValue\(get\(\)\.text, 'newTabCwd', where\)/.test(store),
    'setNewTabCwd no longer writes [terminal] newTabCwd into the document',
  );
  assert.ok(
    /newTabCwd: parse\.error \? get\(\)\.newTabCwd : \(parse\.terminal\.newTabCwd \?\? null\)/.test(
      store,
    ),
    'the store no longer reads the value back out of the parsed document',
  );
  // Every place that re-parses carries it, or one path through the store would answer
  // with a stale value: two reads and the write-back.
  assert.equal(
    (store.match(/newTabCwd: parse\.error/g) || []).length,
    3,
    'a path through the store re-parses the document without carrying newTabCwd',
  );
});

console.log('\nthe row in Settings:');

check('the control is offered exactly where the rule acts', () => {
  // Not two readings of `runsHere`. A row that writes a value this client ignores is a
  // switch for something that cannot happen, which is the mistake `shellControls` was
  // written to end — so the gate and the behaviour are one function.
  for (const runsHere of [true, false]) {
    const acts = Object.keys(newTabCwdStart({ asked: '/srv/work', runsHere })).length > 0;
    assert.equal(newTabCwdApplies({ runsHere }), acts, `runsHere=${runsHere}`);
  }
});

check('Settings asks that function, and a document it can write', () => {
  assert.ok(
    SETTINGS.includes('newTabCwdApplies(shellOwnership) && hasWorkspaceFile'),
    'the row no longer borrows both conditions — the rule, and a readable document',
  );
});

check('the row offers the document value and holds no copy of it', () => {
  // ADR 0023: the file IS the value. `copyMode` is reported rather than offered next door
  // because a dropdown beside the file would be a second place to set one value; a
  // dropdown that WRITES the file is not.
  assert.ok(
    /useLayouts\(\(st\) => st\.newTabCwd\)/.test(SETTINGS),
    'Settings no longer reads the value from the workspace document',
  );
  assert.ok(
    /useLayouts\(\(st\) => st\.setNewTabCwd\)/.test(SETTINGS),
    'Settings no longer writes through the store',
  );
  const held = SETTINGS.split('\n').filter((l) => /useState[^\n]*newTabCwd/i.test(l));
  assert.deepEqual(held, [], `Settings keeps the value in component state: ${held.join(' / ')}`);
});

check('every choice the row offers is a value the parser takes', () => {
  // Four entries: the three the document can hold, and one that reveals the path field.
  const offered = [...SETTINGS.matchAll(/\{ value: ([^,]+), label: t\('settings\.newTabCwd/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(offered, ["'default'", 'NEW_TAB_CWD_INHERIT', 'NEW_TAB_CWD_HOME', "'folder'"]);
  // The two words come from the module the parser reads them from, not retyped here.
  assert.ok(
    /NEW_TAB_CWD_HOME,\n  NEW_TAB_CWD_INHERIT,\n  NEW_TAB_CWD_WORDS,\n\} from '\.\.\/store\/layoutsFormat'/.test(
      SETTINGS,
    ),
    'Settings spells the keywords itself instead of importing them',
  );
});

check('a folder is nothing until one is named', () => {
  // Picking "a folder" removes the key, so the row and the document never disagree: a
  // folder shown as chosen while the document holds the old value would be a lie about
  // what the next tab does.
  assert.ok(
    /const value = next === 'default' \|\| next === 'folder' \? null : next;/.test(SETTINGS),
    'picking a folder no longer clears the key while no path is named',
  );
  // And only an absolute path is written: the parser refuses the rest with a line number,
  // and this row would be writing the refusal into the document.
  assert.ok(
    /v\.startsWith\('\/'\) && v !== newTabCwd/.test(SETTINGS),
    'the folder field writes a value the document parser would refuse',
  );
});

console.log(`\n${passed} checks passed`);
