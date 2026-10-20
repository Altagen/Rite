/**
 * Pane Tree Utilities
 *
 * Helper functions for manipulating the pane tree structure
 */

import type {
  AnyPaneNode,
  LeafPaneNode,
  TerminalPaneNode,
  SplitPaneNode,
  SplitDirection,
  LayoutTree,
  TerminalSession,
} from '../types/pane';

/**
 * Generate unique ID using browser crypto API
 */
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Is this node content, rather than a container of other panes?
 *
 * Deliberately `!== 'split'` rather than `=== 'terminal'`. Almost everything in
 * this file is about the shape of the tree — which node is where, which one has
 * focus, what collapses when one closes — and none of it depends on what a pane
 * displays. The two were the same question only while terminal was the only kind.
 *
 * Asked this way, a kind added to `LeafPaneNode` is handled by every traversal
 * below without a further change. The three functions that genuinely are about
 * terminals (`getAllSessions`, `getSessionsInPane`, `updateSession`) narrow on
 * `type` *after* this guard, so when a second kind arrives the compiler points at
 * them and at nothing else.
 */
export function isLeaf(node: AnyPaneNode): node is LeafPaneNode {
  return node.type !== 'split';
}

/**
 * Create a terminal pane node
 */
export function createTerminalPane(session: TerminalSession, isFocused = false): TerminalPaneNode {
  return {
    id: generateId(),
    type: 'terminal',
    session,
    isFocused,
  };
}

/**
 * Create a split pane node
 */
export function createSplitPane(
  direction: SplitDirection,
  left: AnyPaneNode,
  right: AnyPaneNode,
  ratio = 0.5,
): SplitPaneNode {
  return {
    id: generateId(),
    type: 'split',
    direction,
    ratio,
    children: [left, right],
  };
}

/**
 * Find a pane node by ID in the tree
 */
export function findPaneById(tree: LayoutTree, id: string): AnyPaneNode | null {
  if (!tree) return null;
  if (tree.id === id) return tree;

  if (tree.type === 'split') {
    const leftResult = findPaneById(tree.children[0], id);
    if (leftResult) return leftResult;

    const rightResult = findPaneById(tree.children[1], id);
    if (rightResult) return rightResult;
  }

  return null;
}

/**
 * Find the parent of a pane node
 */
export function findParent(tree: LayoutTree, childId: string): SplitPaneNode | null {
  if (!tree || isLeaf(tree)) return null;

  if (tree.children[0].id === childId || tree.children[1].id === childId) {
    return tree;
  }

  const leftResult = findParent(tree.children[0], childId);
  if (leftResult) return leftResult;

  const rightResult = findParent(tree.children[1], childId);
  return rightResult;
}

/**
 * Which side the new pane takes, and how much of the area it gets.
 *
 * Both default to what a chevron split does — beside or below, half and half — so the
 * menu calls this function with nothing extra. A layout file is the caller that needs
 * them: `split = "left"` and `size = "45%"` have no other way through (ADR 0023).
 */
export interface SplitOptions {
  /** The new pane takes the left or top side instead of the right or bottom one. */
  before?: boolean;
  /** The FIRST child's share of the area, 0.1–0.9. A planner states it from that end
   *  because that is what the tree stores and what `SplitPane` lays out. */
  ratio?: number;
}

/**
 * Split a pane in the specified direction, putting a new terminal beside it
 *
 * The pane being split can be of any kind — splitting an SFTP or agent pane is the
 * same tree operation. What lands next to it is a terminal, which is why this takes
 * a session; opening another kind beside a pane is the registry's job, not this
 * function's.
 */
export function splitPane(
  tree: LayoutTree,
  paneId: string,
  direction: SplitDirection,
  newSession: TerminalSession,
  options: SplitOptions = {},
): LayoutTree {
  if (!tree) return null;

  if (tree.id === paneId && isLeaf(tree)) {
    // Found the pane to split - replace it with a split container
    const existingPane: LeafPaneNode = { ...tree, isFocused: false };
    const newPane = createTerminalPane(newSession, true); // New pane gets focus

    // Out-of-range ratios are refused at the file's edge with a line number; anything
    // that reaches here is clamped to what the drag handle allows rather than laying
    // out a pane nobody can see.
    const ratio = Math.max(0.1, Math.min(0.9, options.ratio ?? 0.5));
    return options.before
      ? createSplitPane(direction, newPane, existingPane, ratio)
      : createSplitPane(direction, existingPane, newPane, ratio);
  }

  if (tree.type === 'split') {
    // Recursively search in children
    const newLeft = splitPane(tree.children[0], paneId, direction, newSession, options);
    const newRight = splitPane(tree.children[1], paneId, direction, newSession, options);

    return {
      ...tree,
      children: [newLeft || tree.children[0], newRight || tree.children[1]],
    };
  }

  return tree;
}

/**
 * Close a pane and remove it from the tree
 * Returns the updated tree, or null if the tree is now empty
 */
export function closePane(tree: LayoutTree, paneId: string): LayoutTree {
  if (!tree) return null;

  // If this is the only pane, return null (empty tree)
  if (tree.id === paneId && isLeaf(tree)) {
    return null;
  }

  // If this is a split node, check if one of the children is being closed
  if (tree.type === 'split') {
    const [left, right] = tree.children;

    // If left child is being closed, replace split with right child
    if (left.id === paneId) {
      return right;
    }

    // If right child is being closed, replace split with left child
    if (right.id === paneId) {
      return left;
    }

    // Otherwise, recursively close in children
    const newLeft = closePane(left, paneId);
    const newRight = closePane(right, paneId);

    // If one child became null, collapse the split
    if (!newLeft) return newRight;
    if (!newRight) return newLeft;

    return {
      ...tree,
      children: [newLeft, newRight],
    };
  }

  return tree;
}

/**
 * Update focus state in the tree
 */
export function setFocusedPane(tree: LayoutTree, paneId: string): LayoutTree {
  if (!tree) return null;

  if (isLeaf(tree)) {
    return {
      ...tree,
      isFocused: tree.id === paneId,
    };
  }

  return {
    ...tree,
    children: [
      setFocusedPane(tree.children[0], paneId),
      setFocusedPane(tree.children[1], paneId),
    ] as [AnyPaneNode, AnyPaneNode],
  };
}

/**
 * Get the currently focused pane
 */
export function getFocusedPane(tree: LayoutTree): LeafPaneNode | null {
  if (!tree) return null;

  if (isLeaf(tree)) {
    return tree.isFocused ? tree : null;
  }

  const leftResult = getFocusedPane(tree.children[0]);
  if (leftResult) return leftResult;

  const rightResult = getFocusedPane(tree.children[1]);
  return rightResult;
}

/**
 * Get the first leaf pane (for auto-focus when switching tabs)
 */
export function getFirstLeafPane(tree: LayoutTree): LeafPaneNode | null {
  if (!tree) return null;

  if (isLeaf(tree)) {
    return tree;
  }

  // Try left child first
  const leftResult = getFirstLeafPane(tree.children[0]);
  if (leftResult) return leftResult;

  // Then try right child
  const rightResult = getFirstLeafPane(tree.children[1]);
  return rightResult;
}

/**
 * Get all terminal sessions from the tree (flat list)
 *
 * Terminal-specific by design: a leaf of another kind has no session, and
 * contributing nothing is the right answer rather than an error. The callers are
 * about terminals — closing a tab disposes the sessions it held.
 */
export function getAllSessions(tree: LayoutTree): TerminalSession[] {
  if (!tree) return [];

  if (isLeaf(tree)) {
    return tree.type === 'terminal' ? [tree.session] : [];
  }

  return [...getAllSessions(tree.children[0]), ...getAllSessions(tree.children[1])];
}

/**
 * Get all sessions within a specific pane (including sub-panes if it's a split)
 */
export function getSessionsInPane(tree: LayoutTree, paneId: string): TerminalSession[] {
  if (!tree) return [];

  // If this is the pane we're looking for, return all sessions in it
  if (tree.id === paneId) {
    return getAllSessions(tree);
  }

  // Otherwise, search in children
  if (tree.type === 'split') {
    const leftResult = getSessionsInPane(tree.children[0], paneId);
    if (leftResult.length > 0) return leftResult;

    const rightResult = getSessionsInPane(tree.children[1], paneId);
    return rightResult;
  }

  return [];
}

/**
 * Get all leaf panes from the tree (flat list)
 */
export function getAllPanes(tree: LayoutTree): LeafPaneNode[] {
  if (!tree) return [];

  if (isLeaf(tree)) {
    return [tree];
  }

  return [...getAllPanes(tree.children[0]), ...getAllPanes(tree.children[1])];
}

/**
 * Update split ratio for a split pane
 */
export function updateSplitRatio(tree: LayoutTree, splitId: string, newRatio: number): LayoutTree {
  if (!tree) return null;

  if (tree.id === splitId && tree.type === 'split') {
    return {
      ...tree,
      ratio: Math.max(0.1, Math.min(0.9, newRatio)), // Clamp between 0.1 and 0.9
    };
  }

  if (tree.type === 'split') {
    return {
      ...tree,
      children: [
        updateSplitRatio(tree.children[0], splitId, newRatio),
        updateSplitRatio(tree.children[1], splitId, newRatio),
      ] as [AnyPaneNode, AnyPaneNode],
    };
  }

  return tree;
}

/**
 * Replace a session in the tree (used when updating session data)
 *
 * Terminal-specific, like getAllSessions: a leaf of another kind holds no session
 * to update and is returned untouched.
 */
export function updateSession(
  tree: LayoutTree,
  sessionId: string,
  updater: (session: TerminalSession) => TerminalSession,
): LayoutTree {
  if (!tree) return null;

  if (isLeaf(tree)) {
    if (tree.type === 'terminal' && tree.session.id === sessionId) {
      return {
        ...tree,
        session: updater(tree.session),
      };
    }
    return tree;
  }

  return {
    ...tree,
    children: [
      updateSession(tree.children[0], sessionId, updater),
      updateSession(tree.children[1], sessionId, updater),
    ] as [AnyPaneNode, AnyPaneNode],
  };
}

/**
 * Extract a pane from the tree and return both the extracted pane and the updated tree
 * This is used for detaching a pane to create a new tab group
 */
export function extractPane(
  tree: LayoutTree,
  paneId: string,
): { extractedPane: LeafPaneNode | null; remainingTree: LayoutTree } {
  if (!tree) {
    return { extractedPane: null, remainingTree: null };
  }

  // If this is the pane we want to extract
  if (tree.id === paneId && isLeaf(tree)) {
    return { extractedPane: tree, remainingTree: null };
  }

  // If this is a split node, check children
  if (tree.type === 'split') {
    const [left, right] = tree.children;

    // Check if left child is the target pane
    if (left.id === paneId && isLeaf(left)) {
      return { extractedPane: left, remainingTree: right };
    }

    // Check if right child is the target pane
    if (right.id === paneId && isLeaf(right)) {
      return { extractedPane: right, remainingTree: left };
    }

    // Recursively search in left subtree
    const leftResult = extractPane(left, paneId);
    if (leftResult.extractedPane) {
      // If we found it in left, keep right and update left
      if (!leftResult.remainingTree) {
        // Left became empty, just return right
        return { extractedPane: leftResult.extractedPane, remainingTree: right };
      }
      // Reconstruct the split with updated left
      return {
        extractedPane: leftResult.extractedPane,
        remainingTree: {
          ...tree,
          children: [leftResult.remainingTree, right],
        },
      };
    }

    // Recursively search in right subtree
    const rightResult = extractPane(right, paneId);
    if (rightResult.extractedPane) {
      // If we found it in right, keep left and update right
      if (!rightResult.remainingTree) {
        // Right became empty, just return left
        return { extractedPane: rightResult.extractedPane, remainingTree: left };
      }
      // Reconstruct the split with updated right
      return {
        extractedPane: rightResult.extractedPane,
        remainingTree: {
          ...tree,
          children: [left, rightResult.remainingTree],
        },
      };
    }
  }

  return { extractedPane: null, remainingTree: tree };
}

/**
 * Reorganize panes by moving a source pane to a specific edge of a target pane
 *
 * @param tree - The current pane tree
 * @param sourcePaneId - The pane being moved
 * @param targetPaneId - The pane we're dropping onto
 * @param position - Which edge to drop on ('top', 'bottom', 'left', 'right')
 * @returns The reorganized tree
 */
export function reorganizePane(
  tree: LayoutTree,
  sourcePaneId: string,
  targetPaneId: string,
  position: 'top' | 'bottom' | 'left' | 'right',
): LayoutTree {
  if (!tree || sourcePaneId === targetPaneId) return tree;

  // First, extract the source pane from the tree
  const { extractedPane, remainingTree } = extractPane(tree, sourcePaneId);
  if (!extractedPane) return tree;

  // Helper to find and replace the target pane with a new split
  function replaceTargetPane(node: LayoutTree): LayoutTree {
    if (!node) return null;

    if (node.id === targetPaneId && isLeaf(node)) {
      // Found the target pane - create a split with source and target
      const direction = position === 'left' || position === 'right' ? 'horizontal' : 'vertical';
      const ratio = 0.5;

      // Determine order based on position (extractedPane is guaranteed non-null by the guard above)
      const children: [AnyPaneNode, AnyPaneNode] =
        position === 'left' || position === 'top'
          ? [extractedPane!, node] // Source on left/top
          : [node, extractedPane!]; // Source on right/bottom

      return createSplitPane(direction, children[0], children[1], ratio);
    }

    if (node.type === 'split') {
      return {
        ...node,
        children: [replaceTargetPane(node.children[0]), replaceTargetPane(node.children[1])] as [
          AnyPaneNode,
          AnyPaneNode,
        ],
      };
    }

    return node;
  }

  // Apply the reorganization to the remaining tree
  return replaceTargetPane(remainingTree);
}
