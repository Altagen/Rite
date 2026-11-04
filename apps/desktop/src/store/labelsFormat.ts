/**
 * Labels: the words, their vocabulary, and their colours.
 *
 * ITS OWN MODULE BECAUSE TWO DOCUMENTS SHARE IT. A label goes on a conversation (the marks
 * document, which Rite owns) and on a machine (inside a collection's sealed item, which it
 * does not) — so the cleaning, the caps, the de-duplication and the derived colour cannot
 * live in either one's format module without the other importing it sideways.
 *
 * Imports NOTHING, like the format modules beside it, so a check loads the shipped
 * functions rather than a copy of them.
 */

/**
 * Where a word in the vocabulary comes from, and therefore who can read it.
 *
 * THE SCOPE IS THE CONFIDENTIALITY DECISION rather than a setting beside it:
 *
 *   - `org` — published for the whole instance. PUBLIC, in the clear, inherited by every
 *     collection. Not a compromise: a word everyone may read and use has nothing to hide
 *     from the server, and sealing it under a key every member holds would buy a key
 *     rotation path and no secrecy.
 *   - `collection` — in the collection's sealed blob, read by its members and nobody else.
 *     Where a word that IS sensitive goes, and it never travels upward.
 *   - `personal` — one person's own filing, in the document Rite keeps for them.
 *
 * WHAT IS LABELLED IS ALWAYS SEALED, whatever the word's scope. A machine lives in a
 * collection and a collection is encrypted, so `pci` may be a word the whole instance
 * shares while WHICH machine wears it is known only to that collection's members. The
 * scope governs the vocabulary; it never governs the assignment.
 */
export type LabelScope = 'personal' | 'collection' | 'org';

/** One word on offer, and its scope. */
export interface LabelOffer {
  label: string;
  scope: LabelScope;
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
 * The words already in use, as offers.
 *
 * THE VOCABULARY'S FIRST SOURCE, and the only one until a collection's own list and the
 * instance's exist: every label somebody has actually put on something. A word used once
 * is then offered everywhere, which is the whole of what a picker is for.
 *
 * Lists of lists rather than a shape of its own, so the two screens can hand it machines
 * or marks without this module learning about either.
 *
 * Folded for de-duplication, and THE FIRST SPELLING SEEN IS THE ONE OFFERED — `API` typed
 * first stays `API` rather than being rewritten by a later `api`, which would quietly
 * rename somebody's word on a screen they did not open.
 */
export function offersFrom(
  lists: readonly (readonly string[] | undefined)[],
  scope: LabelScope,
): LabelOffer[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    for (const raw of list ?? []) {
      const label = cleanLabel(raw);
      if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => a.localeCompare(b))
    .map((label) => ({ label, scope }));
}
