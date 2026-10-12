/**
 * The terminal pane kind: what it can do, what it shows, and what it holds open.
 */

import type { PaneKind } from '../registry';
import type { TerminalPaneNode } from '../../types/pane';
import { Backend } from '../../utils/backend';
import { TerminalPaneContent } from './TerminalPaneContent';

export const terminalKind: PaneKind<TerminalPaneNode> = {
  canSplit: true,
  Content: TerminalPaneContent,
  title: (node) => node.session.connectionName,
  dispose: async (node) => {
    await Backend.Terminal.disconnectTerminal(node.session.id);
  },
};
