/**
 * Collection Board (ADR 0016) — a space of cards scoped to one collection, shared
 * with its members on a server and private to the vault locally (ADR 0018).
 *
 * Cards are links, short markdown notes, one-click actions and live-view descriptors,
 * grouped into categories and viewable as a gallery or a list. The whole board is one
 * value encrypted client-side with the collection's itemsKey (via the connections
 * source's readBoard/saveBoard) — the server only stores an opaque blob. Viewers see
 * it read-only; editors and owners can add, edit and remove cards.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import {
  type BoardCard,
  type CardType,
  boardCats,
  boardPreview,
  catOf,
  mdMini,
  newCardId,
} from '../utils/board';

interface Props {
  collectionId: string;
  collectionName: string;
  memberCount: number;
  isPersonal: boolean;
  /** False in a local vault: no members, so nothing here talks about sharing. */
  shared: boolean;
  canWrite: boolean;
  readBoard: (collectionId: string) => Promise<BoardCard[]>;
  saveBoard: (collectionId: string, cards: BoardCard[]) => Promise<void>;
  onClose: () => void;
}

const TYPE_EMOJI: Record<CardType, string> = { link: '🔗', note: '📝', action: '⚡', live: '📡' };

export function BoardModal({
  collectionId,
  collectionName,
  memberCount,
  isPersonal,
  shared,
  canWrite,
  readBoard,
  saveBoard,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<'gallery' | 'list'>('gallery');
  const [filter, setFilter] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  // The card open in the detail modal, and the form (create when type set + no editId).
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form, setForm] = useState<{ type: CardType; editId?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    readBoard(collectionId)
      .then((c) => alive && setCards(c))
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [collectionId, readBoard]);

  // Persist a new set of cards, rolling back the optimistic state if the write fails.
  const persist = async (next: BoardCard[]) => {
    const prev = cards;
    setCards(next);
    setError(null);
    try {
      await saveBoard(collectionId, next);
    } catch (e) {
      setCards(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeCard = (id: string) => void persist(cards.filter((c) => c.id !== id));
  const upsertCard = (card: BoardCard, editId?: string) => {
    setForm(null);
    void persist(editId ? cards.map((c) => (c.id === editId ? card : c)) : [...cards, card]);
  };

  const cats = useMemo(() => boardCats(cards), [cards]);
  const shown = filter === 'all' ? cards : cards.filter((c) => catOf(c) === filter);
  const groups = useMemo(() => {
    const g = new Map<string, BoardCard[]>();
    for (const c of shown) {
      const k = catOf(c);
      const arr = g.get(k);
      if (arr) arr.push(c);
      else g.set(k, [c]);
    }
    return [...g.entries()];
  }, [shown]);

  const subtitle = !shared
    ? null
    : isPersonal || memberCount <= 1
      ? t('board.personal')
      : t('board.members', { n: memberCount });

  const detailCard = detailId ? cards.find((c) => c.id === detailId) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('board.title')}
        className="flex h-[min(78vh,640px)] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
      >
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-medium">
            {collectionName} · {t('board.title')}
          </div>
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        </div>

        {/* Toolbar (pinned) — category filter, view toggle, add. */}
        <div className="border-b border-border px-4 py-2">
          <p className="mb-2 text-xs text-muted-foreground">
            {t(shared ? 'board.intro' : 'board.introLocal', { name: collectionName })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5">
              {['all', ...cats].map((c) => (
                <button
                  key={c}
                  onClick={() => setFilter(c)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    filter === c
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {c === 'all' ? t('board.all') : c}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <div className="flex overflow-hidden rounded border border-border text-xs">
              {(['gallery', 'list'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-2 py-0.5 ${v === view ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'}`}
                >
                  {t(v === 'gallery' ? 'board.gallery' : 'board.list')}
                </button>
              ))}
            </div>
            {canWrite && (
              <div className="relative">
                <button
                  onClick={() => setShowAddMenu((v) => !v)}
                  className="rounded border border-border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  + {t('board.add')}
                </button>
                {showAddMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowAddMenu(false)} />
                    <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded border border-border bg-background shadow-lg">
                      {(
                        [
                          ['link', t('board.menuLink')],
                          ['note', t('board.menuNote')],
                          ['action', t('board.menuAction')],
                          ['live', t('board.menuLive')],
                        ] as [CardType, string][]
                      ).map(([type, label]) => (
                        <button
                          key={type}
                          onClick={() => {
                            setShowAddMenu(false);
                            setForm({ type });
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          <span className="text-base">{TYPE_EMOJI[type]}</span>
                          {label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Sections (the only part that changes on filter/view — scrolls, fixed frame). */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loaded && cards.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('board.empty')}</p>
          )}
          {loaded && cards.length > 0 && groups.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('board.emptyFiltered')}</p>
          )}
          <div className="flex flex-col gap-4">
            {groups.map(([name, items]) => (
              <div key={name}>
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {name}
                  <span className="rounded-full border border-border px-1.5 text-[10px]">{items.length}</span>
                </div>
                {view === 'list' ? (
                  <div className="flex flex-col gap-1">
                    {items.map((c) => (
                      <BoardRow key={c.id} card={c} onOpen={() => setDetailId(c.id)} />
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((c) => (
                      <BoardTile
                        key={c.id}
                        card={c}
                        canWrite={canWrite}
                        onOpen={() => setDetailId(c.id)}
                        onRemove={() => removeCard(c.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
          {!canWrite && loaded && (
            <p className="mt-3 text-xs text-muted-foreground">{t('board.readonly')}</p>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-4 py-3">
          <button
            onClick={onClose}
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {t('board.done')}
          </button>
        </div>
      </div>

      {/* Detail modal — a card opened larger. */}
      {detailCard && (
        <CardDetail
          card={detailCard}
          canWrite={canWrite}
          onClose={() => setDetailId(null)}
          onEdit={() => {
            setForm({ type: detailCard.type, editId: detailCard.id });
            setDetailId(null);
          }}
          onRemove={() => {
            removeCard(detailCard.id);
            setDetailId(null);
          }}
        />
      )}

      {/* Create / edit form. */}
      {form && (
        <CardForm
          type={form.type}
          existing={form.editId ? cards.find((c) => c.id === form.editId) : undefined}
          knownCats={cats}
          defaultCat={filter !== 'all' ? filter : 'General'}
          onCancel={() => setForm(null)}
          onSubmit={(card) => upsertCard(card, form.editId)}
        />
      )}
    </div>
  );
}

/** A gallery tile — compact, clickable, with a quick remove for writers. */
function BoardTile({
  card,
  canWrite,
  onOpen,
  onRemove,
}: {
  card: BoardCard;
  canWrite: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      onClick={onOpen}
      className="group flex min-h-[92px] cursor-pointer flex-col rounded-lg border border-border bg-muted/30 p-2.5 hover:border-primary"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t(`board.type${cap(card.type)}` as 'board.typeLink')}
        </span>
        {canWrite && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="ml-auto px-1 text-xs text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
            title={t('board.remove')}
          >
            ✕
          </button>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-2">
        <span className="text-xl leading-none">
          {card.type === 'link' ? card.emoji || '🔗' : TYPE_EMOJI[card.type]}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{card.title}</div>
          <div className="mt-0.5 line-clamp-3 text-[11px] text-muted-foreground">
            {boardPreview(card)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A list row — dense, clickable. */
function BoardRow({ card, onOpen }: { card: BoardCard; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      onClick={onOpen}
      className="flex cursor-pointer items-center gap-2.5 rounded border border-border bg-muted/30 px-2.5 py-1.5 hover:border-primary"
    >
      <span className="text-base leading-none">
        {card.type === 'link' ? card.emoji || '🔗' : TYPE_EMOJI[card.type]}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t(`board.type${cap(card.type)}` as 'board.typeLink')}
      </span>
      <span className="max-w-[180px] flex-none truncate text-sm font-medium">{card.title}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {boardPreview(card)}
      </span>
    </div>
  );
}

/** The detail modal — full note / full URL before opening / action-live details. */
function CardDetail({
  card,
  canWrite,
  onClose,
  onEdit,
  onRemove,
}: {
  card: BoardCard;
  canWrite: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-medium">
            {card.type === 'link' ? card.emoji || '🔗' : TYPE_EMOJI[card.type]} {card.title}
          </div>
          <div className="text-xs text-muted-foreground">
            {t(`board.type${cap(card.type)}` as 'board.typeLink')} · {catOf(card)}
          </div>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-4 py-4">
          {card.type === 'link' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span className="text-3xl leading-none">{card.emoji || '🔗'}</span>
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('board.fieldUrl')}
                  </div>
                  <div className="break-all font-mono text-sm text-primary">{card.url}</div>
                </div>
              </div>
              <div>
                <button
                  onClick={() => window.open(card.url, '_blank', 'noopener,noreferrer')}
                  className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  {t('board.openLink')}
                </button>
              </div>
            </div>
          )}
          {card.type === 'note' && (
            <div
              className="board-note text-sm leading-relaxed"
              dangerouslySetInnerHTML={{ __html: mdMini(card.text) }}
            />
          )}
          {card.type === 'action' && (
            <div className="flex flex-col gap-3">
              {card.desc && (
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('board.fieldDesc')}
                  </div>
                  <div className="rounded border border-border bg-muted/40 px-2.5 py-2 font-mono text-sm">
                    {card.desc}
                  </div>
                </div>
              )}
              <div>
                <button
                  onClick={() =>
                    void navigator.clipboard?.writeText(card.desc || card.label).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                  }
                  disabled={!card.desc}
                  className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  title={t('board.copy')}
                >
                  {copied ? t('board.copied') : card.label || 'Run'}
                </button>
              </div>
            </div>
          )}
          {card.type === 'live' && (
            <div className="flex flex-col gap-1.5">
              {(card.rows ?? []).length === 0 ? (
                <span className="text-xs text-muted-foreground">{t('board.liveEmpty')}</span>
              ) : (
                (card.rows ?? []).map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 flex-none rounded-full ${r.up ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className={`font-mono text-xs ${r.up ? 'text-muted-foreground' : 'text-red-500'}`}>
                      {r.text}
                    </span>
                  </div>
                ))
              )}
              <div className="mt-1 text-[10px] text-muted-foreground">{t('board.liveHint')}</div>
            </div>
          )}
        </div>
        {canWrite && (
          <div className="flex items-center border-t border-border px-4 py-3">
            <button onClick={onEdit} className="rounded border border-border px-2.5 py-1 text-xs hover:bg-muted">
              {t('board.edit')}
            </button>
            <div className="flex-1" />
            <button onClick={onRemove} className="rounded px-2.5 py-1 text-xs text-red-500 hover:bg-muted">
              {t('board.remove')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Create or edit a card — fields depend on the type; every card carries a category. */
function CardForm({
  type,
  existing,
  knownCats,
  defaultCat,
  onCancel,
  onSubmit,
}: {
  type: CardType;
  existing?: BoardCard;
  knownCats: string[];
  defaultCat: string;
  onCancel: () => void;
  onSubmit: (card: BoardCard) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(existing?.title ?? '');
  const [cat, setCat] = useState(existing ? catOf(existing) : defaultCat);
  const [url, setUrl] = useState(existing?.type === 'link' ? existing.url : '');
  const [emoji, setEmoji] = useState(existing?.type === 'link' ? existing.emoji : '');
  const [text, setText] = useState(existing?.type === 'note' ? existing.text : '');
  const [label, setLabel] = useState(existing?.type === 'action' ? existing.label : '');
  const [desc, setDesc] = useState(existing?.type === 'action' ? existing.desc : '');
  const [source, setSource] = useState<'failed' | 'containers'>(
    existing?.type === 'live' ? existing.source : 'failed',
  );

  const input = 'w-full rounded border border-border bg-input px-2.5 py-1.5 text-sm';
  const fieldCls = 'flex flex-col gap-1 text-xs';
  const labelCls = 'text-muted-foreground';

  const submit = () => {
    const id = existing?.id ?? newCardId();
    const ttl = title.trim() || type;
    const c = cat.trim() || 'General';
    let card: BoardCard;
    if (type === 'link') {
      card = { id, type, title: ttl, url: url.trim() || 'https://example.com', emoji: emoji.trim() || '🔗', cat: c };
    } else if (type === 'note') {
      card = { id, type, title: ttl, text: text.trim(), cat: c };
    } else if (type === 'action') {
      card = { id, type, title: ttl, label: label.trim() || 'Run', desc: desc.trim(), cat: c };
    } else {
      card = {
        id,
        type,
        title: ttl,
        source,
        rows: existing?.type === 'live' ? existing.rows : [],
        cat: c,
      };
    }
    onSubmit(card);
  };

  const catField = (
    <label className={fieldCls}>
      <span className={labelCls}>{t('board.fieldCategory')}</span>
      <input value={cat} onChange={(e) => setCat(e.target.value)} list="board-cats" className={input} placeholder="Ops" />
      <datalist id="board-cats">
        {knownCats.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </label>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          {existing ? t('board.editCard', { type }) : t('board.newCard', { type })}
        </div>
        <div className="flex max-h-[60vh] flex-col gap-2.5 overflow-y-auto px-4 py-3">
          <label className={fieldCls}>
            <span className={labelCls}>{t('board.fieldTitle')}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={input} autoFocus />
          </label>
          {type === 'link' && (
            <>
              <label className={fieldCls}>
                <span className={labelCls}>{t('board.fieldUrl')}</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} className={input} placeholder="https://grafana.acme.io" />
              </label>
              <div className="flex gap-2.5">
                <label className={`${fieldCls} w-24`}>
                  <span className={labelCls}>{t('board.fieldEmoji')}</span>
                  <input value={emoji} onChange={(e) => setEmoji(e.target.value)} className={input} placeholder="📊" />
                </label>
                <div className="flex-1">{catField}</div>
              </div>
            </>
          )}
          {type === 'note' && (
            <>
              <label className={fieldCls}>
                <span className={labelCls}>
                  {t('board.fieldText')} <span className="font-normal">· {t('board.fieldTextHint')}</span>
                </span>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={4}
                  className={`${input} font-mono leading-relaxed`}
                  style={{ resize: 'vertical' }}
                />
              </label>
              {catField}
            </>
          )}
          {type === 'action' && (
            <>
              <div className="flex gap-2.5">
                <label className={`${fieldCls} w-36`}>
                  <span className={labelCls}>{t('board.fieldLabel')}</span>
                  <input value={label} onChange={(e) => setLabel(e.target.value)} className={input} placeholder="Restart" />
                </label>
                <div className="flex-1">{catField}</div>
              </div>
              <label className={fieldCls}>
                <span className={labelCls}>
                  {t('board.fieldDesc')} <span className="font-normal">· {t('board.fieldDescHint')}</span>
                </span>
                <input value={desc} onChange={(e) => setDesc(e.target.value)} className={`${input} font-mono`} placeholder="systemctl restart app" />
              </label>
            </>
          )}
          {type === 'live' && (
            <>
              <label className={fieldCls}>
                <span className={labelCls}>{t('board.fieldSource')}</span>
                <select value={source} onChange={(e) => setSource(e.target.value as 'failed' | 'containers')} className={input}>
                  <option value="failed">{t('board.sourceFailed')}</option>
                  <option value="containers">{t('board.sourceContainers')}</option>
                </select>
              </label>
              {catField}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button onClick={onCancel} className="rounded border border-border px-2.5 py-1 text-xs hover:bg-muted">
            {t('board.cancel')}
          </button>
          <button onClick={submit} className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90">
            {existing ? t('board.saveEdit') : t('board.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
