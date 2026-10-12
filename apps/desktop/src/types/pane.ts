/**
 * Pane Tree Data Model
 *
 * Defines the tree structure for split panes (multiplexer)
 */

/**
 * A terminal session's identity. Defined here rather than in TerminalManager so a
 * pure utility like paneTree does not have to import from a React component to
 * describe a data shape — and so the module stays free of runtime imports, which
 * is what lets `e2e/pane-tree-check.mjs` load it with Node's type stripping.
 */
export interface TerminalSession {
  id: string;
  connectionId: string;
  connectionName: string;
}

export type SplitDirection = 'horizontal' | 'vertical';

/**
 * Terminal leaf node - contains actual terminal session
 */
export interface TerminalPaneNode {
  id: string;
  type: 'terminal';
  session: TerminalSession;
  isFocused?: boolean;
}

/**
 * Split container node - contains two child panes (recursive structure)
 */
export interface SplitPaneNode {
  id: string;
  type: 'split';
  direction: SplitDirection;
  ratio: number; // 0.0 to 1.0 - position of divider
  children: [AnyPaneNode, AnyPaneNode]; // Always exactly two children
}

/**
 * Union type for any pane node
 */
export type AnyPaneNode = TerminalPaneNode | SplitPaneNode;

/**
 * Base node type (for backward compatibility)
 */
export type PaneNode = AnyPaneNode;

/**
 * Root layout tree (for a single tab)
 */
export type LayoutTree = AnyPaneNode | null;

/**
 * Tab - contains a pane tree (can be a single terminal or split panes)
 */
export interface Tab {
  id: string;
  name: string;
  paneTree: LayoutTree;
}
