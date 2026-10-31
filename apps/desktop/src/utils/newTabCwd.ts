/**
 * Where a new tab's shell starts.
 *
 * ONE VALUE, TWO STATES. `[terminal] newTabCwd` holds an absolute path and every new tab
 * starts there; it holds nothing and a new tab starts where the standing pane is, or in the
 * home directory when no pane stands. A split is unchanged — it has always followed the
 * pane it divides.
 *
 * A BROWSER ASKS FOR NOTHING AT ALL, whatever the document says and whatever pane stands.
 * Its local terminal is the instance's shell in the instance's container (ADR 0031), so a
 * new tab there opens where the image starts a shell — `/home/rite`, from
 * `Containerfile.server` — every time. A path a desktop wrote means nothing on that
 * filesystem, a client naming one would be choosing where a shared server spawns a shell
 * (`named_start_dir` refuses it unconditionally in accounts mode), and inheriting is not
 * wanted either: the base shell directory, always. A SPLIT still follows the pane it
 * divides, in both UIs — that is the gesture's own meaning and not this setting.
 *
 * `home` goes over the wire as the WORD, from a desktop only. The client cannot know the
 * home directory of the machine the shell starts on, and that machine can.
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
  // A browser: nothing, ever. See the header — the instance's shell starts where the image
  // starts a shell, and that is the whole answer there.
  if (!newTabCwdApplies(i)) return WHEREVER;
  // The path, where the document names one.
  if (i.asked) return { cwd: i.asked };
  // Otherwise the standing pane, which is where a split would have gone.
  if (i.from) return { inheritCwdFrom: i.from };
  // And with no pane to follow — the first tab of a session — the home directory.
  return { cwd: NEW_TAB_CWD_HOME };
}
