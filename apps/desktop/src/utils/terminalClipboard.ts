/**
 * Copying out of a terminal and pasting into one, by the convention the person chose.
 *
 * MEASURED on both engines before any of it was written — `e2e/desktop-bench` for
 * WebKitGTK, which is the one Rite ships in, and Playwright for Chromium:
 *
 *   - `Ctrl+Shift+C` sent nothing and copied nothing, on EITHER engine. xterm's own
 *     `copyHandler` works (a native `copy` event with a selection yields the text), but
 *     no chord ever fires it: `_keyDown` takes `Ctrl+C` to send `\x03`, which is right for
 *     a terminal and also stops the engine firing its own copy.
 *   - `Ctrl+Shift+V` already pastes on BOTH engines — Chromium maps it to "paste as plain
 *     text", WebKitGTK fires a paste too. It is therefore never claimed here: claiming it
 *     would paste twice.
 *   - a paste with nothing to paste sends `ESC[200~ ESC[201~`: two escape sequences for no
 *     text. xterm's `paste()` has no empty case — it brackets whatever it is given — so a
 *     middle click with an empty clipboard does it every time, on both engines.
 *   - `navigator.clipboard` rejects `NotAllowedError` from an eval and resolves from a real
 *     gesture. It is transient activation, not a permission, so every read and write here
 *     happens inside the handler; an async hop before it would lose the gesture.
 *
 * WHAT THE MODES ARE FOR. Terminals disagree about which gesture copies, and the
 * disagreement is old enough that people have habits rather than preferences. Rite follows
 * the one asked for instead of picking a winner. The modes are named after the
 * conventions they reproduce, and `chord` is the default so that nobody's terminal changes
 * behaviour without being asked.
 *
 * ONE THING RITE CANNOT REPRODUCE, and it is the reason `select` is not the default: a
 * webview has no access to the X11 PRIMARY selection. In xterm or urxvt, selecting writes
 * PRIMARY and leaves CLIPBOARD alone, so the two coexist. Here, "selecting copies" means
 * writing the real clipboard on every drag — including a stray one. That is what the mode
 * does, deliberately, and the Settings screen says so.
 *
 * `Mod+Shift+C` stays in `RESERVED_BINDINGS` (shortcuts/commands.ts). That list keeps the
 * rebindable table from taking the chord, which is precisely what lets the terminal own
 * it: copying out of a terminal is terminal behaviour, not an app command with a chord.
 *
 * The decision is a pure function, as `plan_vault_command` and `plan_pick_file` are in the
 * shell: `e2e/clipboard-decision-check.mjs` holds the whole table across every mode, and
 * the DOM half below stays thin enough to read. Neither engine can test the empty paste
 * honestly — a synthetic `paste` with empty data is reported cancelled and delivers
 * nothing, and a real middle click pastes whatever X11 holds, which a page cannot clear —
 * so that one is asserted on the real engine by the bench.
 */

/**
 * Which convention this terminal follows.
 *
 *   `chord`             Ctrl+Shift+C copies. The engine pastes on Ctrl+Shift+V, and a
 *                       middle click pastes. What Rite has always done, and the default.
 *   `select`            Selecting copies, as xterm and urxvt do with PRIMARY — except that
 *                       here it writes the clipboard, because PRIMARY is unreachable. The
 *                       chord keeps working.
 *   `selectRightPaste`  Selecting copies and a right click pastes, as PuTTY does. The
 *                       engine's own context menu is given up to free the gesture.
 *   `ctrlC`             Ctrl+C copies WHEN SOMETHING IS SELECTED, as Windows Terminal
 *                       does, and interrupts otherwise.
 */
export type ClipboardMode = 'chord' | 'select' | 'selectRightPaste' | 'ctrlC';

export const CLIPBOARD_MODES: ClipboardMode[] = [
  'chord',
  'select',
  'selectRightPaste',
  'ctrlC',
];

/** The shipped default: what Rite did before the modes existed. */
export const DEFAULT_CLIPBOARD_MODE: ClipboardMode = 'chord';

/** True for a value that names a mode, for reading a configuration file. */
export const isClipboardMode = (v: unknown): v is ClipboardMode =>
  typeof v === 'string' && (CLIPBOARD_MODES as string[]).includes(v);

/** Where the event landed. Mouse events never reach xterm's textarea, keys only do. */
export type ClipboardWhere = 'textarea' | 'terminal' | 'elsewhere';

/**
 * What to do about one event.
 *
 * `paste` means Rite has to do it: the gesture carries no native paste, so the clipboard
 * is read and handed to the terminal. `drop-paste` is the opposite — a native paste that
 * carries nothing and must not reach the shell. `ignore` means: not ours, leave it alone.
 */
export type ClipboardAction =
  | { kind: 'copy'; text: string }
  | { kind: 'paste' }
  | { kind: 'drop-paste' }
  | { kind: 'ignore' };

/** The facts the decision needs, so it can be taken without a DOM. */
export interface ClipboardEventFacts {
  /** `keydown`, `paste`, `mouseup` or `contextmenu`; anything else is ignored. */
  type: string;
  where: ClipboardWhere;
  mode: ClipboardMode;
  key?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** For a mouseup: which button, as the DOM numbers them (0 left, 1 middle, 2 right). */
  button?: number;
  /** For a keydown or mouseup, what is selected. For a paste, what it carries. */
  text?: string;
}

const IGNORE: ClipboardAction = { kind: 'ignore' };

/** True when a mode copies on selection rather than on a chord. */
const copiesOnSelect = (mode: ClipboardMode): boolean =>
  mode === 'select' || mode === 'selectRightPaste';

/**
 * The explicit copy chord, available in every mode. `Ctrl+Shift+C` everywhere, because
 * that is what every Linux terminal uses and `Ctrl+C` has to stay SIGINT; plus `Cmd+C` on
 * macOS, where the platform's copy chord does not collide with SIGINT in the first place.
 */
const isCopyChord = (f: ClipboardEventFacts): boolean => {
  if (f.key !== 'c' && f.key !== 'C') return false;
  if (f.metaKey && !f.ctrlKey && !f.shiftKey && !f.altKey) return true; // Cmd+C, macOS
  return !!f.ctrlKey && !!f.shiftKey && !f.metaKey && !f.altKey;
};

/** `Ctrl+C` alone — the interrupt, which only `ctrlC` mode ever borrows. */
const isPlainCtrlC = (f: ClipboardEventFacts): boolean =>
  (f.key === 'c' || f.key === 'C') && !!f.ctrlKey && !f.shiftKey && !f.metaKey && !f.altKey;

/** Decide what one event is for. Pure: no DOM, no clipboard, no side effect. */
export function planClipboard(f: ClipboardEventFacts): ClipboardAction {
  if (f.where === 'elsewhere') return IGNORE;

  if (f.type === 'keydown') {
    // Keys reach xterm through its hidden textarea and nowhere else.
    if (f.where !== 'textarea') return IGNORE;
    if (isCopyChord(f)) {
      // With nothing selected the chord is not ours: claiming it would make a dead key of
      // it, and copying an empty selection would wipe whatever was on the clipboard.
      return f.text ? { kind: 'copy', text: f.text } : IGNORE;
    }
    // Borrowing the interrupt is opt-in, and only with something to copy. Without a
    // selection it stays what it has always been, which is the whole point of the chord.
    if (f.mode === 'ctrlC' && isPlainCtrlC(f) && f.text) {
      return { kind: 'copy', text: f.text };
    }
    return IGNORE;
  }

  if (f.type === 'paste') {
    if (f.where !== 'textarea') return IGNORE;
    // Text is the engine's to deliver, bracketed and whole. Nothing is not a paste.
    return f.text ? IGNORE : { kind: 'drop-paste' };
  }

  if (f.type === 'mouseup') {
    // Only the button that selects, and only in a mode that copies on selection. A middle
    // click is the engine's paste and a right click is handled below.
    if (!copiesOnSelect(f.mode) || f.button !== 0) return IGNORE;
    return f.text ? { kind: 'copy', text: f.text } : IGNORE;
  }

  if (f.type === 'contextmenu') {
    // Taking this gesture means giving up the engine's own menu, which is why only the
    // mode named for it does so.
    return f.mode === 'selectRightPaste' ? { kind: 'paste' } : IGNORE;
  }

  return IGNORE;
}

/** What the guard needs from its terminal. */
export interface TerminalClipboardHost {
  /** The selected text as xterm sees it — its selection is its own, never a DOM one. */
  selection: () => string;
  /** The convention in force, read per event so a change applies without a remount. */
  mode: () => ClipboardMode;
  /**
   * Hand text to the terminal as a paste. xterm's own `paste()`, so the bracketing and
   * the `bracketedPasteMode` it depends on stay the library's business and not a second
   * implementation of them here.
   */
  paste: (text: string) => void;
  /** Called when the guard acts, for diagnostics. */
  onTrace?: (what: string) => void;
}

/** True for the hidden textarea xterm keeps for keyboard input. */
const isXtermTextarea = (target: EventTarget | null): boolean =>
  target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea');

/**
 * Put `text` on the clipboard from inside the current gesture.
 *
 * Two paths, and the second is not a nicety: `navigator.clipboard` does not exist in an
 * insecure context, which is the web UI served over plain HTTP on a LAN. `copy` is the
 * event xterm's own handler serves, it needs no permission at all, and it fills the
 * clipboard from the same selection service — so the fallback is the library's own path
 * rather than a second implementation.
 */
const writeClipboard = (text: string, trace?: (what: string) => void): void => {
  if (navigator.clipboard?.writeText) {
    // Fired, not awaited: awaiting would not help, and by the time a rejection arrives the
    // gesture is gone, so the fallback there is best-effort rather than a guarantee.
    navigator.clipboard.writeText(text).catch(() => {
      trace?.('writeText rejected, falling back to the copy event');
      viaCopyEvent();
    });
    trace?.(`copied ${text.length} chars through the clipboard API`);
    return;
  }
  trace?.(viaCopyEvent() ? 'copied through the copy event' : 'nothing copied');
};

const viaCopyEvent = (): boolean => {
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
};

/**
 * Read the clipboard and hand it over, from inside the current gesture.
 *
 * There is no permission-free fallback for reading, unlike writing: `paste` is an event
 * the engine fires, never one a page can ask for. In an insecure context this does
 * nothing, which is why the mode that needs it is not the default.
 */
const readClipboardInto = (
  hand: (text: string) => void,
  trace?: (what: string) => void,
): void => {
  if (!navigator.clipboard?.readText) {
    trace?.('no clipboard to read — the context is not a secure one');
    return;
  }
  navigator.clipboard
    .readText()
    .then((text) => {
      // Nothing to paste is nothing to send: the same rule as the native path above, or a
      // right click on an empty clipboard would put ESC[200~ ESC[201~ into the shell.
      if (text) hand(text);
      else trace?.('an empty clipboard was not pasted');
    })
    .catch(() => trace?.('readText rejected, so nothing was pasted'));
};

/**
 * Watch `root` for whichever gestures the mode in force claims. Returns the detach
 * function.
 */
export function attachTerminalClipboard(
  root: HTMLElement,
  host: TerminalClipboardHost,
): () => void {
  const handle = (e: Event) => {
    const target = e.target;
    const where: ClipboardWhere = isXtermTextarea(target)
      ? 'textarea'
      : target instanceof Node && root.contains(target)
        ? 'terminal'
        : 'elsewhere';
    const ke = e as KeyboardEvent;
    const action = planClipboard({
      type: e.type,
      where,
      mode: host.mode(),
      key: ke.key,
      ctrlKey: ke.ctrlKey,
      shiftKey: ke.shiftKey,
      metaKey: ke.metaKey,
      altKey: ke.altKey,
      button: (e as MouseEvent).button,
      text:
        e.type === 'paste'
          ? ((e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '')
          : host.selection(),
    });
    if (action.kind === 'ignore') return;
    // A mouseup that copies must not be cancelled: cancelling it would leave xterm's
    // selection service mid-drag. Everything else is claimed before xterm sees it — a
    // copy chord so it does not also reach `_keyDown`, a paste so `handlePasteEvent`
    // never runs, a context menu so the engine's own does not open over the paste.
    if (e.type !== 'mouseup') {
      e.preventDefault();
      e.stopPropagation();
    }
    if (action.kind === 'copy') writeClipboard(action.text, host.onTrace);
    else if (action.kind === 'paste') readClipboardInto(host.paste, host.onTrace);
    else host.onTrace?.('an empty paste was dropped');
  };

  // Capture on an ancestor, traversed before the target: xterm registers its own
  // listeners on the textarea and on `.xterm`, and a listener added later on the same
  // element would run second, after the damage.
  const types = ['keydown', 'paste', 'mouseup', 'contextmenu'];
  for (const type of types) root.addEventListener(type, handle, true);

  return () => {
    for (const type of types) root.removeEventListener(type, handle, true);
  };
}
