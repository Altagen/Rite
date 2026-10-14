/**
 * The layouts file (docs/LAYOUTS.md), parsed.
 *
 * A layout is the start of a working day — what opens, where, and on which machine —
 * so it is a file rather than a row in a settings table: it names machines, it has an
 * order, it can be what runs before you have typed anything, and it is the kind of
 * thing people keep in version control and copy between computers.
 *
 * This module imports NOTHING on purpose. Node's type stripping can load it straight
 * from a check script, so the parser is tested against the real file format rather
 * than against a copy of it.
 *
 * A deliberately small TOML subset: `[[layout]]`, `[[layout.pane]]`, quoted strings
 * and booleans. The server writes and reads the bytes; the shape is decided here,
 * once, for both shells.
 */

/** One terminal of a layout. */
export interface LayoutPane {
  /** A machine from the library, by the name the user gave it. Absent ⇒ this computer. */
  machine?: string;
  /** Typed into the pane once it is ready. Empty ⇒ a plain shell. */
  command: string;
  /** A label for the pane header. Absent ⇒ the machine, else the command's first word. */
  name?: string;
}

export interface Layout {
  /** Stable within one parse: the file has no ids, and the menu needs a key. */
  id: string;
  name: string;
  /** Opens itself in a new tab when Rite starts. */
  startup: boolean;
  panes: LayoutPane[];
}

/** Where the file stopped making sense. `line` is 1-based; 0 means "the whole file". */
export interface LayoutError {
  line: number;
  message: string;
}

export interface LayoutParse {
  layouts: Layout[];
  error: LayoutError | null;
}

/**
 * Parse the file. A file that does not parse yields NO layouts and an error naming
 * the line: half a file is worse than no file, because you would not know which half
 * you got. A file of nothing but comments is not an error — that is a fresh install.
 */
export function parseLayoutFile(text: string): LayoutParse {
  const layouts: Layout[] = [];
  let current: Layout | null = null;
  let pane: LayoutPane | null = null;
  const fail = (line: number, message: string): LayoutParse => ({ layouts: [], error: { line, message } });

  const lines = (text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;

    if (line === '[[layout]]') {
      current = { id: `l${layouts.length + 1}`, name: '', startup: false, panes: [] };
      layouts.push(current);
      pane = null;
      continue;
    }
    if (line === '[[layout.pane]]') {
      if (!current) return fail(i + 1, '[[layout.pane]] before any [[layout]]');
      pane = { command: '' };
      current.panes.push(pane);
      continue;
    }
    if (line.startsWith('[')) {
      return fail(i + 1, `unknown table ${line} — only [[layout]] and [[layout.pane]] exist`);
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) return fail(i + 1, `not a key or a table header: ${line}`);
    const [, key, raw] = match;
    const value = raw.trim();

    let parsed: string | boolean;
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      parsed = unquote(value.slice(1, -1));
    else if (value === 'true' || value === 'false') parsed = value === 'true';
    else return fail(i + 1, `a value is a quoted string or true/false, not ${value || 'nothing'}`);

    if (pane) {
      if (key === 'machine') pane.machine = String(parsed);
      else if (key === 'command') pane.command = String(parsed);
      else if (key === 'name') pane.name = String(parsed);
      else return fail(i + 1, `a pane takes machine, command and name — not ${key}`);
    } else if (current) {
      if (key === 'name') current.name = String(parsed);
      else if (key === 'startup') current.startup = parsed === true;
      else return fail(i + 1, `a layout takes name and startup — not ${key}`);
    } else {
      return fail(i + 1, `${key} is outside any [[layout]]`);
    }
  }

  const nameless = layouts.findIndex((l) => !l.name.trim());
  if (nameless >= 0) return fail(0, `layout #${nameless + 1} has no name`);
  const empty = layouts.find((l) => l.panes.length === 0);
  if (empty) return fail(0, `layout "${empty.name}" has no [[layout.pane]]`);

  return { layouts, error: null };
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

/** The pane header a layout asks for, when it does not name one itself. */
export function paneLabel(pane: LayoutPane): string {
  if (pane.name?.trim()) return pane.name.trim();
  if (pane.machine?.trim()) return pane.machine.trim();
  const first = pane.command.trim().split(/\s+/)[0];
  return first || '';
}

/** Write layouts back out, in the documented shape. Used by the editor's formatter. */
export function formatLayoutFile(layouts: Layout[]): string {
  return layouts
    .map((l) => {
      const head = [`[[layout]]`, `name = ${quote(l.name)}`]
        .concat(l.startup ? ['startup = true'] : [])
        .join('\n');
      const panes = l.panes
        .map((p) => {
          const keys = [`  [[layout.pane]]`];
          if (p.machine) keys.push(`  machine = ${quote(p.machine)}`);
          keys.push(`  command = ${quote(p.command)}`);
          if (p.name) keys.push(`  name = ${quote(p.name)}`);
          return keys.join('\n');
        })
        .join('\n\n');
      return `${head}\n\n${panes}\n`;
    })
    .join('\n');
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
