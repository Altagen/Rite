/**
 * Terminal Manager
 *
 * Manages multiple terminal sessions with split panes and tabs
 */

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Tauri } from '../utils/tauri';
import { PaneContainer } from './PaneContainer';
import { Tab } from '../types/pane';
import { getAllSessions, getFocusedPane, getFirstTerminalPane } from '../utils/paneTree';
import { PaneDragProvider } from '../contexts/PaneDragContext';
import { errorHandler, ErrorSeverity, ErrorCategory } from '../utils/errorHandler';

export interface TerminalSession {
  id: string;
  connectionId: string;
  connectionName: string;
}

interface TerminalManagerProps {
  tabGroups: Tab[];
  activeTabId: string | null;
  onSplitPane: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  onClosePane: (paneId: string) => void;
  onFocusPane: (paneId: string) => void;
  onSplitRatioChange: (splitId: string, newRatio: number) => void;
  onSwitchTab: (tabId: string) => void;
  onReorderTabs?: (tabs: Tab[]) => void;
  onDetachPane?: (paneId: string) => void;
  onRenameTab?: (tabId: string, newName: string) => void;
  onMergeTab?: (sourceTabId: string, targetTabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onReorganizePane?: (sourcePaneId: string, targetPaneId: string, position: 'top' | 'bottom' | 'left' | 'right') => void;
  onNewLocalTerminal?: (shell?: string) => void;
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
  onReorderTabs,
  onDetachPane,
  onRenameTab,
  onMergeTab,
  onCloseTab,
  onReorganizePane,
  onNewLocalTerminal,
  onSaveQuickSSH,
  quickSSHSessions = [],
}: TerminalManagerProps) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [showShellDropdown, setShowShellDropdown] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const [installedShells, setInstalledShells] = useState<string[]>([]);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [isDroppingOnPane, setIsDroppingOnPane] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [tabToClose, setTabToClose] = useState<{ id: string; terminalCount: number } | null>(null);
  const dropdownButtonRef = useRef<HTMLButtonElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Helper to reset drag state
  const resetDragState = () => {
    setDraggedTabId(null);
    setDropTargetId(null);
    setIsDroppingOnPane(false);
  };

  // Define all possible shells
  const shells = [
    { name: 'Fish', path: '/usr/bin/fish', icon: '🐠' },
    { name: 'Bash', path: '/usr/bin/bash', icon: '🐚' },
    { name: 'Zsh', path: '/usr/bin/zsh', icon: '⚡' },
    { name: 'Sh', path: '/usr/bin/sh', icon: '📜' },
  ];

  // Check which shells are installed
  const checkInstalledShells = async () => {
    try {
      const allShellPaths = shells.map(s => s.path);
      const installed = await Tauri.Terminal.getInstalledShells(allShellPaths);
      setInstalledShells(installed);
    } catch (error) {
      errorHandler.handle('Failed to check installed shells', {
        severity: ErrorSeverity.WARNING,
        category: ErrorCategory.TERMINAL,
        originalError: error,
        context: { component: 'TerminalManager', shellPaths: shells.map(s => s.path) },
        silent: true, // Don't notify user, fallback gracefully
      });
      // If check fails, assume all shells are installed (backward compatibility)
      setInstalledShells(shells.map(s => s.path));
    }
  };

  // Get active tab's pane tree
  const activeTab = tabGroups.find(tab => tab.id === activeTabId);
  const paneTree = activeTab?.paneTree || null;

  // Get focused pane from active tab
  const focusedPane = paneTree ? getFocusedPane(paneTree) : null;

  // Track the last focused tab to avoid re-focusing on every render
  const lastFocusedTabRef = useRef<string | null>(null);

  // Auto-focus first pane when switching tabs
  useEffect(() => {
    if (paneTree && activeTabId && activeTabId !== lastFocusedTabRef.current) {
      // Tab has changed, focus the first pane
      const firstPane = getFirstTerminalPane(paneTree);
      if (firstPane) {
        console.log('[TerminalManager] Auto-focusing first pane on tab switch:', firstPane.id, 'for tab:', activeTabId);
        lastFocusedTabRef.current = activeTabId;
        onFocusPane(firstPane.id);
      }
    }
  }, [activeTabId, paneTree, onFocusPane]); // Need paneTree to get the pane to focus

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!focusedPane) return;

      // Ctrl+W: Close current pane
      // We handle it here at the manager level to avoid issues with multiple
      // terminals and focus changes. We use capture phase to intercept before xterm.
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        e.stopPropagation();

        // Ignore key repeats when user holds the key down
        if (e.repeat) return;

        onClosePane(focusedPane.id);
        return;
      }

      // Ctrl+Shift+H: Split horizontally
      if (e.ctrlKey && e.shiftKey && e.key === 'H') {
        e.preventDefault();
        onSplitPane(focusedPane.id, 'horizontal');
      }

      // Ctrl+Shift+V: Split vertically
      if (e.ctrlKey && e.shiftKey && e.key === 'V') {
        e.preventDefault();
        onSplitPane(focusedPane.id, 'vertical');
      }
    };

    // Use capture phase to intercept before xterm gets the event
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [focusedPane, onClosePane, onSplitPane]);

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
      setTabToClose({ id: tab.id, terminalCount });
      setShowCloseConfirm(true);
    } else {
      // Single terminal - close directly
      if (onCloseTab) {
        onCloseTab(tab.id);
      }
    }
  };

  // Confirm close tab
  const handleConfirmCloseTab = () => {
    if (tabToClose && onCloseTab) {
      onCloseTab(tabToClose.id);
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
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <p className="text-lg">No active terminal sessions</p>
        <p className="mt-2 text-sm">Double-click a connection to open a terminal</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border bg-card px-2 py-1 pb-3 overflow-x-auto overflow-y-visible flex-shrink-0 relative z-10">
        {tabGroups.map((tab) => {
          // Get all sessions in this tab for Quick SSH detection
          const tabSessions = getAllSessions(tab.paneTree);
          const hasQuickSSH = tabSessions.some(s => quickSSHSessions.includes(s.id));
          const quickSSHSessionId = hasQuickSSH ? tabSessions.find(s => quickSSHSessions.includes(s.id))?.id : null;

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
                className="flex items-center gap-2 cursor-move select-none"
              >
                <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
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
                    <span className="max-w-[150px] truncate" title={tab.name}>{tab.name}</span>
                    {/* Edit button - appears on hover */}
                    {onRenameTab && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartRename(tab);
                        }}
                        className="rounded p-0.5 opacity-0 transition-opacity hover:bg-background/50 group-hover:opacity-100"
                        title="Rename tab (double-click also works)"
                      >
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
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
                  title="Save connection"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
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
                  title={tabSessions.length > 1 ? `Close tab (${tabSessions.length} terminals)` : 'Close tab'}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}

        {/* New Terminal Dropdown Button */}
        {onNewLocalTerminal && (
          <div className="relative">
            <button
              ref={dropdownButtonRef}
              onClick={async () => {
                if (!showShellDropdown) {
                  // Check installed shells before opening dropdown
                  await checkInstalledShells();
                }
                setShowShellDropdown(!showShellDropdown);
              }}
              className="flex items-center gap-1 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors flex-shrink-0"
              title="New terminal"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showShellDropdown && createPortal(
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
                          isInstalled ? 'hover:bg-muted cursor-pointer' : 'opacity-50 cursor-not-allowed'
                        }`}
                        title={!isInstalled ? `${shell.name} is not installed` : ''}
                      >
                        <span>{shell.icon}</span>
                        <div className="flex-1 flex items-center gap-2">
                          <span className="font-medium">{shell.name}</span>
                          {!isInstalled && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-500 border border-red-500/30">
                              Not installed
                            </span>
                          )}
                        </div>
                        <span className="ml-auto text-xs text-muted-foreground">{shell.path}</span>
                      </button>
                    );
                  })}
                </div>
              </>,
              document.body
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
                <svg className="h-6 w-6 text-primary animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <span className="text-base font-medium text-primary">Drop to merge into this tab</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Close tab confirmation modal */}
      {showCloseConfirm && tabToClose && createPortal(
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
                  <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-foreground mb-2">
                    Close Multiple Terminals?
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    You are about to close <span className="font-semibold text-foreground">{tabToClose.terminalCount} terminals</span>. All active connections will be terminated. Are you sure?
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={handleCancelCloseTab}
                  className="px-4 py-2 rounded-md text-sm font-medium text-foreground bg-muted hover:bg-muted/80 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmCloseTab}
                  className="px-4 py-2 rounded-md text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors"
                >
                  Close All
                </button>
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
