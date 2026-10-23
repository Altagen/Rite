/**
 * A preference about this machine survives a relaunch.
 *
 * It did not. The desktop shell loads `http://127.0.0.1:<port>` and its server binds
 * `:0`, so the kernel hands out a different port every launch — and `localStorage` is
 * keyed by origin, so everything stored there was gone on the next start: the toolbar,
 * the theme, the LANGUAGE, the keyboard overrides, the snippets, the pinned dashboard
 * cards. Eleven keys. Pinning the port would fix it and trade away a security property
 * (ADR 0009 pairs a random loopback port with a per-window token), so the shell keeps
 * these in a file instead and injects them as `window.__RITE_DEVICE__`.
 *
 * This drives `utils/deviceStore.ts` directly, with the two worlds faked in turn: Node
 * strips the types and the module imports nothing at runtime, so this tests the shipped
 * code rather than a copy of it. What it cannot cover is the shell's own file write — that
 * is Rust, and `device_prefs_path` is exercised by hand until the desktop has a harness.
 *
 * Run: node e2e/device-prefs-check.mjs
 */
import assert from 'node:assert/strict';

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
};

/** A browser: a stable origin, so localStorage is the right place. */
function asBrowser() {
  const store = new Map();
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return store;
}

/** The desktop shell: a token (so `isNativeShell()` is true) and an injected snapshot. */
function asShell(injected = {}) {
  const sent = [];
  globalThis.window = {
    __RITE_TOKEN__: 'test-token',
    __RITE_DEVICE__: injected,
    ipc: { postMessage: (m) => sent.push(JSON.parse(m)) },
  };
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('the shell must not read localStorage: its origin changes every launch');
    },
    setItem: () => {
      throw new Error('the shell must not write localStorage: it is lost on the next launch');
    },
    removeItem: () => {
      throw new Error('the shell must not clear localStorage');
    },
  };
  return sent;
}

const { deviceStore } = await import('../apps/desktop/src/utils/deviceStore.ts');

console.log('in a browser, where the origin is stable:');

await check('a preference round-trips through localStorage', () => {
  const store = asBrowser();
  deviceStore.setItem('rite-toolbar', '{"quickSsh":false}');
  assert.equal(deviceStore.getItem('rite-toolbar'), '{"quickSsh":false}');
  assert.equal(store.get('rite-toolbar'), '{"quickSsh":false}', 'and it is really there');
  deviceStore.removeItem('rite-toolbar');
  assert.equal(deviceStore.getItem('rite-toolbar'), null);
});

await check('storage that throws is a missing preference, not a crash', () => {
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(deviceStore.getItem('anything'), null);
  deviceStore.setItem('anything', 'x'); // must not throw
  deviceStore.removeItem('anything');
});

console.log('in the desktop shell, where it is not:');

await check('what the shell injected is what is read', () => {
  asShell({ 'rite-locale': 'fr', 'rite-toolbar': '{"quickSsh":false}' });
  assert.equal(deviceStore.getItem('rite-locale'), 'fr');
  assert.equal(deviceStore.getItem('rite-toolbar'), '{"quickSsh":false}');
  assert.equal(deviceStore.getItem('never-set'), null);
});

await check('a write goes to the shell, and never to localStorage', () => {
  // The fake localStorage throws on every call: reaching it at all fails this.
  const sent = asShell({});
  deviceStore.setItem('rite-locale', 'en');
  assert.deepEqual(sent, [{ type: 'device-set', key: 'rite-locale', value: 'en' }]);
});

await check('a write is readable in the same tick, before the file exists', () => {
  // The round trip through the shell is asynchronous and nothing waits for it, so the
  // injected snapshot has to be updated in memory too — otherwise a store that saves and
  // immediately re-reads (zustand does) reads the old value back.
  asShell({});
  deviceStore.setItem('rite.healthPref', 'always');
  assert.equal(deviceStore.getItem('rite.healthPref'), 'always');
});

await check('removing tells the shell to drop the key', () => {
  const sent = asShell({ 'rite-toolbar': '{}' });
  deviceStore.removeItem('rite-toolbar');
  assert.equal(deviceStore.getItem('rite-toolbar'), null);
  assert.deepEqual(sent, [{ type: 'device-set', key: 'rite-toolbar', value: null }]);
});

await check('a value the file holds as a number or object still reads as a string', () => {
  // `device.json` is a file a person can edit, and an older build may have written a
  // bare value. Callers do their own JSON.parse, so a non-string must not reach them.
  asShell({ 'rite.showMemberCount': true, 'rite-snippets': [{ name: 'x' }] });
  assert.equal(deviceStore.getItem('rite.showMemberCount'), 'true');
  assert.equal(deviceStore.getItem('rite-snippets'), '[{"name":"x"}]');
});

await check('an older shell with no injection falls back rather than losing writes', () => {
  // A binary that predates `__RITE_DEVICE__`: there is no file to write to, so
  // localStorage is still better than nothing for the session.
  const store = asBrowser();
  globalThis.window.__RITE_TOKEN__ = 'test-token';
  deviceStore.setItem('rite-locale', 'fr');
  assert.equal(store.get('rite-locale'), 'fr', 'the write lands somewhere rather than nowhere');
  assert.equal(deviceStore.getItem('rite-locale'), 'fr', 'and is readable for this session');
});

console.log(`\n${passed} checks passed`);
