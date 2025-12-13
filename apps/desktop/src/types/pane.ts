/**
 * Pane Tree Data Model
 *
 * Defines the tree structure for split panes (multiplexer)
 */

import { TerminalSession } from '../components/TerminalManager';

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
