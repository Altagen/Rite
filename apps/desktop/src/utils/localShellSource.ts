/**
 * Which shell a new local terminal starts, and whose machine decides (ADR 0031).
 *
 * A local terminal runs on the client that asked for it. On the desktop that is the user's
 * own machine, in a server context as much as in a local vault — so the shell is this
 * machine's and the instance's list does not apply. That list exists to stop a client
 * naming a program the INSTANCE does not offer, which is a statement about the instance's
 * machine, and the instance has no standing over what runs on someone else's.
 *
 * In a browser the instance is the only machine there is, so its shell is the one that
 * starts and the old rule stands: send a NAME, and only one the instance offers, and let it
 * resolve the path itself.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE LINES IN A COMPONENT. The discriminator is
 * `isNativeShell()`, which reads a global the wry shell injects — absent under Playwright,
 * so every suite would exercise the browser arm and the desktop arm would ship untested.
 * The engine gap is not theoretical: a `mouseleave` that Chromium delivers and WebKitGTK
 * does not shipped a sidebar arrow that never hid. So the rule is pure, its inputs are
 * passed in, and `e2e/local-shell-source-check.mjs` holds every arm of it.
 *
 * Imports nothing, so that check can load it through Node's type stripping.
 */

export interface ShellSourceInputs {
  /** This client runs the shell: the native desktop, whatever the active context. */
  runsHere: boolean;
  /** A remote instance is the active context. */
  serverContext: boolean;
  /** A shell the caller named (the toolbar's picker), if any. */
  asked?: string;
  /** What this machine starts when nothing is named. */
  localDefault: string;
  /** What the instance starts when nothing is named. */
  instanceDefault?: string;
  /** The shells the instance offers by name. Empty = it keeps the decision. */
  instanceOffers: string[];
}

/**
 * The value to send with a new local terminal, or `undefined` to let the receiving end
 * apply its own rule.
 */
export function shellToStart(i: ShellSourceInputs): string | undefined {
  // The shell runs here, so it is named here. A path the instance resolved belongs to the
  // instance's filesystem and would, at best, fall back to something else on this one.
  if (i.runsHere) return i.asked || i.localDefault;

  // A browser against an instance: the instance's machine, so the instance's rules.
  if (i.serverContext) {
    const offered = i.asked && i.instanceOffers.includes(i.asked) ? i.asked : undefined;
    if (offered) return offered;
    // Nothing offered at all means the instance keeps the decision — say nothing rather
    // than echo a default back at it, so an administrator who changes it carries everyone.
    return i.instanceOffers.length > 0 ? i.instanceDefault : undefined;
  }

  return i.asked || i.localDefault;
}
