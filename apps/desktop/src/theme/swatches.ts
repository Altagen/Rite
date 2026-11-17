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
 * THIRTY-TWO, AS EIGHT FAMILIES OF FOUR. Written family by family, lightest first, so the
 * source reads the way the grid does: `SwatchGrid` lays it out four rows deep and lets the
 * columns run, which puts each family in its own column — blues with blues, greens with
 * greens. A picker is scanned, not read, and a scan needs the thing it is looking for to
 * be somewhere in particular.
 *
 * It was nine for machines and folders, then sixteen when labels started using it, both
 * times as one row of circles. Nine colours is a fleet of nine groups; a row of sixteen is
 * a pile.
 *
 * EVERY COLOUR THAT WAS EVER OFFERED IS STILL HERE, which is what keeps a stored value
 * showing as selected — the two greys a hair apart among them, `#94a3b8` and `#8b93a7`,
 * which are what two drifted copies each called "grey". They sit side by side in the
 * neutral column now, where a reader can at least see that they are two.
 *
 * THE ORDER IS NOT LOAD-BEARING FOR A CHOSEN COLOUR, and it is for a derived one:
 * `labelColor` falls back to `MACHINE[hash % MACHINE.length]`, which is what makes
 * `urgent` the same colour in every vault. The length changed, so every undeclared chip
 * repaints — nothing is lost, since a derived colour was never stored, but it is why this
 * list is rearranged in one go rather than a colour at a time.
 */
export const MACHINE_SWATCHES = [
  // blue
  '#7dcfff',
  '#7c9cf5',
  '#5e81ac',
  '#3d59a1',
  // cyan and teal
  '#73daca',
  '#2ac3de',
  '#56c7c0',
  '#2a9d8f',
  // green
  '#9ece6a',
  '#73b06f',
  '#4e9a74',
  '#2f6f4f',
  // yellow and sand
  '#f2d08c',
  '#e5b567',
  '#c9a227',
  '#8c6d1f',
  // orange and brown
  '#ff9e64',
  '#f0a35e',
  '#c76b32',
  '#a1785c',
  // red and rose
  '#f7a8c4',
  '#f7768e',
  '#db4b4b',
  '#9d2449',
  // purple
  '#bb9af7',
  '#9d7cd8',
  '#7a5cd6',
  '#b48ead',
  // neutral
  '#c0caf5',
  '#94a3b8',
  '#8b93a7',
  '#6b7280',
] as const;
