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
  acceptedLabels,
  cleanLabel,
  labelColor,
  type LabelOffer,
  type LabelScope,
  type VocabWord,
} from '../store/labelsFormat';
import { MACHINE_SWATCHES } from '../theme/swatches';

// The scopes and the vocabulary live in `store/labelsFormat.ts`: two documents share
// them, and a check can load a module that imports no React.
export type { LabelOffer, LabelScope } from '../store/labelsFormat';
export { offersFrom } from '../store/labelsFormat';

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
}: {
  label: string;
  small?: boolean;
  scope?: LabelScope;
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
  const testId = [scope, `label-${label.toLowerCase()}`].filter(Boolean).join('-');
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-1.5 ${
        small ? 'text-[10px]' : 'text-[11px]'
      }`}
      style={{ borderColor: color, color }}
      title={scope ? `${label} — ${t(SCOPE_KEY[scope])}` : label}
      data-testid={testId}
    >
      {label}
    </span>
  );
}

/**
 * The labels on one thing, as a field: type them, or click one already in use.
 *
 * TYPED AS TEXT, COMMA-SEPARATED, and the picker is beside it rather than instead of it.
 * A picker that is the only way in decides what a person may call things; a field that is
 * the only way in makes them retype a long word every time. The field owns the raw text
 * and the caller owns the parsed list, so the caller never has to know about commas.
 *
 * The preview under the field is what the document will hold — including the cap and the
 * case-insensitive de-duplication, which happen on the way in and are otherwise invisible
 * until the dialog is reopened.
 */
export function LabelField({
  labels,
  onChange,
  vocabulary,
  inputId,
  testPrefix,
  onColor,
}: {
  /** The labels currently on the thing. */
  labels: string[];
  onChange: (labels: string[]) => void;
  /** Every word on offer, with its scope. Offered, never required. */
  vocabulary: LabelOffer[];
  inputId: string;
  /** Prefixes every `data-testid` here, so two screens' fields are told apart. */
  testPrefix: string;
  /**
   * Declare a colour for one word. Absent ⇒ the field does not offer to.
   *
   * ONLY WHERE THE WORDS ARE DECLARED, which is a vocabulary editor and not a machine
   * form. Choosing a colour on a machine would make it that machine's colour for the
   * word, and then the word has several — the thing this shape exists to prevent.
   */
  onColor?: (label: string, color: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState(labels.join(', '));
  // Through the shipped cleaner, so the preview and the document cannot disagree.
  const parsed = acceptedLabels(typed.split(',').map(cleanLabel));
  const capped = typed.split(',').filter((p) => cleanLabel(p)).length !== parsed.length;
  // What is offered is what is not already on: a chip that does nothing when clicked is a
  // chip somebody clicks twice before reading the field above it.
  const unused = vocabulary.filter(
    (v) => !parsed.some((l) => l.toLowerCase() === v.label.toLowerCase()),
  );
  // Only when there is more than one, for the reason on `LabelChip`.
  const scopes = new Set(vocabulary.map((v) => v.scope));
  // What the offers declare, so a chip in this field wears the colour it will wear
  // everywhere else rather than one derived here and nowhere else.
  const declaredWords: VocabWord[] = vocabulary.map((v) =>
    v.color ? { label: v.label, color: v.color } : { label: v.label },
  );
  const write = (next: string) => {
    setTyped(next);
    onChange(acceptedLabels(next.split(',').map(cleanLabel)));
  };
  return (
    <>
      <label className="mt-3 block text-xs text-muted-foreground" htmlFor={inputId}>
        {t('labels.field')}
      </label>
      <input
        id={inputId}
        className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
        placeholder={t('labels.placeholder')}
        value={typed}
        onChange={(e) => write(e.target.value)}
        data-testid={`${testPrefix}-input`}
      />
      {parsed.length !== 0 && (
        <div className="mt-1.5 flex flex-col gap-1" data-testid={`${testPrefix}-preview`}>
          {parsed.map((l) => (
            <span key={l.toLowerCase()} className="flex items-center gap-1.5">
              <LabelChip label={l} declared={declaredWords} />
              {/* The palette, only in an editor of the words themselves — see `onColor`.
                  The swatch that is currently in force is ringed, whether it was chosen or
                  derived, so "no choice" is a visible state rather than an empty row. */}
              {onColor &&
                MACHINE_SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() =>
                      onColor(
                        l,
                        labelColor(l, MACHINE_SWATCHES, declaredWords) === c ? undefined : c,
                      )
                    }
                    aria-label={c}
                    data-testid={`${testPrefix}-colour-${l.toLowerCase()}-${c.slice(1)}`}
                    className={`h-4 w-4 rounded-full border ${
                      labelColor(l, MACHINE_SWATCHES, declaredWords) === c
                        ? 'border-foreground'
                        : 'border-transparent'
                    }`}
                    style={{ background: c }}
                  />
                ))}
            </span>
          ))}
        </div>
      )}
      {unused.length !== 0 && (
        <>
          <div className="mt-2 text-[11px] text-muted-foreground">{t('labels.known')}</div>
          <div className="mt-1 flex flex-wrap gap-1" data-testid={`${testPrefix}-known`}>
            {unused.map((v) => (
              <button
                key={`${v.scope}:${v.label.toLowerCase()}`}
                type="button"
                disabled={parsed.length >= LABELS_MAX}
                onClick={() => write(acceptedLabels([...parsed, v.label]).join(', '))}
                className="rounded-full disabled:opacity-40"
                data-testid={`${testPrefix}-add-${v.label.toLowerCase()}`}
              >
                <LabelChip
                  label={v.label}
                  small
                  scope={scopes.size === 1 ? undefined : v.scope}
                  declared={declaredWords}
                />
              </button>
            ))}
          </div>
        </>
      )}
      {capped && (
        <div className="mt-1 text-[11px] text-amber-500" data-testid={`${testPrefix}-dropped`}>
          {t('labels.capped', { count: String(LABELS_MAX) })}
        </div>
      )}
    </>
  );
}
