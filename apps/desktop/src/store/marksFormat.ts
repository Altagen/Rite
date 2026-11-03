/**
 * The marks document: what a name a person gave to a conversation looks like on disk.
 *
 * Imports NOTHING, so `e2e/marks-check.mjs` loads the shipped shape rather than a copy —
 * the same arrangement `layoutsFormat.ts` has, and the reason both are separate from the
 * stores that fetch them.
 *
 * JSON, because nobody edits this one by hand. The workspace document is TOML because
 * people read and write it; this one is Rite's own, so it has no parser to get wrong and
 * no syntax error to report.
 */

/**
 * A name a person gave to someone else's conversation (ADR 0022 §6).
 *
 * Keyed by machine, tool and conversation, because none of the three is unique alone: two
 * machines can hold the same tool, and two tools the same id shape. The machine is its
 * id — a uuid, or `@local` — and never its name, so a stored mark says nothing about
 * which host it is about to anyone who has not opened the vault that holds it.
 */
export interface Mark {
  machine: string;
  tool: string;
  id: string;
  name: string;
  /** A colour from the shared machine palette, or absent. */
  color?: string;
}

/**
 * What survives a read: only what we wrote, and only the shape we wrote.
 *
 * A row short of any of its four keys names NOTHING — none of machine, tool and id is
 * unique alone — and keeping it would put a person's name on whatever happened to match.
 * A colour that is not one is dropped and the mark kept, because the name is the mark and
 * the colour is a decoration on it: refusing the row would lose what was actually typed.
 */
export function acceptedMarks(parsed: unknown): Mark[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { marks?: unknown }).marks;
  if (!Array.isArray(list)) return [];
  const out: Mark[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const m = row as Record<string, unknown>;
    const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (!str(m.machine) || !str(m.tool) || !str(m.id) || !str(m.name)) continue;
    out.push({
      machine: m.machine,
      tool: m.tool,
      id: m.id,
      name: m.name,
      ...(str(m.color) ? { color: m.color } : {}),
    });
  }
  return out;
}

/** The document as it is written. Versioned, so a later shape is told apart rather than guessed. */
export const formatMarks = (marks: Mark[]): string =>
  JSON.stringify({ version: 1, marks }, null, 2);

/**
 * One rename applied to a list: replace the mark for this conversation, or remove it.
 *
 * One mark per (machine, tool, id) — renaming twice replaces rather than stacking — and
 * an empty name removes the entry instead of leaving one that says nothing.
 */
export function withMark(
  marks: Mark[],
  mark: Mark | (Omit<Mark, 'name' | 'color'> & { name: null }),
): Mark[] {
  const kept = marks.filter(
    (m) => !(m.machine === mark.machine && m.tool === mark.tool && m.id === mark.id),
  );
  return mark.name === null ? kept : [...kept, mark as Mark];
}
