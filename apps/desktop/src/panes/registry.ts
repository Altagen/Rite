/**
 * The pane kind registry
 *
 * A pane's surroundings — the focus ring, the drag-and-drop chrome, the drop zone
 * indicator, the recursion through splits — are the same whatever the pane shows.
 * What differs is the content and what it holds open. This is where the two meet, so
 * that `PaneContainer` renders a pane without knowing what kind it is, and closing a
 * tab releases what the panes held without knowing either.
 *
 * Adding a kind is: extend `LeafPaneNode` in ../types/pane, write the kind under
 * ./kinds, then add its entry to the record below. The record is keyed by the union's
 * own discriminant, so leaving the entry out is a compile error rather than a pane
 * that renders as nothing.
 */

import type { ComponentType } from 'react';
import type { LeafPaneNode } from '../types/pane';
import { disposePanes, type PaneDisposer } from './dispose';
import { terminalKind } from './kinds/terminal';

/**
 * What a pane's surroundings hand to its content.
 *
 * Every one of these is about the pane's place in the layout, not about what it
 * displays, which is why they are passed in rather than looked up: a kind that wants
 * a close button wires it to `onClose` and does not need to know what closing means.
 * Focus is not here — it is on the node, which the kind already has.
 */
export interface PaneChrome {
  /** True while *any* pane is being dragged — content disables pointer events. */
  isDragging: boolean;
  onClose: () => void;
  /** Absent when the kind cannot be split, so the content cannot offer the action. */
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onDetach?: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

export interface PaneContentProps<N extends LeafPaneNode = LeafPaneNode> {
  node: N;
  chrome: PaneChrome;
}

export interface PaneKind<N extends LeafPaneNode = LeafPaneNode> {
  /**
   * Can a pane of this kind be split in two?
   *
   * The one reader is `PaneContainer`, which withholds the split callbacks when this
   * is false — so a kind that says no cannot offer the action in the first place.
   */
  canSplit: boolean;
  /**
   * The pane's content.
   *
   * A component rather than a render function, for two reasons: a kind that needs
   * hooks gets its own place to put them, and `PaneContainer` hands the chrome over
   * as a prop instead of calling into it mid-render — the chrome closes over a ref,
   * and reading a ref during render is exactly what `react-hooks/refs` forbids.
   */
  Content: ComponentType<PaneContentProps<N>>;
  /**
   * What to call this pane where the layout has to name it.
   *
   * The one reader is detaching: a pane dragged out becomes a tab, and the tab needs
   * a name. Only the kind can produce one — for a terminal it is the connection's
   * name, and nothing outside the kind should be reaching into a node for it.
   */
  title: (node: N) => string;
  /**
   * Release what this pane holds. Omitted by a kind that holds nothing.
   *
   * Called as the pane leaves the tree, and allowed to fail: see ./dispose.
   */
  dispose?: (node: N) => Promise<void>;
}

const kinds: { [T in LeafPaneNode['type']]: PaneKind<Extract<LeafPaneNode, { type: T }>> } = {
  terminal: terminalKind,
};

/**
 * The kind for this node.
 *
 * One cast, in one place. The record is keyed by the node's own discriminant, so
 * `kinds[node.type]` is by construction the kind for exactly this node — but a kind's
 * parameters are contravariant, so TypeScript widens the lookup to a union of kinds
 * that nothing can be passed to. Asserting the correlation here once is what spares
 * every call site a `switch`, which is the branching this registry exists to remove.
 */
export function paneKind(node: LeafPaneNode): PaneKind<LeafPaneNode> {
  return kinds[node.type] as PaneKind<LeafPaneNode>;
}

/** Release what every one of these panes holds. See ./dispose for the semantics. */
export function disposeAllPanes(panes: readonly LeafPaneNode[]) {
  return disposePanes(panes, (node) => paneKind(node).dispose as PaneDisposer | undefined);
}
