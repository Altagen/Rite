/**
 * Releasing what panes hold, as they leave the tree.
 *
 * Deliberately free of React and of the registry itself: that keeps the module free
 * of runtime imports, which is what lets `e2e/pane-dispose-check.mjs` load it with
 * Node's type stripping and test the fan-out directly. The registry supplies the
 * lookup; this file owns only how the fan-out behaves.
 */

import type { LeafPaneNode } from '../types/pane';

export type PaneDisposer = (node: LeafPaneNode) => Promise<void>;

/** How the caller finds the disposer for a pane, if that kind holds anything at all. */
export type DisposerLookup = (node: LeafPaneNode) => PaneDisposer | undefined;

/**
 * Dispose every pane, whatever happens to any one of them.
 *
 * Closing a tab is not a transaction. A session the server has already forgotten
 * must not stop the others from being released, and the tab closes either way — so
 * every disposer is started, all of them are awaited, and a failure is reported back
 * rather than thrown. The caller decides what to say about the ones that refused.
 */
export async function disposePanes(
  panes: readonly LeafPaneNode[],
  lookup: DisposerLookup
): Promise<{ disposed: number; failed: { pane: LeafPaneNode; error: unknown }[] }> {
  const outcomes = await Promise.all(
    panes.map(async (pane) => {
      const dispose = lookup(pane);
      // A kind that holds nothing is not a failure; it simply has nothing to release.
      if (!dispose) return { pane, error: undefined, skipped: true };
      try {
        await dispose(pane);
        return { pane, error: undefined, skipped: false };
      } catch (error) {
        return { pane, error, skipped: false };
      }
    })
  );

  return {
    disposed: outcomes.filter((o) => !o.skipped && o.error === undefined).length,
    failed: outcomes
      .filter((o) => o.error !== undefined)
      .map(({ pane, error }) => ({ pane, error })),
  };
}
