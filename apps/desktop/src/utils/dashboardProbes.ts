/**
 * May this client run the dashboard cards that reach out to a host (ADR 0019)?
 *
 * Two parties answer, and the most restrictive one wins: a "yes" is only ever a
 * permission, never an instruction. It takes both to let a request leave, and either
 * one is enough to stop it.
 *
 * Kept out of the component so the precedence can be tested as a table rather than
 * by mounting a dashboard and inferring the rule from what rendered.
 */

import { isNativeShell } from './nativeShell';
import type { DashboardPolicy, ServerMode } from './backend';

export type ProbeVerdict =
  | { allowed: true }
  /**
   * Blocked, and by whom — the dashboard says so rather than rendering an empty panel.
   * A server refusal also carries the shell it refused, because the two are not the same
   * statement: in a browser nothing runs at all, on a client the request simply isn't made.
   */
  | { allowed: false; by: 'server'; shell: 'webui' | 'clients' }
  | { allowed: false; by: 'you' };

export interface ProbeInputs {
  /** This server's mode, or null before it loads. A local vault has `accounts: false`. */
  mode: Pick<ServerMode, 'accounts'> & { dashboardPolicy?: DashboardPolicy } | null;
  /** The per-device preference (`displayPrefs.machineProbes`). */
  userWants: boolean;
  /** Override for tests; defaults to the real shell detection. */
  native?: boolean;
}

export function probeVerdict({ mode, userWants, native }: ProbeInputs): ProbeVerdict {
  const inDesktop = native ?? isNativeShell();

  // A standalone vault has no authority to consult: it is the user's vault, their
  // network, their machines. Only their own preference applies.
  const governed = mode?.accounts === true;
  if (governed) {
    const policy = mode?.dashboardPolicy;
    // Absent policy ⇒ allowed. A server that has never been configured has not said no,
    // and reading silence as a refusal would disable the feature on every older server.
    const serverAllows = (inDesktop ? policy?.clients : policy?.webui) ?? true;
    if (!serverAllows) return { allowed: false, by: 'server', shell: inDesktop ? 'clients' : 'webui' };
  }

  return userWants ? { allowed: true } : { allowed: false, by: 'you' };
}

/**
 * Why the cards are not there, as an i18n key rather than a sentence — this stays a pure
 * function, and the dashboard is translated like the rest of it.
 *
 * Three refusals, three different things to tell the reader: in the web UI nobody can
 * undo it, on a client the server asked and this client agreed, and their own switch is
 * one click away. A single "disabled" would flatten all three.
 */
export function probeBlockedReason(verdict: ProbeVerdict): string | null {
  if (verdict.allowed) return null;
  if (verdict.by === 'you') return 'dash.probesOffYou';
  return verdict.shell === 'webui' ? 'dash.probesOffWebui' : 'dash.probesOffClients';
}
