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
/**
 * What a split should open, beyond "a plain terminal".
 *
 * One shape for the chevron's presets, a snippet, and one pane of a layout, because
 * from the splitter's side they are the same request: a name to show, a command to
 * run, and — layouts only — the machine to run it on. Widening this one type is what
 * gave layouts their machines without a new callback threaded through every pane.
 */
export interface SplitTarget {
  /** Shown in the pane header. Absent ⇒ the usual local-terminal name. */
  name?: string;
  /** Typed into the new pane once it is ready. Empty ⇒ a plain shell. */
  command: string;
  /** A machine from the library, by name (layouts). Absent ⇒ this computer. */
  machine?: string;
}

export interface TerminalSession {
  id: string;
  connectionId: string;
  connectionName: string;
  /**
   * Why this pane is not what was asked for.
   *
   * A layout names a machine and this computer may not have it — renamed, a locked
   * vault, a file from another computer. The pane still opens, as a plain shell, and
   * this is the only thing on screen that would ever say so, so it travels with the
   * session rather than being toasted once and lost.
   */
  note?: string;
  /**
   * A command to run once, as soon as this session is ready to read one.
   *
   * It lives on the session rather than being sent by whoever opened it, because
   * only the pane knows when "ready" happened: the backend buffers a session's first
   * output and switches to streaming only when the pane claims that buffer, so there
   * is no event for an outsider to wait on — and a shell discards queued input while
   * it sets the tty up, which turns "a bit early" into "silently never ran".
   */
  initialCommand?: string;
}

export type SplitDirection = 'horizontal' | 'vertical';

/**
 * What every node in the tree has, whatever it is
 */
interface PaneNodeBase {
  id: string;
}

/**
 * What every *leaf* kind has in common.
 *
 * Focus lives here rather than on the terminal node because focus belongs to the
 * layout, not to what a pane contains: the tree has to be able to move it onto an
 * SFTP or agent pane without knowing what either of those is. A split is never
 * focused — focus always lands on content — so it does not extend this.
 */
interface LeafPaneNodeBase extends PaneNodeBase {
  isFocused?: boolean;
}

/**
 * Terminal leaf node - contains actual terminal session
 */
export interface TerminalPaneNode extends LeafPaneNodeBase {
  type: 'terminal';
  session: TerminalSession;
}

/**
 * Split container node - contains two child panes (recursive structure)
 */
export interface SplitPaneNode extends PaneNodeBase {
  type: 'split';
  direction: SplitDirection;
  ratio: number; // 0.0 to 1.0 - position of divider
  children: [AnyPaneNode, AnyPaneNode]; // Always exactly two children
}

/**
 * Every kind of pane that holds content rather than other panes.
 *
 * Terminal is the only one today. SFTP and the agent manager join this union, and
 * joining it is the whole of what the tree has to learn about them: `paneTree`
 * reaches a leaf through `isLeaf()` and never asks which kind it is, except in the
 * three places that genuinely are about terminals.
 */
export type LeafPaneNode = TerminalPaneNode;

/**
 * Union type for any pane node
 */
export type AnyPaneNode = LeafPaneNode | SplitPaneNode;

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
