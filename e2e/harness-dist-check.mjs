/**
 * EVERY HARNESS THAT SERVES THE FRONTEND REFUSES A STALE ONE.
 *
 * `e2e/dist-fresh.sh` is the rule: Playwright serves `apps/desktop/dist` from disk and
 * builds nothing, so a bundle older than the source tests the previous commit and reports
 * "passed". The rule was written into three of the seven harness servers, which is the
 * shape a rule takes when it is added where the problem was noticed rather than
 * everywhere it applies — four scripts kept serving whatever was on disk.
 *
 * So the carrier is defined mechanically here instead of by hand: a script that exports
 * `RITE_WEB_DIR` serves the frontend, and a script that serves the frontend calls the
 * guard. Nothing to keep in step, and a new harness is covered the day it is written.
 *
 * Run: node e2e/harness-dist-check.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2e = dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(e2e).filter((f) => /^serve.*\.sh$/.test(f));

let failed = 0;
console.log('\nharness servers that serve the frontend:');
for (const name of scripts.sort()) {
  const text = readFileSync(join(e2e, name), 'utf8');
  const serves = /^export RITE_WEB_DIR=/m.test(text);
  const guards = /dist-fresh\.sh/.test(text);
  if (!serves) {
    console.log(`  --  ${name} (serves no frontend)`);
    continue;
  }
  if (guards) {
    console.log(`  ok  ${name}`);
  } else {
    console.log(`  FAIL  ${name} exports RITE_WEB_DIR and never calls e2e/dist-fresh.sh`);
    failed++;
  }
}

// And the guard itself has to be there to be called.
if (!readdirSync(e2e).includes('dist-fresh.sh')) {
  console.log('  FAIL  e2e/dist-fresh.sh is gone, so every call above is a no-op');
  failed++;
}

if (failed) {
  console.log(`\n${failed} failed\n`);
  process.exit(1);
}
console.log(`\n${scripts.length} harness scripts read\nall ok\n`);
