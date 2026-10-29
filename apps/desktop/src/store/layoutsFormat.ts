/**
 * The workspace file (docs/LAYOUTS.md), parsed and compiled (ADR 0023).
 *
 * One file holds both features that describe this machine's setup: `[[preset]]` is
 * the split menu's library, `[[layout]]` is the morning — what opens, where on the
 * screen, and on which machine. It is a file rather than a row in a settings table
 * because it is the machine's, not the account's: a shared server never sees it, and
 * nothing in it is a secret.
 *
 * This module imports NOTHING on purpose. Node's type stripping can load it straight
 * from a check script, so the parser and the planner are tested against the real file
 * format rather than against a copy of them.
 *
 * A deliberately small TOML subset: `[[preset]]`, `[[layout]]`, `[[layout.pane]]`,
 * quoted strings and booleans. The server writes and reads the bytes; the shape is
 * decided here, once.
 */

/** Where a pane goes, in the screen's words. The tree's `horizontal`/`vertical` is an
 *  internal spelling and half the world reads it the wrong way round, so the file
 *  never uses it. */
export type SplitWord = 'right' | 'down' | 'left' | 'up';

/** One terminal of a layout. */
export interface LayoutPane {
  /** A machine from the library, by the name the user gave it. Absent ⇒ this computer. */
  machine?: string;
  /** Typed into the pane once it is ready. Empty ⇒ a plain shell. */
  command: string;
  /** A label for the pane header, and the anchor name `of` points at. */
  name?: string;
  /** A `[[preset]]` whose command this pane runs. Resolved into `command` at parse. */
  preset?: string;
  /** Which way this pane is cut out of the area. Absent ⇒ see `planLayout`. */
  split?: SplitWord;
  /** The pane this one is cut out of, by `name`. Absent ⇒ the previous pane. */
  of?: string;
  /** This pane's share of the area being cut, 0.1–0.9. Absent ⇒ half. */
  size?: number;
  /** The named tab this pane belongs to. Absent ⇒ the previous pane's tab. */
  tab?: string;
}

/** A command in the split menu's library. */
export interface Preset {
  /** Stable within one parse: the file has no ids, and the menu needs a key. */
  id: string;
  name: string;
  command: string;
}

export interface Layout {
  /** Stable within one parse: the file has no ids, and the menu needs a key. */
  id: string;
  name: string;
  /** Opens itself when Rite starts. */
  startup: boolean;
  panes: LayoutPane[];
}

/** Where the file stopped making sense. `line` is 1-based; 0 means "the whole file". */
export interface LayoutError {
  line: number;
  message: string;
}

/**
 * The copy/paste conventions `[terminal] copyMode` may name.
 *
 * DUPLICATED ON PURPOSE, and held by a check. `CLIPBOARD_MODES` in
 * `utils/terminalClipboard.ts` is the one the terminal acts on; this is the one the parser
 * validates against, and `e2e/clipboard-mode-file-check.mjs` asserts the two are identical
 * so neither can grow a mode the other refuses.
 *
 * The alternative was importing it, and this module imports NOTHING: two standalone checks
 * load it through Node's type stripping, which needs an explicit `.ts` on every specifier.
 * One list in two places that a check compares is the same arrangement the Settings rail
 * already uses between the mock and the app — and it beats a parser that accepts any
 * string and leaves a typo to be ignored in silence, with no line number.
 */
export const FILE_COPY_MODES = ['chord', 'select', 'selectRightPaste', 'ctrlC'] as const;
export type FileCopyMode = (typeof FILE_COPY_MODES)[number];

/**
 * Where a new tab starts, as `[terminal] newTabCwd`.
 *
 * ONE VALUE, AND TWO STATES. A path and every new tab starts there; nothing and a new tab
 * starts where the standing pane is, or in the home directory when there is no pane to
 * follow. That is the whole rule, and the earlier shape — `inherit` and `home` as words
 * beside a path — made a setting out of what people expect anyway.
 *
 * An absolute path only. The file is read on one machine and the shell can start on
 * another, so `work` would mean two different places; the parser checks the shape, since
 * there is no list of directories to validate against.
 *
 * `home` survives as a WIRE word, not a value anybody writes: the client asks for the home
 * directory when no pane stands, and the machine that starts the shell is the only side
 * that can resolve it. See `utils/newTabCwd.ts`.
 */
export const NEW_TAB_CWD_HOME = 'home';

/** What `[terminal]` carries: this machine's behaviour, not its arrangement (ADR 0023). */
export interface TerminalSection {
  /** Absent ⇒ the shipped default, which is what Rite has always done. */
  copyMode?: FileCopyMode;
  /** An absolute path, where every new tab then starts. Absent ⇒ the standing pane's
   *  directory, or the home directory when no pane stands. */
  newTabCwd?: string;
}

export interface LayoutParse {
  presets: Preset[];
  layouts: Layout[];
  /** Always present; its fields are absent when the file does not set them. */
  terminal: TerminalSection;
  error: LayoutError | null;
}

/** The smallest and largest share a pane may take, matching what the drag handle and
 *  `updateSplitRatio` already clamp to. A file outside this range is refused rather
 *  than clamped: a screen that does not match the file is worse than a rejection. */
const MIN_SHARE = 0.1;
const MAX_SHARE = 0.9;

/**
 * Parse the file. A file that does not parse yields NOTHING and an error naming the
 * line: half a file is worse than no file, because you would not know which half you
 * got. A file of nothing but comments is not an error — that is a fresh install.
 */
export function parseLayoutFile(text: string): LayoutParse {
  const presets: Preset[] = [];
  /** `[terminal]` is a single table, not an array of them: a machine has one behaviour. */
  const terminal: TerminalSection = {};
  let inTerminal = false;
  const layouts: Layout[] = [];
  let preset: Preset | null = null;
  let current: Layout | null = null;
  let pane: LayoutPane | null = null;
  /** Which line each of a pane's keys came from, so a check made after the whole file
   *  is read can still point at one. A Map, because this module imports nothing. */
  const keyLines = new Map<object, Record<string, number>>();
  const at = (obj: object, key: string): number => keyLines.get(obj)?.[key] ?? 0;
  const remember = (obj: object, key: string, line: number) => {
    const seen = keyLines.get(obj) ?? {};
    seen[key] = line;
    keyLines.set(obj, seen);
  };
  const fail = (line: number, message: string): LayoutParse => ({
    presets: [],
    layouts: [],
    // Nothing from a file that does not parse, the mode included: half a file is worse
    // than no file, and a copy gesture quietly taken from a rejected file would be the
    // one surviving half.
    terminal: {},
    error: { line, message },
  });

  const lines = (text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;

    if (line === '[[preset]]') {
      preset = { id: `p${presets.length + 1}`, name: '', command: '' };
      inTerminal = false;
      presets.push(preset);
      current = null;
      pane = null;
      continue;
    }
    if (line === '[[layout]]') {
      current = { id: `l${layouts.length + 1}`, name: '', startup: false, panes: [] };
      inTerminal = false;
      layouts.push(current);
      preset = null;
      pane = null;
      continue;
    }
    if (line === '[terminal]') {
      // Not `[[terminal]]`: repeating it would ask which one wins, and there is no
      // answer worth having. A second `[terminal]` is caught below as a duplicate key.
      inTerminal = true;
      preset = null;
      current = null;
      pane = null;
      continue;
    }
    if (line === '[[layout.pane]]') {
      if (!current) return fail(i + 1, '[[layout.pane]] before any [[layout]]');
      pane = { command: '' };
      current.panes.push(pane);
      inTerminal = false;
      continue;
    }
    if (line.startsWith('[')) {
      return fail(
        i + 1,
        `unknown table ${line} — only [terminal], [[preset]], [[layout]] and ` +
          `[[layout.pane]] exist`,
      );
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) return fail(i + 1, `not a key or a table header: ${line}`);
    const [, key, raw] = match;
    const value = raw.trim();

    let parsed: string | boolean;
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      parsed = unquote(value.slice(1, -1));
    else if (value === 'true' || value === 'false') parsed = value === 'true';
    // A bare number is the mistake this subset invites, and `size = 45%` is the one
    // people will actually type, so it gets its own sentence instead of the generic one.
    else if (/^[0-9]+(\.[0-9]+)?%?$/.test(value))
      return fail(
        i + 1,
        `a value is quoted — write ${key} = "${value.endsWith('%') ? value : `${value}%`}"`,
      );
    else return fail(i + 1, `a value is a quoted string or true/false, not ${value || 'nothing'}`);

    if (inTerminal) {
      if (key === 'newTabCwd') {
        if (terminal.newTabCwd !== undefined) {
          return fail(i + 1, 'newTabCwd is set twice');
        }
        const where = String(parsed);
        if (!where.startsWith('/')) {
          // A relative path has no meaning here: the file is read on one machine and the
          // shell can start on another, so "." would mean two places. A word is refused
          // too — there is nothing to say in words any more, and `inherit` written here
          // would otherwise be taken for a directory and fail at spawn instead of on this
          // line.
          return fail(i + 1, `newTabCwd is an absolute path — not ${where || 'nothing'}`);
        }
        terminal.newTabCwd = where;
        continue;
      }
      if (key !== 'copyMode') {
        return fail(i + 1, `[terminal] takes copyMode or newTabCwd, not ${key}`);
      }
      if (terminal.copyMode !== undefined) {
        return fail(i + 1, 'copyMode is set twice');
      }
      const mode = String(parsed);
      if (!(FILE_COPY_MODES as readonly string[]).includes(mode)) {
        // Named, not just refused: a typo here would otherwise leave the terminal on its
        // default with nothing to say why, which is the silent failure this subset of
        // TOML exists to avoid.
        return fail(i + 1, `copyMode is one of ${FILE_COPY_MODES.join(', ')} — not ${mode}`);
      }
      terminal.copyMode = mode as FileCopyMode;
      continue;
    }

    if (pane) {
      remember(pane, key, i + 1);
      if (key === 'machine') pane.machine = String(parsed);
      else if (key === 'command') pane.command = String(parsed);
      else if (key === 'name') pane.name = String(parsed);
      else if (key === 'preset') pane.preset = String(parsed);
      else if (key === 'of') pane.of = String(parsed);
      else if (key === 'tab') pane.tab = String(parsed);
      else if (key === 'split') {
        const word = String(parsed);
        if (!isSplitWord(word))
          return fail(i + 1, `a split is right, down, left or up — not ${word}`);
        pane.split = word;
      } else if (key === 'size') {
        const share = parseShare(String(parsed));
        if (share === null)
          return fail(
            i + 1,
            `a size is a percentage between 10% and 90%, not ${String(parsed) || 'nothing'}`,
          );
        pane.size = share;
      } else
        return fail(
          i + 1,
          `a pane takes machine, command, name, preset, split, of, size and tab — not ${key}`,
        );
    } else if (preset) {
      remember(preset, key, i + 1);
      if (key === 'name') preset.name = String(parsed);
      else if (key === 'command') preset.command = String(parsed);
      else return fail(i + 1, `a preset takes name and command — not ${key}`);
    } else if (current) {
      remember(current, key, i + 1);
      if (key === 'name') current.name = String(parsed);
      else if (key === 'startup') current.startup = parsed === true;
      else return fail(i + 1, `a layout takes name and startup — not ${key}`);
    } else {
      return fail(i + 1, `${key} is outside any [[preset]] or [[layout]]`);
    }
  }

  // Checks that can only be made once the whole file is read: a preset may be
  // declared after the layout that cites it, and an anchor is only wrong in the
  // company of the other panes.
  const namelessPreset = presets.find((p) => !p.name.trim());
  if (namelessPreset) return fail(at(namelessPreset, 'command'), 'a preset has no name');
  const nameless = layouts.findIndex((l) => !l.name.trim());
  if (nameless >= 0) return fail(0, `layout #${nameless + 1} has no name`);
  const empty = layouts.find((l) => l.panes.length === 0);
  if (empty) return fail(0, `layout "${empty.name}" has no [[layout.pane]]`);

  for (const layout of layouts) {
    const seen = new Set<string>();
    for (const p of layout.panes) {
      if (p.name?.trim()) {
        if (seen.has(p.name.trim()))
          return fail(
            at(p, 'name'),
            `two panes are named "${p.name.trim()}" — "of" could not tell them apart`,
          );
        seen.add(p.name.trim());
      }
      if (p.preset !== undefined) {
        const cited = presets.find((x) => x.name.trim() === p.preset?.trim());
        if (!cited) return fail(at(p, 'preset'), `no [[preset]] is named "${p.preset}"`);
        if (at(p, 'command'))
          return fail(at(p, 'command'), 'a pane takes preset or command, not both');
        p.command = cited.command;
      }
    }
    // The planner needs the tabs and the anchors to hold; it is the same walk, so it
    // reports here rather than throwing later with no line to name.
    const planned = planTabs(layout, at);
    if ('error' in planned) return { presets: [], layouts: [], terminal: {}, error: planned.error };
  }

  return { presets, layouts, terminal, error: null };
}

/** One cut of the screen: which pane is added, out of which pane's area, and how. */
export interface SplitStep {
  /** Index into the tab's `panes` of the pane being opened. */
  pane: number;
  /** Index into the tab's `panes` of the pane whose area is cut. */
  anchor: number;
  /** The tree's spelling: `horizontal` is side by side, `vertical` is stacked. */
  direction: 'horizontal' | 'vertical';
  /** The new pane takes the left or top side. */
  before: boolean;
  /** The FIRST child's share of the area, which is what `splitPane` takes. */
  ratio: number;
}

/** One tab a layout opens, with the panes it holds and the cuts that arrange them. */
export interface TabPlan {
  /** The tab's name, or `null` for the layout's single unnamed tab. */
  tab: string | null;
  panes: LayoutPane[];
  /** In the order the screen is cut, which for a grid is not the file's order. */
  steps: SplitStep[];
}

/**
 * Compile a layout into the tabs it opens and the cuts that arrange each one.
 *
 * A layout opens its own tabs: the first pane of a tab IS that tab, not a split of
 * whatever happened to be on screen. That is what lets an eight-pane file produce
 * exactly eight panes, and it is why `startup` can be honoured before anything else
 * exists.
 *
 * Two ways to arrange them, and a file picks by what it says:
 *
 * - **It says nothing.** No pane in the tab declares `split`, so the panes tile into
 *   a balanced grid, filled left to right then top to bottom. Four panes make a 2×2.
 * - **It says where.** Any `split` in the tab switches to following the file: each
 *   pane is cut out of the previous one, or out of the pane `of` names, at the share
 *   `size` asks for. Cuts are made in the file's order, so a file describes the big
 *   cuts before the small ones — the order a mouse would do it in.
 *
 * Both produce the same kind of plan, so there is one applier downstream.
 */
export function planLayout(layout: Layout): TabPlan[] {
  const planned = planTabs(layout, () => 0);
  // `parseLayoutFile` has already refused anything that could fail here. A layout that
  // reached this function another way gets the panes with no cuts rather than a throw:
  // one terminal too few is recoverable, a dead workspace is not.
  return 'error' in planned ? planned.fallback : planned.tabs;
}

type Planned = { tabs: TabPlan[] } | { error: LayoutError; fallback: TabPlan[] };

function planTabs(layout: Layout, at: (obj: object, key: string) => number): Planned {
  const tabs: TabPlan[] = [];
  const byName = new Map<string | null, TabPlan>();
  let currentTab: string | null = null;

  for (const pane of layout.panes) {
    if (pane.tab?.trim()) currentTab = pane.tab.trim();
    let plan = byName.get(currentTab);
    if (!plan) {
      plan = { tab: currentTab, panes: [], steps: [] };
      byName.set(currentTab, plan);
      tabs.push(plan);
    }
    plan.panes.push(pane);
  }

  const fallback = tabs.map((t) => ({ ...t, steps: [] }));

  for (const plan of tabs) {
    const explicit = plan.panes.some((p) => p.split !== undefined);
    const first = plan.panes[0];
    for (const key of ['split', 'of', 'size'] as const) {
      if (first[key] !== undefined)
        return {
          error: {
            line: at(first, key),
            message: `the first pane of a tab is the whole area — it has no ${key}`,
          },
          fallback,
        };
    }

    if (!explicit) {
      plan.steps = gridSteps(plan.panes.length);
      continue;
    }

    for (let i = 1; i < plan.panes.length; i++) {
      const pane = plan.panes[i];
      let anchor = i - 1;
      if (pane.of !== undefined) {
        const wanted = pane.of.trim();
        const found = plan.panes.findIndex((p, j) => j < i && p.name?.trim() === wanted);
        if (found < 0) {
          const elsewhere = layout.panes.some((p) => p.name?.trim() === wanted);
          return {
            error: {
              line: at(pane, 'of'),
              message: elsewhere
                ? `"${wanted}" is in another tab, or comes later — "of" points at a pane already placed in this tab`
                : `no pane placed before this one is named "${wanted}"`,
            },
            fallback,
          };
        }
        anchor = found;
      }
      const word = pane.split ?? 'right';
      const share = pane.size ?? 0.5;
      const before = word === 'left' || word === 'up';
      plan.steps.push({
        pane: i,
        anchor,
        direction: word === 'right' || word === 'left' ? 'horizontal' : 'vertical',
        before,
        // The file states the NEW pane's share; the tree stores the first child's.
        ratio: before ? share : 1 - share,
      });
    }
  }

  return { tabs };
}

/**
 * Tile `count` panes into a balanced grid, filled left to right then top to bottom.
 *
 * Rows before columns, because a cut divides one pane's area: while a row is still a
 * single pane it stands for the whole row, and once it is subdivided it no longer
 * does. Each cut takes `1/(remaining)` of what is left, which is what makes the cells
 * equal — halving every time would give 50/25/25.
 *
 * Wider is better for a terminal, so the row count is the square root rounded DOWN:
 * eight panes become 4×2 rather than 3×3 with a gap.
 */
function gridSteps(count: number): SplitStep[] {
  const steps: SplitStep[] = [];
  if (count < 2) return steps;
  const rows = Math.max(1, Math.floor(Math.sqrt(count)));
  const cols = Math.ceil(count / rows);

  const rowStart = (r: number) => r * cols;
  const rowCount = (r: number) => Math.min(cols, count - rowStart(r));
  const usedRows = Math.ceil(count / cols);

  for (let r = 1; r < usedRows; r++) {
    steps.push({
      pane: rowStart(r),
      anchor: rowStart(r - 1),
      direction: 'vertical',
      before: false,
      ratio: 1 / (usedRows - r + 1),
    });
  }
  for (let r = 0; r < usedRows; r++) {
    const n = rowCount(r);
    for (let c = 1; c < n; c++) {
      steps.push({
        pane: rowStart(r) + c,
        anchor: rowStart(r) + c - 1,
        direction: 'horizontal',
        before: false,
        ratio: 1 / (n - c + 1),
      });
    }
  }
  return steps;
}

function isSplitWord(value: string): value is SplitWord {
  return value === 'right' || value === 'down' || value === 'left' || value === 'up';
}

/**
 * Read `"45%"` as a share of the area being cut.
 *
 * A percentage, because that is the unit the renderer already works in — `SplitPane`
 * lays out `${ratio * 100}%` — and the decimal was an internal spelling leaking into
 * someone's file. Outside 10–90 % there is no answer to give: both the drag handle and
 * `updateSplitRatio` clamp there, so the screen could not honour the file.
 */
function parseShare(value: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*%$/.exec(value.trim());
  if (!match) return null;
  const share = Number(match[1]) / 100;
  if (!(share >= MIN_SHARE && share <= MAX_SHARE)) return null;
  return share;
}

/**
 * Undo what `quote()` does: a quoted value may carry an escaped quote or backslash,
 * and a name like `the "big" one` round-trips through the writer only if the reader
 * puts it back. Other escape sequences are left alone rather than invented — a
 * command containing `\n` means those two characters to a shell.
 */
function unquote(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

/**
 * Drop a trailing comment, but not a `#` inside a quoted value — `command = "git log
 * --format=%h#%s"` is one command, not a command and a comment.
 */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== '\\') quoted = !quoted;
    else if (c === '#' && !quoted) return line.slice(0, i);
  }
  return line;
}

/**
 * Rewrite only the `[[preset]]` blocks of a file, leaving everything else as typed.
 *
 * The preset editor is a list of fields, and the file is hand-written and commented.
 * Regenerating the whole document from the parse would silently throw away the
 * comments, the blank lines and the order someone chose — so the editor splices: the
 * first preset block's lines become the whole new library, the other preset blocks go
 * away, and every other line of the file is untouched. A file with no presets yet gets
 * them before its first table, after whatever header comments it opens with.
 *
 * Comments written INSIDE a preset block are the one thing this loses, because they
 * belong to the rows being replaced. Everything else survives, which is what makes the
 * dialog and the editor safe to use on the same file.
 */
export function replacePresetBlocks(text: string, presets: Preset[]): string {
  const lines = (text ?? '').split('\n');
  const isHeader = (line: string) => stripComment(line).trim().startsWith('[');
  const isPresetHeader = (line: string) => stripComment(line).trim() === '[[preset]]';

  const block = presets
    .map((p) =>
      [`[[preset]]`, `name = ${quote(p.name)}`, `command = ${quote(p.command)}`].join('\n'),
    )
    .join('\n\n');

  const out: string[] = [];
  let written = false;
  let i = 0;
  // Everything before the first table header is the file's own preamble and stays put.
  while (i < lines.length && !isHeader(lines[i])) out.push(lines[i++]);

  for (; i < lines.length; i++) {
    if (!isPresetHeader(lines[i])) {
      if (!written && isHeader(lines[i])) {
        if (block) out.push(block, '');
        written = true;
      }
      out.push(lines[i]);
      continue;
    }
    // Skip this block: its header, then its keys, up to the next table or the end.
    if (!written) {
      if (block) out.push(block, '');
      written = true;
    }
    i++;
    while (i < lines.length && !isHeader(lines[i])) i++;
    // Land on the header that ended the block, so the loop's own step reaches it.
    i--;
  }

  if (!written && block) {
    // No table at all: the preamble is the whole file, so the presets go after it.
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(block, '');
  }

  return out.join('\n');
}

/**
 * Turn one layout's `startup` on or off, touching nothing else in the file.
 *
 * Same contract as `replacePresetBlocks`, for the same reason: the file is written and
 * commented by hand, so an edit made from the UI splices one key rather than
 * regenerating the document and throwing away the comments and the order someone
 * chose. The target is the layout's **position in the file**, not its name — two
 * layouts may legitimately share a name, and the position is what the parse returns.
 *
 * Switching it off removes the line rather than writing `startup = false`, which
 * matches what `formatLayoutFile` emits and keeps the file free of a key that states
 * the default. Switching it on adds the line under `name`, where the documentation
 * shows it.
 *
 * An index no layout occupies returns the text unchanged: the file may have been
 * edited under the dialog, and silently rewriting the wrong layout would be worse
 * than doing nothing.
 */
export function setLayoutStartup(text: string, index: number, startup: boolean): string {
  const lines = (text ?? '').split('\n');
  const isHeader = (line: string) => stripComment(line).trim().startsWith('[');
  const keyOf = (line: string) =>
    /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(stripComment(line).trim())?.[1];

  // Find the header that opens the layout we were asked about.
  let seen = -1;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (stripComment(lines[i]).trim() !== '[[layout]]') continue;
    seen++;
    if (seen === index) {
      start = i;
      break;
    }
  }
  if (start < 0) return text ?? '';

  // Its keys run to the next table — `[[layout.pane]]` included, which is exactly
  // right: `startup` belongs to the layout, so it cannot live past the first pane.
  let end = start + 1;
  while (end < lines.length && !isHeader(lines[end])) end++;

  const at = lines.slice(start + 1, end).findIndex((l) => keyOf(l) === 'startup');
  const out = lines.slice();

  if (at >= 0) {
    if (startup) out[start + 1 + at] = indentOf(lines[start + 1 + at]) + 'startup = true';
    else out.splice(start + 1 + at, 1);
    return out.join('\n');
  }
  if (!startup) return text ?? '';

  // No key yet: under `name` if there is one, otherwise straight under the header.
  const nameAt = lines.slice(start + 1, end).findIndex((l) => keyOf(l) === 'name');
  const insertAt = nameAt >= 0 ? start + 2 + nameAt : start + 1;
  out.splice(insertAt, 0, indentOf(lines[insertAt - 1]) + 'startup = true');
  return out.join('\n');
}

/**
 * Write one `[terminal]` key into the file, or take it out with `null`.
 *
 * `[terminal]` is where this machine's behaviour lives (ADR 0023), so a Settings control
 * edits the FILE rather than keeping a second copy of the value beside it — which is the
 * whole reason the section exists. `setLayoutStartup` above does the same for a layout's
 * own key, and this is its counterpart for the one table that is not a list.
 *
 * The table is created when it is absent, at the TOP of the file. It cannot go at the
 * bottom: in this subset a key belongs to whichever table is currently open, so a
 * `[terminal]` appended after a `[[layout.pane]]` would be fine but one appended without
 * its header would silently become a pane's key. Writing the header too makes that
 * impossible either way, and the top is where a reader looks for a file-wide setting.
 */
export function setTerminalValue(text: string, key: string, value: string | null): string {
  const lines = (text ?? '').split('\n');
  const isHeader = (line: string) => stripComment(line).trim().startsWith('[');
  const keyOf = (line: string) =>
    /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(stripComment(line).trim())?.[1];

  const start = lines.findIndex((l) => stripComment(l).trim() === '[terminal]');

  if (start < 0) {
    if (value === null) return text ?? '';
    const head = ['[terminal]', `${key} = ${quote(value)}`, ''];
    // An empty file gets the table and nothing else: no leading blank line to strip later.
    return (text ?? '').trim() === '' ? head.join('\n') : head.concat(lines).join('\n');
  }

  let end = start + 1;
  while (end < lines.length && !isHeader(lines[end])) end++;

  const at = lines.slice(start + 1, end).findIndex((l) => keyOf(l) === key);
  const out = lines.slice();

  if (at >= 0) {
    const line = start + 1 + at;
    if (value === null) out.splice(line, 1);
    else out[line] = indentOf(lines[line]) + `${key} = ${quote(value)}`;
    return out.join('\n');
  }
  if (value === null) return text ?? '';

  out.splice(start + 1, 0, indentOf(lines[start + 1] ?? '') + `${key} = ${quote(value)}`);
  return out.join('\n');
}

/** The leading whitespace of a line, so a spliced key lines up with its neighbours. */
function indentOf(line: string): string {
  return /^\s*/.exec(line ?? '')?.[0] ?? '';
}

/** The pane header a layout asks for, when it does not name one itself. */
export function paneLabel(pane: LayoutPane): string {
  if (pane.name?.trim()) return pane.name.trim();
  if (pane.machine?.trim()) return pane.machine.trim();
  const first = pane.command.trim().split(/\s+/)[0];
  return first || '';
}

/** Write the file back out, in the documented shape. Used by the editor's formatter
 *  and by the one-time migration out of the release candidate's browser storage. */
export function formatLayoutFile(layouts: Layout[], presets: Preset[] = []): string {
  const blocks = presets.map((p) =>
    [`[[preset]]`, `name = ${quote(p.name)}`, `command = ${quote(p.command)}`].join('\n'),
  );

  for (const l of layouts) {
    const head = [`[[layout]]`, `name = ${quote(l.name)}`]
      .concat(l.startup ? ['startup = true'] : [])
      .join('\n');
    const panes = l.panes
      .map((p) => {
        const keys = [`  [[layout.pane]]`];
        if (p.tab) keys.push(`  tab = ${quote(p.tab)}`);
        if (p.machine) keys.push(`  machine = ${quote(p.machine)}`);
        if (p.preset) keys.push(`  preset = ${quote(p.preset)}`);
        else keys.push(`  command = ${quote(p.command)}`);
        if (p.name) keys.push(`  name = ${quote(p.name)}`);
        if (p.split) keys.push(`  split = ${quote(p.split)}`);
        if (p.of) keys.push(`  of = ${quote(p.of)}`);
        if (p.size !== undefined) keys.push(`  size = ${quote(`${Math.round(p.size * 100)}%`)}`);
        return keys.join('\n');
      })
      .join('\n\n');
    blocks.push(`${head}\n\n${panes}\n`);
  }

  return blocks.join('\n');
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
