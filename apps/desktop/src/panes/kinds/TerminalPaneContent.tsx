/**
 * The content of a terminal pane.
 *
 * Its own file, exporting nothing but the component, so Fast Refresh can replace it
 * on edit — a file that mixes components with other exports loses that.
 */

import type { PaneContentProps } from '../registry';
import type { TerminalPaneNode } from '../../types/pane';
import { Terminal } from '../../components/Terminal';

/**
 * The key is load-bearing rather than decoration: it is the session's identity, so a
 * pane handed a different session remounts instead of reusing a terminal that has
 * already been written to.
 */
export function TerminalPaneContent({ node, chrome }: PaneContentProps<TerminalPaneNode>) {
  return (
    <Terminal
      key={node.session.id}
      connectionId={node.session.connectionId}
      connectionName={node.session.connectionName}
      sessionId={node.session.id}
      isFocused={node.isFocused}
      onClose={chrome.onClose}
      onSplitHorizontal={chrome.onSplitHorizontal}
      onSplitVertical={chrome.onSplitVertical}
      onSplitWith={chrome.onSplitWith}
      initialCommand={node.session.initialCommand}
      note={node.session.note}
      onDetach={chrome.onDetach}
      onDragStart={chrome.onDragStart}
      onDragEnd={chrome.onDragEnd}
      onDragOver={chrome.onDragOver}
      onDrop={chrome.onDrop}
      isDragging={chrome.isDragging}
    />
  );
}
