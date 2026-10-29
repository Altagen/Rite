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
 * The JavaScript side was worse: both CI jobs named a threshold and both then threw the
 * result away, one with `|| true` and one with `continue-on-error: true`, so `pnpm audit`
 * had never been able to fail anything at all.
 *
 * So `scripts/audit.sh` proves the run happened before it believes the result, it is the
 * only place either audit is invoked or thresholded, and no caller is allowed to discard
 * what it says. This check holds all of that, because a bare `cargo audit` is one line
 * away and nothing else would notice.
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

/** The workflow jobs that run an audit, by the step's `run:` line. */
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/security.yml'];

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

/**
 * What actually runs: comments stripped, and a workflow step's `name:` with them — "Run
 * pnpm audit" is a label, not an invocation.
 */
const strip = (text) => text.split('\n')
  .filter((l) => !/^\s*#/.test(l) && !/^\s*-?\s*name:/.test(l))
  .join('\n');
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

check('the JavaScript threshold is named once', () => {
  // Every caller said `--audit-level=high` itself, which is how both came to ignore it.
  assert.match(script, /pnpm audit --audit-level=high/);
  const elsewhere = CALLERS.filter((f) => /--audit-level/.test(strip(read(f))));
  assert.deepEqual(elsewhere, [], 'these set the threshold themselves instead of calling the script');
});

check('no caller discards what the audit says', () => {
  // `|| true` on the step and `continue-on-error: true` on the job are the same defect
  // as a swallowed exit code: the audit runs, reports, and nothing happens.
  const escaped = [];
  for (const f of WORKFLOWS) {
    const lines = strip(read(f)).split('\n');
    lines.forEach((line, i) => {
      if (!/sh scripts\/audit\.sh/.test(line)) return;
      if (/\|\|\s*true/.test(line)) escaped.push(`${f}: || true`);
      // The step's own keys follow its `run:`, at the same indentation.
      const indent = line.match(/^\s*/)[0].length;
      for (const next of lines.slice(i + 1)) {
        if (!next.trim()) continue;
        if (next.match(/^\s*/)[0].length < indent || /^\s*-\s/.test(next)) break;
        if (/continue-on-error:\s*true/.test(next)) escaped.push(`${f}: continue-on-error`);
      }
    });
  }
  assert.deepEqual(escaped, [], 'an audit step whose result is thrown away');
});

check('no caller invokes pnpm audit bare', () => {
  const bare = CALLERS.filter((f) => /(?<!scripts\/)\bpnpm audit\b/.test(strip(read(f))));
  assert.deepEqual(bare, [], 'these run pnpm audit instead of scripts/audit.sh');
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

check('the script answers for one tree at a time, as CI asks it to', () => {
  // CI audits the two trees in two jobs, so the script has to be splittable.
  assert.match(script, /^\s*rust\)\s+audit_rust ;;$/m);
  assert.match(script, /^\s*js\)\s+audit_js ;;$/m);
  for (const f of WORKFLOWS) {
    assert.match(read(f), /sh scripts\/audit\.sh rust/, `${f} does not audit the Rust tree`);
    assert.match(read(f), /sh scripts\/audit\.sh js/, `${f} does not audit the JavaScript tree`);
  }
});

console.log(`\n${passed} checks passed (${CALLERS.length} callers, all through scripts/audit.sh)`);
