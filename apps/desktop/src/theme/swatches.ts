/**
 * The swatch palettes of the application layer.
 *
 * Rite themes in two layers: the application (this file, the tokens in `index.css`, the
 * menus) and the terminal (`THEMES` in `utils/terminalPool.ts`, keyed `rite.terminalTheme`).
 * These are the application's, and the terminal's `ITheme` sets are not reachable from
 * here — a swatch names an object in the UI, not a colour the shell prints with.
 *
 * EIGHT COPIES, DRIFTED THREE WAYS (#396). Each surface declared its own array, and nothing
 * made them agree:
 *
 *   avatars                     #e0af68 as the 8th, in both copies
 *   collections                 #f472b6 in the panel, #94a3b8 in the workspace dialog
 *   machines and folders        #94a3b8 in the folder dialogs, #8b93a7 in the machine form
 *
 * The visible defect was the second: creating a collection from the workspace offered grey
 * where the panel offered pink, so a pink collection reopened there showed NO swatch
 * selected. Measured across all six chosen palettes, each one failed to offer 9 of the 17
 * colours some other surface can store — the same bug between every pair.
 *
 * THREE CONSTANTS AND NOT ONE, because the three are not the same kind of value:
 *
 * `AVATAR` is DERIVED — `AVATAR[hash % AVATAR.length]` — so its length and order are
 * load-bearing. Both copies were byte-identical, so this is their common value unchanged;
 * adding a colour or reordering one would repaint every member.
 *
 * `COLLECTION` and `MACHINE` are CHOSEN, and the chosen value is stored. What matters there
 * is coverage, not order: a palette that does not offer what a sibling stored shows no
 * selection. Each is the union of its own copies, so nothing already saved loses its
 * swatch and no stored colour changes how it renders.
 *
 * SINCE LABELS, `MACHINE` IS ALSO DERIVED — `labelColor` falls back to
 * `MACHINE[hash % MACHINE.length]` for a word nobody has coloured, which is what makes
 * `urgent` the same colour on every machine and in every vault. So its LENGTH is
 * load-bearing in a second way: adding a colour repaints every undeclared chip. Nothing
 * is lost (no chosen colour moves, and a derived colour was never stored), but it is a
 * visible shift, and it is why this list grows on purpose rather than by accident. It
 * also means two Rite versions with different lengths derive differently — acceptable
 * while the feature is one release old, and the reason to do any further growing in one
 * go rather than a colour at a time.
 *
 * Collapsing COLLECTION and MACHINE into one application palette is the next step and a
 * visual decision, not this one. The two overlap in exactly one colour — `#94a3b8`, the
 * grey both drifted to as their 8th — so the other sixteen would each need a mapping for
 * the values already stored. A migration, not an edit.
 */

/** Derived from a hash. Length and order are load-bearing — see the note above. */
export const AVATAR_SWATCHES = [
  '#7c9cf5',
  '#9ece6a',
  '#e5b567',
  '#f0a35e',
  '#f7768e',
  '#bb9af7',
  '#56c7c0',
  '#e0af68',
] as const;

/** Chosen for a collection. The union of the panel's and the workspace dialog's. */
export const COLLECTION_SWATCHES = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#14b8a6',
  '#f472b6',
  '#94a3b8',
] as const;

/**
 * Chosen for a machine, a folder or a label — and derived for a label nobody coloured.
 *
 * The first nine are the union of the two folder dialogs' and the machine form's, kept in
 * their order so a stored colour still shows as selected. The seven after them were added
 * when the palette started serving labels too: nine colours is a fleet of nine groups, and
 * the two greys at the end of the first row are a hair apart because they are what two
 * drifted copies each called "grey" — a picker where two swatches look alike spends a
 * colour without buying one.
 *
 * Each addition is a hue the first nine do not hold, rather than a lighter version of one:
 * a sky that is not the periwinkle, a steel that is not the sky, a deep green beside the
 * bright one, a brown, a rose that is not the red, a mauve that is not the lilac, and an
 * indigo. Chosen to stay apart at the size they are read at — a 12px chip with a coloured
 * border, on a dark card.
 */
export const MACHINE_SWATCHES = [
  '#7c9cf5',
  '#9ece6a',
  '#e5b567',
  '#f0a35e',
  '#f7768e',
  '#bb9af7',
  '#56c7c0',
  '#94a3b8',
  '#8b93a7',
  '#7dcfff',
  '#5e81ac',
  '#4e9a74',
  '#a1785c',
  '#f7a8c4',
  '#b48ead',
  '#7a5cd6',
] as const;
