/**
 * Every quick auth method goes through the guard, and the form can offer both supports.
 *
 * ADR 0028 §4 refuses a key path in accounts mode inside the server, not only in the UI: a
 * path there names a file in the server's own container, so a file an administrator drops
 * at that path would authenticate every account that can read the record. The refusal lives
 * in `quick_auth`, and the way it stops being true is a fifth handler that converts a
 * `QuickAuthMethod` with `.into()` and never asks. So that is what this reads for.
 *
 * The client half: the form resolves which support it is editing from the record, not from
 * which field happens to be filled, which is what made the support a property of the shell
 * that created the machine.
 *
 * Run: node e2e/key-support-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const server = read('packages/rite-server/src/lib.rs');

console.log('a key path is refused where the server would read its own filesystem:');

check('the guard exists, and refuses on `accounts`', () => {
  const fn = server.match(/fn quick_auth\([\s\S]*?\n}/);
  assert.ok(fn, 'quick_auth is gone or no longer shaped as a function');
  assert.match(fn[0], /state\.accounts/, 'the guard must turn on accounts mode');
  assert.match(fn[0], /QuickAuthMethod::PublicKey/, 'it must be the path variant it refuses');
});

check('a local vault is not caught by it', () => {
  // `accounts` is false in a desktop shell's own server, which is exactly where a path is
  // the better support. A guard that refused there would remove the feature it protects.
  const fn = server.match(/fn quick_auth\([\s\S]*?\n}/)[0];
  assert.match(fn, /if state\.accounts &&/, 'the condition must be conjunctive with accounts');
});

check('no handler converts a quick auth method behind the guard', () => {
  // `.into()` on a QuickAuthMethod is the one way to get an AuthMethod without asking.
  const direct = [...server.matchAll(/^.*auth_method(?:\.clone\(\))?\.into\(\).*$/gm)].map((m) =>
    m[0].trim(),
  );
  assert.deepEqual(
    direct,
    [],
    `convert with quick_auth(&state, …) instead:\n        ${direct.join('\n        ')}`,
  );
});

check('and every handler that takes one calls it', () => {
  // One call per request field of that type, plus the hop chain's own.
  const fields = [...server.matchAll(/auth_method: QuickAuthMethod,/g)].length;
  const calls = [...server.matchAll(/quick_auth\(/g)].length;
  assert.ok(fields >= 4, `only ${fields} request types carry a quick auth method`);
  // `fn quick_auth` itself is one of the matches, so the calls must exceed the definition
  // by at least one per request type.
  assert.ok(
    calls >= fields + 1,
    `${fields} request types carry one and quick_auth appears ${calls} times`,
  );
});

check('the refusal says where a path is read, and not who to blame', () => {
  const refusal = server.match(/impl IntoResponse for KeyPathRefused \{[\s\S]*?\n}/);
  assert.ok(refusal, 'the refusal type is gone');
  assert.match(refusal[0], /BAD_REQUEST/, 'a path here is a bad request, not a server error');
  assert.match(refusal[0], /desktop client/, 'it must name what would work');
  assert.doesNotMatch(refusal[0], /\byou\b|\byour\b/, 'a refusal does not address its caller');
});

console.log('\nthe client edits the support the record already uses:');

const form = read('apps/desktop/src/components/ConnectionForm.tsx');
const authMethod = read('apps/desktop/src/utils/authMethod.ts');
const section = read('apps/desktop/src/components/AuthSection.tsx');

check('the wire shape follows `keySupport`, not which field was filled', () => {
  const build = authMethod.match(/export function toAuthMethodInput[\s\S]*?\n}/)[0];
  assert.match(build, /s\.keySupport === 'path'/, 'the branch must read the support');
  // The old rule: `s.key ? vaultKey : publicKey`. It made an edit that typed nothing
  // convert a carried machine to a path.
  assert.doesNotMatch(
    build,
    /s\.key\s*\n?\s*\?\s*\{ type: 'vaultKey'/,
    'the support must not be inferred from the key field',
  );
});

check('the form seeds the support from the stored method', () => {
  assert.match(
    form,
    /keySupport: connection\?\.authType === 'publicKey' \? 'path' : 'carried'/,
    'opening a machine must not silently move it to the other support',
  );
});

check('switching support insists on the new field', () => {
  assert.match(form, /switchedSupport/, 'the validation must notice a switch');
  const validate = form.match(/const switchedSupport[\s\S]{0,600}/)[0];
  assert.match(validate, /!hasStoredKey \|\| switchedSupport/, 'a switch has to be validated');
});

check('a stored key is named rather than shown as an empty picker', () => {
  assert.match(section, /auth-key-stored/, 'the stored-key row is gone');
  assert.match(section, /auth-key-replace/, 'there must be a way to replace it');
  assert.match(section, /showStoredKey \? \(/, 'the picker must be behind that row');
});

check('the carried support is the default, and the instance can remove it', () => {
  assert.match(authMethod, /keySupport: 'carried',/, 'carried is the shipped default');
  assert.match(section, /const mayCarry = mayRemember;/, 'the policy must gate carrying');
  assert.match(
    section,
    /const support = inVault \? 'path' : mayCarry \? value\.keySupport : 'path';/,
    'a forbidden carried support must fall back to a path, not to an empty form',
  );
});

check('a browser does not try to open a path-record', () => {
  const source = read('apps/desktop/src/store/accountsConnectionsSource.ts');
  assert.match(
    source,
    /record\.authMethod\.type === 'publicKey' && !isNativeShell\(\)/,
    'the request must not be made from a browser',
  );
});

console.log(`\n${passed} checks passed`);
