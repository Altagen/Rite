/**
 * What each machine answered the last time it was asked (ADR 0022 §4).
 *
 * WHY THIS IS KEPT AT ALL. Discovery costs an SSH round trip, so it is asked for
 * explicitly and never repeated by itself — which means that without this, closing the
 * window threw the answer away and the next one started at "has not been probed". It did:
 * reinstalling the binary lost a reading that had cost a connection to every machine.
 *
 * A CACHE, NOT A RECORD, and the difference is on screen: every answer carries the time
 * this client read it, the manager shows that time, and "Read again" is one button. What
 * is stored is never presented as current.
 *
 * ON THE DEVICE, like the toolbar and the splits library — not in the workspace document.
 * A document is exported and imported between machines; a listing of one machine's home
 * directory is not configuration and has no business travelling with one. It also keeps
 * hundreds of paths out of a file a person reads.
 *
 * CAPPED, because it holds the listings themselves: roughly 40 KB for a machine with
 * sixty conversations, so eight machines is the ceiling and the least recently read is
 * the one that goes. A fleet of forty is a cache that is not worth what it costs.
 */

// With the extension, like `agentAdapters.ts`: `e2e/agent-answers-check.mjs` loads this
// module directly under Node, which does not resolve an extensionless specifier.
import { deviceStore } from '../utils/deviceStore.ts';
import type { ProbedTool } from '../utils/agentProbe';

/** One machine's answer, with when this client read it. */
export interface Answer {
  at: number;
  tools: ProbedTool[];
}

const KEY = 'rite-agent-answers';

/** How many machines' answers are worth keeping. See the note above. */
export const ANSWER_CAP = 8;

/** Only what we wrote, and only the shape we wrote: anything else in storage is ignored. */
function accepted(stored: unknown): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const [machine, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as { at?: unknown; tools?: unknown };
    if (typeof v.at !== 'number' || !Array.isArray(v.tools)) continue;
    out[machine] = { at: v.at, tools: v.tools as ProbedTool[] };
  }
  return out;
}

export function readAnswers(): Record<string, Answer> {
  try {
    return accepted(JSON.parse(deviceStore.getItem(KEY) ?? 'null'));
  } catch {
    return {};
  }
}

/**
 * Keep one machine's answer, dropping the least recently read once past the cap.
 *
 * Returns what is now held, so a caller does not have to read back what it just wrote.
 */
export function keepAnswer(
  machine: string,
  answer: Answer,
  held: Record<string, Answer> = readAnswers(),
): Record<string, Answer> {
  const next: Record<string, Answer> = { ...held, [machine]: answer };
  const byAge = Object.entries(next).sort((a, b) => b[1].at - a[1].at);
  const kept = Object.fromEntries(byAge.slice(0, ANSWER_CAP));
  try {
    deviceStore.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Storage full, or a browser that refuses it. The answer still stands for this
    // session; what is lost is only the convenience of it surviving the window.
  }
  return kept;
}

/** Forget one machine's answer, or every one of them. */
export function forgetAnswers(machine?: string): Record<string, Answer> {
  const kept = machine ? { ...readAnswers() } : {};
  if (machine) delete kept[machine];
  try {
    deviceStore.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* see keepAnswer */
  }
  return kept;
}
