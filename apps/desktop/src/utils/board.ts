/**
 * Collection Board (ADR 0016) — the data model, shared by the store and the UI.
 *
 * A Board is a members-only space of cards attached to a collection: styled links,
 * short markdown notes, one-click actions, and live views. The whole board is one
 * value, encrypted client-side with the collection's itemsKey and stored as an
 * opaque blob (`boardEnc`) — the server never learns its contents.
 */

/** A styled link button (opens a URL). */
export interface LinkCard {
  id: string;
  type: 'link';
  title: string;
  url: string;
  emoji: string;
}

/** A short markdown note (**bold**, `code`). */
export interface NoteCard {
  id: string;
  type: 'note';
  title: string;
  text: string;
}

/** A one-click action — a command to copy/run (a snippet, a TUI, a connect). */
export interface ActionCard {
  id: string;
  type: 'action';
  title: string;
  label: string;
  desc: string;
}

/**
 * A live view descriptor — what to show and where from. The rows are refreshed by a
 * connected machine (systemd units / containers); until the Containers/Services
 * cards land, a live card renders its last-seen rows (if any) plus its source.
 */
export interface LiveCard {
  id: string;
  type: 'live';
  title: string;
  source: 'failed' | 'containers';
  rows?: { up: boolean; text: string }[];
}

export type BoardCard = LinkCard | NoteCard | ActionCard | LiveCard;

/** A short, collision-resistant id for a new card. */
export function newCardId(): string {
  return 'b' + Math.random().toString(36).slice(2, 8);
}

/** Parse a decrypted board value defensively — anything malformed yields an empty board. */
export function parseBoard(value: unknown): BoardCard[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (c): c is BoardCard =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as { id?: unknown }).id === 'string' &&
      ['link', 'note', 'action', 'live'].includes((c as { type?: unknown }).type as string),
  );
}

/**
 * Mini-markdown for note cards: escapes HTML, then renders **bold**, `code`, and
 * newlines. Returns an HTML string for `dangerouslySetInnerHTML` (input is escaped
 * first, so no raw HTML survives).
 */
export function mdMini(t: string): string {
  return (t || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
