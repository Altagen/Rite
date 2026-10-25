/**
 * Dead-key input in the desktop webview, where xterm.js and WebKitGTK disagree.
 *
 * MEASURED, not inferred. WebKitGTK delivers `^` then `o` as:
 *
 *     keydown  keyCode=229                     the dead key
 *     compositionstart / compositionupdate "^"
 *     input    insertCompositionText  "^"       the preview
 *     keydown  keyCode=229                      the letter
 *     input    deleteCompositionText            the preview is withdrawn
 *     compositionend data=""                    first end, empty
 *     keydown  keyCode=229
 *     input    insertFromComposition "ô"        the character, and only here
 *     compositionend data="ô"                   second end
 *
 * Three keydowns carrying 229 and two `compositionend`s for one character. xterm's
 * `CompositionHelper` cannot survive that, because it decides across a timer:
 *
 *     keydown(e) { ... return 229 !== e.keyCode || (this._handleAnyTextareaChanges(), false) }
 *
 * `_handleAnyTextareaChanges` snapshots the hidden textarea, waits a tick, compares, and
 * sends the difference — or `\x7f` if the value shrank, or **the whole textarea** if the
 * length matched but the content changed. `_finalizeComposition` likewise slices the
 * textarea from an index captured earlier, after a `setTimeout(0)`.
 *
 * Nothing clears that textarea on this engine: `_inputEvent` bails out on
 * `(!e.composed || !this._keyDownSeen)` — WebKitGTK sets `composed` on every event — so the
 * value accumulates for the life of the pane. Each dead key then races three 229 keydowns
 * and two ends against those timers, and the outcome is the character, a `\x7f` that eats
 * the letter before it, or the entire accumulated line replayed at once. All three were
 * observed in one session.
 *
 * So this guard owns the composition on this engine instead of patching the race:
 *
 *   - every keydown carrying 229 is stopped, which is what keeps
 *     `_handleAnyTextareaChanges` from running at all — no `\x7f`, no replay;
 *   - every composition event is stopped, so `_finalizeComposition` never runs and
 *     `_isComposing` is never set, leaving no timer-driven path alive;
 *   - the character is sent from the event that carries it, once, with no timer;
 *   - the textarea is emptied on commit, so even a slice that slipped through would
 *     return nothing.
 *
 * What this deliberately does NOT touch: a directly typed accent (`é è à ù ç` on AZERTY)
 * arrives with `keyCode` 0 and is sent by xterm's own `_keyPress`. Those work, they are
 * measured as working, and `insertText` is left entirely alone — taking it as well would
 * send every one of them twice.
 *
 * The cost is xterm's inline preview: the pending `^` is no longer shown before the letter
 * completes it. The input method draws its own candidate window, and a terminal is better
 * off deterministic than previewed.
 *
 * Upstream: xterm.js #6250 and #5894, both open when this was written.
 */

/** What the guard needs from its host, so it can be driven by a test. */
export interface ImeGuardHost {
  /** Send one chunk of input, exactly as a keystroke would. */
  send: (data: string) => void;
  /** Called when the guard handles an event, for diagnostics. */
  onTrace?: (what: string) => void;
}

/** True for the hidden textarea xterm keeps for keyboard input. */
const isXtermTextarea = (target: EventTarget | null): target is HTMLTextAreaElement =>
  target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea');

/**
 * `input` types that belong to a composition. `insertText` is absent on purpose: that is
 * the ordinary path, already sent by xterm, and claiming it would double every keystroke.
 */
const COMPOSED_INPUT = new Set([
  'insertCompositionText',
  'deleteCompositionText',
  'insertFromComposition',
]);

/**
 * True for a keydown that belongs to a composition rather than to a key the terminal has
 * to act on.
 *
 * 229 says only that an input method owns the keyboard, not that text is being composed:
 * under ibus or fcitx a plain Tab arrives with that code too. What tells them apart is
 * `key` — a composition reports `Unidentified`, `Process`, `Dead`, or the character being
 * composed, while a control key names itself. Swallowing those by code alone cost shell
 * completion: Tab disappeared while typing went on working.
 */
const isCompositionKey = (e: KeyboardEvent): boolean => {
  if (e.key === 'Process' || e.key === 'Dead') return true;
  if (e.keyCode !== 229) return false;
  // `Unidentified` is what WebKitGTK reports for the dead key itself; a single character
  // is the letter an input method is holding. Anything else is a named key — Tab, Enter,
  // Backspace, an arrow — and belongs to xterm.
  return e.key === 'Unidentified' || Array.from(e.key).length === 1;
};

/**
 * Watch `root` for the composition sequence and handle it before xterm can. Returns the
 * detach function.
 */
export function attachImeGuard(root: HTMLElement, host: ImeGuardHost): () => void {
  // What this composition already sent. The engine announces the committed text twice —
  // on an `insertFromComposition` input and again on `compositionend` — and either may
  // come first, so the text is sent on whichever arrives and skipped on the other.
  let sent = '';

  const commit = (data: string, target: HTMLTextAreaElement) => {
    if (!data || data === sent) return;
    host.send(data);
    sent = data;
    // The one place this value is cleared on this engine. An empty textarea is what makes
    // every `substring` in xterm's composition paths return nothing.
    target.value = '';
    host.onTrace?.(`commit ${JSON.stringify(data)}`);
  };

  const onKeyDown = (e: Event) => {
    if (!isXtermTextarea(e.target)) return;
    const ke = e as KeyboardEvent;
    // Letting a composition keydown through runs `_handleAnyTextareaChanges`, which is the
    // `\x7f` and the replay. Letting a control key through is the point: see
    // `isCompositionKey`.
    if (isCompositionKey(ke)) {
      e.stopPropagation();
      host.onTrace?.(`swallowed keydown keyCode=${ke.keyCode} key=${ke.key}`);
    }
  };

  const onCompositionStart = (e: Event) => {
    if (!isXtermTextarea(e.target)) return;
    sent = '';
    e.stopPropagation();
  };

  const onCompositionUpdate = (e: Event) => {
    if (!isXtermTextarea(e.target)) return;
    e.stopPropagation();
  };

  const onCompositionEnd = (e: Event) => {
    const target = e.target;
    if (!isXtermTextarea(target)) return;
    // An engine that commits only here — a full input method rather than a dead key —
    // still gets its text through.
    commit((e as CompositionEvent).data ?? '', target);
    e.stopPropagation();
  };

  const onInput = (e: Event) => {
    const target = e.target;
    if (!isXtermTextarea(target)) return;
    const ie = e as InputEvent;
    if (!COMPOSED_INPUT.has(ie.inputType)) return; // xterm's to send
    // `insertCompositionText` is the preview and `deleteCompositionText` its withdrawal:
    // both are swallowed and neither is sent. Only the insertion carries the character.
    if (ie.inputType === 'insertFromComposition') commit(ie.data ?? '', target);
    e.stopPropagation();
  };

  const pairs: Array<[string, EventListener]> = [
    ['keydown', onKeyDown],
    ['compositionstart', onCompositionStart],
    ['compositionupdate', onCompositionUpdate],
    ['compositionend', onCompositionEnd],
    ['input', onInput],
  ];
  // Capture on an ancestor, which is traversed before the target: xterm registers its own
  // `input` listener with capture on the textarea itself, and a listener added later on
  // the same element would run second, after the damage.
  for (const [type, fn] of pairs) root.addEventListener(type, fn, true);

  return () => {
    for (const [type, fn] of pairs) root.removeEventListener(type, fn, true);
  };
}
