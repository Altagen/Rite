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
import { createHash } from 'node:crypto';
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
const ACTIONS = '.github/actions';
const workflows = readdirSync(resolve(ROOT, WORKFLOWS)).filter((f) => f.endsWith('.yml'));

/** Every `runs-on:` literal, by file. An `${{ … }}` expression resolves through a matrix. */
function runners() {
  const found = [];
  for (const file of workflows) {
    // Per job, because a job that COMPILES A SHIPPED BINARY answers to a different rule.
    // Its runner is chosen for its glibc — the build host's is the floor of what ships —
    // not to mirror the CI image. The marker is the composite action that does the
    // compiling, so the exemption follows the work rather than a list of job names.
    for (const job of read(`${WORKFLOWS}/${file}`).split(/\n(?=  [a-z][a-z0-9_-]*:\n)/)) {
      const ships = /build-server-binary/.test(job);
      for (const [, value] of job.matchAll(/^\s*runs-on:\s*(\S+)\s*$/gm)) {
        if (!value.startsWith('${{')) found.push({ file, value, ships });
      }
    }
  }
  return found;
}

/** Every `os: ubuntu-…` inside a build matrix — the client, and the server binary. */
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
const ubuntuRunners = runners().filter((r) => r.value.startsWith('ubuntu') && !r.ships);
// A matrix `os:` plus any job whose runner was picked for its glibc.
const shippedRunners = [...matrixRunners(), ...runners().filter((r) => r.ships)];

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

check('a shipped binary is built on an ubuntu no newer than the image', () => {
  assert.ok(shippedRunners.length > 0, 'no build matrix names an ubuntu runner');
  const newer = shippedRunners.filter((r) => rank(r.value) > rank(`ubuntu-${image}`));
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
  // COMPOSITE ACTIONS COUNT. A step moved out of a workflow and into
  // `.github/actions/<name>/action.yml` keeps its `uses:` lines, and those lines went on
  // drifting out of sight: `build-server-binary` carries setup-node, pnpm and rust-cache
  // for two workflows at once, so bumping one of them in `release.yml` and not there
  // would leave the same action at two majors with nothing saying so.
  const files = [
    ...workflows.map((f) => `${WORKFLOWS}/${f}`),
    ...readdirSync(resolve(ROOT, ACTIONS), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `${ACTIONS}/${d.name}/action.yml`),
  ];
  for (const file of files) {
    for (const [, action, ref] of read(file).matchAll(
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

// The acceptance fixture compiles the binary INSIDE the ISO-CI image and then wraps it in
// a base image of its own — so that base is not decoration, it is the glibc the binary has
// to find at load. The two were written equal and drifted the moment the image moved to
// 26.04: `ubuntu:24.04` carries GLIBC 2.39, a 26.04 build needs 2.43, and the failure is a
// loader error in step 5 of the gate that reads as if the server were broken.
check('the acceptance fixture runs the binary on the ubuntu that built it', () => {
  const fixture = read('e2e/turnkey-acceptance.sh');
  const m = fixture.match(/^FROM ubuntu:(\d+\.\d+)$/m);
  assert.ok(m, 'e2e/turnkey-acceptance.sh no longer wraps the binary in a pinned ubuntu');
  assert.equal(
    m[1],
    image,
    `the fixture runs the server on ubuntu:${m[1]} while the image that compiles it is ` +
      `ubuntu:${image} — an older base cannot load a binary built against a newer glibc`,
  );
});

// THE PINNED TOOLCHAIN IMAGE IS THE ONE THESE FILES DESCRIBE.
//
// CI no longer installs a toolchain: four jobs run inside the image `Containerfile`
// builds, pinned in `.github/toolchain-image` by tag AND digest. The digest is what gets
// pulled. The tag is the hash of the image's inputs — and recomputing it here is what
// closes the loop: edit `Containerfile`, `rust-toolchain.toml`, `.node-version` or the
// `packageManager` line, forget to republish, and the jobs would validate that change
// inside the environment it was meant to replace. Silently, and in the direction that
// matters least — a Rust bump tested by the old Rust.
//
// The hash must match what the workflow computes in shell, byte for byte: the three files
// concatenated, then the packageManager value and a newline (what `sed -n ...p` prints).
check('the pinned toolchain image is the one these files describe', () => {
  const pin = read('.github/toolchain-image')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  assert.ok(pin, '.github/toolchain-image pins nothing');
  // `<hash>-<YYYYMMDD>`: the date is what makes a published tag immutable. Reusing a
  // tag untagged the previous manifest, GHCR collected it, and every pinned digest
  // stopped resolving at once — on a Monday it would have been every week.
  const m = pin.match(/^(\S+):([0-9a-f]{12})-(\d{8})@(sha256:[0-9a-f]{64})$/);
  assert.ok(
    m,
    `${pin} is not <image>:<12-hex>-<YYYYMMDD>@sha256:<digest> — all three parts carry something`,
  );
  const pm = read('package.json').match(/"packageManager"\s*:\s*"([^"]*)"/);
  assert.ok(pm, 'package.json no longer declares packageManager');
  const h = createHash('sha256');
  for (const f of ['Containerfile', 'rust-toolchain.toml', '.node-version']) {
    h.update(readFileSync(resolve(ROOT, f)));
  }
  h.update(`${pm[1]}\n`);
  const want = h.digest('hex').slice(0, 12);
  assert.equal(
    m[2],
    want,
    `the image is pinned at ${m[2]} but these files hash to ${want} — one of ` +
      'Containerfile, rust-toolchain.toml, .node-version or packageManager changed ' +
      'without the image being republished. Run the `Base images` workflow and pin ' +
      'the line it prints.',
  );
});

check('no CI job installs what the image already carries', () => {
  const ci = read(`${WORKFLOWS}/ci.yml`);
  const jobs = ci.split(/\n(?=  [a-z][a-z0-9_-]*:\n)/);
  const offenders = jobs
    .filter((j) => /\bcontainer:\n\s+image:/.test(j))
    .filter((j) => /apt-get install|setup-node@|pnpm\/action-setup@|actions\/setup-rust/.test(j))
    .map((j) => j.trim().split('\n')[0]);
  assert.deepEqual(
    offenders,
    [],
    'a job runs in the toolchain image and still installs a toolchain beside it',
  );
});

// THE SERVER IMAGE'S THREE STAGES SHARE ONE DEBIAN — across two files now.
//
// `rust:<v>-<suite>` compiles the binary and `Containerfile.runtime` runs it, and the
// binary links against the builder's glibc: trixie is 2.41 and bookworm 2.36, so a
// builder moved without the runtime fails at LOAD, not at build — the error arrives in
// production wearing the mask of a broken server. The node stage is in the set because
// its bundle is what rust-embed compiles in.
//
// THE BINARY IS BUILT ON A GLIBC THE RUNTIME BASE CAN SATISFY.
//
// This replaces "every stage names the same Debian", which answered the question by
// construction: the binary was compiled inside the image, on the distribution it would
// run on, so there was nothing to compare. It is compiled on a GitHub runner now and run
// on the Debian base below, and a binary cannot find a glibc OLDER than the one it was
// linked against. The build host's glibc is therefore the floor of what ships.
//
// A VIOLATION DOES NOT FAIL THE BUILD, IT FAILS THE START. The image assembles perfectly,
// and `docker run` then prints a loader error about a version not found — naming a
// library, never a workflow file. That is why this lives here, in a check that runs on
// every commit, rather than in a comment next to the runner label.
//
// THE NUMBERS ARE THE DISTRIBUTIONS', not a binary's observed symbols: `ubuntu-22.04`
// ships 2.35 (Launchpad) and Debian trixie ships 2.41 (packages.debian.org). An unknown
// name is a failure rather than a pass, because the whole point is that nobody should be
// able to move either end by hand without this saying something.
const GLIBC = {
  'ubuntu-20.04': [2, 31],
  'ubuntu-22.04': [2, 35],
  'ubuntu-24.04': [2, 39],
  'ubuntu-26.04': [2, 43],
  bullseye: [2, 31],
  bookworm: [2, 36],
  trixie: [2, 41],
};

const glibc = (name, what) => {
  // `ubuntu-22.04-arm` is the same distribution on another architecture.
  const key = name.replace(/-arm$/, '');
  const v = GLIBC[key];
  assert.ok(v, `${what} is ${name}, whose glibc this check does not know — add it to GLIBC`);
  return v;
};

const show = ([a, b]) => `${a}.${b}`;
const le = ([a, b], [c, d]) => a < c || (a === c && b <= d);

// Every job that compiles rite-server, wherever it is declared. Both workflows build it
// the same way, through the same composite action — so both have to be read, or a runner
// bumped in one of them would sail past.
const serverBuilders = () => {
  const found = [];
  const release = read(`${WORKFLOWS}/release.yml`);
  const job = release.split(/\n(?=  [a-z][a-z0-9_-]*:\n)/).find((j) => j.startsWith('  build-server:'));
  assert.ok(job, 'release.yml no longer has a build-server job');
  for (const m of job.matchAll(/^\s+os:\s*(\S+)$/gm)) found.push([m[1], 'release.yml build-server']);

  const ci = read(`${WORKFLOWS}/ci.yml`);
  const cj = ci.split(/\n(?=  [a-z][a-z0-9_-]*:\n)/).find((j) => j.startsWith('  server-binary:'));
  assert.ok(cj, 'ci.yml no longer has a server-binary job');
  // In a container, the runner label says nothing about the glibc the compiler links
  // against — the image's does. The job must stay on the bare runner it names.
  assert.ok(
    !/\bcontainer:\n/.test(cj),
    'ci.yml server-binary runs in a container, so its runs-on no longer decides the glibc',
  );
  const r = cj.match(/^\s+runs-on:\s*(\S+)$/m);
  assert.ok(r, 'ci.yml server-binary names no runner');
  found.push([r[1], 'ci.yml server-binary']);

  assert.ok(found.length >= 3, `only ${found.length} server build hosts found — expected two in the release and one in CI`);
  return found;
};

check('the server binary is built on a glibc the runtime base can satisfy', () => {
  const base = read('Containerfile.runtime').match(/^FROM debian:([a-z]+)-slim@sha256:[0-9a-f]{64}$/m);
  assert.ok(base, 'Containerfile.runtime no longer names a Debian suite the usual way');
  const ceiling = glibc(base[1], 'the runtime base');

  for (const [host, where] of serverBuilders()) {
    const floor = glibc(host, `${where}'s runner`);
    assert.ok(
      le(floor, ceiling),
      `${where} builds on ${host} (glibc ${show(floor)}) but the image runs on debian ` +
        `${base[1]} (glibc ${show(ceiling)}) — the binary would fail to START, from the ` +
        'loader, with an error naming no workflow',
    );
  }
});

// AND THE RUNTIME BASE IT IS PINNED TO IS THE ONE THAT FILE DESCRIBES. Same closure as the
// toolchain image: the `FROM` line in Containerfile.server is the only copy of the digest,
// and its tag is the hash of `Containerfile.runtime`. Edit that file without republishing
// and the server image would be built on a base that no longer matches its own recipe —
// invisible, since it builds perfectly either way.
check('the pinned runtime base is the one Containerfile.runtime describes', () => {
  const m = read('Containerfile.server').match(
    /^FROM (\S+rite-runtime):([0-9a-f]{12})-(\d{8})@(sha256:[0-9a-f]{64}) AS runtime$/m,
  );
  assert.ok(
    m,
    'the runtime stage no longer reads `FROM <image>:<12-hex>-<YYYYMMDD>@sha256:<digest> AS runtime`',
  );
  const want = createHash('sha256')
    .update(readFileSync(resolve(ROOT, 'Containerfile.runtime')))
    .digest('hex')
    .slice(0, 12);
  assert.equal(
    m[2],
    want,
    `the runtime base is pinned at ${m[2]} but Containerfile.runtime hashes to ${want} — ` +
      'republish it with the `Base images` workflow and pin the line it prints',
  );
});

// The other half of "a local run and CI agree": not only the same distribution, but the
// same WORK. This one was missing and it cost a false green — Dependabot #436 moved the
// Containerfile to 25.10 and every CI tick came back successful, because the check that
// holds the Containerfile and the runners to the same version is in `run-checks.sh` and
// `run-checks.sh` was in no workflow. A gate nobody runs is a comment.
check('the standalone checks run in CI, not only in the local gate', () => {
  const callers = workflows.filter((f) => /\be2e\/run-checks\.sh\b/.test(read(`${WORKFLOWS}/${f}`)));
  assert.ok(
    callers.length > 0,
    'no workflow runs e2e/run-checks.sh — the 69 checks would be local-only again',
  );
  for (const file of callers) {
    const text = read(`${WORKFLOWS}/${file}`);
    // The two ways a check runs and still cannot fail anything, both of which
    // `scripts/audit.sh` was once called through (`e2e/audit-script-check.mjs`).
    assert.doesNotMatch(
      text,
      /run-checks\.sh.*\|\|\s*true/,
      `${file} runs the checks and discards the result`,
    );
    // The job block that holds it: from its own key to the next one at the same indent.
    const jobs = text.split(/\n(?=  [a-z][a-z0-9_-]*:\n)/);
    const owner = jobs.find((j) => /\be2e\/run-checks\.sh\b/.test(j));
    assert.doesNotMatch(
      owner,
      /continue-on-error:\s*true/,
      `${file} lets the job that runs the checks fail without failing the run`,
    );
  }
});

console.log(`\n${passed} checks passed (ubuntu ${image}, shipped binaries on ${
  [...new Set(shippedRunners.map((r) => r.value))].join(' + ')
}, ${actions.size} actions)`);
