/**
 * The image that validates locally is the image CI runs on, and the client is built on an
 * older one on purpose.
 *
 * `Containerfile` exists for one reason (ADR 0001): a local `task check` passes iff CI
 * passes. That holds only while both sides name the same Ubuntu. Nothing made them agree —
 * the Containerfile carried a comment saying which version `ubuntu-latest` resolved to, and
 * a comment cannot fail.
 *
 * `ubuntu-latest` is the drift itself. GitHub moved the label from 24.04 to 26.04 between
 * 2026-10-19 and 2026-11-19, gradually, so two runs of the same commit could land on
 * different distributions. A workflow pins a version; moving it is then a commit with this
 * check and the gate behind it.
 *
 * The release client is the exception, and the opposite rule applies to it. The glibc of the
 * build machine becomes the FLOOR of the shipped binary: 0.2.6, built on 22.04, needs at most
 * GLIBC_2.34 and therefore runs on 24.04 (2.39) and on Debian 13 (2.41). Built on 26.04
 * (2.43) it would refuse to start on the current LTS. So the client matrix must stay at or
 * below the validation image, and this check fails if someone "aligns" it upward.
 *
 * Run: node e2e/ci-image-check.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
};

/** `FROM ubuntu:24.04` → "24.04". The base image, not a later stage's. */
function imageVersion() {
  const m = read('Containerfile').match(/^FROM ubuntu:(\d+\.\d+)$/m);
  assert.ok(m, 'Containerfile no longer starts from a pinned `ubuntu:<version>`');
  return m[1];
}

const WORKFLOWS = '.github/workflows';
const workflows = readdirSync(resolve(ROOT, WORKFLOWS)).filter((f) => f.endsWith('.yml'));

/** Every `runs-on:` literal, by file. An `${{ … }}` expression resolves through a matrix. */
function runners() {
  const found = [];
  for (const file of workflows) {
    for (const [, value] of read(`${WORKFLOWS}/${file}`).matchAll(/^\s*runs-on:\s*(\S+)\s*$/gm)) {
      if (!value.startsWith('${{')) found.push({ file, value });
    }
  }
  return found;
}

/** Every `os: ubuntu-…` inside a build matrix — what the client is compiled on. */
function matrixRunners() {
  const found = [];
  for (const file of workflows) {
    for (const [, value] of read(`${WORKFLOWS}/${file}`).matchAll(/^\s*os:\s*(ubuntu-\S+)\s*$/gm)) {
      found.push({ file, value });
    }
  }
  return found;
}

/** "ubuntu-22.04-arm" → 2204, so two labels compare as numbers whatever the suffix. */
const rank = (label) => {
  const m = label.match(/^ubuntu-(\d+)\.(\d+)/);
  assert.ok(m, `${label} is not a versioned ubuntu label`);
  return Number(m[1]) * 100 + Number(m[2]);
};

const image = imageVersion();
const ubuntuRunners = runners().filter((r) => r.value.startsWith('ubuntu'));
const clientRunners = matrixRunners();

console.log(`the CI image and the workflows agree (Containerfile: ubuntu:${image}):`);

/** "ci.yml ×11, security.yml ×4" — a count, because the same file holds many jobs. */
const tally = (rows) =>
  Object.entries(rows.reduce((acc, r) => ({ ...acc, [r.file]: (acc[r.file] ?? 0) + 1 }), {}))
    .map(([file, n]) => (n > 1 ? `${file} ×${n}` : file))
    .join(', ');

check('no workflow rides `ubuntu-latest`', () => {
  const riding = runners().filter((r) => r.value === 'ubuntu-latest');
  assert.equal(
    riding.length,
    0,
    `${tally(riding)} — the label moves under you, pin the version`,
  );
});

check('at least one workflow runs on a pinned ubuntu', () => {
  assert.ok(ubuntuRunners.length > 0, 'no `runs-on: ubuntu-<version>` found at all');
});

check('every pinned runner is the version the Containerfile builds', () => {
  const wrong = ubuntuRunners.filter((r) => r.value.replace(/-arm$/, '') !== `ubuntu-${image}`);
  assert.equal(
    wrong.length,
    0,
    `${tally(wrong)} run on ${[...new Set(wrong.map((r) => r.value))].join(', ')} while the ` +
      `image builds ${image} — the local image would stop mirroring CI, its one property`,
  );
});

check('the client is built on an ubuntu no newer than the image', () => {
  assert.ok(clientRunners.length > 0, 'the release client matrix names no ubuntu runner');
  const newer = clientRunners.filter((r) => rank(r.value) > rank(`ubuntu-${image}`));
  assert.equal(
    newer.length,
    0,
    `${[...new Set(newer.map((r) => r.value))].join(', ')} is newer than ubuntu-${image} — ` +
      'a newer build host raises the glibc floor of the shipped binary',
  );
});

/* And the actions, which have the same failure mode as the runners: a version that moves
   in one file and not another. `softprops/action-gh-release` sits in three jobs of the
   release workflow, so bumping two of them would leave a release path running two majors —
   and the only thing that exercises that path is a tag, by which point it is too late.

   Asserted as a general rule rather than for that one action: any action used more than
   once must be used at one version. It catches the next three as well. */
function actionVersions() {
  const seen = new Map();
  for (const file of workflows) {
    for (const [, action, ref] of read(`${WORKFLOWS}/${file}`).matchAll(
      /^\s*-?\s*uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([A-Za-z0-9_.-]+)\s*$/gm,
    )) {
      if (!seen.has(action)) seen.set(action, new Set());
      seen.get(action).add(ref);
    }
  }
  return seen;
}

console.log('\nand an action is used at one version, not two:');

const actions = actionVersions();

check('the workflows name some actions at all', () => {
  assert.ok(actions.size > 5, `only ${actions.size} actions parsed`);
});

check('no action is pinned two ways', () => {
  const split = [...actions]
    .filter(([, refs]) => refs.size > 1)
    .map(([action, refs]) => `${action} @ ${[...refs].join(' and ')}`);
  assert.deepEqual(split, [], 'one of these moved in one file and not the others');
});

check('the release workflow publishes through one action version', () => {
  // Named, because this is the one whose drift a gate cannot catch: only a tag runs it.
  const refs = actions.get('softprops/action-gh-release');
  assert.ok(refs, 'the release workflow no longer uses softprops/action-gh-release');
  assert.equal(refs.size, 1, `publishing through ${[...refs].join(' and ')}`);
});

console.log(`\n${passed} checks passed (ubuntu ${image}, client on ${
  [...new Set(clientRunners.map((r) => r.value))].join(' + ')
}, ${actions.size} actions)`);
