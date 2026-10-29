/**
 * An audit that could not answer must not report green.
 *
 * `cargo audit` exits 0 in three ways that all read as clean, and all three were live
 * through the 0.2.7 release: the yanked-crate check erroring out once per crate; a
 * yanked crate that IS found, reported as a warning; and a wrapper that swallows the
 * exit code when `cargo audit` never started at all. Measured, not supposed — with the
 * image name pointed at nothing, the first version of the wrapper printed "audit
 * complete: every check ran" and exited 0.
 *
 * So `scripts/audit.sh` proves the run happened before it believes the result, and every
 * caller goes through it. This check holds both halves, because a bare `cargo audit` is
 * one line away and nothing else would notice.
 *
 * Run: node e2e/audit-script-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

/**
 * Every real `cargo audit` call. A quote in front of it makes it a message — the one in
 * `say` and the two in `die` — and anything else makes it a command, including
 * `{ cargo audit …`, which an anchored regex misses.
 */
const INVOCATIONS = () => script.match(/(?<!")cargo audit\b[^\n]*/g) ?? [];

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

/** The script's code, header stripped: a comment can say anything, only code runs. */
const strip = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const script = strip(read('scripts/audit.sh'));
/** Every file that could invoke the audit itself. */
const CALLERS = [
  '.github/workflows/ci.yml',
  '.github/workflows/security.yml',
  'Taskfile.yaml',
];

check('the audit denies a yanked crate', () => {
  // Without it a yanked crate is "1 allowed warning" and the exit code stays 0.
  const invocations = INVOCATIONS();
  assert.ok(invocations.length > 0, 'the script no longer invokes cargo audit');
  for (const call of invocations) {
    assert.match(call, /--deny yanked/, `a cargo audit call without --deny yanked: ${call}`);
  }
});

check('the audit does not deny unmaintained', () => {
  // RUSTSEC-2024-0370 has no upgrade path from the GTK3 line, so this would fail every
  // run, and a check that always fails gets ignored like one that never runs.
  assert.doesNotMatch(script, /--deny unmaintained/);
});

check('the index is warmed before the yanked check', () => {
  // One index operation through cargo's own client, instead of 588 through cargo-audit's.
  const warms = script.match(/cargo update --dry-run --workspace/g) ?? [];
  const audits = INVOCATIONS();
  assert.equal(warms.length, audits.length, 'a cargo audit call with no warm-up beside it');
});

check('the script proves the audit ran', () => {
  // The needle is the uncoloured remainder of cargo's status line: "Scanning" itself is
  // wrapped in escape codes even through a pipe.
  assert.match(script, /grep -q "Cargo\.lock for vulnerabilities"/);
  assert.doesNotMatch(script, /grep -q "Scanning Cargo/);
});

check('the script fails when a check could not run', () => {
  assert.match(script, /couldn't check if the package is yanked/);
  assert.match(script, /went unasked/);
});

check('the script fails on a non-zero audit', () => {
  assert.match(script, /cargo-audit exit status: \$\?/);
  assert.match(script, /grep -q "\^cargo-audit exit status: "/);
});

check('success is claimed once, and last', () => {
  // Text position is not execution order — the guards sit in a function defined above
  // the dispatch. What is checkable is that nothing claims success early and nothing
  // runs after the claim.
  const lines = script.split('\n').map((l) => l.trim()).filter(Boolean);
  const hits = lines.filter((l) => l.includes('audit complete: every check ran'));
  assert.equal(hits.length, 1, 'success is claimed more than once');
  assert.equal(lines.at(-1), hits[0], 'something runs after success is claimed');
});

check('no caller invokes cargo audit bare', () => {
  const bare = CALLERS.filter((f) => /(?<!scripts\/)\bcargo audit\b/.test(strip(read(f))));
  assert.deepEqual(bare, [], 'these run cargo audit instead of scripts/audit.sh');
});

check('every caller runs the script', () => {
  for (const f of CALLERS) {
    assert.match(read(f), /sh scripts\/audit\.sh/, `${f} no longer runs the audit script`);
  }
});

check('the script answers for rust alone, as CI asks it to', () => {
  // CI audits the two trees in two jobs, so the script has to be splittable.
  assert.match(script, /^\s*rust\)\s+audit_rust ;;$/m);
  assert.match(read('.github/workflows/ci.yml'), /sh scripts\/audit\.sh rust/);
  assert.match(read('.github/workflows/security.yml'), /sh scripts\/audit\.sh rust/);
});

console.log(`\n${passed} checks passed (${CALLERS.length} callers, all through scripts/audit.sh)`);
