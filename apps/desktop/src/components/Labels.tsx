/**
 * Labels, as one component rather than one per screen.
 *
 * A label is a short word a person puts on something to find it again: a conversation in
 * the agent manager, a machine in the library. The thing labelled differs and the gesture
 * does not, so the chip, the field and the picker live here — eight components grew their
 * own hex array for one job once (#396) and nothing made them agree.
 *
 * THREE SCOPES, AND THE SCOPE IS THE CONFIDENTIALITY DECISION rather than a setting
 * beside it:
 *
 *   - `org` — a word published for the whole instance. PUBLIC, in the clear, and that is
 *     not a compromise: a word everyone may read and use has nothing to hide from the
 *     server, and sealing it under a key every member holds would buy a key rotation path
 *     and no secrecy. Inherited by every collection.
 *   - `collection` — in the collection's sealed blob, read by its members and nobody else.
 *     Where a word that IS sensitive goes, and it never travels upward: a collection's own
 *     vocabulary cannot become instance-wide.
 *   - `personal` — one person's own filing, in the document Rite keeps for them.
 *
 * WHAT IS LABELLED IS ALWAYS SEALED, whatever the word's scope. A machine lives in a
 * collection and a collection is encrypted, so `pci` may be a word the whole instance
 * shares while WHICH machine wears it is known only to that collection's members. The
 * scope governs the vocabulary; it never governs the assignment.
 *
 * The colour is derived from the label's own text (`labelColor`) and stored nowhere, so
 * one word looks the same on every machine and in every vault with nothing kept in step.
 */

import { useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import {
  LABELS_MAX,
  acceptedUpTo,
  cleanLabel,
  labelColor,
  type LabelOffer,
  type LabelScope,
  type VocabWord,
} from '../store/labelsFormat';
import { MACHINE_SWATCHES } from '../theme/swatches';

// The scopes and the vocabulary live in `store/labelsFormat.ts`: two documents share
// them, and a check can load a module that imports no React. The TYPES are re-exported
// here as a convenience, since a component importing the field usually wants them too;
// `offersFrom` is not, because a module that exports a component and a function cannot be
// hot-reloaded — its callers import it from the store directly.
export type { LabelOffer, LabelScope } from '../store/labelsFormat';

/** How a scope reads, as a key. */
const SCOPE_KEY: Record<LabelScope, string> = {
  personal: 'labels.scopePersonal',
  collection: 'labels.scopeCollection',
  instance: 'labels.scopeInstance',
};

/**
 * One label, in the colour its own text gives it.
 *
 * `scope` is shown only when the caller passes one, and a caller passes one only when the
 * screen has more than one scope to tell apart — a marker that is the same on every chip
 * is a marker nobody reads.
 */
export function LabelChip({
  label,
  small = false,
  scope,
  declared,
  testId,
}: {
  label: string;
  small?: boolean;
  scope?: LabelScope;
  /**
   * A handle of the caller's own, instead of `label-<word>`.
   *
   * For a screen that draws the SAME word twice — the picker lists every offer and repeats
   * the chosen ones as chips above — where two nodes answering one test id is a trap for
   * whoever writes the next test rather than a bug anybody sees.
   */
  testId?: string;
  /**
   * The vocabularies that might have declared this word, nearest scope first.
   *
   * A DECLARED COLOUR WINS, which is what makes a colour worth scanning for: `pci` is red
   * everywhere the word appears, because somebody said so once. A word nobody declared
   * keeps the colour derived from its own text, which is what every word had before
   * choosing was possible.
   */
  declared?: readonly VocabWord[];
}) {
  const { t } = useTranslation();
  const color = labelColor(label, MACHINE_SWATCHES, declared);
  // Joined rather than interpolated: `e2e/i18n-check.mjs` reads text that FOLLOWS an
  // expression as something on screen — the right default, and right everywhere on this
  // component but here, where it is a handle for a test.
  const id = testId ?? [scope, `label-${label.toLowerCase()}`].filter(Boolean).join('-');
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-1.5 ${
        small ? 'text-[10px]' : 'text-[11px]'
      }`}
      style={{ borderColor: color, color }}
      title={scope ? `${label} — ${t(SCOPE_KEY[scope])}` : label}
      data-testid={id}
    >
      {label}
    </span>
  );
}

/**
 * The labels on one thing: what is on it, what is left, and one click either way.
 *
 * A DROPDOWN, WHICH IS THE THIRD SHAPE THIS FIELD HAS HAD. The first was a
 * comma-separated text box, and the bill came in as a question from the person who
 * commissioned it: "how do I add a label to a conversation?" A text field cannot say
 * which words are already on the thing, offers no way to take one off but editing a
 * string around the commas, and makes a long word something to retype.
 *
 * The second was the list GitLab and Kaneo use, and it was right about the list and wrong
 * about where to put it: permanently open, bordered, a couple of hundred pixels tall,
 * inside a form that already has ten fields — and on a vault with nothing declared, an
 * empty bordered box. The chips above it repeated what the ticks in it already said.
 *
 * So the list is in a POPOVER now. It costs no height until somebody is choosing, which
 * is what GitLab actually does, and the chips go back to being the only thing on screen
 * when nothing is being chosen — which is the state a form spends all its time in.
 *
 * WHAT THE LIST ITSELF GETS RIGHT, kept from the second shape: every word on offer is a
 * row, the rows that are ON are marked, and a row is a toggle — so "what is on this" and
 * "what else could be" are one list read once rather than two groups the reader has to
 * diff. The box filters and only creates when ASKED, never as a side effect of typing,
 * which is how `api` and `api,` became two words. The cap is a count that can be read
 * before it bites, where "at most 8" only ever appeared after something was dropped.
 */
export function LabelField({
  labels,
  onChange,
  vocabulary,
  inputId,
  testPrefix,
}: {
  /** The labels currently on the thing. */
  labels: string[];
  onChange: (labels: string[]) => void;
  /** Every word on offer, with its scope. Offered, never required. */
  vocabulary: LabelOffer[];
  inputId: string;
  /** Prefixes every `data-testid` here, so two screens' fields are told apart. */
  testPrefix: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  /**
   * Words created in THIS dialog, kept so they do not vanish when taken off again.
   *
   * A word typed here is in no vocabulary yet — nothing has been saved — so without this
   * the × on its chip removed the word from the list along with the label, and the only
   * way back was to type it a second time. That makes the × read as "delete the word"
   * when it means "take it off this one", which is the distinction the whole list exists
   * to draw. Found by the test for it, which asserted the row stays and was right.
   */
  const [created, setCreated] = useState<string[]>([]);
  const folded = labels.map((l) => l.toLowerCase());
  const full = labels.length >= LABELS_MAX;

  // THE UNION, not the vocabulary: a word already on this thing, or created a moment ago,
  // always has a row. Folded, so `PCI` and `pci` are never two rows for one word.
  const rows: LabelOffer[] = [...vocabulary];
  for (const label of [...labels, ...created]) {
    if (!rows.some((v) => v.label.toLowerCase() === label.toLowerCase())) {
      rows.push({ label, scope: 'personal' });
    }
  }
  rows.sort((a, b) => a.label.localeCompare(b.label));

  // The word AND its description, because a description is why somebody searches for a
  // word they cannot remember the spelling of.
  const q = query.trim().toLowerCase();
  const shown = q
    ? rows.filter(
        (v) => v.label.toLowerCase().includes(q) || (v.description ?? '').toLowerCase().includes(q),
      )
    : rows;

  // Only when there is more than one, for the reason on `LabelChip`.
  const scopes = new Set(rows.map((v) => v.scope));
  // `scope` is this list's own business and not part of the word, so it is the only field
  // named here: the rest of the shape travels WHOLE. Rebuilt field by field, this dropped
  // the description the moment one existed — which is the defect
  // `e2e/vocab-parity-check.mjs` exists for, and it is the check that caught it here.
  const declaredWords: VocabWord[] = rows.map(({ scope, ...word }) => word);

  const typed = cleanLabel(query);
  // A create action only for a word that is not already a row — otherwise it is a second
  // control for something the list above does, which is how the New button beside the
  // search box came to read as a compose row.
  const creatable =
    typed && !rows.some((v) => v.label.toLowerCase() === typed.toLowerCase()) ? typed : null;

  const put = (next: string[]) => onChange(acceptedUpTo(next, LABELS_MAX));
  const toggle = (label: string) => {
    if (folded.includes(label.toLowerCase())) {
      put(labels.filter((l) => l.toLowerCase() !== label.toLowerCase()));
    } else if (!full) {
      put([...labels, label]);
    }
  };

  return (
    <>
      <div className="mt-3 flex items-baseline justify-between">
        <label className="text-xs text-muted-foreground" htmlFor={inputId}>
          {t('labels.field')}
        </label>
        {/* The cap, readable BEFORE it bites. */}
        <span
          className={`text-[11px] ${full ? 'text-amber-500' : 'text-muted-foreground'}`}
          data-testid={`${testPrefix}-count`}
        >
          {t('labels.ofMax', { count: String(labels.length), max: String(LABELS_MAX) })}
        </span>
      </div>

      {/* What is on it, and the only thing on screen while nothing is being chosen.
          Removable here as well as in the list, because a chip with an × is where a
          reader looks first and the list is where they look to compare. */}
      {labels.length !== 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1" data-testid={`${testPrefix}-on`}>
          {labels.map((l) => (
            <span key={l.toLowerCase()} className="inline-flex items-center">
              <LabelChip label={l} declared={declaredWords} />
              <button
                type="button"
                onClick={() => toggle(l)}
                aria-label={t('labels.removeOne', { word: l })}
                title={t('labels.removeOne', { word: l })}
                className="-ml-0.5 rounded-full px-1 text-[11px] leading-none text-muted-foreground hover:text-foreground"
                data-testid={`${testPrefix}-off-${l.toLowerCase()}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* IN FLOW, NOT FLOATING, and that is not a preference — it is the only thing that
          works here. This field lives inside a dialog whose body scrolls, and a scrolling
          box CLIPS an absolutely-positioned child: the list opened and was cut off after
          one row, with the paragraph underneath showing through beside it. No z-index
          reaches that, because the clip is the overflow, not the stacking order. So the
          list pushes the content below it down — which is also what "unfold" means to
          anyone using it.

          One `onBlur` on the wrapper rather than a document listener: `relatedTarget`
          says whether the focus went to a row inside, so ticking several words in one
          visit does not close it. */}
      <div
        className="mt-1.5"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <div className="relative">
          <input
            id={inputId}
            className="h-8 w-full rounded-md border border-border bg-background px-2 pr-7 text-sm"
            placeholder={t('labels.pick')}
            value={query}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Closes the list and nothing else: this field is inside a dialog, and an
                // Escape that reached it would throw away everything the person typed.
                e.stopPropagation();
                setOpen(false);
                return;
              }
              if (e.key !== 'Enter') return;
              // Enter takes the one obvious action and nothing else: the single row left
              // after filtering, or the word being created. With several rows showing there
              // is no obvious one, so it does nothing rather than guess.
              e.preventDefault();
              if (shown.length === 1) toggle(shown[0].label);
              else if (creatable) {
                setCreated((c) => [...c, creatable]);
                toggle(creatable);
                setQuery('');
              }
            }}
            data-testid={`${testPrefix}-input`}
          />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={t(open ? 'labels.hideList' : 'labels.showList')}
            title={t(open ? 'labels.hideList' : 'labels.showList')}
            className="absolute right-1 top-1 h-6 w-6 rounded text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid={`${testPrefix}-toggle`}
          >
            {open ? '▴' : '▾'}
          </button>
        </div>

        {open && (
          <div
            // SIX ROWS AND THEN IT SCROLLS. A list that grows with the vocabulary pushes
            // Save off the bottom of the dialog on the two-hundredth word; one that shows
            // three makes a reader scroll to compare two. Six is what fits beside the
            // field without moving the rest of the dialog much, and the rest scrolls.
            className="mt-1 max-h-[11.25rem] overflow-y-auto rounded-md border border-border bg-background"
            data-testid={`${testPrefix}-list`}
          >
            {shown.length === 0 && !creatable ? (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                {q ? t('labels.noMatch', { query: query.trim() }) : t('labels.none')}
              </div>
            ) : (
              shown.map((v) => {
                const on = folded.includes(v.label.toLowerCase());
                return (
                  <button
                    key={`${v.scope}:${v.label.toLowerCase()}`}
                    type="button"
                    // A row that cannot be turned on says so by being dim, not by being
                    // absent: the word is still in the vocabulary and the reason is the
                    // count above, which is on screen.
                    disabled={!on && full}
                    onClick={() => toggle(v.label)}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted disabled:opacity-40"
                    data-testid={`${testPrefix}-row-${v.label.toLowerCase()}`}
                  >
                    <span
                      className="w-3 shrink-0 text-[11px] text-foreground"
                      data-testid={on ? `${testPrefix}-on-${v.label.toLowerCase()}` : undefined}
                    >
                      {on ? '✓' : ''}
                    </span>
                    <LabelChip
                      label={v.label}
                      small
                      scope={scopes.size === 1 ? undefined : v.scope}
                      declared={declaredWords}
                      testId={`${testPrefix}-word-${v.label.toLowerCase()}`}
                    />
                    {v.description && (
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {v.description}
                      </span>
                    )}
                  </button>
                );
              })
            )}
            {creatable && (
              <button
                type="button"
                disabled={full}
                onClick={() => {
                  setCreated((c) => [...c, creatable]);
                  toggle(creatable);
                  setQuery('');
                }}
                className="w-full border-t border-border px-2 py-1.5 text-left text-[11px] text-primary hover:bg-muted disabled:opacity-40"
                data-testid={`${testPrefix}-create`}
              >
                {t('labels.addWord', { word: creatable })}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
