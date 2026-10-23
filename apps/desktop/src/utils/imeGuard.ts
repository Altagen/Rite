/**
 * Accented input in the desktop webview, where xterm.js and WebKitGTK disagree.
 *
 * WebKitGTK delivers an accented key through the input method as three events: a
 * `keydown` with `keyCode` 229, an `input`, and a **`compositionend` with no
 * `compositionstart` before it**. Both of xterm's paths then decline the character and
 * one of them replays the whole line:
 *
 * - `_inputEvent` sends `e.data` only when `(!e.composed || !this._keyDownSeen)`. The
 *   229 keydown sets `_keyDownSeen` and the event is composed, so it returns false and
 *   sends nothing.
 * - the orphaned `compositionend` runs `_finalizeComposition`, which slices the hidden
 *   textarea from `_compositionPosition.start`. No `compositionstart` ever set it, so it
 *   is 0 — and **the entire textarea is sent**, replaying everything typed so far.
 *
 * That is the "one accent prints a flood of characters" report, and the flood is not
 * random: it is the line, again, plus whatever the dead key composed on top of an
 * already-composed character.
 *
 * This guard listens in the CAPTURE phase on an ancestor, which is traversed before the
 * target, because xterm's own `input` listener is itself registered with capture on the
 * textarea — a listener added later on the same element would run second and the damage
 * would already be done.
 *
 * It only acts on a composition nobody announced. A real `compositionstart` means a real
 * IME (Pinyin, Kana, a genuine dead-key sequence that reports itself), and those are left
 * entirely to xterm.
 *
 * Upstream: xterm.js #6250 and #5894. No fix had been merged when this was written, and
 * several downstream applications carry a guard of this shape.
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
 * Watch `root` for the WebKitGTK sequence and handle it before xterm can. Returns the
 * detach function.
 */
export function attachImeGuard(root: HTMLElement, host: ImeGuardHost): () => void {
  // A composition the browser announced. Only an unannounced one is ours to handle.
  let announced = false;
  // Set when we took an `input` event, so the orphaned `compositionend` that follows is
  // swallowed rather than allowed to replay the textarea.
  let swallowNextEnd = false;
  // Whether the last keydown was the input method's, which is the ONLY shape this guard
  // may touch. An ordinary key also produces an `input` with `insertText`, and xterm has
  // already sent that one from `keypress` — taking it again types everything twice.
  let fromInputMethod = false;

  const onKeyDown = (e: Event) => {
    if (!isXtermTextarea(e.target)) return;
    const ke = e as KeyboardEvent;
    // 229 is what a browser reports while an input method owns the key. WebKitGTK sends
    // it for a plain accented character; a normal key never carries it.
    fromInputMethod = ke.keyCode === 229 || ke.key === 'Process';

    // And xterm must not see it. Measured, not assumed: a keydown carrying keyCode 229
    // and nothing else makes xterm emit \x7f — a DEL that erases the accent arriving
    // right behind it. That is the other half of the report, the characters that vanish.
    // A keydown from a composition the browser announced is left alone: a real input
    // method needs xterm to follow it.
    if (fromInputMethod && !announced) e.stopPropagation();
  };

  const onCompositionStart = (e: Event) => {
    if (!isXtermTextarea(e.target)) return;
    announced = true;
    swallowNextEnd = false;
  };

  const onInput = (e: Event) => {
    const target = e.target;
    if (!isXtermTextarea(target)) return;
    if (announced) return; // a real composition: xterm owns it
    if (!fromInputMethod) return; // an ordinary key: xterm already sent it
    const ie = e as InputEvent;
    if (ie.inputType !== 'insertText' || !ie.data) return;

    // The character, once, from the event that carries it.
    host.send(ie.data);
    host.onTrace?.(`insertText ${JSON.stringify(ie.data)}`);

    // xterm reads this textarea when it finalizes a composition. Emptying it is what
    // stops a later read from finding the whole line sitting there.
    target.value = '';

    // Stop xterm's own capture listener on the textarea from seeing it at all, and
    // swallow the `compositionend` WebKitGTK sends next.
    e.stopPropagation();
    swallowNextEnd = true;
    fromInputMethod = false;
  };

  const onCompositionEnd = (e: Event) => {
    if (!isXtermTextarea(e.target)) return;
    if (announced) {
      // A composition that started properly ends properly.
      announced = false;
      swallowNextEnd = false;
      return;
    }
    if (swallowNextEnd) {
      swallowNextEnd = false;
      host.onTrace?.('swallowed an orphaned compositionend');
      e.stopPropagation();
      return;
    }
    // An orphaned end with no input event before it: still not a composition xterm was
    // told about, so letting it through would slice from position zero.
    host.onTrace?.('swallowed an orphaned compositionend (no input)');
    e.stopPropagation();
  };

  root.addEventListener('keydown', onKeyDown, true);

  root.addEventListener('compositionstart', onCompositionStart, true);
  root.addEventListener('input', onInput, true);
  root.addEventListener('compositionend', onCompositionEnd, true);

  return () => {
    root.removeEventListener('keydown', onKeyDown, true);
    root.removeEventListener('compositionstart', onCompositionStart, true);
    root.removeEventListener('input', onInput, true);
    root.removeEventListener('compositionend', onCompositionEnd, true);
  };
}
