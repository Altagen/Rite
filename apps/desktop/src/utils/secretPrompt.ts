/**
 * Asking for a secret at connect time (ADR 0024 §4).
 *
 * A member who did not ask Rite to keep a secret has to supply it per connection, which is
 * what `ssh` does without an agent. Two secrets work this way — an SSH password and a key
 * passphrase — and an instance that forbids stored secrets puts every machine in that
 * state, so the question is one mechanism with a `kind` rather than two near-copies.
 *
 * The store that opens the connection cannot render a dialog, so the question travels as a
 * DOM event carrying its own resolver — the same decoupling `openCreateVault` uses, for the
 * same reason: one dialog is mounted in the workspace and any surface can raise it without
 * prop-drilling.
 *
 * The answer is used for that one session and nothing writes it down.
 */

/** Which secret is being asked for. The dialog's wording and test ids follow from it. */
export type SecretKind = 'password' | 'passphrase';

export interface SecretRequest {
  kind: SecretKind;
  /** What the secret is for, as the dialog titles it (a machine's name). */
  label: string;
  /** Called with what was typed, or null when the person cancels. */
  settle: (answer: string | null) => void;
}

const EVENT = 'rite-ask-secret';

/**
 * Ask for a secret. Resolves to null when cancelled — and also when nothing is listening,
 * so a connection attempt fails as "cancelled" rather than hanging on a dialog that will
 * never open.
 */
export function askSecret(kind: SecretKind, label: string): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const once = (answer: string | null) => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    const event = new CustomEvent<SecretRequest>(EVENT, {
      detail: { kind, label, settle: once },
      cancelable: true,
    });
    // `dispatchEvent` returns false only if a listener called preventDefault; what tells us
    // nobody is mounted is that no listener took the request, so the dialog itself marks it.
    const taken = !window.dispatchEvent(event);
    if (!taken) once(null);
  });
}

/** Subscribe to secret requests; returns an unsubscribe fn. */
export function onAskSecret(handler: (request: SecretRequest) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    // Taking the request is how the dialog says it exists (see `askSecret`).
    e.preventDefault();
    handler((e as CustomEvent<SecretRequest>).detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
