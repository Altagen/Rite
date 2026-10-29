/**
 * Where a new tab's shell starts, and whose machine decides.
 *
 * `[terminal] newTabCwd` in the workspace document answers the first half (see
 * `store/layoutsFormat.ts`). This answers the second, which is the part that cannot be
 * read off the document: the document travels with the account, a browser reads the same
 * blob a desktop wrote, and a browser's local terminal is the INSTANCE's shell in the
 * instance's container (ADR 0031). A directory named on a desktop means nothing there, and
 * one named by a client would be choosing where a shared server spawns a shell.
 *
 * So the rule is: a client that runs its own shells honours the document, and a client that
 * does not sends nothing and lets the receiving end start where it would have. Nothing is
 * imposed on a browser and nothing is read there — an SSH session opened from a browser
 * lands on a machine whose paths this document never described.
 *
 * WHY THIS IS A FUNCTION AND NOT FOUR LINES IN `Workspace.tsx`. The discriminator is
 * `isNativeShell()`, a global the wry shell injects and no browser suite can see, so the
 * desktop arm of a rule written inline would ship untested — the same reason
 * `utils/localShellSource.ts` exists, and the same mistake its header records.
 *
 * Imports one module, which itself imports nothing, so `e2e/new-tab-cwd-check.mjs` can load
 * both through Node's type stripping.
 */
import { NEW_TAB_CWD_INHERIT } from '../store/layoutsFormat.ts';

export interface NewTabCwdInputs {
  /** `[terminal] newTabCwd`, or null when the document says nothing. */
  asked: string | null;
  /** This client runs the shell: the native desktop, whatever the active context. */
  runsHere: boolean;
  /** The session a new tab would inherit from — the active pane's, when there is one. */
  from?: string;
}

/**
 * What a new local terminal asks for. At most one field is set: a session to inherit from
 * and a directory to start in are two answers to one question, and a request carrying both
 * would leave the precedence to be agreed in two places.
 */
export interface NewTabCwdStart {
  /** A session whose shell's directory the new one opens in. Read on the server's side. */
  inheritCwdFrom?: string;
  /** A directory the client names: `home`, or an absolute path. */
  cwd?: string;
}

/** Nothing asked: the receiving end starts the shell where it would have. */
const WHEREVER: NewTabCwdStart = {};

export function newTabCwdStart(i: NewTabCwdInputs): NewTabCwdStart {
  // A browser: see the header. The document is read, the value is ignored, and the
  // container's shell starts where the server process stands — which is what it did
  // before this key existed.
  if (!i.runsHere) return WHEREVER;
  if (!i.asked) return WHEREVER;

  if (i.asked === NEW_TAB_CWD_INHERIT) {
    // No pane to inherit from is the first tab of a session, and there is nothing to
    // leave behind. Sending an unknown id instead would be refused as another account's.
    return i.from ? { inheritCwdFrom: i.from } : WHEREVER;
  }

  // `home` and an absolute path travel the same way, unchanged: the server resolves the
  // word and checks the path, because it is the side the shell starts on. The parser
  // already refused everything else, with a line number.
  return { cwd: i.asked };
}
