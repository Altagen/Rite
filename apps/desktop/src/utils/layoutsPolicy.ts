/**
 * Where this window reads its layouts from, and whether it reads them at all (ADR 0027).
 *
 * Three parties answer, most restrictive first: the instance says whether the feature
 * exists and in which shell, the reader says whether they want it, and — in a server
 * context only — this machine says which support to use. A local vault has no instance to
 * ask and no second support, so the file is the answer there and the question is moot.
 *
 * Pure, and importing nothing at runtime, so `e2e/layouts-source-check.mjs` loads this
 * module as it ships and holds the precedence to a table. That is why `native` is a
 * parameter rather than a call to `isNativeShell()`: the caller knows which shell it is in,
 * and a check does not need a window to say so.
 */

import type { LayoutsPolicy, ServerMode } from './backend';

/** The file on this machine, or the sealed blob on the account. */
export type LayoutsSupport = 'file' | 'account';

export type LayoutsVerdict =
  | { allowed: true; support: LayoutsSupport }
  /** Refused by the instance, naming the shell it refused: the two are not one statement. */
  | { allowed: false; by: 'server'; shell: 'webui' | 'clients' }
  | { allowed: false; by: 'you' };

export interface LayoutsInputs {
  /** This server's mode, or null before it loads. A local vault has `accounts: false`. */
  mode: (Pick<ServerMode, 'accounts'> & { layoutsPolicy?: LayoutsPolicy }) | null;
  /** The reader's own switch (gate 2). */
  userWants: boolean;
  /** This machine's choice of support (gate 3). Only consulted in a server context. */
  prefer: LayoutsSupport;
  /** Is this the desktop shell? `isNativeShell()` at every call site but a check's. */
  native: boolean;
}

export function layoutsVerdict({ mode, userWants, prefer, native }: LayoutsInputs): LayoutsVerdict {
  const inDesktop = native;
  const governed = mode?.accounts === true;

  if (governed) {
    const policy = mode?.layoutsPolicy;
    // Absent policy ⇒ allowed, as for every other governed setting: a server that has
    // never been configured has not said no.
    const serverAllows = (inDesktop ? policy?.clients : policy?.webui) ?? true;
    if (!serverAllows) {
      return { allowed: false, by: 'server', shell: inDesktop ? 'clients' : 'webui' };
    }
  }

  if (!userWants) return { allowed: false, by: 'you' };

  // A local vault is the file, always: there is no account to seal a blob under. A browser
  // is the blob, always: there is no filesystem to read. Only a desktop window signed into
  // a server has both, and only there does the machine's preference mean anything.
  if (!governed) return { allowed: true, support: 'file' };
  if (!inDesktop) return { allowed: true, support: 'account' };
  return { allowed: true, support: prefer };
}

/** Why the editor is not there, as an i18n key — the keys mirror the dashboard's three. */
export function layoutsBlockedReason(verdict: LayoutsVerdict): string | null {
  if (verdict.allowed) return null;
  if (verdict.by === 'you') return 'layouts.offYou';
  return verdict.shell === 'webui' ? 'layouts.offWebui' : 'layouts.offClients';
}
