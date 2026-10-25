/**
 * Copying out of a terminal, and not pasting nothing into one.
 *
 * MEASURED on both engines before any of it was written — `e2e/desktop-bench` for
 * WebKitGTK, which is the one Rite ships in, and Playwright for Chromium:
 *
 *   - `Ctrl+Shift+C` sent nothing and copied nothing, on EITHER engine. xterm's own
 *     `copyHandler` works (a native `copy` event with a selection yields the text), but
 *     no chord ever fires it: `_keyDown` takes `Ctrl+C` to send `\x03`, which is right for
 *     a terminal and also stops the engine firing its own copy. Copying with the keyboard
 *     was impossible.
 *   - `Ctrl+Shift+V` already pastes on BOTH engines — Chromium maps it to "paste as plain
 *     text", WebKitGTK fires a paste too. Binding it here would paste twice, so this file
 *     does not bind paste at all. That is what measuring first bought.
 *   - a paste with nothing to paste sends `ESC[200~ ESC[201~`: two escape sequences for no
 *     text. xterm's `paste()` has no empty case — it brackets whatever it is given and
 *     calls `triggerDataEvent` — so a middle click with an empty clipboard does it every
 *     time, which both engines were measured doing.
 *   - `navigator.clipboard.writeText` rejects `NotAllowedError` from an eval and resolves
 *     from a real keydown. It is transient activation, not a permission: the write happens
 *     inside the handler, and an async hop before it would lose the gesture.
 *
 * `Mod+Shift+C` stays in `RESERVED_BINDINGS` (shortcuts/commands.ts). That list keeps the
 * rebindable table from taking the chord, which is precisely what lets the terminal own
 * it: copying out of a terminal is terminal behaviour, not an app command with a setting.
 *
 * The decision is a pure function, as `plan_vault_command` and `plan_pick_file` are in the
 * shell: `e2e/clipboard-decision-check.mjs` holds the whole table, and the DOM half below
 * stays thin enough to read. Neither engine can test the empty paste honestly — a
 * synthetic `paste` with empty data is reported cancelled and delivers nothing, and a real
 * middle click pastes whatever X11 holds, which a test cannot clear — so that one is
 * asserted on the real engine by the bench.
 */

/** What to do about one event. `ignore` means: not ours, leave it entirely alone. */
export type ClipboardAction =
  | { kind: 'copy'; text: string }
  | { kind: 'drop-paste' }
  | { kind: 'ignore' };

/** The shape the decision needs, so it can be taken without a DOM. */
export interface ClipboardEventFacts {
  /** `keydown` or `paste`; anything else is ignored. */
  type: string;
  /** Whether the event landed on xterm's hidden textarea. */
  onTextarea: boolean;
  key?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** For a keydown, what the terminal has selected. For a paste, what it carries. */
  text?: string;
}

/**
 * The copy chord. `Ctrl+Shift+C` everywhere, because that is what every Linux terminal
 * uses and `Ctrl+C` has to stay SIGINT; plus `Cmd+C` on macOS, where the platform's copy
 * chord does not collide with SIGINT in the first place.
 */
const isCopyChord = (f: ClipboardEventFacts): boolean => {
  if (f.key !== 'c' && f.key !== 'C') return false;
  if (f.metaKey && !f.ctrlKey && !f.shiftKey && !f.altKey) return true; // Cmd+C, macOS
  return !!f.ctrlKey && !!f.shiftKey && !f.metaKey && !f.altKey;
};

/** Decide what one event is for. Pure: no DOM, no clipboard, no side effect. */
export function planClipboard(f: ClipboardEventFacts): ClipboardAction {
  if (!f.onTextarea) return { kind: 'ignore' };
  if (f.type === 'keydown') {
    if (!isCopyChord(f)) return { kind: 'ignore' };
    // With nothing selected the chord is not ours: claiming it would make a dead key of
    // it, and copying an empty selection would wipe whatever was on the clipboard.
    return f.text ? { kind: 'copy', text: f.text } : { kind: 'ignore' };
  }
  if (f.type === 'paste') {
    // Text is xterm's to deliver, bracketed and whole. Nothing is not a paste.
    return f.text ? { kind: 'ignore' } : { kind: 'drop-paste' };
  }
  return { kind: 'ignore' };
}

/** What the guard needs from its terminal. */
export interface TerminalClipboardHost {
  /** The selected text as xterm sees it — its selection is its own, never a DOM one. */
  selection: () => string;
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
 * Watch `root` for the copy chord and for a paste carrying nothing. Returns the detach
 * function.
 */
export function attachTerminalClipboard(
  root: HTMLElement,
  host: TerminalClipboardHost,
): () => void {
  const handle = (e: Event) => {
    const onTextarea = isXtermTextarea(e.target);
    const ke = e as KeyboardEvent;
    const action = planClipboard({
      type: e.type,
      onTextarea,
      key: ke.key,
      ctrlKey: ke.ctrlKey,
      shiftKey: ke.shiftKey,
      metaKey: ke.metaKey,
      altKey: ke.altKey,
      text:
        e.type === 'paste'
          ? ((e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '')
          : host.selection(),
    });
    if (action.kind === 'ignore') return;
    // Before xterm either way: for a copy so the chord does not also reach `_keyDown`,
    // for a paste so `handlePasteEvent` never runs and the shell is spared two escape
    // sequences that said nothing.
    e.preventDefault();
    e.stopPropagation();
    if (action.kind === 'copy') writeClipboard(action.text, host.onTrace);
    else host.onTrace?.('an empty paste was dropped');
  };

  // Capture on an ancestor, traversed before the target: xterm registers its own
  // listeners on the textarea and on `.xterm`, and a listener added later on the same
  // element would run second, after the damage.
  for (const type of ['keydown', 'paste']) root.addEventListener(type, handle, true);

  return () => {
    for (const type of ['keydown', 'paste']) root.removeEventListener(type, handle, true);
  };
}
