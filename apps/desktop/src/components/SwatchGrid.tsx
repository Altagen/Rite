/**
 * The one way a colour is chosen, anywhere in the application layer.
 *
 * FIVE COPIES OF A ROW OF CIRCLES is what this replaces — the machine form, the two
 * folder dialogs, the label manager and a conversation's mark dialog each laid the
 * palette out themselves, with their own size, their own gap and their own idea of
 * whether it wrapped. That was tolerable at nine swatches and stopped being so at
 * thirty-two: a row of thirty-two circles is a pile, and a pile is scanned by reading
 * every element.
 *
 * A GRID, FOUR DEEP, AND THE COLUMNS RUN. `MACHINE_SWATCHES` is written family by
 * family, four shades each (`theme/swatches.ts`), so filling column by column puts every
 * blue in one column and every green in another. That is the whole point: a picker is
 * scanned, and a scan needs its target to be somewhere in particular. `grid-auto-flow`
 * does the transposition, so the array stays readable in source — the alternative was
 * writing it shade-major, which reads as noise.
 *
 * Centred, because it is the only thing on its line in three of the five dialogs and a
 * left-aligned block under a centred heading reads as a mistake.
 */

import { useTranslation } from '../i18n/i18n';

/**
 * Which ink a tick needs to be seen on this swatch.
 *
 * The machine form drew its check mark in near-black, which worked while every swatch was
 * a pastel. Thirty-two of them are not: `#3d59a1`, `#2f6f4f` and `#9d2449` would have
 * swallowed it, and "which one is selected" is the only question this control answers.
 * Rec. 709 luminance, the same arithmetic every contrast checker uses.
 */
function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.55 ? '#f7f9ff' : '#0a0e1a';
}

/** One size per surface, and no third: a dialog's and a form's. */
const SIZE = {
  /** The dialogs — the label row, the mark dialog. */
  small: 'h-5 w-5',
  /** The machine form and the folder dialogs, which have the room. */
  large: 'h-7 w-7',
} as const;

export function SwatchGrid({
  palette,
  value,
  onPick,
  testPrefix,
  size = 'small',
}: {
  /** The palette this surface chooses from. Named by the caller, so a reader of that
   *  screen sees WHICH list it offers (`e2e/swatch-palette-check.mjs` holds the pairing). */
  palette: readonly string[];
  /** The colour currently chosen, or undefined for none. */
  value?: string;
  onPick: (hex: string) => void;
  /** Prefixes each swatch's `data-testid`, as `<prefix>-<hex without #>`. */
  testPrefix: string;
  size?: keyof typeof SIZE;
}) {
  const { t } = useTranslation();
  return (
    <div
      // Four rows, columns flowing — see the note above. `justify-center` on the grid
      // itself rather than on the parent, so a caller cannot forget it.
      className="grid grid-flow-col justify-center gap-1.5"
      style={{ gridTemplateRows: `repeat(4, minmax(0, 1fr))` }}
      data-testid={`${testPrefix}-grid`}
    >
      {palette.map((hex) => (
        <button
          key={hex}
          type="button"
          onClick={() => onPick(hex)}
          aria-label={t('dlg.colourAria', { hex })}
          data-testid={`${testPrefix}-${hex.slice(1)}`}
          className={`${SIZE[size]} grid place-items-center rounded-full border-2 text-[11px] font-black leading-none transition-transform hover:scale-110 ${
            value === hex ? 'border-foreground' : 'border-transparent'
          }`}
          style={{ background: hex, color: inkOn(hex) }}
        >
          {/* The ring says which one, and the tick says it again INSIDE the circle —
              thirty-two rings are a lot to scan for one that is lit. */}
          {value === hex ? '✓' : ''}
        </button>
      ))}
    </div>
  );
}
