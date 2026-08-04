/**
 * Workspace — the context-agnostic app surface (connections + terminals + panes).
 *
 * Shared across contexts (local vault, remote server, web). It knows nothing about
 * *how* auth works: the enclosing shell passes an `auth` prop (is the vault
 * locked? how to lock? how to render the unlock modal?), so the same workspace
 * serves the local master-password vault and the accounts session (ADR 0014).
 */

import { useEffect, useState, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Backend } from '../utils/backend';
import { type ConnectionInfo, type ConnectionsSource } from '../store/connectionsStore';
import { useSettingsStore } from '../store/settingsStore';
import { useTranslation } from '../i18n/i18n';
import { LibrarySidebar } from './LibrarySidebar';
import { ConnectionForm } from './ConnectionForm';
import { TerminalManager, type TerminalSession } from './TerminalManager';
import { CollectionView } from './CollectionView';
import { MemberPicker } from './MemberPicker';
import { CollectionEditDialog } from './CollectionEditDialog';
import { CollectionFolderDialog } from './CollectionFolderDialog';
import { IconTerminal, IconBolt, IconGear, IconLock, IconChevronDown } from './icons';
import { LibraryFolderDialog } from './LibraryFolderDialog';
import { MoveToFolderDialog } from './MoveToFolderDialog';
import { MoveMachineDialog } from './MoveMachineDialog';
import { useLibraryTree } from '../store/libraryTree';
import { useServerSession } from '../store/serverSessionStore';
import { deleteCollectionFolder } from '../utils/collectionHeader';
import { Settings } from './Settings';
import { QuickSSHModal, type QuickSSHConnectionInfo } from './QuickSSHModal';
import { ImportSSHConfigModal } from './ImportSSHConfigModal';
import { ImportSSHPasteModal } from './ImportSSHPasteModal';
import { HostKeyModal, type HostKeyPrompt } from './HostKeyModal';
import { ContextPill } from './ContextPill';
import {
  isNativeShell,
  nativeVaults,
  nativeContext,
  sendVaultCommand,
  requestOpenContext,
} from '../utils/nativeShell';
import { transport } from '../utils/transport';
import { Toast } from './Toast';
import { ErrorBoundary } from './ErrorBoundary';
import { AnyPaneNode, SplitDirection, Tab } from '../types/pane';
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
import riteLandscape from '../assets/rite.png';

/**
 * How the enclosing shell exposes its auth/lock to the workspace. Local vault:
 * master-password lock + UnlockScreen. Accounts (later): the vault-key idle lock.
 */
export interface WorkspaceAuth {
  isLocked: boolean;
  lock: () => void;
  renderUnlockModal: (props: { onClose: () => void }) => ReactNode;
  // Label for the lock/sign-out button. Local vault → "Lock"; an accounts session
  // has no separate lock (the key lives in RAM), so it signs out → "Sign out".
  lockLabel?: string;
}

export function Workspace({
  auth,
  conns,
  headerExtra,
  instanceName,
}: {
  auth: WorkspaceAuth;
  conns: ConnectionsSource;
  // A shell-provided slot in the header's action cluster (e.g. the admin surface
  // entry for an org-admin). Context-agnostic: local shells pass nothing.
  headerExtra?: ReactNode;
  // A global instance name (accounts context) shown by the brand so users can
  // tell which server they're on. The browser has no context pill.
  instanceName?: string | null;
}) {
  const { isLocked, lock } = auth;
  const { t } = useTranslation();
  const lockLabel = auth.lockLabel ?? t('main.lock');
  // Locked-state vault picker (ADR 0014 multi-vault): the vaults the shell knows about + which
  // one this window holds, so "no vault open" offers the list + new/open instead of one button.
  const lockedVaults = isNativeShell() ? nativeVaults() : [];
  const currentVaultPath = nativeContext()?.path ?? null;
  const { connections, selectedConnectionId } = conns;
  const fetchConnections = conns.refresh;
  const deleteConnection = conns.remove;
  const selectConnection = conns.select;
  const { settings, fetchSettings, updateSettings } = useSettingsStore();

  const [showForm, setShowForm] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionInfo | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [connectionToDelete, setConnectionToDelete] = useState<ConnectionInfo | null>(null);
  const [showImportSSH, setShowImportSSH] = useState(false);
  const [importCollectionId, setImportCollectionId] = useState<string | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [sidebarQuery, setSidebarQuery] = useState('');

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
  const [showVaultPicker, setShowVaultPicker] = useState(false); // multi-vault picker (ADR 0014)

  // Collection opened in the main area (ADR 0016): which one + which main view is
  // showing (terminal is kept mounted underneath). Plus the members dialog target
  // and the create-into-collection default for the machine form.
  const [openCollectionId, setOpenCollectionId] = useState<string | null>(null);
  const [mainView, setMainView] = useState<'terminal' | 'collection'>('terminal');
  const [membersCollectionId, setMembersCollectionId] = useState<string | null>(null);
  const [formDefaultCollectionId, setFormDefaultCollectionId] = useState<string | null>(null);
  const [formDefaultFolder, setFormDefaultFolder] = useState<string | null>(null);
  const [collectionEdit, setCollectionEdit] = useState<{ id?: string; name?: string; color?: string | null } | null>(null);
  const [showNewCollection, setShowNewCollection] = useState(false);
  // When a new collection is created from a root folder's ＋, place it there.
  const [pendingCollectionFolder, setPendingCollectionFolder] = useState<string | null>(null);
  // Collection sub-folder dialog (create top-level / sub-folder / rename) + delete.
  const [folderDialog, setFolderDialog] = useState<{
    collectionId: string;
    parentPath?: string | null;
    renamePath?: string;
    initialName?: string;
    initialColor?: string | null;
  } | null>(null);
  const [deleteSubfolder, setDeleteSubfolder] = useState<{ collectionId: string; path: string } | null>(null);
  // Server session keys (accounts context) for the folder-delete re-tag; null in local.
  const serverKeys = useServerSession();
  // Quick SSH is a server-governed capability: forbidden when a server says so (off by
  // default). In a local vault (not accounts) the user is their own authority → allowed.
  const allowQuickSsh = !serverKeys.mode?.accounts || serverKeys.mode?.allowQuickSsh === true;
  // In a server context terminals run on the server, so the shell is the server's default
  // (no local-shell picker); locally, the user picks their own shell.
  const isServerCtx = !!serverKeys.mode?.accounts;
  const serverShell = serverKeys.mode?.defaultShell ?? 'bash';
  const [deleteCollectionTarget, setDeleteCollectionTarget] = useState<{ id: string; name: string } | null>(null);
  // Top-level library folders (ADR 0016 view hierarchy) — the encrypted per-user tree.
  const tree = useLibraryTree();
  const [libraryFolderEdit, setLibraryFolderEdit] = useState<{ id?: string; name?: string; color?: string | null; parent?: string | null } | null>(null);
  const [moveCollectionTarget, setMoveCollectionTarget] = useState<{ id: string; name: string } | null>(null);
  const [moveMachineTarget, setMoveMachineTarget] = useState<ConnectionInfo | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<{ id: string; name: string } | null>(null);

  // Host-key confirmation (strict mode): the pending prompt + the connection that
  // triggered it, so accepting can retry that exact connection.
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt | null>(null);
  const [hostKeyBusy, setHostKeyBusy] = useState(false);
  const lastConnectionRef = useRef<ConnectionInfo | null>(null);

  // Surface strict-mode host-key prompts emitted by the backend over the transport.
  useEffect(() => {
    let unlistenUnknown: (() => void) | undefined;
    let unlistenChanged: (() => void) | undefined;
    void (async () => {
      unlistenUnknown = await transport().listen<HostKeyPrompt>('ssh:host-key-unknown', (p) =>
        setHostKeyPrompt({ ...p, changed: false }),
      );
      unlistenChanged = await transport().listen<{
        host: string;
        port: number;
        oldFingerprint: string;
        newFingerprint: string;
      }>('ssh:host-key-changed', (p) =>
        setHostKeyPrompt({
          host: p.host,
          port: p.port,
          fingerprint: p.newFingerprint,
          oldFingerprint: p.oldFingerprint,
          changed: true,
        }),
      );
    })();
    return () => {
      unlistenUnknown?.();
      unlistenChanged?.();
    };
  }, []);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the one-shot pending action after running it
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
      const installed = await Backend.Terminal.getInstalledShells(allShellPaths);
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- close the unlock modal once the vault is unlocked
      setShowUnlockModal(false);
      fetchConnections();
    }
  }, [isLocked, showUnlockModal, fetchConnections]);

  // Show sidebar button for 3 seconds when sidebar closes
  useEffect(() => {
    // React to the sidebar opening/closing to drive the reveal button.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!isSidebarOpen) {
      setShowSidebarButton(true);
      const timer = setTimeout(() => {
        setShowSidebarButton(false);
      }, 3000);
      return () => clearTimeout(timer);
    } else {
      setShowSidebarButton(false);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
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

    let timeoutId: ReturnType<typeof setTimeout>;

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

    let clipboardTimeoutId: ReturnType<typeof setTimeout>;

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
    // Remember the attempt so an accepted host-key prompt can retry it.
    lastConnectionRef.current = connection;

    try {
      // Open a session for this connection via the context's source (local =
      // server-decrypts; accounts = browser-decrypts → server-execute).
      const sessionId = await conns.connect(connection);

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

      // Strict-mode host-key rejection ("Disconnected"): the backend also emits
      // ssh:host-key-unknown, which opens the confirmation modal — don't also toast.
      if (errorMsg.includes('Disconnect')) {
        return;
      }

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

  // Trust the pending host key, then retry the connection that triggered it.
  const handleAcceptHostKey = async () => {
    if (!hostKeyPrompt) return;
    setHostKeyBusy(true);
    try {
      await Backend.Ssh.acceptHostKey(hostKeyPrompt.host, hostKeyPrompt.port);
      setHostKeyPrompt(null);
      if (lastConnectionRef.current) {
        await handleConnect(lastConnectionRef.current);
      }
    } catch (error) {
      console.error('[MainScreen] Failed to accept host key:', error);
      setToastType('error');
      setToastMessage('Failed to trust host key');
    } finally {
      setHostKeyBusy(false);
    }
  };

  // Dismiss the prompt (drop the pending key unless it was a changed-key alert).
  const handleRejectHostKey = async () => {
    if (!hostKeyPrompt) return;
    setHostKeyBusy(true);
    try {
      if (!hostKeyPrompt.changed) {
        await Backend.Ssh.rejectHostKey(hostKeyPrompt.host, hostKeyPrompt.port);
      }
    } catch (error) {
      console.error('[MainScreen] Failed to reject host key:', error);
    } finally {
      setHostKeyPrompt(null);
      setHostKeyBusy(false);
    }
  };

  // Handle new local terminal
  const handleNewLocalTerminal = async (shell?: string) => {
    // Use provided shell or fall back to settings default
    const shellToUse = shell || settings.defaultShell;
    console.log('[MainScreen] Creating local terminal session with shell:', shellToUse);

    try {
      // Call backend to create local terminal session with selected shell
      const sessionId = await Backend.Terminal.connectLocalTerminal(shellToUse);

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
      const sessionId = await Backend.Terminal.connectLocalTerminal(shellToUse);

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
          await Backend.Terminal.disconnectTerminal(session.id);
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
      children: [targetTab.paneTree, sourceTab.paneTree] as [AnyPaneNode, AnyPaneNode],
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

  // Open a collection in the main area (from the sidebar).
  const handleOpenCollection = (collectionId: string) => {
    setOpenCollectionId(collectionId);
    setMainView('collection');
  };
  const handleCloseCollection = () => {
    setOpenCollectionId(null);
    setMainView('terminal');
  };

  // Sidebar collection actions (accounts context).
  const isAccountsContext = conns.writableCollections !== undefined;
  const handleNewMachineInCollection = (collectionId: string, folder: string | null = null) => {
    setFormDefaultCollectionId(collectionId);
    setFormDefaultFolder(folder);
    setEditingConnection(null);
    setConnectionFormPrefill(null);
    setShowForm(true);
  };
  const handleDeleteCollectionConfirmed = async () => {
    if (!deleteCollectionTarget) return;
    const { id } = deleteCollectionTarget;
    try {
      await Backend.Collections.remove(id);
      if (openCollectionId === id) handleCloseCollection();
      await conns.refresh();
    } catch (err) {
      console.error('Failed to delete collection:', err);
    } finally {
      setDeleteCollectionTarget(null);
    }
  };

  // Derive the open collection's machines + header from the decrypted connections.
  const openCollectionMachines = openCollectionId
    ? conns.connections.filter((c) => c.collectionId === openCollectionId)
    : [];
  const openCollectionMeta = openCollectionMachines[0];
  const openCol = conns.collections?.find((c) => c.id === openCollectionId);
  const openCollectionName = openCol?.name ?? openCollectionMeta?.collectionName ?? 'Collection';
  const openCollectionColor = openCol?.color ?? openCollectionMeta?.collectionColor ?? null;
  const openCollectionRole = openCol?.role ?? openCollectionMeta?.collectionRole ?? null;
  const openCollectionWritable = openCollectionRole === 'owner' || openCollectionRole === 'editor';

  // Folder paths available as move destinations for a machine, sorted. In a
  // collection: its declared folders + those inferred from its machines. In local
  // context (no collection): every folder used across the personal machines.
  const folderPathsForMachine = (m: ConnectionInfo): string[] => {
    const s = new Set<string>();
    const add = (p: string) => {
      const segs = p.split('/');
      for (let i = 1; i <= segs.length; i++) s.add(segs.slice(0, i).join('/'));
    };
    if (m.collectionId) {
      const declared = conns.collections?.find((c) => c.id === m.collectionId)?.folders ?? [];
      for (const f of declared) if (f.name) add(f.name);
      for (const c of conns.connections) if (c.collectionId === m.collectionId && c.folder) add(c.folder);
    } else {
      for (const c of conns.connections) if (!c.collectionId && c.folder) add(c.folder);
    }
    return [...s].sort((a, b) => a.localeCompare(b));
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header (design mock: brand · context pill · actions) */}
      <header className="m-appbar">
        <div className="m-brand">
          <img src={riteLandscape} alt="Rite" className="h-[26px] rounded-[7px]" />
        </div>
        {instanceName && (
          <span className="m-chip" title="Server instance">
            <span className="m-dot" />
            {instanceName}
          </span>
        )}
        <ContextPill />
        <span className="m-spacer" />

        {/* New Terminal — server shell in a server context, the local pick otherwise */}
        <button
          onClick={() => handleNewLocalTerminal(isServerCtx ? serverShell : undefined)}
          className="m-btn m-btn-primary m-btn-sm"
          title={
            isServerCtx
              ? `New server terminal (${serverShell})`
              : `New Local Terminal (${settings.defaultShell.split('/').pop()})`
          }
        >
          <IconTerminal className="h-4 w-4" />
          <span className="hidden md:inline">Terminal</span>
        </button>

        {/* Local-shell selector — hidden in a server context (the server sets the shell) */}
        {!isServerCtx && (
        <button
          ref={defaultShellButtonRef}
          onClick={async () => {
            if (!showDefaultShellDropdown) await checkInstalledShells();
            setShowDefaultShellDropdown(!showDefaultShellDropdown);
          }}
          className="m-btn m-btn-sm"
          title="Select default shell"
        >
          <span>{shells.find((s) => s.path === settings.defaultShell)?.icon || '🐚'}</span>
          <span className="hidden text-muted-foreground md:inline">{settings.defaultShell.split('/').pop()}</span>
          <IconChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
        )}

        {/* Quick SSH — hidden when the server forbids it (server-governed capability) */}
        {allowQuickSsh && (
          <button onClick={() => setShowQuickSSH(true)} className="m-btn m-btn-sm" title="Quick SSH Connect">
            <IconBolt className="h-4 w-4" />
            <span className="hidden md:inline">Quick SSH</span>
          </button>
        )}

        {/* Shell-provided actions (e.g. the org-admin surface entry). */}
        {headerExtra}

        {isLocked ? (
          <button onClick={() => setShowUnlockModal(true)} className="m-btn m-btn-primary m-btn-sm" title="Unlock Vault">
            <IconLock className="h-4 w-4" />
            <span className="hidden md:inline">Unlock</span>
          </button>
        ) : (
          <>
            <button onClick={() => setShowSettings(true)} className="m-btn m-btn-ghost m-btn-sm" title={t('settings.title')}>
              <IconGear className="h-4 w-4" />
            </button>
            <button onClick={() => lock()} className="m-btn m-btn-ghost m-btn-sm" title={lockLabel}>
              <IconLock className="h-4 w-4" />
              <span className="hidden md:inline">{lockLabel}</span>
            </button>
          </>
        )}
      </header>

      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden relative">
        {/* Sidebar: saved connections when a vault is open; otherwise a prompt to
            open one (the local terminal + Quick SSH in the header work without it). */}
        <aside className={`m-side border-r border-border flex flex-col transition-all duration-300 overflow-hidden ${
          isSidebarOpen ? 'w-[290px]' : 'w-0'
        }`}>
          {isLocked ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-muted-foreground">
                Open a vault to see your saved connections. The local terminal and
                Quick SSH work without one.
              </p>
              <button
                onClick={() => (lockedVaults.length > 0 ? setShowVaultPicker(true) : setShowUnlockModal(true))}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Open local vault
              </button>
            </div>
          ) : (
          <>
          {/* Search (design mock: at the top of the sidebar) */}
          <div className="m-search">
            <svg className="h-4 w-4 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
            </svg>
            <input
              value={sidebarQuery}
              onChange={(e) => setSidebarQuery(e.target.value)}
              placeholder="Search connections…"
            />
          </div>

          {/* Library header row: eyebrow · + menu · collapse */}
          <div className="m-side-hdr">
            <span className="m-eyebrow">Library</span>
            <div className="relative ml-auto flex items-center gap-1">
              <button
                onClick={() => setShowNewMenu((v) => !v)}
                aria-label="Add to library"
                title="Add to library"
                className="m-btn m-btn-ghost"
                style={{ padding: '4px' }}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
                </svg>
              </button>
              {showNewMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowNewMenu(false)} />
                  <div className="m-menu absolute right-0 top-full z-20 mt-1">
                    {isAccountsContext ? (
                      // No loose machines (ADR 0016): machines & import are
                      // collection-scoped — the library + creates folders & collections.
                      <>
                        <button onClick={() => { setShowNewMenu(false); setLibraryFolderEdit({}); }}>
                          <svg className="h-4 w-4 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                          </svg>
                          New folder…
                        </button>
                        <button onClick={() => { setShowNewMenu(false); setShowNewCollection(true); }}>
                          <svg className="h-4 w-4 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 12L12 17l8.5-5M3.5 16L12 21l8.5-5" />
                          </svg>
                          New collection…
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => { setShowNewMenu(false); handleNewConnection(); }}>New machine…</button>
                        <button onClick={() => { setShowNewMenu(false); setShowImportSSH(true); }}>Import from SSH config…</button>
                      </>
                    )}
                  </div>
                </>
              )}
              <button
                onClick={() => setIsSidebarOpen(false)}
                className="m-btn m-btn-ghost"
                style={{ padding: '4px' }}
                title="Hide sidebar"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                </svg>
              </button>
            </div>
          </div>

          {/* Library tree */}
          <div className="flex-1 overflow-y-auto">
            <LibrarySidebar
              query={sidebarQuery}
              connections={connections}
              selectedId={selectedConnectionId}
              onSelect={selectConnection}
              onEdit={handleEditConnection}
              onDelete={handleDeleteConnection}
              onConnect={handleConnect}
              onMoveMachine={setMoveMachineTarget}
              onOpenCollection={handleOpenCollection}
              openCollectionId={mainView === 'collection' ? openCollectionId : null}
              collections={conns.collections}
              onNewMachineInCollection={isAccountsContext ? handleNewMachineInCollection : undefined}
              onNewFolderInCollection={isAccountsContext ? (id) => setFolderDialog({ collectionId: id }) : undefined}
              onNewSubfolder={
                isAccountsContext
                  ? (id, parentPath) => setFolderDialog({ collectionId: id, parentPath })
                  : undefined
              }
              onNewMachineInFolder={
                isAccountsContext ? (id, folderPath) => handleNewMachineInCollection(id, folderPath) : undefined
              }
              onRenameFolder={
                isAccountsContext
                  ? (id, path, color) =>
                      setFolderDialog({
                        collectionId: id,
                        renamePath: path,
                        initialName: path.split('/').pop() ?? path,
                        initialColor: color,
                      })
                  : undefined
              }
              onDeleteFolder={isAccountsContext ? (id, path) => setDeleteSubfolder({ collectionId: id, path }) : undefined}
              onImportToCollection={
                isAccountsContext
                  ? (id) => {
                      setImportCollectionId(id);
                      setShowImportSSH(true);
                    }
                  : undefined
              }
              onOpenMembers={isAccountsContext ? (id) => setMembersCollectionId(id) : undefined}
              onRenameCollection={
                isAccountsContext ? (id, name, color) => setCollectionEdit({ id, name, color }) : undefined
              }
              onDeleteCollection={isAccountsContext ? (id, name) => setDeleteCollectionTarget({ id, name }) : undefined}
              libraryFolders={isAccountsContext ? tree.folders : undefined}
              collectionPlacement={isAccountsContext ? tree.placement : undefined}
              onNewLibrarySubfolder={isAccountsContext ? (parent) => setLibraryFolderEdit({ parent }) : undefined}
              onNewCollectionInFolder={
                isAccountsContext
                  ? (folderId) => {
                      setPendingCollectionFolder(folderId);
                      setShowNewCollection(true);
                    }
                  : undefined
              }
              onRenameLibraryFolder={
                isAccountsContext ? (id, name, color) => setLibraryFolderEdit({ id, name, color }) : undefined
              }
              onDeleteLibraryFolder={isAccountsContext ? (id, name) => setDeleteFolderTarget({ id, name }) : undefined}
              onMoveCollection={isAccountsContext ? (id, name) => setMoveCollectionTarget({ id, name }) : undefined}
            />
          </div>
          </>
          )}
        </aside>

        {/* Hover zone and toggle button when sidebar is closed */}
        {!isSidebarOpen && (
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

        {/* Main content: a Terminal / Collection tab strip (only when a collection
            is open), then the terminal manager (kept mounted so sessions survive)
            with the collection view overlaid when its tab is active. */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {openCollectionId && (
            <div className="flex items-center gap-1 border-b border-border bg-card px-2 py-1">
              <button
                onClick={() => setMainView('terminal')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
                  mainView === 'terminal' ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 17l6-5-6-5M12 19h8" />
                </svg>
                {t('main.terminal') !== 'main.terminal' ? t('main.terminal') : 'Terminal'}
              </button>
              <div
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
                  mainView === 'collection' ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <button onClick={() => setMainView('collection')} className="flex items-center gap-1.5">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 12L12 17l8.5-5M3.5 16L12 21l8.5-5" />
                  </svg>
                  <span className="max-w-[160px] truncate">{openCollectionName}</span>
                </button>
                <button
                  onClick={handleCloseCollection}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                  aria-label="Close collection"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Collection view overlay (kept above the terminal when its tab is active) */}
            {openCollectionId && mainView === 'collection' && (
              <div className="absolute inset-0 z-10 overflow-hidden bg-background">
                <CollectionView
                  key={openCollectionId}
                  name={openCollectionName}
                  color={openCollectionColor}
                  role={openCollectionRole}
                  machines={openCollectionMachines}
                  folders={openCol?.folders}
                  canWrite={openCollectionWritable}
                  onConnect={handleConnect}
                  onEdit={handleEditConnection}
                  onMove={openCollectionWritable ? setMoveMachineTarget : undefined}
                  onNewMachine={(folderPath) => {
                    setFormDefaultCollectionId(openCollectionId);
                    setFormDefaultFolder(folderPath ?? null);
                    setEditingConnection(null);
                    setConnectionFormPrefill(null);
                    setShowForm(true);
                  }}
                  onNewFolder={(parentPath) =>
                    openCollectionId && setFolderDialog({ collectionId: openCollectionId, parentPath })
                  }
                  onImport={() => {
                    setImportCollectionId(openCollectionId);
                    setShowImportSSH(true);
                  }}
                  isPersonal={openCol?.isPersonal}
                  onOpenMembers={openCol?.isPersonal ? undefined : () => setMembersCollectionId(openCollectionId)}
                />
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
          </div>
        </div>
      </main>

      {/* Connection Form Modal */}
      {showForm && (
        <ConnectionForm
          connection={editingConnection}
          prefillData={connectionFormPrefill}
          create={conns.create}
          update={conns.update}
          collectionTargets={conns.writableCollections}
          defaultCollectionId={formDefaultCollectionId}
          defaultFolder={formDefaultFolder}
          onClose={() => {
            setShowForm(false);
            setEditingConnection(null);
            setConnectionFormPrefill(null);
            setFormDefaultCollectionId(null);
            setFormDefaultFolder(null);
          }}
          onSuccess={() => {
            fetchConnections();
            setConnectionFormPrefill(null);
          }}
        />
      )}

      {/* Collection sharing — the member picker (edit) / new collection (create) */}
      {membersCollectionId && (
        <MemberPicker
          mode="edit"
          collectionId={membersCollectionId}
          initialName={
            conns.connections.find((c) => c.collectionId === membersCollectionId)?.collectionName ??
            conns.writableCollections?.find((c) => c.id === membersCollectionId)?.name ??
            ''
          }
          onClose={() => setMembersCollectionId(null)}
          onSaved={fetchConnections}
        />
      )}
      {showNewCollection && (
        <MemberPicker
          mode="create"
          onClose={() => {
            setShowNewCollection(false);
            setPendingCollectionFolder(null);
          }}
          onSaved={fetchConnections}
          onCreated={(id) => {
            if (pendingCollectionFolder) tree.moveCollection(id, pendingCollectionFolder);
          }}
        />
      )}
      {folderDialog && (
        <CollectionFolderDialog
          collectionId={folderDialog.collectionId}
          collectionName={conns.collections?.find((c) => c.id === folderDialog.collectionId)?.name ?? openCollectionName}
          parentPath={folderDialog.parentPath}
          renamePath={folderDialog.renamePath}
          initialName={folderDialog.initialName}
          initialColor={folderDialog.initialColor}
          onClose={() => setFolderDialog(null)}
          onSaved={fetchConnections}
        />
      )}
      {deleteSubfolder && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => setDeleteSubfolder(null)}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-lg font-semibold">Delete folder “{deleteSubfolder.path.split('/').pop()}”?</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              The folder and its sub-folders are removed for everyone in the collection. Machines inside move up to the
              parent folder — nothing is deleted.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteSubfolder(null)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
                Cancel
              </button>
              <button
                onClick={async () => {
                  const target = deleteSubfolder;
                  setDeleteSubfolder(null);
                  if (!serverKeys.publicKey || !serverKeys.privateKey) return;
                  try {
                    await deleteCollectionFolder(target.collectionId, serverKeys.publicKey, serverKeys.privateKey, target.path);
                    await fetchConnections();
                  } catch (err) {
                    console.error('Failed to delete folder:', err);
                  }
                }}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top-level personal folders (ADR 0016 view hierarchy) */}
      {libraryFolderEdit && (
        <LibraryFolderDialog
          initialName={libraryFolderEdit.id ? libraryFolderEdit.name : undefined}
          initialColor={libraryFolderEdit.color}
          onClose={() => setLibraryFolderEdit(null)}
          onSave={(name, color) =>
            libraryFolderEdit.id
              ? tree.renameFolder(libraryFolderEdit.id, name, color)
              : tree.createFolder(name, color, libraryFolderEdit.parent ?? null)
          }
        />
      )}
      {moveCollectionTarget && (
        <MoveToFolderDialog
          collectionName={moveCollectionTarget.name}
          folders={tree.folders}
          current={tree.placement[moveCollectionTarget.id] ?? null}
          onClose={() => setMoveCollectionTarget(null)}
          onPick={(folderId) => tree.moveCollection(moveCollectionTarget.id, folderId)}
        />
      )}
      {moveMachineTarget && (
        <MoveMachineDialog
          machineName={moveMachineTarget.name}
          currentFolder={moveMachineTarget.folder ?? ''}
          folderPaths={folderPathsForMachine(moveMachineTarget)}
          rootLabel={moveMachineTarget.collectionId ? 'Collection root' : 'No folder (root)'}
          onClose={() => setMoveMachineTarget(null)}
          onPick={async (folder) => {
            await conns.update({ id: moveMachineTarget.id, folder });
            await fetchConnections();
          }}
        />
      )}
      {deleteFolderTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => setDeleteFolderTarget(null)}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-lg font-semibold">Delete folder “{deleteFolderTarget.name}”?</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              This only removes the folder from your view — the collections in it move back to the root. Nothing is
              deleted or unshared.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteFolderTarget(null)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
                Cancel
              </button>
              <button
                onClick={() => {
                  tree.deleteFolder(deleteFolderTarget.id);
                  setDeleteFolderTarget(null);
                }}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / rename collection dialog (ADR 0016) */}
      {collectionEdit && (
        <CollectionEditDialog
          collectionId={collectionEdit.id}
          initialName={collectionEdit.name}
          initialColor={collectionEdit.color}
          onClose={() => setCollectionEdit(null)}
          onSaved={fetchConnections}
        />
      )}

      {/* Delete collection confirmation (ADR 0016) */}
      {deleteCollectionTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => setDeleteCollectionTarget(null)}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-lg font-semibold">Delete “{deleteCollectionTarget.name}”?</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              This permanently deletes the collection and its machines for everyone. Members lose access. This cannot be
              undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteCollectionTarget(null)}
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteCollectionConfirmed}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
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

      {/* Settings Modal */}
      {showSettings && (
        <Settings onClose={() => setShowSettings(false)} />
      )}

      {/* Quick SSH Modal */}
      {showQuickSSH && (
        <QuickSSHModal
          onClose={() => setShowQuickSSH(false)}
          onConnected={handleQuickSSHConnected}
          collectionTargets={conns.writableCollections}
          onSaveToCollection={conns.create}
        />
      )}

      {/* SSH host-key confirmation (strict mode) */}
      {hostKeyPrompt && (
        <HostKeyModal
          prompt={hostKeyPrompt}
          busy={hostKeyBusy}
          onAccept={handleAcceptHostKey}
          onReject={handleRejectHostKey}
        />
      )}

      {/* Import SSH Config Modal */}
      {showImportSSH &&
        (isAccountsContext ? (
          // Server context: no server-side file paths — paste the config, parse it
          // in the browser, and import the chosen hosts into a collection (ADR 0016).
          <ImportSSHPasteModal
            collectionTargets={conns.writableCollections ?? []}
            defaultCollectionId={importCollectionId}
            create={conns.create}
            onClose={() => {
              setShowImportSSH(false);
              setImportCollectionId(null);
            }}
            onImported={(count) => {
              fetchConnections();
              setToastType('success');
              setToastMessage(`Imported ${count} machine${count !== 1 ? 's' : ''}`);
            }}
          />
        ) : (
          <ImportSSHConfigModal
            onClose={() => setShowImportSSH(false)}
            onImported={(count) => {
              fetchConnections();
              setToastType('success');
              setToastMessage(`Successfully imported ${count} connection${count !== 1 ? 's' : ''}`);
            }}
          />
        ))}

      {/* Vault picker (ADR 0014 multi-vault): the list of known vaults + new/open. Picking this
          window's vault unlocks it here; a different one opens its own window. */}
      {showVaultPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setShowVaultPicker(false)}
        >
          <div
            className="mx-4 w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Open a vault</h2>
            <p className="mt-1 text-sm text-muted-foreground">Pick a local vault, or create/open one.</p>
            <div className="mt-4 flex flex-col gap-2">
              {lockedVaults.map((v) => {
                const isThisWindow = currentVaultPath != null && v.path === currentVaultPath;
                return (
                  <button
                    key={v.path}
                    onClick={() => {
                      setShowVaultPicker(false);
                      if (isThisWindow) setShowUnlockModal(true);
                      else requestOpenContext({ kind: 'local', path: v.path });
                    }}
                    className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-left text-sm hover:border-primary hover:bg-muted"
                  >
                    {v.icon?.startsWith('data:') ? (
                      <img src={v.icon} alt="" className="h-6 w-6 flex-none rounded object-cover" />
                    ) : (
                      <span className="text-xl leading-none" aria-hidden>
                        {v.icon || '🔒'}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{v.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{v.path}</span>
                    </span>
                    <span className="flex-none text-xs text-muted-foreground">
                      {isThisWindow ? 'Unlock' : 'New window'}
                    </span>
                  </button>
                );
              })}
              <button
                onClick={() => {
                  setShowVaultPicker(false);
                  sendVaultCommand({ type: 'vault-new' });
                }}
                className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-sm text-muted-foreground hover:border-primary hover:text-foreground"
              >
                <span aria-hidden>＋</span> New local vault…
              </button>
              <button
                onClick={() => {
                  setShowVaultPicker(false);
                  sendVaultCommand({ type: 'vault-open-file' });
                }}
                className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-sm text-muted-foreground hover:border-primary hover:text-foreground"
              >
                <span aria-hidden>📂</span> Open a vault file…
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unlock Modal (context-specific, provided by the shell) */}
      {showUnlockModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-lg">
            {auth.renderUnlockModal({ onClose: () => setShowUnlockModal(false) })}
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
                  <span className={`text-lg ${settings.defaultShell === shell.path ? 'text-yellow-500' : 'text-muted-foreground/30'}`}>
                    {settings.defaultShell === shell.path ? '⭐' : '☆'}
                  </span>
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
