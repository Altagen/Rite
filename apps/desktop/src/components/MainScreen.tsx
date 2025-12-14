/**
 * Main Screen - Application main interface
 *
 * Shown when the application is unlocked
 */

import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Tauri } from '../utils/tauri';
import { useAuthStore } from '../store/authStore';
import { useConnectionsStore, type ConnectionInfo } from '../store/connectionsStore';
import { useSettingsStore } from '../store/settingsStore';
import { useTranslation } from '../i18n/i18n';
import { ConnectionList } from './ConnectionList';
import { ConnectionForm } from './ConnectionForm';
import { CollectionsManager } from './CollectionsManager';
import { TerminalManager, type TerminalSession } from './TerminalManager';
import { Settings } from './Settings';
import { QuickSSHModal, type QuickSSHConnectionInfo } from './QuickSSHModal';
import { ImportSSHConfigModal } from './ImportSSHConfigModal';
import { UnlockScreen } from './UnlockScreen';
import { Toast } from './Toast';
import { ErrorBoundary } from './ErrorBoundary';
import { SplitDirection, Tab } from '../types/pane';
import {
  createTerminalPane,
  splitPane,
  closePane,
  setFocusedPane,
  updateSplitRatio,
  getFocusedPane,
  getAllPanes,
  getAllSessions,
  getSessionsInPane,
  extractPane,
  reorganizePane,
} from '../utils/paneTree';
import riteLandscape from '../assets/RITE-icon-landscape.png';

export function MainScreen() {
  const { isLocked, lock } = useAuthStore();
  const { t } = useTranslation();
  const {
    connections,
    fetchConnections,
    deleteConnection,
    selectConnection,
    selectedConnectionId,
  } = useConnectionsStore();
  const { settings, fetchSettings, updateSettings } = useSettingsStore();

  const [showForm, setShowForm] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionInfo | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [connectionToDelete, setConnectionToDelete] = useState<ConnectionInfo | null>(null);
  const [showCollectionsManager, setShowCollectionsManager] = useState(false);
  const [showImportSSH, setShowImportSSH] = useState(false);

  // Tab groups state - each tab has its own pane tree
  const [tabGroups, setTabGroups] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Sidebar state
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [showSidebarButton, setShowSidebarButton] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Quick SSH and Unlock modals
  const [showQuickSSH, setShowQuickSSH] = useState(false);
  const [showUnlockModal, setShowUnlockModal] = useState(false);

  // Toast notification state
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'error'>('error');
  const [toastAction, setToastAction] = useState<{ label: string; onClick: () => void } | undefined>(undefined);

  // Default shell selector state
  const [showDefaultShellDropdown, setShowDefaultShellDropdown] = useState(false);
  const [defaultShellDropdownPosition, setDefaultShellDropdownPosition] = useState({ top: 0, left: 0 });
  const defaultShellButtonRef = useRef<HTMLButtonElement>(null);

  // Installed shells state
  const [installedShells, setInstalledShells] = useState<string[]>([]);

  // Define all possible shells for default shell selector
  const shells = [
    { name: 'Fish', path: '/usr/bin/fish', icon: '🐠' },
    { name: 'Bash', path: '/usr/bin/bash', icon: '🐚' },
    { name: 'Zsh', path: '/usr/bin/zsh', icon: '⚡' },
    { name: 'Sh', path: '/usr/bin/sh', icon: '📜' },
  ];

  // Store Quick SSH connection info for later saving
  const [quickSSHConnections, setQuickSSHConnections] = useState<Map<string, QuickSSHConnectionInfo>>(new Map());

  // Store pre-fill data for connection form (when saving Quick SSH)
  const [connectionFormPrefill, setConnectionFormPrefill] = useState<QuickSSHConnectionInfo | null>(null);

  // Store pending action after unlock
  const [pendingActionAfterUnlock, setPendingActionAfterUnlock] = useState<(() => void) | null>(null);

  // Execute pending action after unlock
  useEffect(() => {
    if (!isLocked && pendingActionAfterUnlock) {
      console.log('[MainScreen] Executing pending action after unlock');
      pendingActionAfterUnlock();
      setPendingActionAfterUnlock(null);
    }
  }, [isLocked, pendingActionAfterUnlock]);

  // Load connections on mount (only if unlocked)
  useEffect(() => {
    if (!isLocked) {
      fetchConnections();
    }
  }, [isLocked, fetchConnections]);

  // Load settings on mount
  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Check which shells are installed
  const checkInstalledShells = async () => {
    try {
      const allShellPaths = shells.map(s => s.path);
      const installed = await Tauri.Terminal.getInstalledShells(allShellPaths);
      console.log('[MainScreen] Installed shells:', installed);
      setInstalledShells(installed);
    } catch (error) {
      console.error('[MainScreen] Failed to check installed shells:', error);
      // If check fails, assume all shells are installed (backward compatibility)
      setInstalledShells(shells.map(s => s.path));
    }
  };

  // Close unlock modal when unlocked
  useEffect(() => {
    if (!isLocked && showUnlockModal) {
      setShowUnlockModal(false);
      fetchConnections();
    }
  }, [isLocked, showUnlockModal, fetchConnections]);

  // Show sidebar button for 3 seconds when sidebar closes
  useEffect(() => {
    if (!isSidebarOpen) {
      setShowSidebarButton(true);
      const timer = setTimeout(() => {
        setShowSidebarButton(false);
      }, 3000);
      return () => clearTimeout(timer);
    } else {
      setShowSidebarButton(false);
    }
  }, [isSidebarOpen]);

  // Update default shell dropdown position when it opens
  useEffect(() => {
    if (showDefaultShellDropdown && defaultShellButtonRef.current) {
      const rect = defaultShellButtonRef.current.getBoundingClientRect();
      const dropdownWidth = 300;
      const viewportWidth = window.innerWidth;

      let left = rect.left;
      if (left + dropdownWidth > viewportWidth) {
        left = rect.right - dropdownWidth;
        if (left < 0) {
          left = 8;
        }
      }

      setDefaultShellDropdownPosition({
        top: rect.bottom + 4,
        left: left,
      });
    }
  }, [showDefaultShellDropdown]);

  // Auto-lock timer - monitors user activity and locks after inactivity
  useEffect(() => {
    // Only enable auto-lock if it's enabled and timeout is > 0
    if (!settings.autoLockEnabled || settings.autoLockTimeout <= 0) {
      return;
    }

    console.log(`[Auto-lock] Enabled with timeout: ${settings.autoLockTimeout} minute(s)`);

    let timeoutId: NodeJS.Timeout;

    const resetTimer = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        console.log('[Auto-lock] Locking due to inactivity');
        lock();
      }, settings.autoLockTimeout * 60 * 1000); // Convert minutes to milliseconds
    };

    // Start the timer
    resetTimer();

    // Listen for user activity events
    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];
    events.forEach(event => {
      document.addEventListener(event, resetTimer);
    });

    // Cleanup on unmount or when settings change
    return () => {
      clearTimeout(timeoutId);
      events.forEach(event => {
        document.removeEventListener(event, resetTimer);
      });
      console.log('[Auto-lock] Cleanup - timer removed');
    };
  }, [settings.autoLockEnabled, settings.autoLockTimeout, lock]);

  // Clipboard auto-clear - clears clipboard after copy event
  useEffect(() => {
    if (!settings.clipboardClearEnabled) {
      return;
    }

    console.log(`[Clipboard] Auto-clear enabled with timeout: ${settings.clipboardClearTimeout} second(s)`);

    let clipboardTimeoutId: NodeJS.Timeout;

    const handleCopy = async () => {
      // Clear any existing timer
      clearTimeout(clipboardTimeoutId);

      // Start new timer to clear clipboard
      clipboardTimeoutId = setTimeout(async () => {
        try {
          await navigator.clipboard.writeText('');
          console.log('[Clipboard] Cleared clipboard after timeout');
        } catch (error) {
          console.error('[Clipboard] Failed to clear clipboard:', error);
        }
      }, settings.clipboardClearTimeout * 1000); // Convert seconds to milliseconds

      console.log(`[Clipboard] Copy detected, will clear in ${settings.clipboardClearTimeout}s`);
    };

    // Listen for copy events
    document.addEventListener('copy', handleCopy);

    // Cleanup on unmount or when settings change
    return () => {
      clearTimeout(clipboardTimeoutId);
      document.removeEventListener('copy', handleCopy);
      console.log('[Clipboard] Cleanup - auto-clear removed');
    };
  }, [settings.clipboardClearEnabled, settings.clipboardClearTimeout]);

  // Handle new connection
  const handleNewConnection = () => {
    setEditingConnection(null);
    setShowForm(true);
  };

  // Handle edit connection
  const handleEditConnection = (connection: ConnectionInfo) => {
    setEditingConnection(connection);
    setShowForm(true);
  };

  // Handle delete connection
  const handleDeleteConnection = (connection: ConnectionInfo) => {
    setConnectionToDelete(connection);
    setShowDeleteConfirm(true);
  };

  // Confirm delete
  const confirmDelete = async () => {
    if (connectionToDelete) {
      try {
        await deleteConnection(connectionToDelete.id);
        setShowDeleteConfirm(false);
        setConnectionToDelete(null);
      } catch (error) {
        console.error('Failed to delete connection:', error);
      }
    }
  };

  // Helper function to create a new tab group with a terminal session
  const addTerminalToTree = (session: TerminalSession) => {
    const newPane = createTerminalPane(session, true);

    // Create a new tab group with this terminal
    const newTab: Tab = {
      id: crypto.randomUUID(),
      name: session.connectionName,
      paneTree: newPane,
    };

    setTabGroups(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  // Handle connect - open terminal (allows multiple tabs for same connection)
  const handleConnect = async (connection: ConnectionInfo) => {
    console.log('[MainScreen] handleConnect called for connection:', connection.name, 'ID:', connection.id);

    try {
      // Call backend to create SSH terminal session
      console.log('[MainScreen] Calling backend connect_terminal...');
      const sessionId = await Tauri.Terminal.connectTerminal(connection.id);

      console.log('[MainScreen] Backend returned session ID:', sessionId);

      // Create terminal session with backend session ID
      const session: TerminalSession = {
        id: sessionId,
        connectionId: connection.id,
        connectionName: connection.name,
      };

      console.log('[MainScreen] Adding terminal session to tree:', session.id);
      addTerminalToTree(session);
    } catch (error) {
      console.error('[MainScreen] Failed to connect to terminal:', error);
      let errorMsg = typeof error === 'string' ? error : error instanceof Error ? error.message : 'Failed to connect';

      // Improve error message for authentication failures (likely empty password)
      if (errorMsg.includes('Authentication failed') || errorMsg.includes('authentication')) {
        errorMsg = `Authentication failed - Configuration is incomplete`;

        // Add action button to open edit form
        setToastAction({
          label: 'Edit Configuration',
          onClick: () => handleEditConnection(connection),
        });
      } else {
        setToastAction(undefined);
      }

      setToastType('error');
      setToastMessage(errorMsg);
    }
  };

  // Handle new local terminal
  const handleNewLocalTerminal = async (shell?: string) => {
    // Use provided shell or fall back to settings default
    const shellToUse = shell || settings.defaultShell;
    console.log('[MainScreen] Creating local terminal session with shell:', shellToUse);

    try {
      // Call backend to create local terminal session with selected shell
      const sessionId = await Tauri.Terminal.connectLocalTerminal(shellToUse);

      // Create terminal session
      const shellName = shellToUse.split('/').pop() || 'shell';
      const session: TerminalSession = {
        id: sessionId,
        connectionId: 'local',
        connectionName: `Local Terminal (${shellName})`,
      };

      console.log('[MainScreen] Local terminal session created:', sessionId);
      addTerminalToTree(session);
    } catch (error) {
      console.error('[MainScreen] Failed to create local terminal:', error);
      // Show error message with toast
      const errorMsg = typeof error === 'string' ? error : 'Failed to create local terminal';
      setToastType('error');
      setToastMessage(errorMsg);
    }
  };

  // Handle Quick SSH connected
  const handleQuickSSHConnected = (sessionId: string, connectionInfo: QuickSSHConnectionInfo) => {
    console.log('[MainScreen] Quick SSH connected, session:', sessionId);

    // Store connection info for potential saving later
    setQuickSSHConnections(new Map(quickSSHConnections).set(sessionId, connectionInfo));

    // Create terminal session with special quick-connect ID
    const session: TerminalSession = {
      id: sessionId,
      connectionId: `quick-${sessionId}`, // Special ID for quick connects
      connectionName: '⚡ Quick SSH',
    };

    addTerminalToTree(session);
  };

  // Handle split pane
  const handleSplitPane = async (paneId: string, direction: SplitDirection) => {
    console.log('[MainScreen] Splitting pane:', paneId, 'direction:', direction);

    if (!activeTabId) return;

    try {
      // Create a new local terminal session for the new pane
      const shellToUse = settings.defaultShell;
      const sessionId = await Tauri.Terminal.connectLocalTerminal(shellToUse);

      const shellName = shellToUse.split('/').pop() || 'shell';
      const newSession: TerminalSession = {
        id: sessionId,
        connectionId: 'local',
        connectionName: `Local Terminal (${shellName})`,
      };

      // Split the pane in the active tab's tree
      setTabGroups(prev => prev.map(tab => {
        if (tab.id === activeTabId) {
          const newTree = splitPane(tab.paneTree, paneId, direction, newSession);
          return { ...tab, paneTree: newTree };
        }
        return tab;
      }));
    } catch (error) {
      console.error('[MainScreen] Failed to split pane:', error);
      const errorMsg = typeof error === 'string' ? error : 'Failed to create terminal for split';
      setToastType('error');
      setToastMessage(errorMsg);
    }
  };

  // Handle close pane
  const handleClosePane = (paneId: string) => {
    console.log('[MainScreen] Closing pane:', paneId);

    if (!activeTabId) return;

    // Check how many terminals will be closed
    const activeTab = tabGroups.find(t => t.id === activeTabId);
    if (!activeTab) return;

    // Check how many terminals are in this specific pane subtree
    const sessionsInPane = getSessionsInPane(activeTab.paneTree, paneId);
    const sessionCount = sessionsInPane.length;

    // Ask confirmation ONLY if closing this pane will close multiple terminals
    // (don't ask for single terminal in a tab with multiple terminals - that's annoying)
    if (sessionCount > 1) {
      const message = `This pane contains ${sessionCount} terminals. Close all of them?`;
      const confirmed = window.confirm(message);
      if (!confirmed) return;
    }

    setTabGroups(prev => {
      // Remember current tab index BEFORE any modifications
      const currentTabIndex = prev.findIndex(t => t.id === activeTabId);

      const newTabs = prev.map(tab => {
        if (tab.id !== activeTabId) return tab;

        const newTree = closePane(tab.paneTree, paneId);

        // If tree becomes empty, mark tab for removal
        if (!newTree) {
          return null;
        }

        // Auto-focus another pane if the closed pane was focused
        const focusedPane = getFocusedPane(newTree);
        if (!focusedPane) {
          // No pane is focused, focus the first available one
          const allPanes = getAllPanes(newTree);
          if (allPanes.length > 0) {
            return { ...tab, paneTree: setFocusedPane(newTree, allPanes[0].id) };
          }
        }

        return { ...tab, paneTree: newTree };
      }).filter((tab): tab is Tab => tab !== null);

      // If we removed the active tab, switch to the previous or next tab
      const stillExists = newTabs.find(t => t.id === activeTabId);
      if (!stillExists && newTabs.length > 0) {
        // Try to go to the previous tab, or next tab if we were at index 0
        // Make sure the index is valid after removal
        const newIndex = Math.min(currentTabIndex > 0 ? currentTabIndex - 1 : 0, newTabs.length - 1);
        if (newTabs[newIndex]) {
          setActiveTabId(newTabs[newIndex].id);
        }
      } else if (newTabs.length === 0) {
        setActiveTabId(null);
      }

      return newTabs;
    });
  };

  // Handle focus pane
  const handleFocusPane = (paneId: string) => {
    console.log('[MainScreen] Focusing pane:', paneId);

    if (!activeTabId) return;

    setTabGroups(prev => prev.map(tab => {
      if (tab.id === activeTabId) {
        return { ...tab, paneTree: setFocusedPane(tab.paneTree, paneId) };
      }
      return tab;
    }));
  };

  // Handle split ratio change
  const handleSplitRatioChange = (splitId: string, newRatio: number) => {
    if (!activeTabId) return;

    setTabGroups(prev => prev.map(tab => {
      if (tab.id === activeTabId) {
        return { ...tab, paneTree: updateSplitRatio(tab.paneTree, splitId, newRatio) };
      }
      return tab;
    }));
  };

  // Handle switch tab (now switches between tab groups)
  const handleSwitchTab = (tabId: string) => {
    console.log('[MainScreen] Switching to tab group:', tabId);
    setActiveTabId(tabId);
  };

  // Handle reorder tabs
  const handleReorderTabs = (newTabOrder: Tab[]) => {
    console.log('[MainScreen] Reordering tab groups:', newTabOrder.map(t => t.id));
    setTabGroups(newTabOrder);
  };

  // Handle close tab - gracefully close all terminals in a tab and remove it
  const handleCloseTab = async (tabId: string) => {
    console.log('[MainScreen] Closing tab:', tabId);

    const tabToClose = tabGroups.find(t => t.id === tabId);
    if (!tabToClose) return;

    // Get all sessions in this tab
    const sessionsToClose = getAllSessions(tabToClose.paneTree);

    // Gracefully disconnect all terminal sessions
    console.log('[MainScreen] Disconnecting', sessionsToClose.length, 'terminal sessions');
    await Promise.all(
      sessionsToClose.map(async (session) => {
        try {
          await Tauri.Terminal.disconnectTerminal(session.id);
          console.log('[MainScreen] Disconnected session:', session.id);
        } catch (err) {
          console.error('[MainScreen] Failed to disconnect session:', session.id, err);
        }
      })
    );

    // Remove the tab
    setTabGroups(prev => {
      const newTabs = prev.filter(t => t.id !== tabId);

      // If we're closing the active tab, switch to another tab
      if (activeTabId === tabId && newTabs.length > 0) {
        const closedTabIndex = prev.findIndex(t => t.id === tabId);
        // Switch to the tab before, or the first tab if we closed the first one
        const newActiveIndex = Math.max(0, closedTabIndex - 1);
        setActiveTabId(newTabs[newActiveIndex].id);
      } else if (newTabs.length === 0) {
        setActiveTabId(null);
      }

      return newTabs;
    });
  };

  // Handle detach pane - extract a pane from current tab and create a new tab with it
  const handleDetachPane = (paneId: string) => {
    console.log('[MainScreen] Detaching pane:', paneId);

    if (!activeTabId) return;

    const activeTab = tabGroups.find(t => t.id === activeTabId);
    if (!activeTab) return;

    // Extract the pane from the current tab's tree
    const { extractedPane, remainingTree } = extractPane(activeTab.paneTree, paneId);

    if (!extractedPane) {
      console.error('[MainScreen] Failed to extract pane:', paneId);
      return;
    }

    // Create a new tab with the extracted pane
    const newTab: Tab = {
      id: crypto.randomUUID(),
      name: extractedPane.session.connectionName,
      paneTree: { ...extractedPane, isFocused: true },
    };

    // Update tab groups
    setTabGroups(prev => {
      // If remaining tree is empty, remove the old tab
      if (!remainingTree) {
        return [...prev.filter(t => t.id !== activeTabId), newTab];
      }

      // Otherwise, update the old tab and add the new one
      return [
        ...prev.map(t => t.id === activeTabId ? { ...t, paneTree: remainingTree } : t),
        newTab,
      ];
    });

    // Switch to the newly created tab
    setActiveTabId(newTab.id);
  };

  // Handle rename tab
  const handleRenameTab = (tabId: string, newName: string) => {
    console.log('[MainScreen] Renaming tab:', tabId, 'to:', newName);
    setTabGroups(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, name: newName } : tab
    ));
  };

  // Handle merge tab - drag a tab and drop it into another tab's pane area
  const handleMergeTab = (sourceTabId: string, targetTabId: string) => {
    console.log('[MainScreen] Merging tab:', sourceTabId, 'into:', targetTabId);

    if (sourceTabId === targetTabId) return;

    const sourceTab = tabGroups.find(t => t.id === sourceTabId);
    const targetTab = tabGroups.find(t => t.id === targetTabId);

    if (!sourceTab || !targetTab || !sourceTab.paneTree || !targetTab.paneTree) return;

    // Get all panes from source tab
    const sourcePanes = getAllPanes(sourceTab.paneTree);
    if (sourcePanes.length === 0) return;

    // Merge by splitting the target tab with the first pane from source
    // For simplicity, we'll add the entire source tree as a vertical split
    const mergedTree = {
      id: crypto.randomUUID(),
      type: 'split' as const,
      direction: 'vertical' as const,
      ratio: 0.5,
      children: [targetTab.paneTree, sourceTab.paneTree] as [any, any],
    };

    // Update tabs: remove source, update target
    setTabGroups(prev =>
      prev
        .filter(t => t.id !== sourceTabId)
        .map(t => t.id === targetTabId ? { ...t, paneTree: mergedTree } : t)
    );

    // Keep active tab on the merged one
    setActiveTabId(targetTabId);
  };

  // Handle reorganize pane - drag a pane within the same tab to reorganize layout
  const handleReorganizePane = (
    sourcePaneId: string,
    targetPaneId: string,
    position: 'top' | 'bottom' | 'left' | 'right'
  ) => {
    console.log('[MainScreen] Reorganizing pane:', sourcePaneId, 'to', position, 'of', targetPaneId);

    if (!activeTabId) return;

    const activeTab = tabGroups.find(t => t.id === activeTabId);
    if (!activeTab || !activeTab.paneTree) return;

    // Use the reorganizePane utility to restructure the tree
    const reorganizedTree = reorganizePane(activeTab.paneTree, sourcePaneId, targetPaneId, position);

    // Update the active tab with the new tree
    setTabGroups(prev => prev.map(tab =>
      tab.id === activeTabId ? { ...tab, paneTree: reorganizedTree } : tab
    ));
  };

  // Handle save Quick SSH connection
  const handleSaveQuickSSH = (sessionId: string) => {
    console.log('[MainScreen] Save Quick SSH connection requested for session:', sessionId);

    // Get connection info for this session
    const connectionInfo = quickSSHConnections.get(sessionId);
    if (!connectionInfo) {
      console.error('[MainScreen] No connection info found for session:', sessionId);
      return;
    }

    // Check if app is locked
    if (isLocked) {
      console.log('[MainScreen] App is locked, showing unlock modal and storing pending action');

      // Store the action to execute after unlock
      setPendingActionAfterUnlock(() => () => {
        console.log('[MainScreen] Executing pending Quick SSH save after unlock');
        setConnectionFormPrefill(connectionInfo);
        setEditingConnection(null);
        setShowForm(true);
      });

      setShowUnlockModal(true);
      return;
    }

    // Store prefill data and open form for creating new connection
    setConnectionFormPrefill(connectionInfo);
    setEditingConnection(null); // null = creating new connection
    setShowForm(true);
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <img src={riteLandscape} alt="RITE" className="h-10 rounded-md" />
          </div>

          <div className="flex items-center gap-2">
            {/* New Local Terminal - always visible */}
            <button
              onClick={() => handleNewLocalTerminal()}
              className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              title={`New Local Terminal (${settings.defaultShell.split('/').pop()})`}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              <span>Local Terminal</span>
            </button>

            {/* Default Shell Selector */}
            <button
              ref={defaultShellButtonRef}
              onClick={async () => {
                if (!showDefaultShellDropdown) {
                  // Check installed shells before opening dropdown
                  await checkInstalledShells();
                }
                setShowDefaultShellDropdown(!showDefaultShellDropdown);
              }}
              className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
              title="Select default shell"
            >
              <span className="text-base">{shells.find(s => s.path === settings.defaultShell)?.icon || '🐚'}</span>
              <span className="text-xs text-muted-foreground">{settings.defaultShell.split('/').pop()}</span>
              <svg className="h-3 w-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Quick SSH - always visible */}
            <button
              onClick={() => setShowQuickSSH(true)}
              className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
              title="Quick SSH Connect"
            >
              <span className="text-base">⚡</span>
              <span>Quick SSH</span>
            </button>

            {/* Unlock/Lock button */}
            {isLocked ? (
              <button
                onClick={() => setShowUnlockModal(true)}
                className="flex items-center gap-2 rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/20 transition-colors"
                title="Unlock Vault"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                </svg>
                <span>Unlock</span>
              </button>
            ) : (
              <>
                <button
                  onClick={() => setShowSettings(true)}
                  className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
                  title={t('settings.title')}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
                <button
                  onClick={() => lock()}
                  className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
                  title={t('main.lock')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-4 w-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  <span>{t('main.lock')}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden relative">
        {/* Sidebar - only visible when unlocked */}
        {!isLocked && (
          <aside className={`border-r border-border bg-card flex flex-col transition-all duration-300 overflow-hidden ${
            isSidebarOpen ? 'w-80' : 'w-0'
          }`}>
          <div className="p-4 border-b border-border space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-muted-foreground">{t('main.connections')}</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleNewConnection}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                  title={t('main.newConnection')}
                >
                  {t('main.newConnection')}
                </button>
                <button
                  onClick={() => setIsSidebarOpen(false)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted transition-colors"
                  title="Hide sidebar"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                  </svg>
                </button>
              </div>
            </div>
            <button
              onClick={() => setShowCollectionsManager(true)}
              className="w-full flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
              title={t('connections.collectionManage')}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              {t('connections.collectionManage')}
            </button>
            <button
              onClick={() => setShowImportSSH(true)}
              className="w-full flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
              title="Import from SSH config"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              Import SSH Config
            </button>
          </div>

          {/* Connection List */}
          <div className="flex-1 overflow-y-auto">
            <ConnectionList
              connections={connections}
              selectedId={selectedConnectionId}
              onSelect={selectConnection}
              onEdit={handleEditConnection}
              onDelete={handleDeleteConnection}
              onConnect={handleConnect}
            />
          </div>
        </aside>
        )}

        {/* Hover zone and toggle button when sidebar is closed */}
        {!isLocked && !isSidebarOpen && (
          <div className="absolute left-0 top-0 h-full w-12 z-10 group">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className={`absolute left-0 top-1/2 -translate-y-1/2 bg-card border border-border rounded-r-md p-2 hover:bg-muted transition-all shadow-lg ${
                showSidebarButton
                  ? 'opacity-100 animate-pulse'
                  : 'opacity-0 group-hover:opacity-100'
              }`}
              title="Show sidebar"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}

        {/* Main panel - Terminal Manager */}
        <ErrorBoundary level="feature" name="TerminalManager">
          <TerminalManager
            tabGroups={tabGroups}
            activeTabId={activeTabId}
            onSplitPane={handleSplitPane}
            onClosePane={handleClosePane}
            onFocusPane={handleFocusPane}
            onSplitRatioChange={handleSplitRatioChange}
            onSwitchTab={handleSwitchTab}
            onReorderTabs={handleReorderTabs}
            onDetachPane={handleDetachPane}
            onRenameTab={handleRenameTab}
            onMergeTab={handleMergeTab}
            onCloseTab={handleCloseTab}
            onReorganizePane={handleReorganizePane}
            onNewLocalTerminal={handleNewLocalTerminal}
            onSaveQuickSSH={handleSaveQuickSSH}
            quickSSHSessions={Array.from(quickSSHConnections.keys())}
          />
        </ErrorBoundary>
      </main>

      {/* Connection Form Modal */}
      {showForm && (
        <ConnectionForm
          connection={editingConnection}
          prefillData={connectionFormPrefill}
          onClose={() => {
            setShowForm(false);
            setEditingConnection(null);
            setConnectionFormPrefill(null);
          }}
          onSuccess={() => {
            fetchConnections();
            setConnectionFormPrefill(null);
          }}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && connectionToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
            <h2 className="mb-4 text-xl font-bold">{t('connections.delete')}</h2>
            <p className="mb-6 text-sm text-muted-foreground">
              {t('connections.deleteConfirm')}
            </p>
            <p className="mb-6 font-medium">{connectionToDelete.name}</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setConnectionToDelete(null);
                }}
                className="rounded bg-secondary px-4 py-2 font-medium text-secondary-foreground hover:bg-secondary/80"
              >
                {t('connections.cancel')}
              </button>
              <button
                onClick={confirmDelete}
                className="rounded bg-red-500 px-4 py-2 font-medium text-white hover:bg-red-600"
              >
                {t('connections.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Collections Manager Modal */}
      {showCollectionsManager && (
        <CollectionsManager onClose={() => setShowCollectionsManager(false)} />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <Settings onClose={() => setShowSettings(false)} />
      )}

      {/* Quick SSH Modal */}
      {showQuickSSH && (
        <QuickSSHModal
          onClose={() => setShowQuickSSH(false)}
          onConnected={handleQuickSSHConnected}
        />
      )}

      {/* Import SSH Config Modal */}
      {showImportSSH && (
        <ImportSSHConfigModal
          onClose={() => setShowImportSSH(false)}
          onImported={(count) => {
            fetchConnections();
            setToastType('success');
            setToastMessage(`Successfully imported ${count} connection${count !== 1 ? 's' : ''}`);
          }}
        />
      )}

      {/* Unlock Modal */}
      {showUnlockModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-lg">
            <UnlockScreen asModal onClose={() => setShowUnlockModal(false)} />
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <Toast
          message={toastMessage}
          type={toastType}
          onClose={() => {
            setToastMessage(null);
            setToastAction(undefined);
          }}
          action={toastAction}
        />
      )}

      {/* Default Shell Dropdown (Portal) */}
      {showDefaultShellDropdown && createPortal(
        <>
          <div
            className="fixed inset-0 z-[100]"
            onClick={() => setShowDefaultShellDropdown(false)}
          />

          <div
            className="fixed z-[110] min-w-[300px] rounded-md border border-border bg-card shadow-xl"
            style={{
              top: `${defaultShellDropdownPosition.top}px`,
              left: `${defaultShellDropdownPosition.left}px`,
            }}
          >
            <div className="p-2 border-b border-border">
              <p className="text-xs font-medium text-muted-foreground">Default Shell</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Used when clicking "+ Local Terminal"
              </p>
            </div>
            {shells.map((shell, index) => {
              const isInstalled = installedShells.includes(shell.path);
              return (
                <button
                  key={shell.path}
                  onClick={async () => {
                    if (!isInstalled) {
                      setToastType('error');
                      setToastMessage(`${shell.name} is not installed on this system`);
                      setShowDefaultShellDropdown(false);
                      return;
                    }
                    await updateSettings({ defaultShell: shell.path });
                    setShowDefaultShellDropdown(false);
                    setToastType('success');
                    setToastMessage(`${shell.name} set as default shell`);
                  }}
                  disabled={!isInstalled}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left transition-colors ${
                    index === 0 ? 'rounded-t-md' : ''
                  } ${index === shells.length - 1 ? 'rounded-b-md' : ''} ${
                    settings.defaultShell === shell.path ? 'bg-primary/10' : ''
                  } ${
                    isInstalled ? 'hover:bg-muted cursor-pointer' : 'opacity-50 cursor-not-allowed'
                  }`}
                  title={!isInstalled ? `${shell.name} is not installed` : ''}
                >
                  <span className="text-lg">{shell.icon}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{shell.name}</span>
                      {!isInstalled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-500 border border-red-500/30">
                          Not installed
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">{shell.path}</span>
                  </div>
                  {settings.defaultShell === shell.path && (
                    <span className="text-lg text-yellow-500">⭐</span>
                  )}
                </button>
              );
            })}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
