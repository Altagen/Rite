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

/**
 * Does the instance get to narrow which shell starts?
 *
 * One function for every place that asks, because asking it in several places is how the
 * first pass at ADR 0031 shipped half-converted: `handleNewLocalTerminal` and the Settings
 * section were moved, while the toolbar kept hiding its shell picker on a server, kept
 * listing the INSTANCE's shells in the chevron, kept saying "New server terminal", and kept
 * probing nothing. The owner found it in two minutes of use.
 *
 * So the rule has one home and four callers, and `e2e/local-shell-source-check.mjs` holds
 * it — rather than four `isServerCtx` tests that have to be remembered together.
 */
export function instanceChoosesShell(i: Pick<ShellSourceInputs, 'runsHere' | 'serverContext'>) {
  return !i.runsHere && i.serverContext;
}

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
  // A browser against an instance: the instance's machine, so the instance's rules.
  // Anywhere else the shell runs here, so it is named here — a path the instance resolved
  // belongs to the instance's filesystem and would, at best, fall back to something else.
  if (instanceChoosesShell(i)) {
    const offered = i.asked && i.instanceOffers.includes(i.asked) ? i.asked : undefined;
    if (offered) return offered;
    // Nothing offered at all means the instance keeps the decision — say nothing rather
    // than echo a default back at it, so an administrator who changes it carries everyone.
    return i.instanceOffers.length > 0 ? i.instanceDefault : undefined;
  }

  return i.asked || i.localDefault;
}

/**
 * Which shell controls can exist at all — the buttons, and therefore their switches.
 *
 * A switch for a button that cannot appear is worse than a missing switch: it says you
 * have a choice. That reasoning was right, and it was applied with `isLocalContext`, which
 * stopped being the question once ADR 0031 made a desktop's shell its own. The switches
 * then vanished in a server context while the buttons they govern rendered — the opposite
 * of the rule they were written for.
 *
 * So the condition is answered once, here, and read by `Workspace.tsx` for the buttons and
 * `Settings.tsx` for the rows. Two files asking the same question in their own words is how
 * they came to disagree.
 */
export function shellControls(i: ShellSourceInputs | Pick<ShellSourceInputs, 'runsHere' | 'serverContext' | 'instanceOffers'>) {
  const theirs = instanceChoosesShell(i);
  return {
    /** The default-shell picker: this machine's choice, so only where the choice is ours. */
    picker: !theirs,
    /**
     * The per-terminal shell menu. Ours whenever the shell is ours; on an instance it
     * exists only where the instance offers more than one, and then the switch does too,
     * because there is a button to hide.
     */
    newTerminalMenu: !theirs || i.instanceOffers.length > 0,
  };
}
