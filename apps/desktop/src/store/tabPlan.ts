/**
 * Reading a live pane tree back into the plan that would rebuild it.
 *
 * WHY THIS EXISTS. Duplicating a tab cannot copy its panes: each one holds a live
 * session, and an SSH connection is not a value you can clone. What a duplicate means is
 * "the same arrangement, against the same targets, with fresh sessions" — which is exactly
 * what `handleApplyLayout` already does from a `TabPlan`. So the only missing piece is the
 * direction nobody had needed yet: tree → plan. Going that way means duplicate reuses the
 * opener that layouts have been exercising all along, instead of a second tree-walker that
 * would drift from it.
 *
 * It is also most of a second roadmap item — "save the current arrangement as a layout",
 * which has the same missing step. That one needs plan → file as well, and this is the
 * half that was hard.
 *
 * ORDER IS THE WHOLE PROBLEM. `splitPane` cuts an EXISTING pane, so a step can only run
 * once its anchor is on screen. A depth-first walk that emitted each subtree completely
 * would try to split panes that do not exist yet. So each node emits its own cut first and
 * recurses after: the top-level cut, then what happens inside each side.
 *
 * WHAT IS DELIBERATELY NOT PRESERVED. Focus, pane ids, and anything a session accumulated
 * — scrollback, a running job, a shell's history. A duplicate is a fresh pair of terminals
 * arranged alike, and pretending otherwise by carrying an id would make two panes claim
 * one session.
 *
 * Imports nothing at runtime, so `e2e/tab-plan-check.mjs` can load it with Node's type
 * stripping — the same reason `commands.ts` and `palette.ts` import nothing.
 */
import type { AnyPaneNode, TerminalSession } from '../types/pane';
import type { LayoutPane, SplitStep, TabPlan } from './layoutsFormat';

/** The connection id a local shell carries, as `Workspace.localSession` mints it. */
const LOCAL = 'local';

/** True for a node that holds content rather than other panes. */
const isLeaf = (node: AnyPaneNode): node is Extract<AnyPaneNode, { type: 'terminal' }> =>
  node.type === 'terminal';

/**
 * What one live pane asks for, as a plan pane.
 *
 * `machine` is a NAME, because that is what a plan names and what the opener resolves
 * against this computer's library — so a duplicate inherits the same "machine not found"
 * fallback a layout gets, rather than a second answer to the same question. A local shell
 * names no machine.
 *
 * `command` is empty on purpose. A session's `initialCommand` already ran, in the pane
 * being duplicated; replaying it would re-run a deploy, a `rm`, or whatever the preset
 * was, which is not what copying an arrangement means.
 */
function paneFor(session: TerminalSession): LayoutPane {
  const machine = session.connectionId === LOCAL ? undefined : session.connectionName.trim();
  return machine ? { machine, command: '' } : { command: '' };
}

/** The first leaf a walk of this subtree reaches: the pane that holds its area. */
function firstLeaf(node: AnyPaneNode): TerminalSession {
  let at = node;
  while (!isLeaf(at)) at = at.children[0];
  return at.session;
}

/**
 * The plan that would rebuild `tree`, with `tabName` as the tab it opens.
 *
 * Pure: no DOM, no sessions opened, no ids minted. Hand the result to the same opener a
 * layout uses.
 */
export function planFromTree(tree: AnyPaneNode, tabName: string | null): TabPlan {
  const panes: LayoutPane[] = [paneFor(firstLeaf(tree))];
  const steps: SplitStep[] = [];

  /** `node`'s area is currently held by `panes[anchor]`. */
  const walk = (node: AnyPaneNode, anchor: number): void => {
    if (isLeaf(node)) return;
    // The second child is the pane being added; the first keeps the anchor's place, which
    // is what `before: false` says. A finished tree cannot tell which side was cut out of
    // which — the two are symmetric — so this picks one consistently and the geometry
    // comes out the same either way.
    const added = panes.length;
    panes.push(paneFor(firstLeaf(node.children[1])));
    steps.push({
      pane: added,
      anchor,
      direction: node.direction,
      before: false,
      ratio: node.ratio,
    });
    // This cut first, then what happens inside each side: a step cannot anchor to a pane
    // that is not on screen yet.
    walk(node.children[0], anchor);
    walk(node.children[1], added);
  };

  walk(tree, 0);
  return { tab: tabName, panes, steps };
}
