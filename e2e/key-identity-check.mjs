/**
 * The key fingerprint shown beside a stored key (ADR 0028 §6), against the reference.
 *
 * A record that carries a key has to say WHICH key, and the only identity worth printing is
 * the one `ssh-keygen -lf` prints — anything else cannot be compared against an
 * `authorized_keys` line, which is the whole use. So this holds the parser to that output.
 *
 * Two halves. The vectors below are **public** keys wrapped in the private-key envelope at
 * run time: the parser only ever reads the public half, so the fixture needs no private key
 * material and none is committed. Then, where `ssh-keygen` exists, real pairs are generated
 * in a temp directory — including a passphrase-encrypted one — and the parser is held to
 * what the tool says about them. The frozen vectors cannot drift from reality, and a machine
 * without OpenSSH still runs the first half.
 *
 * Run: node e2e/key-identity-check.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyIdentity } from '../apps/desktop/src/utils/sshKeyFingerprint.ts';

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

/** `ssh-keygen -lf` output for these public keys, recorded from the tool. */
const VECTORS = [
  {
    name: 'ed25519',
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:kR5H7EShEl2nT0FyClhidIziT6t5FbUMYyuNIHFB3bs',
    blob:
      'AAAAC3NzaC1lZDI1NTE5AAAAIJ7VVFSJT96GFkpCpvtRh8jnOe2GfnkP9WyssvMjo3az',
  },
  {
    name: 'ecdsa',
    algorithm: 'ecdsa-sha2-nistp256',
    fingerprint: 'SHA256:8iyC31cFYDrTJgJeCgbifgLiT2kKCdpio+k+tHYTQTo',
    blob:
      'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBDS4WNT+L/rG/9C09RITkdW8eK+SjImyIjTYPox+f1hh79T1Gk4wuOCU7jvn7pH53p+7YlvWYMCRzqg+mVg5PF4=',
  },
  {
    name: 'rsa',
    algorithm: 'ssh-rsa',
    fingerprint: 'SHA256:znSFx3XZGUqI21vzNWB7w25hXxjQIaxhhNbrlWcfI7Y',
    blob:
      'AAAAB3NzaC1yc2EAAAADAQABAAABAQCy13omOlcop/I/22QPexP/fxILVP1huYod28Ib4MPJC+HZQvf7ghjrXYBWgSVU+cf8g/EfR/2TvYSgMUGVDan95u6rL7jGYdKQL4LM/2lXEDEodcdCFPFLMlHcdPlOqp/gUjja6o2s0LFhbenV3xAkmLvb8Z86KV59Bl/n6mfrduMgwXKL0chEZKYLQxhZS1trB2CHS90uj/sVBvkkH7tPj+rY50oUvqyDlL8oib9AYTd1ySi+A7EXvygTJdC1/6DKbbzhTtlW7BN/IfsDYSpHm/5w3fGztdpuu+zdxJHPAjXEGVP78pwf0fvvW/aRVTNC8RN6+LROQjGtIubeiy//',
  },];

const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const field = (bytes) => Buffer.concat([u32(bytes.length), Buffer.from(bytes)]);

/**
 * Wrap a public blob in the `openssh-key-v1` container, as a key file holds it.
 *
 * `cipher` is what an encrypted key names here; the public half sits outside whatever the
 * private half is protected with, which is why a passphrase is never needed to read it.
 */
function envelope(blobBase64, cipher = 'none', keys = 1) {
  const pub = Buffer.from(blobBase64, 'base64');
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    field(Buffer.from(cipher)),
    field(Buffer.from(cipher === 'none' ? 'none' : 'bcrypt')),
    field(Buffer.alloc(0)),
    u32(keys),
    field(pub),
    field(Buffer.from('the private half, which is never read here')),
  ]);
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

console.log('the fingerprint is the one ssh-keygen prints:');

for (const v of VECTORS) {
  await check(`${v.name}, unencrypted`, async () => {
    const id = await keyIdentity(envelope(v.blob));
    assert.ok(id, 'no identity read');
    assert.equal(id.fingerprint, v.fingerprint);
    assert.equal(id.algorithm, v.algorithm);
  });
  await check(`${v.name}, passphrase-encrypted`, async () => {
    // The point of reading the public half: a locked key still says which key it is, so the
    // form can name it without ever asking for the passphrase.
    const id = await keyIdentity(envelope(v.blob, 'aes256-ctr'));
    assert.ok(id, 'an encrypted key must still be named');
    assert.equal(id.fingerprint, v.fingerprint);
  });
}

console.log('\nand anything that is not one of those is not guessed at:');

const REFUSED = [
  ['empty text', ''],
  ['prose', 'this is not a key at all, it is a sentence'],
  ['a public key file', 'ssh-ed25519 ' + VECTORS[0].blob + ' someone@host\n'],
  ['PKCS#8, whose public half is not in the clear', '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n'],
  ['traditional RSA', '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK==\n-----END RSA PRIVATE KEY-----\n'],
  ['the right header over junk', '-----BEGIN OPENSSH PRIVATE KEY-----\nbm90IGEga2V5\n-----END OPENSSH PRIVATE KEY-----\n'],
  ['no footer', '-----BEGIN OPENSSH PRIVATE KEY-----\n' + envelope(VECTORS[0].blob).split('\n')[1]],
];

for (const [name, text] of REFUSED) {
  await check(name, async () => assert.equal(await keyIdentity(text), null));
}

await check('a truncated envelope, cut at every length', async () => {
  // A field length larger than what is left must refuse, not read past the buffer. Every
  // prefix of a real file is tried, because the bug this guards against is off-by-one.
  const whole = envelope(VECTORS[0].blob);
  const body = whole.match(/KEY-----\n([\s\S]*?)\n-----END/)[1].replace(/\n/g, '');
  const bytes = Buffer.from(body, 'base64');
  for (let cut = 1; cut < bytes.length; cut++) {
    const text = `-----BEGIN OPENSSH PRIVATE KEY-----\n${bytes.subarray(0, cut).toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`;
    const id = await keyIdentity(text);
    // A prefix may legitimately still hold the whole public blob; what it must never do is
    // throw or invent a different key.
    if (id !== null) assert.equal(id.fingerprint, VECTORS[0].fingerprint, `cut at ${cut}`);
  }
});

await check('a container declaring no keys', async () => {
  assert.equal(await keyIdentity(envelope(VECTORS[0].blob, 'none', 0)), null);
});

console.log('\nand it agrees with the tool on keys it has never seen:');

let keygen = true;
try {
  execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
} catch (err) {
  // `-?` is not an option, so a present ssh-keygen exits non-zero with usage on stderr; an
  // absent one fails to spawn. Only the second is a reason to skip.
  keygen = err.code !== 'ENOENT';
}

if (!keygen) {
  console.log('      (ssh-keygen is not installed — the vectors above are the whole check)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'rite-key-identity-'));
  try {
    for (const [type, passphrase] of [
      ['ed25519', ''],
      ['ed25519', 'a passphrase'],
      ['rsa', ''],
      ['ecdsa', 'another one'],
    ]) {
      const path = join(dir, `${type}-${passphrase ? 'locked' : 'plain'}`);
      execFileSync('ssh-keygen', ['-q', '-t', type, '-N', passphrase, '-C', 'check', '-f', path]);
      const expected = execFileSync('ssh-keygen', ['-lf', `${path}.pub`], { encoding: 'utf8' })
        .trim()
        .split(/\s+/);
      await check(`${type}${passphrase ? ', encrypted' : ''}, freshly generated`, async () => {
        const id = await keyIdentity(readFileSync(path, 'utf8'));
        assert.ok(id, 'no identity read from a real key');
        assert.equal(id.fingerprint, expected[1], 'the fingerprint ssh-keygen prints');
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} checks passed`);
