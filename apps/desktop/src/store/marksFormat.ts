import { acceptedLabels } from './labelsFormat.ts';

/**
 * The marks document: what a name a person gave to a conversation looks like on disk.
 *
 * Imports nothing but its sibling `labelsFormat` — no React, no store, no backend — so
 * `e2e/marks-check.mjs` loads the shipped shape rather than a copy. That is the same
 * arrangement `layoutsFormat.ts` has, and the reason both are separate from the stores
 * that fetch them. The labels live next door because a machine carries them too, and
 * neither document's format module should have to import the other's.
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
  /**
   * The one name this conversation goes by, or empty when it is only labelled.
   *
   * ONE PER CONVERSATION, and it answers a different question from a label: a name is
   * "which one is this" and goes on the card as its headline, a label is "which group is
   * this in" and there can be several. Collapsing the two would make the headline a list.
   */
  name: string;
  /** A colour from the shared machine palette, on the NAME. Labels colour themselves. */
  color?: string;
  /**
   * The groups this conversation is in. Order is the person's; duplicates are dropped.
   *
   * Plain strings and no registry, because a label's colour is DERIVED from its own text
   * (`labelColor`): `urgent` is the same colour on every machine and in every vault,
   * nothing has to be kept in step, and a label typed on one host is recognisable on the
   * next without the document carrying a palette that could disagree with itself.
   */
  labels?: string[];
}

/**
 * What survives a read: only what we wrote, and only the shape we wrote.
 *
 * A row short of any of its three keys names NOTHING — none of machine, tool and id is
 * unique alone — and keeping it would put a person's name on whatever happened to match.
 * A colour that is not one is dropped and the mark kept, because what a person typed is
 * the mark and the colour is a decoration on it: refusing the row would lose the typing.
 * A row with neither a name nor a label marks nothing either, and goes the same way.
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
    if (!str(m.machine) || !str(m.tool) || !str(m.id)) continue;
    const labels = acceptedLabels(m.labels);
    // A row with neither a name nor a label marks nothing, so it is not a mark. Either
    // one alone IS: a conversation can be labelled without being renamed, and renamed
    // without being filed.
    const name = str(m.name) ? m.name : '';
    if (!name && labels.length === 0) continue;
    out.push({
      machine: m.machine,
      tool: m.tool,
      id: m.id,
      name,
      ...(str(m.color) ? { color: m.color } : {}),
      ...(labels.length ? { labels } : {}),
    });
  }
  return out;
}

/** The document as it is written. Versioned, so a later shape is told apart rather than guessed. */
export const formatMarks = (marks: Mark[]): string =>
  JSON.stringify({ version: 1, marks }, null, 2);

/**
 * One edit applied to a list: replace the mark for this conversation, or remove it.
 *
 * One mark per (machine, tool, id) — editing twice replaces rather than stacking — and a
 * mark left with neither a name nor a label is REMOVED rather than written as an entry
 * that says nothing. That is also what the Clear button does, so the two gestures cannot
 * leave the document in different states.
 */
export function withMark(
  marks: Mark[],
  mark: Mark | (Omit<Mark, 'name' | 'color' | 'labels'> & { name: null }),
): Mark[] {
  const kept = marks.filter(
    (m) => !(m.machine === mark.machine && m.tool === mark.tool && m.id === mark.id),
  );
  if (mark.name === null) return kept;
  const full = mark as Mark;
  const labels = acceptedLabels(full.labels);
  if (!full.name && labels.length === 0) return kept;
  return [
    ...kept,
    {
      machine: full.machine,
      tool: full.tool,
      id: full.id,
      name: full.name,
      ...(full.color ? { color: full.color } : {}),
      ...(labels.length ? { labels } : {}),
    },
  ];
}
