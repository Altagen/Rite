/**
 * The label manager: one screen that declares the words, for every scope.
 *
 * ONE SCREEN AND NOT TWO EDITORS. The vocabulary used to be edited in two places — a
 * comma-separated field in Settings for the instance, another inside the collection
 * dialog — and a table of two hundred rows does not belong in a modal. Managing the words
 * and applying one are two gestures, so they are two surfaces: this declares them, and
 * `LabelField` picks from what is declared. GitLab draws the same line, and it is the same
 * line already drawn between naming a conversation and filing it.
 *
 * THE SCOPE IS CHOSEN HERE, which is the only reason one screen can replace two. It is
 * also the confidentiality decision (`store/labelsFormat.ts`): `instance` is public on a
 * server, a collection's words are sealed to its members, and a collection's never travel
 * up. Switching the selector switches which document is being written.
 *
 * NO PAGINATION, AND THAT IS A DECISION. The list arrives in one blob — it must, because
 * it is sealed and the search is therefore client-side — and it is capped at two hundred.
 * Pages over a list already in memory hide rows from the filter: a word is found by typing
 * it, not by knowing which page it is on. If the cap ever rises, pages become worth their
 * cost; today they would only add a control that can conceal the answer.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { LabelChip } from './Labels';
import { MACHINE_SWATCHES } from '../theme/swatches';
import {
  DESCRIPTION_MAX,
  INSTANCE_LABELS_MAX,
  LABEL_MAX,
  cleanDescription,
  cleanLabel,
  labelColor,
  type VocabWord,
} from '../store/labelsFormat';
import { IconPlus, IconSearch, IconTrash } from './icons';

/** One scope the manager can write, and where its words are kept. */
export interface LabelTarget {
  id: string;
  name: string;
  words: VocabWord[];
  /** Absent ⇒ this scope is readable here but not writable (a viewer's collection). */
  save?: (words: VocabWord[]) => Promise<void>;
}

export function LabelManager({
  targets,
  inherited,
}: {
  targets: LabelTarget[];
  /**
   * Words this scope can USE but not change — the instance's, seen from a collection.
   *
   * SHOWN AND NOT EDITABLE HERE, which is the answer to "where is `pci` declared". GitLab
   * draws the same thing on a project's label page, and the reason is the same: a word
   * that applies here but is owned elsewhere has to be visible or somebody declares it a
   * second time. It never travels the other way — a collection's own words stay in it.
   */
  inherited?: readonly VocabWord[];
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState(targets[0]?.id ?? '');
  const target = targets.find((x) => x.id === scope) ?? targets[0];
  const [query, setQuery] = useState('');
  /** The edited list, or null while nothing has been touched. */
  const [draft, setDraft] = useState<VocabWord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which row is open for editing, by its word folded — or `@new` for the row being added. */
  const [open, setOpen] = useState<string | null>(null);

  const words = draft ?? target?.words ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return words;
    // The word and its description, because a description is why somebody would search for
    // a word they cannot remember the spelling of.
    return words.filter(
      (w) => w.label.toLowerCase().includes(q) || (w.description ?? '').toLowerCase().includes(q),
    );
  }, [words, query]);

  const edit = (next: VocabWord[]) => {
    setDraft(next);
    setError(null);
  };

  const save = async () => {
    if (!draft || !target?.save) return;
    setBusy(true);
    try {
      await target.save(draft);
      setDraft(null);
      setOpen(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!target) return null;
  const readOnly = !target.save;
  const full = words.length >= INSTANCE_LABELS_MAX;

  return (
    <div data-testid="label-manager">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* Only when there is a choice: one scope needs no selector, and a desktop with no
            collections open has exactly one. */}
        {targets.length > 1 && (
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              // A draft belongs to the scope it was typed in. Carrying it across would
              // write one document's words into another's.
              setDraft(null);
              setOpen(null);
              setError(null);
            }}
            aria-label={t('labels.scope')}
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
            data-testid="label-manager-scope"
          >
            {targets.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        )}
        {/* A MAGNIFIER AND THE WORD "SEARCH", because a bare text box beside a New button
            reads as a compose row — type here, press that, configure after. It was read
            that way on the first look, which is the box's fault and not the reader's. */}
        <div className="flex h-8 w-56 items-center gap-1.5 rounded-md border border-border bg-background px-2">
          <IconSearch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('labels.search')}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            data-testid="label-manager-search"
          />
        </div>
        <span className="flex-1" />
        {/* FILLED, NOT OUTLINED. The inputs on this row are bordered boxes; the one thing
            that is not an input must not look like one. */}
        {!readOnly && (
          <button
            type="button"
            disabled={full || open === '@new'}
            onClick={() => setOpen('@new')}
            className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            data-testid="label-manager-new"
          >
            <IconPlus className="h-3.5 w-3.5" />
            {t('labels.newLabel')}
          </button>
        )}
      </div>

      {open === '@new' && (
        <Row
          word={{ label: '' }}
          words={words}
          inherited={inherited}
          // Headed, so the row that appears is obviously the one being ADDED rather than
          // a row of the table that happened to open.
          heading={t('labels.newLabel')}
          onDone={(w) => {
            setOpen(null);
            if (w) edit([...words, w]);
          }}
        />
      )}

      <div className="divide-y divide-border rounded-md border border-border">
        {shown.length === 0 ? (
          /* ONE New BUTTON, the one above. A second here was two controls for one
             action — and the toolbar one carries its own weight now that it is the only
             filled thing on that row rather than another bordered box. */
          <p className="p-3 text-xs text-muted-foreground" data-testid="label-manager-empty">
            {query ? t('labels.noMatch', { query }) : t('labels.none')}
          </p>
        ) : (
          shown.map((w) =>
            open === w.label.toLowerCase() ? (
              <Row
                key={w.label.toLowerCase()}
                word={w}
                words={words}
                inherited={inherited}
                onDone={(next) => {
                  setOpen(null);
                  if (next) {
                    edit(words.map((x) => (x.label === w.label ? next : x)));
                  }
                }}
              />
            ) : (
              <div
                key={w.label.toLowerCase()}
                className="flex items-center gap-3 px-3 py-2"
                data-testid={`label-row-${w.label.toLowerCase()}`}
              >
                <LabelChip label={w.label} declared={words} />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {w.description || '—'}
                </span>
                {!readOnly && (
                  <>
                    <button
                      type="button"
                      onClick={() => setOpen(w.label.toLowerCase())}
                      className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                      data-testid={`label-edit-${w.label.toLowerCase()}`}
                    >
                      {t('labels.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => edit(words.filter((x) => x.label !== w.label))}
                      title={t('labels.remove')}
                      aria-label={t('labels.remove')}
                      className="rounded p-1 text-red-500 hover:bg-red-500/10"
                      data-testid={`label-remove-${w.label.toLowerCase()}`}
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            ),
          )
        )}
      </div>

      {/* THE WORDS THAT APPLY HERE AND ARE OWNED ELSEWHERE. Last, because they are not
          what this screen is for — and listed rather than merged into the table above, so
          there is no row carrying an Edit that would write the wrong document. */}
      {inherited && inherited.length !== 0 && (
        <div className="mt-3">
          <div className="text-[11px] text-muted-foreground">{t('labels.inherited')}</div>
          <div className="mt-1 flex flex-wrap gap-1" data-testid="label-manager-inherited">
            {inherited.map((w) => (
              <LabelChip key={w.label.toLowerCase()} label={w.label} declared={inherited} />
            ))}
          </div>
        </div>
      )}

      {/* WHAT IS LEFT, SAID RATHER THAN DISCOVERED by a New button that stops working. */}
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span data-testid="label-manager-count">
          {t('labels.count', {
            count: String(words.length),
            left: String(INSTANCE_LABELS_MAX - words.length),
          })}
        </span>
        <span className="flex-1" />
        {!readOnly && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={draft === null || busy}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            data-testid="label-manager-save"
          >
            {t('labels.instanceSave')}
          </button>
        )}
      </div>
      {readOnly && (
        <p className="mt-2 text-[11px] text-amber-500" data-testid="label-manager-readonly">
          {t('labels.readOnly')}
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs text-amber-500" data-testid="label-manager-error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * One row being written: the word, its colour, its description.
 *
 * A ROW AND NOT A MODAL, because a modal over a list loses the list — and the thing being
 * edited is one line of it. `onDone(null)` is a cancel, which is why it is one callback
 * rather than two.
 */
function Row({
  word,
  words,
  inherited,
  heading,
  onDone,
}: {
  word: VocabWord;
  /** The rest of the list, to refuse a word that is already in it. */
  words: readonly VocabWord[];
  /**
   * The words owned elsewhere that apply here, which are also a clash.
   *
   * Declaring `pci` in a collection when the instance already declares it would give one
   * word two declarations, and every lookup folds and takes the first — so the second is
   * unreachable and whoever wrote it would wonder why their colour did nothing.
   */
  inherited?: readonly VocabWord[];
  /** Shown above the fields when this row is an ADDITION rather than an edit. */
  heading?: string;
  onDone: (word: VocabWord | null) => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(word.label);
  const [color, setColor] = useState(word.color);
  const [description, setDescription] = useState(word.description ?? '');
  const clean = cleanLabel(label);
  // A word already in the list, unless it is this row's own: two rows for one word would
  // make the second unreachable, since every lookup folds and takes the first.
  const clash =
    clean.toLowerCase() !== word.label.toLowerCase() &&
    [...words, ...(inherited ?? [])].some((w) => w.label.toLowerCase() === clean.toLowerCase());
  const ok = clean !== '' && !clash;
  return (
    <div className="border-b border-border bg-muted/30 px-3 py-2">
      {heading && (
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{heading}</div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={label}
          maxLength={LABEL_MAX}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('labels.wordPlaceholder')}
          className="h-8 w-40 rounded-md border border-border bg-background px-2 text-sm"
          data-testid="label-row-word"
        />
        <input
          value={description}
          maxLength={DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('labels.descriptionPlaceholder')}
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
          data-testid="label-row-description"
        />
        <div className="flex items-center gap-1">
          {MACHINE_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(color === c ? undefined : c)}
              aria-label={c}
              data-testid={`label-row-colour-${c.slice(1)}`}
              className={`h-4 w-4 rounded-full border ${
                (color ?? labelColor(clean || word.label, MACHINE_SWATCHES)) === c
                  ? 'border-foreground'
                  : 'border-transparent'
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => onDone(null)}
          className="rounded-md border border-border px-2.5 py-1 text-xs"
          data-testid="label-row-cancel"
        >
          {t('agent.renameCancel')}
        </button>
        <button
          type="button"
          disabled={!ok}
          onClick={() =>
            onDone({
              label: clean,
              ...(color ? { color } : {}),
              ...(cleanDescription(description)
                ? { description: cleanDescription(description) }
                : {}),
            })
          }
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          data-testid="label-row-done"
        >
          {t('agent.renameSave')}
        </button>
        {/* Said where it happens: a clash is refused, and a refusal with no reason reads as
          a button that does not work. */}
        {clash && (
          <span className="text-[11px] text-amber-500" data-testid="label-row-clash">
            {t('labels.clash', { word: clean })}
          </span>
        )}
      </div>
    </div>
  );
}
