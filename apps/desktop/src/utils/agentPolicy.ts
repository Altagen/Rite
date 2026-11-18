/**
 * May this client ask a machine what agent conversations it holds (ADR 0022 §3)?
 *
 * The server half is enforced on the routes — a browser that ignores its own gate is
 * still refused, because the server is the thing that would run the command. This is the
 * other half: not asking at all, so a refused screen says why instead of showing a 403.
 *
 * Kept out of the component, like `dashboardProbes.ts`, so the precedence is a table
 * rather than something inferred from what rendered. Two differences from that one, both
 * from ADR 0022:
 *
 *   - NO USER PREFERENCE. Discovery is explicit — a person picks a machine and asks — so
 *     there is nothing periodic to switch off. The Tools dialog's per-adapter switch is a
 *     third thing again: it stops Rite LOOKING for one tool, and using it to tidy a
 *     screen would silently stop discovery.
 *   - NO FLOOR. `agentPolicy` has two keys and no `minInterval`, for the same reason.
 *
 * RUNNING an agent is not governed, and this does not pretend to govern it: anyone who
 * can open a terminal pane on a machine can type `claude --resume` there themselves.
 * What the policy decides is whether RITE generates that traffic and reads those files on
 * the user's behalf, which is a product decision an administrator can legitimately make.
 */

import type { AgentPolicy, ServerMode } from './backend';

export type AgentVerdict =
  | { allowed: true }
  /**
   * Refused, and by which shell — the two are not the same statement. In a browser
   * nothing runs for anybody here; on a client the request is simply never made.
   */
  | { allowed: false; shell: 'webui' | 'clients' };

export interface AgentPolicyInputs {
  /** This server's mode, or null before it loads. A local vault has `accounts: false`. */
  mode: (Pick<ServerMode, 'accounts'> & { agentPolicy?: AgentPolicy }) | null;
  /**
   * Whether this is the desktop client, which decides WHICH half of the policy applies.
   *
   * Passed in rather than detected here, unlike `dashboardProbes.ts`: detecting it means
   * importing `nativeShell`, which imports the whole backend module, and this file is
   * loaded directly by a standalone check so the precedence can be held as a table. A
   * pure decision with no imports is also the shape `planClipboard` and `plan_vault_command`
   * already have.
   */
  native: boolean;
}

export function agentVerdict({ mode, native }: AgentPolicyInputs): AgentVerdict {
  // A standalone vault has no authority to consult: the user's vault, their network,
  // their machines.
  if (mode?.accounts !== true) return { allowed: true };
  const inDesktop = native;
  // Absent policy ⇒ allowed. A server that has never been configured has not said no,
  // and reading silence as a refusal would disable a shipped feature on upgrade.
  const allows = (inDesktop ? mode.agentPolicy?.clients : mode.agentPolicy?.webui) ?? true;
  return allows ? { allowed: true } : { allowed: false, shell: inDesktop ? 'clients' : 'webui' };
}

/**
 * Why discovery is not there, as an i18n key rather than a sentence — this stays a pure
 * function and the manager is translated like the rest of the interface.
 */
export function agentBlockedReason(verdict: AgentVerdict): string | null {
  if (verdict.allowed) return null;
  return verdict.shell === 'webui' ? 'agent.offWebui' : 'agent.offClients';
}
