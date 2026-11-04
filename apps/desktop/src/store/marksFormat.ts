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

/** How long a label may be, and how many a conversation may carry. */
export const LABEL_MAX = 24;
export const LABELS_MAX = 8;

/**
 * One label's text, as it is kept: trimmed, squeezed to one line, case left alone.
 *
 * Case is the person's — `API` and `api` are the same label, so the comparison folds it,
 * but what is STORED is what was typed. Lower-casing on the way in would quietly rewrite
 * someone's `API` into `api` on an edit they did not make.
 */
export const cleanLabel = (raw: string): string =>
  raw.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);

/** The labels of one mark, cleaned, de-duplicated case-insensitively, capped. */
export function acceptedLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const label = cleanLabel(value);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length === LABELS_MAX) break;
  }
  return out;
}

/**
 * A label's colour, derived from its own text rather than stored.
 *
 * NOTHING TO KEEP IN STEP. A stored palette is a second collection in the document, an
 * editor for it, and two machines that can disagree about what `urgent` looks like. A
 * derived colour is the same everywhere by construction, survives an export and an
 * import, and costs no bytes.
 *
 * Case-folded, so `API` and `api` are one label and wear one colour. The palette is the
 * machine palette, like a mark's own — `e2e/swatch-palette-check.mjs` is what stops a
 * ninth hand-written array.
 *
 * `palette` is passed in rather than imported because this module imports nothing: the
 * check loads the shipped function and the component supplies the shipped swatches.
 */
export function labelColor(label: string, palette: readonly string[]): string {
  const key = cleanLabel(label).toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    // djb2, which spreads short words — and short words is all a label is.
    hash = (hash * 33 + key.charCodeAt(i)) % 0xffffffff;
  }
  return palette[hash % palette.length];
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
