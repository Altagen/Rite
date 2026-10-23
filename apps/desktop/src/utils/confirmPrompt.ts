/**
 * Asking "are you sure" without handing the question to the browser.
 *
 * Five places called `window.confirm`: promoting a user to admin, a role change under the
 * instance policy, deleting a team, deleting a collection from the console, and closing a
 * pane holding several terminals. A system box does not take the app's theme, does not
 * translate its own OK and Cancel, and gives the destructive answer the same weight as the
 * safe one. It also hid text from the string checks — `window.confirm(message)`, with
 * `message` built a line above, kept an English sentence out of the locales for a release.
 *
 * Shaped like `askSecret`: the question travels as a DOM event carrying its own resolver, so
 * a store or a deeply nested handler can raise it without prop-drilling, and the call site
 * keeps reading like the `window.confirm` it replaces —
 * `if (!(await askConfirm({ title }))) return;`.
 *
 * Resolves FALSE when nothing is listening. For a confirmation that is the safe default: a
 * destructive action never happens because a dialog failed to mount.
 */

export interface ConfirmRequest {
  title: string;
  body?: string;
  /** The word on the button that does the thing; a plain Confirm when absent. */
  action?: string;
  /** Red rather than primary — for what destroys, or cannot be undone. */
  danger?: boolean;
}

interface ConfirmEventDetail extends ConfirmRequest {
  settle: (answer: boolean) => void;
}

const EVENT = 'rite-ask-confirm';

/** Ask for confirmation. False on cancel, and false when no dialog is mounted. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const once = (answer: boolean) => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    const event = new CustomEvent<ConfirmEventDetail>(EVENT, {
      detail: { ...request, settle: once },
      cancelable: true,
    });
    // The dialog marks the request as taken by calling preventDefault; no listener means
    // `dispatchEvent` returns true, and the answer is no.
    const taken = !window.dispatchEvent(event);
    if (!taken) once(false);
  });
}

/** Subscribe to confirmation requests; returns an unsubscribe fn. */
export function onAskConfirm(handler: (request: ConfirmEventDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    e.preventDefault();
    handler((e as CustomEvent<ConfirmEventDetail>).detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
