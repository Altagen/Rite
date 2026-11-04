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
 *   - `instance` — declared once above the collections, so it does not have to be
 *     redeclared in each one. BOTH CONTEXTS HAVE THIS, which is why it is not called
 *     `org`: a local vault has no organisation and no administrator, but it is still an
 *     instance of Rite with collections under it.
 *
 *     Its support differs because its READERS do. On a server every member reads it, so
 *     it is a plaintext table: a word everyone may read and use has nothing to hide from
 *     the server, and sealing it under a key every member holds would buy a key rotation
 *     path and no secrecy. On a local vault the only reader is the owner, so it is a
 *     document sealed under the master key like their marks.
 *   - `collection` — in the collection's sealed blob, read by its members and nobody else.
 *     Where a word that IS sensitive goes, and it never travels upward.
 *   - `personal` — one person's own filing, in the document Rite keeps for them.
 *
 * WHAT IS LABELLED IS ALWAYS SEALED, whatever the word's scope. A machine lives in a
 * collection and a collection is encrypted, so `pci` may be a word the whole instance
 * shares while WHICH machine wears it is known only to that collection's members. The
 * scope governs the vocabulary; it never governs the assignment.
 */
export type LabelScope = 'personal' | 'collection' | 'instance';

/** One word on offer, its scope, and the colour it was declared with when it has one. */
export interface LabelOffer {
  label: string;
  scope: LabelScope;
  color?: string;
}

/**
 * One word as a vocabulary DECLARES it: the text, and a colour when somebody chose one.
 *
 * THE COLOUR BELONGS TO THE WORD, NOT TO THE USE. `pci` is the same colour on every
 * machine, in every collection, for every member who can see the word — otherwise a
 * colour stops being something you can scan a grid for, which is the only reason it is
 * there. So it is declared beside the word in a vocabulary, and a machine's own `labels`
 * stay plain strings: no migration, and nothing to keep in step per item.
 *
 * It lives in the SAME vocabulary as the word it describes, and not in one shared store.
 * A collection's word is readable only by its members; a map of colours in the instance
 * list would carry `client-acme` into a document every member reads, which is the scope
 * model undone by a convenience.
 *
 * Absent ⇒ the colour is derived from the text (`labelColor`), which is what every word
 * had before anybody could choose, and what an undeclared word still has.
 */
export interface VocabWord {
  label: string;
  color?: string;
}

/** How long a label may be, and how many one thing may carry. */
export const LABEL_MAX = 24;
export const LABELS_MAX = 8;

/**
 * How many words the instance vocabulary may declare.
 *
 * Bigger than `LABELS_MAX`, because this is the list to choose FROM rather than the list
 * on one thing. Duplicated in `rite-server` (`INSTANCE_LABELS_MAX`), because there is
 * nothing to import across the two languages — `e2e/label-caps-check.mjs` asserts the
 * three numbers agree, so neither side can move one alone.
 */
export const INSTANCE_LABELS_MAX = 200;

/**
 * One label's text, as it is kept: trimmed, squeezed to one line, case left alone.
 *
 * Case is the person's — `API` and `api` are the same label, so the comparison folds it,
 * but what is STORED is what was typed. Lower-casing on the way in would quietly rewrite
 * someone's `API` into `api` on an edit they did not make.
 */
export const cleanLabel = (raw: string): string =>
  raw.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);

/**
 * A list of labels, cleaned: trimmed, de-duplicated case-insensitively, capped.
 *
 * ONE WALK FOR BOTH CALLERS, because they differ only in the cap — and a second copy of
 * this loop is how the field and the vocabulary come to disagree about whether `API` and
 * `api` are one word.
 *
 * The FIRST spelling seen is kept: `API` typed first stays `API` rather than being
 * rewritten by a later `api`, which would rename somebody's word on an edit they did not
 * make.
 */
function cleaned(raw: unknown, cap: number): string[] {
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
    if (out.length === cap) break;
  }
  return out;
}

/** The labels one thing carries, cleaned and capped at `LABELS_MAX`. */
export const acceptedLabels = (raw: unknown): string[] => cleaned(raw, LABELS_MAX);

/**
 * The same walk, to a cap the caller names.
 *
 * TWO CAPS EXIST AND A FIELD HAS TO KNOW WHICH IT IS EDITING. The shared field applied
 * `LABELS_MAX` everywhere, so a vocabulary editor silently refused its ninth word while
 * the screen beside it promised two hundred — and the only visible sign was a message
 * naming a number that did not match. A cap is not a property of the walk; it is a
 * property of the list being edited.
 */
export const acceptedUpTo = (raw: unknown, cap: number): string[] => cleaned(raw, cap);

/**
 * A vocabulary, cleaned: words through the same walk, each with its colour when it
 * declared one.
 *
 * ACCEPTS BOTH SHAPES ON THE WAY IN — a bare string, or `{label, color}` — because a
 * document written before colours could be chosen holds strings, and rejecting it would
 * lose a list somebody typed. One shape goes OUT, which is what the callers read.
 *
 * A colour that is not a `#rrggbb` is dropped and the word kept: the word is the
 * declaration and the colour is a decoration on it.
 */
export function acceptedVocab(raw: unknown): VocabWord[] {
  if (!Array.isArray(raw)) return [];
  const out: VocabWord[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const text = typeof entry === 'string' ? entry : (entry as VocabWord)?.label;
    if (typeof text !== 'string') continue;
    const label = cleanLabel(text);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    const chosen = typeof entry === 'string' ? undefined : (entry as VocabWord)?.color;
    const color = typeof chosen === 'string' && /^#[0-9a-f]{6}$/i.test(chosen) ? chosen : undefined;
    out.push(color ? { label, color } : { label });
    if (out.length === INSTANCE_LABELS_MAX) break;
  }
  return out;
}

/** The same vocabulary as bare words, for a caller that only needs the text. */
export const acceptedVocabulary = (raw: unknown): string[] =>
  acceptedVocab(raw).map((w) => w.label);

/**
 * A vocabulary as it is WRITTEN: a bare string when no colour was chosen, an object when
 * one was.
 *
 * TWO SHAPES OUT, ON PURPOSE. A word with no colour writes exactly what it wrote before
 * colours existed, so a document nobody has coloured round-trips byte for byte and an
 * older reader still understands all of it. A word that gains a colour becomes an object;
 * clearing the colour turns it back into a string. The core writes the same two shapes
 * (`VocabEntry` in `local_collections.rs`), which is what the parity tests hold.
 */
export const formatVocab = (words: readonly VocabWord[]): (string | VocabWord)[] =>
  words.map((w) => (w.color ? { label: w.label, color: w.color } : w.label));

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
export function labelColor(
  label: string,
  palette: readonly string[],
  /**
   * The vocabularies that might have declared this word. A DECLARED colour wins, which is
   * the whole point: `pci` is red because somebody said so, everywhere the word appears.
   * Searched in order, so the collection's own declaration beats the instance's — the
   * narrower scope is the more specific statement.
   */
  declared?: readonly VocabWord[],
): string {
  const key = cleanLabel(label).toLowerCase();
  const chosen = declared?.find((w) => w.label.toLowerCase() === key)?.color;
  if (chosen) return chosen;
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
  lists: readonly (readonly (string | VocabWord)[] | undefined)[],
  scope: LabelScope,
): LabelOffer[] {
  const seen = new Map<string, VocabWord>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      const text = typeof entry === 'string' ? entry : entry?.label;
      if (typeof text !== 'string') continue;
      const label = cleanLabel(text);
      if (!label || seen.has(label.toLowerCase())) continue;
      const color = typeof entry === 'string' ? undefined : entry?.color;
      seen.set(label.toLowerCase(), color ? { label, color } : { label });
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((w) => ({ ...w, scope }));
}
