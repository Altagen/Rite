/**
 * Inline styling is inventoried, so it cannot grow back quietly.
 *
 * The app writes CSS in two places: a stylesheet, and the elements themselves. The second
 * is why the served CSP carries `style-src 'unsafe-inline'`, and it is why a theme cannot
 * be a file yet — a value that belongs to the design lands in a component instead, and
 * nothing says which values those are.
 *
 * The 2026-10-28 inventory sorted every site into four kinds (docs/ROADMAP.md, "Styling:
 * one place for it"), and only one of them was movable: static CSS, inline for no reason.
 * Those are gone. What is left is per-element data — a split's percentage, a popup's
 * coordinates, a colour the user chose — which no stylesheet can hold.
 *
 * So this check pins COUNTS, not shapes. It is a ratchet: a new inline site fails it, and
 * the fix is either a class or a line in the inventory saying which kind it is and why a
 * stylesheet cannot hold it. Each number may only go DOWN without a deliberate edit here.
 *
 * It counts imperative writes too (`el.style.x = ...`). They are inline styling just the
 * same, they are invisible to a `style={{}}` search, and the first inventory missed them.
 *
 * Run: node e2e/inline-style-inventory-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const SRC = new URL('../apps/desktop/src/', import.meta.url);

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

/** Every .ts/.tsx under apps/desktop/src, as [relative path, text]. */
function sources(dir = SRC, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...sources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push([`${prefix}${entry.name}`, readFileSync(new URL(entry.name, dir), 'utf8')]);
    }
  }
  return out;
}

const FILES = sources();

/** Sites of a given pattern, as `path:line` so a failure names them. */
function sites(re) {
  const found = [];
  for (const [path, text] of FILES) {
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) found.push(`${path}:${i + 1}`);
    });
  }
  return found;
}

/* ---- the ratchet ------------------------------------------------------------------ */

/* A JSX style prop. 30 after the 2026-10-28 sort: 14 runtime geometry, 14 a colour the
   user chose, 1 a context's badge, 1 the overflow button whose display a layout effect
   drives imperatively — a class there would lose to `el.style.display = ''`. */
const STYLE_PROP_CEILING = 30;

/* Imperative writes: a textarea growing to its content, a drag image built off-screen,
   and the overflow nav collapsing its items. All three measure first and then write, so
   none of them can be a class. */
const IMPERATIVE_CEILING = 12;

check(`no more than ${STYLE_PROP_CEILING} \`style={{\` sites`, () => {
  const found = sites(/style=\{\{/);
  assert.ok(
    found.length <= STYLE_PROP_CEILING,
    `${found.length} sites, ceiling ${STYLE_PROP_CEILING}. A new one needs a class, or a ` +
      `line in the ROADMAP inventory saying why a stylesheet cannot hold it:\n        ` +
      found.join('\n        '),
  );
});

check(`no more than ${IMPERATIVE_CEILING} imperative \`.style.x =\` writes`, () => {
  const found = sites(/\.style\.[a-zA-Z]+\s*=/);
  assert.ok(
    found.length <= IMPERATIVE_CEILING,
    `${found.length} writes, ceiling ${IMPERATIVE_CEILING}. These are inline styles that a ` +
      `\`style={{}}\` search does not see:\n        ` + found.join('\n        '),
  );
});

/* ---- what the sort already settled, so it cannot come back ------------------------ */

/* Each of these was an inline declaration on 2026-10-28 and is now a class. Named one by
   one: a count alone would let a conversion be undone while another site was removed. */
const CONVERTED = [
  ["resize: 'vertical'", 'a textarea the user can drag taller — `resize-y`'],
  ["userSelect: 'none'", "the split divider's drag — `select-none`"],
  ["pointerEvents: 'auto'", 'the pane header above a drag — `pointer-events-auto`'],
  ["transform: 'rotate(90deg)'", 'the vertical split glyph — an arbitrary-property class'],
  ["padding: '4px'", 'the sidebar icon buttons — `p-1`'],
  ["paddingLeft: '6px'", "the library tree's left inset — `pl-1.5`"],
];

for (const [decl, why] of CONVERTED) {
  check(`\`${decl}\` stays a class`, () => {
    const found = sites(new RegExp(decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(found.length, 0, `${why}; back inline at ${found.join(', ')}`);
  });
}

/* No hex literal inside a style prop. The one that was there, `color: '#f7768e'`, was
   `--destructive` (`348.8 89% 71.6%`) written out — the two agreed by hand and nothing
   said so, so a palette change would have left that single button on the old red.
   Stated as a rule rather than against that one value: a colour reaching an element is
   either a token, and belongs in a class, or the user's own, and arrives in a variable.

   Scoped to style props on purpose. The swatch arrays — the colours a user may PICK for
   a collection, a machine or a folder — are hex literals too, legitimately: they are
   data, not design, and one of them happens to be #f7768e by coincidence of palette. */
check('no hex literal inside a style prop', () => {
  const found = [];
  for (const [path, text] of FILES) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/style=\{\{/.test(line)) return;
      // A style prop may span lines; read to its closing braces, bounded.
      const block = lines.slice(i, i + 8).join('\n');
      const upto = block.indexOf('}}');
      if (/#[0-9a-fA-F]{3,8}\b/.test(upto === -1 ? block : block.slice(0, upto))) {
        found.push(`${path}:${i + 1}`);
      }
    });
  }
  assert.equal(
    found.length,
    0,
    `a token belongs in a class, the user's colour in a variable. At ${found.join(', ')}`,
  );
});

console.log(`\n${passed} checks passed`);
