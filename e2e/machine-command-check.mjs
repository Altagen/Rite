/**
 * The dashboard's command builders, and the one thing they all have in common:
 * every argument they interpolate was read off a remote host.
 *
 * A container name comes from `docker ps`, a unit name from `systemctl list-units`,
 * and the command built from either is typed into a live shell on that host. Docker
 * and systemd both restrict the names they will accept, which is why this has never
 * gone wrong in practice — but that is their rule, about data that has already left
 * their hands by the time it reaches `machineProbe.ts`. This check is that file's
 * own rule, and it is here now rather than later because the agent manager (ADR
 * 0022) will interpolate *file paths* read from a host, and a path genuinely can
 * contain anything.
 *
 * Loads apps/desktop/src/utils/machineProbe.ts directly: it imports nothing at
 * runtime, so this tests the shipped builders rather than a copy of them.
 *
 * Run: node e2e/machine-command-check.mjs
 */
import assert from 'node:assert/strict';
import {
  shellArg,
  containerShellCmd,
  containerLogsCmd,
  containerRestartCmd,
  serviceJournalCmd,
  serviceRestartCmd,
  serviceToggleCmd,
  servicesShowCmd,
  parseContainers,
  parseServices,
} from '../apps/desktop/src/utils/machineProbe.ts';

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
 * Everything a POSIX shell would read as more than one word, or as punctuation.
 *
 * The no-space entries are the ones that matter: a field that rejects whitespace
 * still accepts `web;id`, and a check whose every hostile case contains a space
 * passes on a regex that allows semicolons.
 */
const HOSTILE = [
  'web;id',
  'web|id',
  'web&id',
  'web<x',
  'web; rm -rf /',
  'web && curl http://x | sh',
  'web`id`',
  'web$(id)',
  'web$HOME',
  'web | tee /tmp/x',
  'web\nnext-command',
  'web with spaces',
  'web>out',
  "web'quoted",
  'web*',
];

console.log('quoting:');

check('an ordinary name is left alone, because it is also the tooltip', () => {
  // `docker logs -f --tail 200 web-01` is what the user is about to run and is
  // worth reading. Quoting every name to guard the one that needs it would cost
  // that for nothing.
  for (const name of ['web-01', 'api_2', 'app.service', 'user@host', 'a', 'x:1', 'c+d']) {
    assert.equal(shellArg(name), name, name);
  }
});

check('anything else is single-quoted', () => {
  for (const name of HOSTILE) {
    const out = shellArg(name);
    assert.notEqual(out, name, `${JSON.stringify(name)} was passed through`);
    assert.equal(out[0], "'", out);
    assert.equal(out[out.length - 1], "'", out);
  }
});

check('a literal quote is escaped the only way POSIX allows', () => {
  // Leave the quotes, escape the quote, come back: 'it'\''s'. Getting this wrong is
  // how a quoting helper becomes the injection it was added to prevent.
  assert.equal(shellArg("it's"), "'it'\\''s'");
});

check('a name that starts with a dash is quoted', () => {
  // Quoting does not stop argv parsing — `-rm` is still read as a flag — but a name
  // that cannot come from docker or systemd should not come out of here as a bare
  // word either. The residual is named in machineProbe.ts rather than hidden.
  assert.equal(shellArg('-rm'), "'-rm'");
  assert.equal(shellArg('--help'), "'--help'");
});

check('the empty name is quoted, not dropped', () => {
  // Dropping it would shift every later argument by one position.
  assert.equal(shellArg(''), "''");
});

console.log('\nthe builders:');

const BUILDERS = [
  ['containerShellCmd', (n) => containerShellCmd('docker', n)],
  ['containerLogsCmd', (n) => containerLogsCmd('podman', n)],
  ['containerRestartCmd', (n) => containerRestartCmd('none', n)],
  ['serviceJournalCmd', (n) => serviceJournalCmd(n)],
  ['serviceRestartCmd', (n) => serviceRestartCmd(n)],
  ['serviceToggleCmd', (n) => serviceToggleCmd(n, true)],
  ['servicesShowCmd', (n) => servicesShowCmd([n])],
];

check('no builder puts a hostile name in front of a shell unquoted', () => {
  for (const [label, build] of BUILDERS) {
    for (const name of HOSTILE) {
      const cmd = build(name);
      assert.ok(
        cmd.includes(shellArg(name)),
        `${label} did not quote ${JSON.stringify(name)}: ${cmd}`,
      );
      assert.ok(
        !cmd.includes(` ${name} `) && !cmd.endsWith(` ${name}`),
        `${label} passed ${JSON.stringify(name)} through: ${cmd}`,
      );
    }
  }
});

check('an ordinary name still reads as the command the user expects', () => {
  assert.equal(containerShellCmd('docker', 'web-01'), 'docker exec -it web-01 sh');
  assert.equal(containerLogsCmd('podman', 'web-01'), 'podman logs -f --tail 200 web-01');
  assert.equal(containerRestartCmd('none', 'web-01'), 'docker restart web-01');
  assert.equal(serviceJournalCmd('nginx.service'), 'journalctl -u nginx.service -f -n 200');
  assert.equal(serviceRestartCmd('nginx.service'), 'sudo systemctl restart nginx.service');
  assert.equal(serviceToggleCmd('nginx.service', true), 'sudo systemctl stop nginx.service');
  assert.equal(serviceToggleCmd('nginx.service', false), 'sudo systemctl start nginx.service');
});

check('a missing runtime still drives docker, not an empty command', () => {
  assert.ok(containerShellCmd('none', 'web').startsWith('docker '));
});

check('servicesShowCmd keeps the name instead of filing it down', () => {
  // It used to strip whatever it did not like, which turns `a;b.service` into
  // `ab.service` — a real unit, possibly someone else's, silently asked about
  // instead of the one in hand. Quoting keeps the name and asks about nothing else.
  const cmd = servicesShowCmd(['a;b.service', 'nginx.service']);
  assert.ok(cmd.includes("'a;b.service'"), cmd);
  assert.ok(!cmd.includes('ab.service'), cmd);
  assert.ok(cmd.includes(' nginx.service '), cmd);
});

console.log('\nwhat the parsers hand the builders:');

check('a container name arrives exactly as the host wrote it', () => {
  // The parsers do not sanitise, and must not start: a name they alter is a name
  // the action then misses. Quoting is the answer, which is why it is in one place.
  const { runtime, rows } = parseContainers("__rt__ docker\nweb; rm -rf /|nginx|running||2 days ago");
  assert.equal(runtime, 'docker');
  assert.equal(rows[0].name, 'web; rm -rf /');
  assert.ok(containerShellCmd(runtime, rows[0].name).includes("'web; rm -rf /'"));
});

check('a unit name arrives as written too', () => {
  const rows = parseServices("a'b.service loaded active running Odd unit");
  assert.equal(rows[0].name, "a'b.service");
  assert.ok(serviceRestartCmd(rows[0].name).includes("'a'\\''b.service'"));
});

console.log(`\n${passed} checks passed`);
