/**
 * The agent pane kind: a resumed conversation, in a terminal of its own.
 *
 * `canSplit` is true and that is the point of registering it rather than building a
 * view: an agent splits with plain terminals in the same tab, so a `top` or a
 * `watch docker ps` sits beside the agent that is causing them, on the same machine.
 *
 * `initialCommand` is deliberately not passed. The resume line is the program the
 * channel runs (ADR 0022 §7.1), named when the session is created — typing it into a
 * shell afterwards is what that section forbids, because a shell discards queued
 * input while it sets the tty up.
 */

import type { PaneKind } from '../registry';
import type { AgentPaneNode } from '../../types/pane';
import { Backend } from '../../utils/backend';
import { AgentPaneContent } from './AgentPaneContent';

export const agentKind: PaneKind<AgentPaneNode> = {
  canSplit: true,
  Content: AgentPaneContent,
  // The project, not the tool: a tab reading "Claude Code" three times names nothing,
  // and the conversation is about the project.
  title: (node) => node.agent.project,
  // The same release as a terminal's, because it is the same thing underneath: one
  // SSH channel. Closing the pane ends the agent, which is what closing it means.
  dispose: async (node) => {
    await Backend.Terminal.disconnectTerminal(node.session.id);
  },
};
