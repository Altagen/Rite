/**
 * Terminal Manager
 *
 * Manages multiple terminal sessions with split panes and tabs
 */

import type { SplitTarget } from '../types/pane';
import { useTranslation } from '../i18n/i18n';
import { TabMenu } from './TabMenu';
import { useBroadcast } from '../store/broadcast';
import type { Layout } from '../store/layoutsFormat';
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Backend } from '../utils/backend';
import { PaneContainer } from './PaneContainer';
import { LayoutsMenu } from './LayoutsMenu';
import { Tab } from '../types/pane';
import { getAllSessions, getFocusedPane, getFirstLeafPane } from '../utils/paneTree';
import { useShortcut } from '../shortcuts/useShortcut';
import { PaneDragProvider } from '../contexts/PaneDragContext';
import { errorHandler, ErrorSeverity, ErrorCategory } from '../utils/errorHandler';
import type { ShellChoice } from '../utils/shells';

// Moved to ../types/pane (a data shape does not belong in a component). Re-exported
// here because callers already import it from this module.
export type { TerminalSession } from '../types/pane';

interface TerminalManagerProps {
  tabGroups: Tab[];
  activeTabId: string | null;
  onSplitPane: (
    paneId: string,
    direction: 'horizontal' | 'vertical',
    target?: SplitTarget,
  ) => Promise<void>;
  onClosePane: (paneId: string) => void;
  onFocusPane: (paneId: string) => void;
  onSplitRatioChange: (splitId: string, newRatio: number) => void;
  onSwitchTab: (tabId: string) => void;
  onReorderTabs?: (tabs: Tab[]) => void;
  onDetachPane?: (paneId: string) => void;
  onRenameTab?: (tabId: string, newName: string) => void;
  onMergeTab?: (sourceTabId: string, targetTabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  /**
   * Open the same arrangement again, against the same targets, with fresh sessions.
   * Not a copy: a pane holds a live session and an SSH connection cannot be cloned.
   */
  onDuplicateTab?: (tabId: string) => void;
  /** Close every tab but this one. */
  onCloseOtherTabs?: (tabId: string) => void;
  /** Start or stop sharing every keystroke among this tab's panes. */
  onToggleBroadcast?: (tabId: string) => void;
  onReorganizePane?: (
    sourcePaneId: string,
    targetPaneId: string,
    position: 'top' | 'bottom' | 'left' | 'right',
  ) => void;
  onNewLocalTerminal?: (shell?: string) => void;
  /**
   * What "+" offers for one terminal, or nothing — then it just opens one. Empty when
   * this person hid the menu, and on a server that keeps the shell to itself. The
   * button is never hidden: it is the only "new terminal" in the strip.
   *
   * The caller passes the entries because the two contexts answer differently: a
   * machine offers the shells Rite looks for, a server offers the ones it reported.
   */
  shellMenu?: ShellChoice[];
  /**
   * Whether to grey out entries this machine does not have. A server's list is already
   * what it has, so probing it would ask the wrong computer.
   */
  probeShells?: boolean;
  /**
   * Open a saved layout in the active tab. Here rather than on a pane because a
   * layout arranges the whole tab, which is also why its button sits in this strip.
   */
  onApplyLayout?: (layout: Layout) => Promise<void>;
  /** The machines a layout can name, and whether their names can be read at all. */
  layoutConnections?: { name: string }[];
  layoutLibraryReadable?: boolean;
  /**
   * The collection / machine tabs, rendered in this strip after the terminal tabs
   * and before the "+", which is where the mock puts them (`#mtabs`). They used to
   * live in a second strip above this one: two bars, one of which was meaningless
   * for whichever view was showing, and the terminal strip — `relative z-10`, same
   * level as the dashboard overlay and later in the DOM — drew on top of the very
   * dashboard it had nothing to do with.
   */
  viewTabs?: React.ReactNode;
  onSaveQuickSSH?: (sessionId: string) => void;
  quickSSHSessions?: string[];
}

export function TerminalManager({
  tabGroups,
  activeTabId,
  onSplitPane,
  onClosePane,
  onFocusPane,
  onSplitRatioChange,
  onSwitchTab,
  onApplyLayout,
  layoutConnections,
  layoutLibraryReadable,
  onReorderTabs,
  onDetachPane,
  onRenameTab,
  onMergeTab,
  onCloseTab,
  onDuplicateTab,
  onCloseOtherTabs,
  onToggleBroadcast,
  onReorganizePane,
  onNewLocalTerminal,
  shellMenu,
  probeShells = false,
  viewTabs,
  onSaveQuickSSH,
  quickSSHSessions = [],
}: TerminalManagerProps) {
  const { t } = useTranslation();
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [showShellDropdown, setShowShellDropdown] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const [installedShells, setInstalledShells] = useState<string[]>([]);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [isDroppingOnPane, setIsDroppingOnPane] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  /**
   * What the confirmation is asking about.
   *
   * `one` closes the tab named by `id`; `others` closes every tab EXCEPT it. One state
   * rather than two dialogs, because the question and the buttons are the same and only
   * the wording differs — two dialogs would drift apart on the next change to either.
   */
  const [tabToClose, setTabToClose] = useState<{
    id: string;
    terminalCount: number;
    kind: 'one' | 'others';
    /** How many tabs will go, for the `others` wording. */
    tabCount?: number;
  } | null>(null);
  /** Which tab was right-clicked, and where, so the menu opens at the pointer. */
  const [tabMenu, setTabMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null);
  const broadcastTab = useBroadcast((s) => s.tabId);
  const stopBroadcast = useBroadcast((s) => s.off);
  const dropdownButtonRef = useRef<HTMLButtonElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Helper to reset drag state
  const resetDragState = () => {
    setDraggedTabId(null);
    setDropTargetId(null);
    setIsDroppingOnPane(false);
  };

  // The shells on offer, from the caller: this menu was a third hardcoded list, and the
  // first two had already drifted (see ../utils/shells).
  const shells = shellMenu ?? [];
  const hasMenu = shells.length > 0;

  // Check which shells are installed
  const checkInstalledShells = async () => {
    if (!probeShells) {
      setInstalledShells(shells.map((s) => s.path));
      return;
    }
    try {
      const allShellPaths = shells.map((s) => s.path);
      const installed = await Backend.Terminal.getInstalledShells(allShellPaths);
      setInstalledShells(installed);
    } catch (error) {
      errorHandler.handle('Failed to check installed shells', {
        severity: ErrorSeverity.WARNING,
        category: ErrorCategory.TERMINAL,
        originalError: error,
        context: { component: 'TerminalManager', shellPaths: shells.map((s) => s.path) },
        silent: true, // Don't notify user, fallback gracefully
      });
      // If check fails, assume all shells are installed (backward compatibility)
      setInstalledShells(shells.map((s) => s.path));
    }
  };

  // Get active tab's pane tree
  const activeTab = tabGroups.find((tab) => tab.id === activeTabId);
  const paneTree = activeTab?.paneTree || null;

  // Get focused pane from active tab
  const focusedPane = paneTree ? getFocusedPane(paneTree) : null;

  // Track the last focused tab to avoid re-focusing on every render
  const lastFocusedTabRef = useRef<string | null>(null);

  // Auto-focus first pane when switching tabs
  useEffect(() => {
    if (paneTree && activeTabId && activeTabId !== lastFocusedTabRef.current) {
      // Tab has changed, focus the first pane
      const firstPane = getFirstLeafPane(paneTree);
      if (firstPane) {
        lastFocusedTabRef.current = activeTabId;
        onFocusPane(firstPane.id);
      }
    }
  }, [activeTabId, paneTree, onFocusPane]); // Need paneTree to get the pane to focus

  // Keyboard shortcuts
  // Pane commands live at the manager level — one focused pane, one handler each —
  // rather than in every terminal, where multiple panes and focus changes used to
  // make them fight. Which keys fire them is the engine's business, not this file's.
  useShortcut('pane.close', () => focusedPane && onClosePane(focusedPane.id), !!focusedPane);
  useShortcut(
    'pane.splitHorizontal',
    () => focusedPane && void onSplitPane(focusedPane.id, 'horizontal'),
    !!focusedPane,
  );
  useShortcut(
    'pane.splitVertical',
    () => focusedPane && void onSplitPane(focusedPane.id, 'vertical'),
    !!focusedPane,
  );

  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    setDraggedTabId(tabId);
    e.dataTransfer.effectAllowed = 'move';
    // Use a custom MIME type to distinguish tab drags from pane drags
    e.dataTransfer.setData('application/x-rite-tab', tabId);
  };

  const handleDragOver = (e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedTabId && draggedTabId !== tabId) {
      setDropTargetId(tabId);
    }
  };

  const handleDragLeave = () => {
    setDropTargetId(null);
  };

  const handleDrop = (e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    if (!draggedTabId || draggedTabId === targetTabId || !onReorderTabs) {
      resetDragState();
      return;
    }

    const draggedIndex = tabGroups.findIndex((t) => t.id === draggedTabId);
    const targetIndex = tabGroups.findIndex((t) => t.id === targetTabId);

    if (draggedIndex === -1 || targetIndex === -1) {
      resetDragState();
      return;
    }

    const newTabs = [...tabGroups];
    const [draggedTab] = newTabs.splice(draggedIndex, 1);
    newTabs.splice(targetIndex, 0, draggedTab);

    onReorderTabs(newTabs);
    resetDragState();
  };

  const handleDragEnd = () => {
    resetDragState();
  };

  // Handle dragging over the pane area
  const handlePaneDragOver = (e: React.DragEvent) => {
    // Only handle tab drags, not pane drags
    if (!e.dataTransfer.types.includes('application/x-rite-tab')) {
      return; // Let PaneContainer handle pane drags
    }

    e.preventDefault();

    // Allow dropping a tab onto a different tab's pane area
    if (draggedTabId && draggedTabId !== activeTabId) {
      e.dataTransfer.dropEffect = 'move';
      setIsDroppingOnPane(true);
    } else if (draggedTabId) {
      e.dataTransfer.dropEffect = 'none';
    }
  };

  const handlePaneDragLeave = (e: React.DragEvent) => {
    // Only clear if we're leaving the pane container entirely
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const { clientX, clientY } = e;
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      setIsDroppingOnPane(false);
    }
  };

  // Handle dropping on the pane area
  const handlePaneDrop = (e: React.DragEvent) => {
    // Only handle tab drags, not pane drags
    if (!e.dataTransfer.types.includes('application/x-rite-tab')) {
      return; // Let PaneContainer handle pane drags
    }

    e.preventDefault();
    if (draggedTabId && activeTabId && draggedTabId !== activeTabId && onMergeTab) {
      onMergeTab(draggedTabId, activeTabId);
    }
    setDraggedTabId(null);
    setDropTargetId(null);
    setIsDroppingOnPane(false);
  };

  // Update dropdown position when it opens
  useEffect(() => {
    if (showShellDropdown && dropdownButtonRef.current) {
      const rect = dropdownButtonRef.current.getBoundingClientRect();
      const dropdownWidth = 280;
      const viewportWidth = window.innerWidth;

      let left = rect.left;
      if (left + dropdownWidth > viewportWidth) {
        left = rect.right - dropdownWidth;
        if (left < 0) {
          left = 8;
        }
      }

      setDropdownPosition({
        top: rect.bottom + 4,
        left: left,
      });
    }
  }, [showShellDropdown]);

  // Auto-focus edit input when editing starts
  useEffect(() => {
    if (editingTabId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingTabId]);

  // Handle starting tab rename
  const handleStartRename = (tab: Tab) => {
    setEditingTabId(tab.id);
    setEditingTabName(tab.name);
  };

  // Handle finishing tab rename
  const handleFinishRename = () => {
    if (editingTabId && editingTabName.trim() && onRenameTab) {
      onRenameTab(editingTabId, editingTabName.trim());
    }
    setEditingTabId(null);
    setEditingTabName('');
  };

  // Handle cancel rename
  const handleCancelRename = () => {
    setEditingTabId(null);
    setEditingTabName('');
  };

  // Handle close tab button click
  const handleCloseTabClick = (tab: Tab) => {
    const tabSessions = getAllSessions(tab.paneTree);
    const terminalCount = tabSessions.length;

    if (terminalCount > 1) {
      // Multiple terminals - show confirmation dialog
      setTabToClose({ id: tab.id, terminalCount, kind: 'one' });
      setShowCloseConfirm(true);
    } else {
      // Single terminal - close directly
      if (onCloseTab) {
        onCloseTab(tab.id);
      }
    }
  };

  /**
   * Closing every other tab.
   *
   * Always confirms when anything is open, whatever the terminal count: closing one tab
   * is a decision about one tab, and closing eight at once is a decision about work in
   * progress. The single-terminal shortcut above does not apply here.
   */
  const handleCloseOthersClick = (tab: Tab) => {
    const others = tabGroups.filter((t) => t.id !== tab.id);
    if (others.length === 0) return;
    const terminalCount = others.reduce((n, t) => n + getAllSessions(t.paneTree).length, 0);
    setTabToClose({ id: tab.id, terminalCount, kind: 'others', tabCount: others.length });
    setShowCloseConfirm(true);
  };

  // Confirm close tab
  const handleConfirmCloseTab = () => {
    if (tabToClose) {
      if (tabToClose.kind === 'others') onCloseOtherTabs?.(tabToClose.id);
      else onCloseTab?.(tabToClose.id);
    }
    setShowCloseConfirm(false);
    setTabToClose(null);
  };

  // Cancel close tab
  const handleCancelCloseTab = () => {
    setShowCloseConfirm(false);
    setTabToClose(null);
  };

  if (tabGroups.length === 0) {
    return (
      <div className="flex flex-1 w-full flex-col items-center justify-center bg-background text-muted-foreground">
        <svg className="mb-4 h-16 w-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <p className="text-lg">{t('tm.noSessions')}</p>
        <p className="mt-2 text-sm">{t('tm.doubleClickHint')}</p>
        {/* A layout opens its own tabs, so this is exactly when it is wanted: nothing
            is open, and the morning is one click away. It used to live only beside the
            tabs, which meant you had to open a terminal before you could open the
            arrangement that opens terminals. */}
        {onApplyLayout && (
          <div className="mt-6">
            <LayoutsMenu
              onApplyLayout={onApplyLayout}
              connections={layoutConnections ?? []}
              libraryReadable={layoutLibraryReadable ?? false}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Tabs */}
      <div
        role="tablist"
        aria-label={t('tm.openTabs')}
        className="flex items-center gap-1 border-b border-border bg-card px-2 py-1 pb-3 overflow-x-auto overflow-y-visible flex-shrink-0 relative z-10"
      >
        {tabGroups.map((tab) => {
          // Get all sessions in this tab for Quick SSH detection
          const tabSessions = getAllSessions(tab.paneTree);
          const hasQuickSSH = tabSessions.some((s) => quickSSHSessions.includes(s.id));
          const quickSSHSessionId = hasQuickSSH
            ? tabSessions.find((s) => quickSSHSessions.includes(s.id))?.id
            : null;

          return (
            <div
              key={tab.id}
              onDragOver={(e) => handleDragOver(e, tab.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, tab.id)}
              className={`group relative flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-all flex-shrink-0 ${
                activeTabId === tab.id
                  ? 'bg-primary/20 text-primary font-medium'
                  : 'hover:bg-muted text-muted-foreground'
              } ${draggedTabId === tab.id ? 'opacity-50' : ''} ${
                dropTargetId === tab.id ? 'border-l-4 border-l-primary' : ''
              }`}
            >
              <div
                draggable={editingTabId !== tab.id}
                onDragStart={(e) => handleDragStart(e, tab.id)}
                onDragEnd={handleDragEnd}
                onClick={() => onSwitchTab(tab.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleStartRename(tab);
                }}
                onContextMenu={(e) => {
                  // The engine's own menu would cover ours, and it offers nothing about a
                  // tab. Prevented here and nowhere else: the terminal keeps its native
                  // menu, which is where copy and paste live.
                  e.preventDefault();
                  e.stopPropagation();
                  setTabMenu({ tab, x: e.clientX, y: e.clientY });
                }}
                /* A tab is a selector first: one click switches to it, and the mock
                   says `cursor:pointer`. `cursor-move` promised a drag on hover and
                   made every click look like the start of one. Dragging says so while
                   it happens, which is when it is true. */
                className={`flex items-center gap-2 select-none ${
                  draggedTabId === tab.id ? 'cursor-grabbing' : 'cursor-pointer'
                }`}
                data-testid="tab-select"
              >
                <svg
                  className="h-3.5 w-3.5 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 17l6-5-6-5M12 19h8"
                  />
                </svg>

                {/* Editable tab name */}
                {editingTabId === tab.id ? (
                  <input
                    ref={editInputRef}
                    type="text"
                    value={editingTabName}
                    onChange={(e) => setEditingTabName(e.target.value)}
                    onBlur={handleFinishRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleFinishRename();
                      } else if (e.key === 'Escape') {
                        handleCancelRename();
                      }
                    }}
                    className="max-w-[150px] bg-background border border-primary rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="max-w-[150px] truncate" title={tab.name}>
                      {tab.name}
                    </span>
                    {/* Edit button - appears on hover */}
                    {onRenameTab && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartRename(tab);
                        }}
                        className="rounded p-0.5 opacity-0 transition-opacity hover:bg-background/50 group-hover:opacity-100"
                        title={t('tm.renameTab')}
                      >
                        <svg
                          className="h-3 w-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                          />
                        </svg>
                      </button>
                    )}
                  </>
                )}

                {/* Show pane count if more than 1 */}
                {tabSessions.length > 1 && (
                  <span className="text-xs bg-primary/10 px-1.5 py-0.5 rounded flex-shrink-0">
                    {tabSessions.length}
                  </span>
                )}
              </div>
              {quickSSHSessionId && onSaveQuickSSH && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSaveQuickSSH(quickSSHSessionId);
                  }}
                  className="rounded p-0.5 opacity-0 transition-opacity hover:bg-background/50 group-hover:opacity-100"
                  title={t('tm.saveConnection')}
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"
                    />
                  </svg>
                </button>
              )}

              {/* Close tab button */}
              {onCloseTab && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTabClick(tab);
                  }}
                  className="rounded p-0.5 opacity-0 transition-opacity hover:bg-red-500/20 hover:text-red-500 group-hover:opacity-100"
                  title={
                    tabSessions.length > 1
                      ? t('tm.closeTabCount', { count: tabSessions.length })
                      : t('tm.closeTab')
                  }
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
          );
        })}

        {viewTabs}

        {/* Layouts — a whole-tab arrangement, so it belongs beside the tabs. */}
        {onApplyLayout && (
          <LayoutsMenu
            onApplyLayout={onApplyLayout}
            connections={layoutConnections ?? []}
            libraryReadable={layoutLibraryReadable ?? false}
          />
        )}

        {/* New Terminal Dropdown Button */}
        {onNewLocalTerminal && (
          <div className="relative">
            <button
              ref={dropdownButtonRef}
              onClick={async () => {
                // Without the menu the button is the action: a terminal, in the shell
                // the default names. With it, it asks which shell just this once.
                if (!hasMenu) {
                  onNewLocalTerminal();
                  return;
                }
                if (!showShellDropdown) {
                  // Check installed shells before opening dropdown
                  await checkInstalledShells();
                }
                setShowShellDropdown(!showShellDropdown);
              }}
              className="flex items-center gap-1 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors flex-shrink-0"
              title={t('tm.newTerminal')}
              data-testid="tab-new-terminal"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              {hasMenu && (
                <svg
                  className="h-3 w-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  data-testid="tab-new-terminal-chevron"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              )}
            </button>

            {hasMenu &&
              showShellDropdown &&
              createPortal(
                <>
                  <div
                    className="fixed inset-0 z-[100]"
                    onClick={() => setShowShellDropdown(false)}
                  />

                  <div
                    className="fixed z-[110] min-w-[280px] rounded-md border border-border bg-card shadow-xl"
                    style={{
                      top: `${dropdownPosition.top}px`,
                      left: `${dropdownPosition.left}px`,
                    }}
                    data-testid="tab-shell-menu"
                  >
                    {shells.map((shell, index) => {
                      const isInstalled = installedShells.includes(shell.path);
                      return (
                        <button
                          key={shell.path}
                          onClick={() => {
                            if (isInstalled) {
                              onNewLocalTerminal(shell.path);
                              setShowShellDropdown(false);
                            }
                          }}
                          disabled={!isInstalled}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                            index === 0 ? 'rounded-t-md' : ''
                          } ${index === shells.length - 1 ? 'rounded-b-md' : ''} ${
                            isInstalled
                              ? 'hover:bg-muted cursor-pointer'
                              : 'opacity-50 cursor-not-allowed'
                          }`}
                          title={!isInstalled ? `${shell.name} is not installed` : ''}
                        >
                          <span>{shell.icon}</span>
                          <div className="flex-1 flex items-center gap-2">
                            <span className="font-medium">{shell.name}</span>
                            {!isInstalled && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-500 border border-red-500/30">
                                {t('tm.notInstalled')}
                              </span>
                            )}
                          </div>
                          <span className="ml-auto text-xs text-muted-foreground">
                            {shell.path}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>,
                document.body,
              )}
          </div>
        )}
      </div>

      {/* Pane Container - renders the split tree */}
      <div
        className={`flex flex-1 min-h-0 w-full relative transition-all ${
          isDroppingOnPane ? 'ring-2 ring-primary ring-inset' : ''
        }`}
        onDragOver={handlePaneDragOver}
        onDragLeave={handlePaneDragLeave}
        onDrop={handlePaneDrop}
      >
        {paneTree && (
          <PaneDragProvider>
            <PaneContainer
              node={paneTree}
              onSplitRatioChange={onSplitRatioChange}
              onClosePane={onClosePane}
              onFocusPane={onFocusPane}
              onSplitPane={onSplitPane}
              onDetachPane={onDetachPane}
              onReorganizePane={onReorganizePane}
            />
          </PaneDragProvider>
        )}

        {/* Drop zone indicator */}
        {isDroppingOnPane && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-primary/5 backdrop-blur-[2px]">
            <div className="bg-card border-2 border-primary border-dashed rounded-lg px-6 py-4 shadow-2xl">
              <div className="flex items-center gap-3">
                <svg
                  className="h-6 w-6 text-primary animate-pulse"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                <span className="text-base font-medium text-primary">{t('tm.dropToMerge')}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Close tab confirmation modal */}
      {/* Broadcasting is announced where the tabs are, in amber, with a cross. A mode that
          sends every keystroke to several shells has to be impossible to miss and one
          click to stop: the cost of forgetting it is a command running on machines nobody
          meant to touch. Absent while off — a permanent badge stops being read. */}
      {broadcastTab && (
        <button
          type="button"
          onClick={() => stopBroadcast()}
          title={t('tm.broadcastingWhy')}
          className="ml-2 flex flex-none items-center gap-1.5 rounded-md border border-amber-500 bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-500 hover:bg-amber-500/25"
          data-testid="broadcast-badge"
        >
          {t('tm.broadcasting')}
          <span aria-hidden="true">✕</span>
        </button>
      )}

      {tabMenu && (
        <TabMenu
          at={{ x: tabMenu.x, y: tabMenu.y }}
          onRename={() => handleStartRename(tabMenu.tab)}
          onDuplicate={() => onDuplicateTab?.(tabMenu.tab.id)}
          // Absent when this is the only tab: an entry that would close nothing is worse
          // than no entry, because it reads as "nothing happened".
          onCloseOthers={
            tabGroups.length > 1 ? () => handleCloseOthersClick(tabMenu.tab) : undefined
          }
          // Offered per tab because that is its scope, and labelled with the scope:
          // "broadcast" alone does not say how far it reaches.
          broadcasting={broadcastTab === tabMenu.tab.id}
          onToggleBroadcast={() => onToggleBroadcast?.(tabMenu.tab.id)}
          onClose={() => setTabMenu(null)}
        />
      )}

      {showCloseConfirm &&
        tabToClose &&
        createPortal(
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[200]"
              onClick={handleCancelCloseTab}
            />

            {/* Modal */}
            <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[210] w-full max-w-md">
              <div className="bg-card border border-border rounded-lg shadow-2xl p-6">
                {/* Icon and title */}
                <div className="flex items-start gap-4 mb-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                    <svg
                      className="h-6 w-6 text-red-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-foreground mb-2">
                      {tabToClose.kind === 'others'
                        ? t('tm.closeOthersTitle')
                        : t('tm.closeMany')}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {tabToClose.kind === 'others'
                        ? t('tm.closeOthersWhy', {
                            count: tabToClose.terminalCount,
                            tabs: tabToClose.tabCount ?? 0,
                          })
                        : t('tm.closeManyWhy', { count: tabToClose.terminalCount })}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-3">
                  <button
                    onClick={handleCancelCloseTab}
                    className="px-4 py-2 rounded-md text-sm font-medium text-foreground bg-muted hover:bg-muted/80 transition-colors"
                  >
                    {t('dlg.cancel')}
                  </button>
                  <button
                    onClick={handleConfirmCloseTab}
                    className="px-4 py-2 rounded-md text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors"
                  >
                    {t('tm.closeAll')}
                  </button>
                </div>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
