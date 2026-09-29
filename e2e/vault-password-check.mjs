#!/usr/bin/env node
/**
 * Test a candidate master password against a vault, outside Rite.
 *
 * When the app says the password is wrong there are two possibilities, and from
 * the outside they look identical: the password really is different, or the app
 * is failing to verify a correct one. This tells them apart — it reads the PHC
 * hash straight out of the vault file and verifies against it with an
 * independent Argon2 implementation, touching none of Rite's code.
 *
 * The password is read from the terminal with echo off, is never written
 * anywhere, and never leaves the machine. The vault is opened read-only.
 *
 *   node e2e/vault-password-check.mjs [path/to/vault.db]
 *
 * Defaults to $XDG_DATA_HOME/rite/vault.db, else ~/.local/share/rite/vault.db.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

/** hash-wasm lives in the desktop workspace, not at the repo root, and ESM does
 *  not read NODE_PATH — so fall back to the file itself when the bare specifier
 *  cannot be resolved (i.e. whenever this is run from the repo root). */
const { argon2id } = await (async () => {
  try {
    return await import('hash-wasm');
  } catch {
    const here = dirname(fileURLToPath(import.meta.url));
    const vendored = resolve(here, '..', 'apps', 'desktop', 'node_modules', 'hash-wasm', 'dist', 'index.esm.js');
    if (!existsSync(vendored)) {
      console.error('hash-wasm not found. Run `pnpm install` first, or run this from apps/desktop.');
      process.exit(2);
    }
    return await import(pathToFileURL(vendored).href);
  }
})();

/**
 * Read `master_password.hash` through SQLite, not by scanning the file.
 *
 * Scanning looks simpler and is wrong: a live vault is in WAL mode, so the row
 * you want is usually in `vault.db-wal` and not in `vault.db` at all. A probe
 * that reads only the main file reports "no password set" on a vault that
 * plainly has one — which, when you are diagnosing a lockout, is the worst
 * possible lie. SQLite reads the WAL for us.
 */
function readPhcHash(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT hash FROM master_password ORDER BY id DESC LIMIT 1').get();
    return row?.hash ?? null;
  } catch {
    return null; // no such table ⇒ not a Rite vault
  } finally {
    db.close();
  }
}

function parsePhc(phc) {
  const parts = phc.split('$');
  const params = Object.fromEntries(parts[3].split(',').map((kv) => kv.split('=')));
  const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return {
    variant: parts[1],
    version: Number(parts[2].slice(2)),
    memorySize: Number(params.m),
    iterations: Number(params.t),
    parallelism: Number(params.p),
    salt: b64(parts[4]),
    hash: b64(parts[5]),
  };
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      // Keep the prompt on screen, print nothing for the keystrokes themselves.
      if (['\n', '\r', '\u0004'].includes(String(char))) process.stdin.removeListener('data', onData);
      else process.stdout.write('\u001b[2K\u001b[200D' + prompt);
    };
    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const dbPath =
  process.argv[2] ||
  join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'rite', 'vault.db');

if (!existsSync(dbPath)) {
  console.error(`No vault at ${dbPath}`);
  process.exit(2);
}

const phc = readPhcHash(dbPath);
if (!phc) {
  console.error(`No master-password hash found in ${dbPath} — is this a Rite vault?`);
  process.exit(2);
}

const p = parsePhc(phc);
console.log(`Vault:  ${dbPath}`);
console.log(`Hash:   ${p.variant}, v=${p.version}, m=${p.memorySize}, t=${p.iterations}, p=${p.parallelism}`);
console.log('The password is not echoed, not stored, and not sent anywhere.\n');

const password = await askHidden('Master password to test: ');

const computed = await argon2id({
  password,
  salt: p.salt,
  parallelism: p.parallelism,
  iterations: p.iterations,
  memorySize: p.memorySize,
  hashLength: p.hash.length,
  outputType: 'binary',
});

const ok = Buffer.from(computed).equals(p.hash);
console.log(ok ? '\n✅  This password matches the vault.' : '\n❌  This password does not match the vault.');
console.log(
  ok
    ? 'So the stored hash is fine and Rite should accept it — if it does not, the bug is in the app.'
    : 'Argon2 says no, independently of Rite: the vault was sealed with a different password.',
);
process.exit(ok ? 0 : 1);
