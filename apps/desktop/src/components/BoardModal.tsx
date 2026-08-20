/**
 * Collection Board (ADR 0016) — a members-only space of cards.
 *
 * Cards are links, short markdown notes, one-click actions and live-view descriptors.
 * The whole board is one value encrypted client-side with the collection's itemsKey
 * (via the connections source's readBoard/saveBoard) — the server only stores an
 * opaque blob. Viewers see it read-only; editors and owners can add/remove cards.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { type BoardCard, mdMini, newCardId } from '../utils/board';

type CardType = BoardCard['type'];

interface Props {
  collectionId: string;
  collectionName: string;
  memberCount: number;
  isPersonal: boolean;
  canWrite: boolean;
  readBoard: (collectionId: string) => Promise<BoardCard[]>;
  saveBoard: (collectionId: string, cards: BoardCard[]) => Promise<void>;
  onClose: () => void;
}

export function BoardModal({
  collectionId,
  collectionName,
  memberCount,
  isPersonal,
  canWrite,
  readBoard,
  saveBoard,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [addType, setAddType] = useState<CardType | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    readBoard(collectionId)
      .then((c) => {
        if (alive) setCards(c);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(true);
      });
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

  const addCard = (card: BoardCard) => {
    setAddType(null);
    void persist([...cards, card]);
  };

  const subtitle = isPersonal
    ? t('board.personal')
    : memberCount > 1
      ? t('board.members', { n: memberCount })
      : t('board.personal');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-medium">
            {collectionName} · {t('board.title')}
          </div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 text-xs text-muted-foreground">
            {t('board.intro', { name: collectionName })}
          </p>

          {loaded && cards.length === 0 && (
            <p className="mb-3 text-sm text-muted-foreground">{t('board.empty')}</p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {cards.map((c) => (
              <BoardCardView
                key={c.id}
                card={c}
                canWrite={canWrite}
                onRemove={() => removeCard(c.id)}
              />
            ))}
          </div>

          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

          {canWrite && (
            <div className="relative mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => setShowAddMenu((v) => !v)}
                className="rounded border border-border px-2.5 py-1 text-xs hover:bg-muted"
              >
                + {t('board.add')}
              </button>
              {showAddMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowAddMenu(false)} />
                  <div className="absolute bottom-full right-0 z-20 mb-1 w-64 rounded border border-border bg-background shadow-lg">
                    {(
                      [
                        ['link', '🔗', t('board.menuLink')],
                        ['note', '📝', t('board.menuNote')],
                        ['action', '⚡', t('board.menuAction')],
                        ['live', '📡', t('board.menuLive')],
                      ] as [CardType, string, string][]
                    ).map(([type, emoji, label]) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          setShowAddMenu(false);
                          setAddType(type);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                      >
                        <span className="text-base">{emoji}</span>
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {addType && (
            <CardForm type={addType} onCancel={() => setAddType(null)} onAdd={addCard} />
          )}

          {!canWrite && loaded && (
            <p className="mt-3 text-xs text-muted-foreground">{t('board.readonly')}</p>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {t('board.done')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One rendered card, by type, with a remove affordance for writers. */
function BoardCardView({
  card,
  canWrite,
  onRemove,
}: {
  card: BoardCard;
  canWrite: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const typeLabel: Record<CardType, string> = {
    link: t('board.typeLink'),
    note: t('board.typeNote'),
    action: t('board.typeAction'),
    live: t('board.typeLive'),
  };

  const header = (
    <div className="mb-1.5 flex items-center justify-between">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {typeLabel[card.type]}
      </span>
      {canWrite && (
        <button
          type="button"
          onClick={onRemove}
          className="rounded px-1 text-xs text-muted-foreground hover:text-foreground"
          title={t('board.remove')}
        >
          ✕
        </button>
      )}
    </div>
  );

  const shell = 'rounded-lg border border-border bg-muted/30 p-3';

  if (card.type === 'link') {
    return (
      <div className={shell}>
        {header}
        <button
          type="button"
          onClick={() => window.open(card.url, '_blank', 'noopener,noreferrer')}
          title={t('board.openLink')}
          className="flex w-full items-center gap-2.5 text-left"
        >
          <span className="text-2xl">{card.emoji || '🔗'}</span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{card.title}</span>
            <span className="block truncate text-xs text-muted-foreground">{card.url}</span>
          </span>
        </button>
      </div>
    );
  }

  if (card.type === 'note') {
    return (
      <div className={shell}>
        {header}
        <div className="text-sm font-medium">{card.title}</div>
        <div
          className="board-note mt-1 text-sm text-muted-foreground"
          dangerouslySetInnerHTML={{ __html: mdMini(card.text) }}
        />
      </div>
    );
  }

  if (card.type === 'action') {
    return (
      <div className={shell}>
        {header}
        <div className="text-sm font-medium">{card.title}</div>
        {card.desc && (
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={card.desc}>
            {card.desc}
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(card.desc || card.label).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          disabled={!card.desc}
          className="mt-2 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          title={t('board.copy')}
        >
          {copied ? t('board.copied') : card.label || 'Run'}
        </button>
      </div>
    );
  }

  // live
  const rows = card.rows ?? [];
  return (
    <div className={shell}>
      {header}
      <div className="text-sm font-medium">{card.title}</div>
      <div className="mt-1.5 flex flex-col gap-1">
        {rows.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t('board.liveEmpty')}</span>
        ) : (
          rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 flex-none rounded-full ${r.up ? 'bg-green-500' : 'bg-red-500'}`}
              />
              <span className="truncate font-mono text-[11px] text-muted-foreground">{r.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="mt-1.5 text-[10px] text-muted-foreground">{t('board.liveHint')}</div>
    </div>
  );
}

/** The inline "new card" form, whose fields depend on the chosen type. */
function CardForm({
  type,
  onCancel,
  onAdd,
}: {
  type: CardType;
  onCancel: () => void;
  onAdd: (card: BoardCard) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [emoji, setEmoji] = useState('');
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [desc, setDesc] = useState('');
  const [source, setSource] = useState<'failed' | 'containers'>('failed');

  const inputCls =
    'w-full rounded border border-border bg-input px-2.5 py-1.5 text-sm';
  const fieldCls = 'flex flex-col gap-1 text-xs';
  const labelCls = 'text-muted-foreground';

  const submit = () => {
    const ttl = title.trim() || type;
    let card: BoardCard;
    if (type === 'link') {
      card = {
        id: newCardId(),
        type: 'link',
        title: ttl,
        url: url.trim() || 'https://example.com',
        emoji: emoji.trim() || '🔗',
      };
    } else if (type === 'note') {
      card = { id: newCardId(), type: 'note', title: ttl, text: text.trim() };
    } else if (type === 'action') {
      card = {
        id: newCardId(),
        type: 'action',
        title: ttl,
        label: label.trim() || 'Run',
        desc: desc.trim(),
      };
    } else {
      card = { id: newCardId(), type: 'live', title: ttl, source, rows: [] };
    }
    onAdd(card);
  };

  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-lg border border-border p-3">
      <label className={fieldCls}>
        <span className={labelCls}>{t('board.fieldTitle')}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
      </label>

      {type === 'link' && (
        <>
          <label className={fieldCls}>
            <span className={labelCls}>{t('board.fieldUrl')}</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} className={inputCls} placeholder="https://grafana.acme.io" />
          </label>
          <label className={fieldCls}>
            <span className={labelCls}>{t('board.fieldEmoji')}</span>
            <input value={emoji} onChange={(e) => setEmoji(e.target.value)} className={`${inputCls} w-24`} placeholder="📊" />
          </label>
        </>
      )}

      {type === 'note' && (
        <label className={fieldCls}>
          <span className={labelCls}>
            {t('board.fieldText')} <span className="font-normal">· {t('board.fieldTextHint')}</span>
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className={`${inputCls} font-mono leading-relaxed`}
            style={{ resize: 'vertical' }}
          />
        </label>
      )}

      {type === 'action' && (
        <>
          <label className={fieldCls}>
            <span className={labelCls}>{t('board.fieldLabel')}</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} placeholder="Restart" />
          </label>
          <label className={fieldCls}>
            <span className={labelCls}>
              {t('board.fieldDesc')} <span className="font-normal">· {t('board.fieldDescHint')}</span>
            </span>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} className={`${inputCls} font-mono`} placeholder="systemctl restart app" />
          </label>
        </>
      )}

      {type === 'live' && (
        <label className={fieldCls}>
          <span className={labelCls}>{t('board.fieldSource')}</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as 'failed' | 'containers')}
            className={inputCls}
          >
            <option value="failed">{t('board.sourceFailed')}</option>
            <option value="containers">{t('board.sourceContainers')}</option>
          </select>
        </label>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border px-2.5 py-1 text-xs hover:bg-muted"
        >
          {t('board.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          {t('board.save')}
        </button>
      </div>
    </div>
  );
}
