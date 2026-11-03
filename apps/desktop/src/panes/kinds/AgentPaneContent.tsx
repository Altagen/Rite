/**
 * The content of an agent pane: a terminal, and a header that says what is in it.
 *
 * Its own file, exporting nothing but the component, so Fast Refresh can replace it
 * on edit — like the terminal's.
 */

import { useTranslation } from '../../i18n/i18n';
import type { PaneContentProps } from '../registry';
import type { AgentPaneNode } from '../../types/pane';
import { Terminal } from '../../components/Terminal';

/**
 * The one action that belongs to an agent and to nothing else: the conversation's id.
 *
 * It is here because the reader never typed it and never will — the adapter built the
 * resume line. Which means that the day Rite is not in front of them, the handle to
 * that conversation is somewhere they cannot reach, and a clipboard button is the
 * whole of the escape hatch. A clipboard icon and not a pencil: nothing is edited.
 */
function CopyIdButton({ id, label }: { id: string; label: string }) {
  return (
    <button
      type="button"
      data-testid="agent-copy-id"
      onClick={() => void navigator.clipboard?.writeText(id)}
      title={label}
      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 4h10a2 2 0 012 2v10M6 8h10a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2z"
        />
      </svg>
    </button>
  );
}

export function AgentPaneContent({ node, chrome }: PaneContentProps<AgentPaneNode>) {
  const { t } = useTranslation();
  const { agent, session } = node;
  // Where the agent is, then where it works. The machine first because that is the
  // question a fleet makes you ask; absent means this computer, which needs no name.
  const where = agent.machine
    ? t('agent.onMachine', { machine: agent.machine })
    : t('agent.onThisMachine');

  return (
    <Terminal
      key={session.id}
      connectionId={session.connectionId}
      connectionName={agent.project}
      sessionId={session.id}
      badge={agent.toolName}
      subtitle={agent.cwd ? `${where} · ${agent.cwd}` : where}
      leadActions={
        <CopyIdButton
          id={agent.conversationId}
          label={t('agent.copyId', { id: agent.conversationId })}
        />
      }
      isFocused={node.isFocused}
      onClose={chrome.onClose}
      onSplitHorizontal={chrome.onSplitHorizontal}
      onSplitVertical={chrome.onSplitVertical}
      onSplitWith={chrome.onSplitWith}
      note={session.note}
      onDetach={chrome.onDetach}
      onDragStart={chrome.onDragStart}
      onDragEnd={chrome.onDragEnd}
      onDragOver={chrome.onDragOver}
      onDrop={chrome.onDrop}
      isDragging={chrome.isDragging}
    />
  );
}
