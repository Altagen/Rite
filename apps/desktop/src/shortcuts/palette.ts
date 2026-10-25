/**
 * Which commands a palette query matches, and in what order.
 *
 * A pure function, as `planClipboard` and the shell's `plan_pick_file` are: the ranking is
 * the whole user-visible behaviour of a command palette, and it is a table rather than a
 * feeling. `e2e/palette-filter-check.mjs` holds it.
 *
 * WHY THESE RULES AND NOT FUZZY MATCHING. A subsequence matcher ("sph" → "split
 * horizontal") looks clever and is unexplainable: two entries tie and nobody can say why
 * one won. Every token has to appear, which is predictable, and the rank says WHERE the
 * first token landed. Someone who types "spl" sees splits; someone who types "split pane"
 * sees the same ones; someone who types "zzz" sees nothing and knows why.
 *
 * Order within a rank is the table's own, which is a design call made in `commands.ts` —
 * so the sort is stable and never invents a preference the table did not express.
 */

/** One runnable command, as the palette shows it. */
export interface PaletteEntry {
  id: string;
  /** Resolved from the locale by the caller: this module never reads translations. */
  label: string;
  /** Longer text, searched as well as shown. */
  description?: string;
  /** How the chord reads on this platform, for display only. Absent = no chord. */
  chord?: string;
}

/**
 * Lower is better. Exported so the check can name what it asserts.
 *
 * An object and not an `enum`: a standalone check loads this file through Node's
 * type-stripping loader, which refuses an enum outright — the same reason `commands.ts`
 * imports nothing. Types that erase, only.
 */
export const PaletteRank = {
  /** The label starts with the query's first token. */
  LabelPrefix: 0,
  /** A word inside the label starts with it. */
  LabelWord: 1,
  /** It appears somewhere in the label. */
  LabelAnywhere: 2,
  /** Only the description carries it. */
  DescriptionOnly: 3,
} as const;
export type PaletteRank = (typeof PaletteRank)[keyof typeof PaletteRank];

const norm = (s: string) => s.toLowerCase().trim();

/** Where `token` lands in `label`, or null when it does not. */
function rankInLabel(label: string, token: string): PaletteRank | null {
  if (label.startsWith(token)) return PaletteRank.LabelPrefix;
  // A word start, which is what makes "hor" find "Split horizontally" without also
  // ranking it beside a label that merely contains the letters.
  if (new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(label)) {
    return PaletteRank.LabelWord;
  }
  return label.includes(token) ? PaletteRank.LabelAnywhere : null;
}

/**
 * The entries `query` matches, best first.
 *
 * An empty query is not a filter: everything comes back in the table's order, because a
 * palette that opens empty is a menu and a menu has an order.
 */
export function filterPalette(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...entries];

  const scored: Array<{ entry: PaletteEntry; rank: number; at: number }> = [];
  entries.forEach((entry, at) => {
    const label = norm(entry.label);
    const haystack = `${label} ${norm(entry.description ?? '')}`;
    // Every token has to appear somewhere. A query is a conjunction, which is what makes
    // typing more characters always narrow and never surprise.
    if (!tokens.every((t) => haystack.includes(t))) return;
    // The rank is decided by the FIRST token only: it is the one being typed, and letting
    // a later token improve the rank would make the list jump around mid-word.
    const rank = rankInLabel(label, tokens[0]) ?? PaletteRank.DescriptionOnly;
    scored.push({ entry, rank, at });
  });

  // Stable by construction: `at` breaks every tie with the table's own order.
  scored.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return scored.map((s) => s.entry);
}
