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
 * Why the cards are not there, in words the reader can act on. The server's refusal
 * is not something they can undo here; their own is one click away, so the two do not
 * get the same sentence.
 */
export function probeBlockedReason(verdict: ProbeVerdict): string | null {
  if (verdict.allowed) return null;
  if (verdict.by === 'you') return 'Container and service checks are off in your settings.';
  return verdict.shell === 'webui'
    // Enforcement: the browser cannot open SSH, so this server is the only thing that could
    // have run the command. There is nothing for the reader to turn back on.
    ? 'Your server turns off container and service checks in the web UI, so they run for nobody here.'
    // Policy: this client could probe from its own network, and honours the setting instead.
    : 'Your server turns off container and service checks for this client.';
}
