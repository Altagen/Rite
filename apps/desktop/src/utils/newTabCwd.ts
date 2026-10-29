/**
 * Where a new tab's shell starts.
 *
 * ONE VALUE, TWO STATES. `[terminal] newTabCwd` holds an absolute path and every new tab
 * starts there; it holds nothing and a new tab starts where the standing pane is, or in the
 * home directory when no pane stands. A split is unchanged — it has always followed the
 * pane it divides.
 *
 * A PATH IS THE ONLY THING A CLIENT NAMES, and only a client that runs its own shells names
 * it. A browser's local terminal is the instance's shell in the instance's container (ADR
 * 0031): a directory a desktop wrote means nothing there, and a client naming one would be
 * choosing where a shared server spawns a shell — `named_start_dir` in `rite-server`
 * refuses it unconditionally in accounts mode. Following the standing pane is not that: it
 * is one of the instance's own sessions, on the instance's own filesystem, which is what a
 * split already does there.
 *
 * `home` goes over the wire as the WORD. The client cannot know the home directory of the
 * machine the shell starts on, and that machine can. A browser asks for nothing instead:
 * the word would be refused in accounts mode, and the image starts its shells in
 * `/home/rite` anyway (`Containerfile.server`), so the answer is the same without a client
 * naming a directory.
 *
 * WHY THIS IS A FUNCTION AND NOT FOUR LINES IN `Workspace.tsx`. The discriminator is
 * `isNativeShell()`, a global the wry shell injects and no browser suite can see, so the
 * desktop arm of a rule written inline would ship untested — the same reason
 * `utils/localShellSource.ts` exists, and the same mistake its header records.
 *
 * Imports one module, which itself imports nothing, so `e2e/new-tab-cwd-check.mjs` can load
 * both through Node's type stripping.
 */
import { NEW_TAB_CWD_HOME } from '../store/layoutsFormat.ts';

export interface NewTabCwdInputs {
  /** `[terminal] newTabCwd` — an absolute path, or null when the document says nothing. */
  asked: string | null;
  /** This client runs the shell: the native desktop, whatever the active context. */
  runsHere: boolean;
  /** The session a new tab would follow — the standing pane's, when there is one. */
  from?: string;
}

/**
 * What a new local terminal asks for. At most one field is set: a session to follow and a
 * directory to start in are two answers to one question, and a request carrying both would
 * leave the precedence to be agreed in two places.
 */
export interface NewTabCwdStart {
  /** A session whose shell's directory the new one opens in. Read on the server's side. */
  inheritCwdFrom?: string;
  /** A directory the client names: `home`, or an absolute path. */
  cwd?: string;
}

/** Nothing asked: the receiving end starts the shell where it would have. */
const WHEREVER: NewTabCwdStart = {};

/**
 * Does this client's document govern where a new tab starts?
 *
 * Settings asks it before offering the path field, and `newTabCwdStart` below asks it
 * before applying one — one function rather than two readings of `runsHere`, so a field
 * that writes a value this client ignores cannot exist. A control for something that
 * cannot happen says there is a choice; `utils/localShellSource.ts` records what that cost
 * once already.
 */
export function newTabCwdApplies(i: Pick<NewTabCwdInputs, 'runsHere'>): boolean {
  return i.runsHere;
}

export function newTabCwdStart(i: NewTabCwdInputs): NewTabCwdStart {
  // The path, where there is one and this client is the machine it describes.
  if (newTabCwdApplies(i) && i.asked) return { cwd: i.asked };
  // Otherwise the standing pane, which is where a split would have gone.
  if (i.from) return { inheritCwdFrom: i.from };
  // And with no pane to follow — the first tab of a session — the home directory. A
  // browser asks for nothing: see the header.
  return newTabCwdApplies(i) ? { cwd: NEW_TAB_CWD_HOME } : WHEREVER;
}
