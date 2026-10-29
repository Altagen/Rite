/**
 * Where a new tab's shell starts.
 *
 * `[terminal] newTabCwd` is parsed by `store/layoutsFormat.ts` and covered by
 * `e2e/layout-file-check.mjs`. What the value MEANS for the client reading it is a
 * different question, and this holds it: one value and two states — a path and every new
 * tab starts there, nothing and a new tab follows the standing pane, or opens in the home
 * directory when no pane stands.
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
import { NEW_TAB_CWD_HOME } from '../apps/desktop/src/store/layoutsFormat.ts';
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

check('a silent document follows the standing pane', () => {
  // The default, and a behaviour change from 0.2.7, where a new tab opened wherever Rite
  // itself stood — which was nobody's directory. A split has always done this.
  assert.deepEqual(newTabCwdStart({ asked: null, runsHere: true, from: 's1' }), {
    inheritCwdFrom: 's1',
  });
});

check('with no pane to follow, the home directory', () => {
  // The first tab of a session: there is nothing to leave behind. `home` goes over the
  // wire as the WORD — the client cannot know the home directory of the machine the shell
  // starts on, and that machine can.
  assert.deepEqual(newTabCwdStart({ asked: null, runsHere: true }), { cwd: NEW_TAB_CWD_HOME });
});

check('a path is where every new tab starts, pane or no pane', () => {
  // "Every time" is the point of naming one: a path that the standing pane could override
  // would be a preference nobody could rely on.
  for (const from of ['s1', undefined]) {
    assert.deepEqual(newTabCwdStart({ asked: '/srv/work', runsHere: true, from }), {
      cwd: '/srv/work',
    });
  }
});

check('a browser asks for nothing at all, pane or no pane', () => {
  // The instance's shell in the instance's container, so a new tab there opens where the
  // image starts a shell — /home/rite (`e2e/server-image-check.mjs`) — every time. A path
  // a desktop wrote means nothing on that filesystem, naming one would be choosing where a
  // shared server spawns a shell, and inheriting is not wanted either: the base shell
  // directory, always. A SPLIT still follows its pane there; that is `localSession`, not
  // this rule.
  for (const asked of [null, '/srv/work', NEW_TAB_CWD_HOME]) {
    for (const from of ['s1', undefined]) {
      assert.deepEqual(
        newTabCwdStart({ asked, runsHere: false, from }),
        {},
        `asked=${asked} from=${from}`,
      );
    }
  }
});

check('at most one answer is ever asked for', () => {
  // A session to follow and a directory to start in are two answers to one question. A
  // request carrying both would leave the precedence to be agreed twice.
  for (const asked of [null, '/srv/work', NEW_TAB_CWD_HOME]) {
    for (const from of ['s1', undefined]) {
      for (const runsHere of [true, false]) {
        const keys = Object.keys(newTabCwdStart({ asked, runsHere, from }));
        assert.ok(keys.length <= 1, `${asked} / ${from} / ${runsHere} asked for ${keys}`);
      }
    }
  }
});

console.log('\nthe two sides spell the keyword the same way:');

check('the server resolves the same word the client sends', () => {
  // Duplicated across two languages, where there is nothing to import. If one side is
  // renamed, a first tab silently stops opening in the home directory.
  assert.ok(
    SERVER.includes(`"${NEW_TAB_CWD_HOME}" => std::env::var_os("HOME")`),
    `rite-server does not resolve "${NEW_TAB_CWD_HOME}" against $HOME`,
  );
});

check('a shared instance names no directory at all', () => {
  // The gate is INSIDE the rule, not beside its call: a second call site could otherwise
  // be added without it. A browser names nothing, and this is what makes that safe rather
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
  // by a missing serde rename — a split that quietly stopped following its pane.
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
  // And it follows a LOCAL pane only. A focused SSH pane stands on another computer, so
  // its id would have the server find no local session and start the shell wherever Rite
  // itself stands — silently, and nowhere anybody asked for. The home directory is the
  // answer there, which is what no pane at all gives.
  assert.ok(
    /standing\?\.session\.connectionId === 'local' \? standing\.session\.id : undefined/.test(
      workspace,
    ),
    'Workspace follows a pane whose directory is not on this machine',
  );
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

console.log('\nthe field in Settings:');

check('the field is offered exactly where a path is applied', () => {
  // Not two readings of `runsHere`. A field that writes a value this client ignores is a
  // control for something that cannot happen, which is the mistake `shellControls` was
  // written to end — so the gate and the behaviour are one function.
  for (const runsHere of [true, false]) {
    const applied = newTabCwdStart({ asked: '/srv/work', runsHere }).cwd === '/srv/work';
    assert.equal(newTabCwdApplies({ runsHere }), applied, `runsHere=${runsHere}`);
  }
});

check('Settings asks that function, and a document it can write', () => {
  assert.ok(
    SETTINGS.includes('newTabCwdApplies(shellOwnership) && hasWorkspaceFile'),
    'the field no longer borrows both conditions — the rule, and a readable document',
  );
});

check('the switch reads the document and holds no copy of its value', () => {
  // ADR 0023: the file IS the value. `copyMode` is reported rather than offered next door
  // because a control beside the file would be a second place to set one value; a control
  // that WRITES the file is not. The draft is the text being typed, not the value.
  assert.ok(
    /useLayouts\(\(st\) => st\.newTabCwd\)/.test(SETTINGS),
    'Settings no longer reads the value from the workspace document',
  );
  assert.ok(
    /useLayouts\(\(st\) => st\.setNewTabCwd\)/.test(SETTINGS),
    'Settings no longer writes through the store',
  );
  const held = SETTINGS.split('\n').filter(
    (l) => /useState[^\n]*newTabCwd/i.test(l) && !/Draft/.test(l),
  );
  assert.deepEqual(held, [], `Settings keeps the value in component state: ${held.join(' / ')}`);
  // And both the draft and the switch are seeded from the document, so the row opens
  // showing what is in force rather than what was last clicked.
  assert.ok(
    /setNewTabCwdDraft\(newTabCwd \?\? ''\)/.test(SETTINGS),
    'the field no longer opens on the value the document holds',
  );
  assert.ok(
    /if \(newTabCwd !== null\) setFixedStart\(true\);/.test(SETTINGS),
    'the switch no longer opens on whether the document holds a path',
  );
});

check('the switch is the control, not a native checkbox', () => {
  // A native one is drawn by WebKitGTK in the desktop shell and by the browser in the web
  // UI: the same bundle showing two different controls, which is the one thing these two
  // surfaces must never do. `SettingsToggle` draws `SwitchPill` for every switch here.
  assert.ok(
    /<SettingsToggle\n\s*title=\{t\('settings\.newTabCwd'\)\}/.test(SETTINGS),
    'the row no longer uses the shared switch',
  );
  assert.ok(
    !/type="checkbox"/.test(SETTINGS),
    'Settings draws a native checkbox somewhere',
  );
});

check('the path field is dead while the switch is off', () => {
  // Greyed rather than hidden, so the setting reads as one thing with two states instead
  // of a field that appears and disappears.
  assert.ok(/disabled=\{!fixedStart\}/.test(SETTINGS), 'the path field is still live when off');
  assert.ok(
    /disabled:cursor-not-allowed disabled:opacity-50/.test(SETTINGS),
    'the disabled field is not drawn as disabled',
  );
  // Switching off removes the key, so the standing pane answers again.
  assert.ok(
    /if \(!next && newTabCwd !== null\) void setNewTabCwd\(null\);/.test(SETTINGS),
    'switching the row off no longer removes the key',
  );
});

check('the field names no keyword, because there are none left', () => {
  // One value and two states: the states are what the key is absent or present, not words
  // anybody types. A keyword spelled here would be a third state nothing else knows.
  const row = SETTINGS.slice(
    SETTINGS.indexOf('{newTabCwdApplies(shellOwnership)'),
    SETTINGS.indexOf('{/* Keyboard'),
  );
  assert.ok(row.length > 0, 'the row is gone');
  for (const word of ["'home'", "'inherit'", 'NEW_TAB_CWD']) {
    assert.ok(!row.includes(word), `the field spells ${word} itself`);
  }
});

check('an empty field is the absent key, and only a path is written', () => {
  // Cleared with the switch still on ⇒ the key goes and the field stays there to type in.
  // The parser refuses anything else with a line number, and this field would be writing
  // that refusal into the document.
  assert.ok(
    /if \(v === ''\) \{\n\s*if \(newTabCwd !== null\) void setNewTabCwd\(null\);/.test(SETTINGS),
    'clearing the field no longer removes the key',
  );
  assert.ok(
    /v\.startsWith\('\/'\) && v !== newTabCwd/.test(SETTINGS),
    'the field writes a value the document parser would refuse',
  );
});

check('the row says what it governs, in both locales', () => {
  // The first label was "Always start in one folder" — no subject, in a section that also
  // holds the shell picker, so nothing on screen said what ended up in the folder. The
  // owner read it and said so. A switch has to name a new tab; the hint has to say what
  // the OTHER state does, or the setting is legible only to whoever wrote it.
  for (const locale of ['en', 'fr']) {
    const { settings } = JSON.parse(read(`apps/desktop/src/i18n/locales/${locale}.json`));
    const says = (key, rx, what) =>
      assert.match(settings[key], rx, `${locale}.${key} does not say ${what}`);
    says('newTabCwd', /\btabs?\b|onglet/i, 'what it governs');
    says('newTabCwdDesc', /\btabs?\b|onglet/i, 'what it governs');
    says('newTabCwdDesc', /pane|panneau/i, 'where a new tab starts when it is off');
    says('newTabCwdDesc', /home|personnel/i, 'what happens with no pane to follow');
    says('newTabCwdDesc', /split|division/i, 'that a split is unaffected');
    says('newTabCwdPath', /folder|dossier/i, 'what the field holds');
    says('newTabCwdPathDesc', /absolute|absolu/i, 'which paths it takes');
    says('newTabCwdPathDesc', /newTabCwd/, 'where the value is written');
  }
});

console.log(`\n${passed} checks passed`);
