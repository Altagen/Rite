/**
 * Workspace — the context-agnostic app surface (connections + terminals + panes).
 *
 * Shared across contexts (local vault, remote server, web). It knows nothing about
 * *how* auth works: the enclosing shell passes an `auth` prop (is the vault
 * locked? how to lock? how to render the unlock modal?), so the same workspace
 * serves the local master-password vault and the accounts session (ADR 0014).
 */

import { useEffect, useState, useRef, useCallback, type ReactNode } from 'react';
import { useShortcut } from '../shortcuts/useShortcut';
import { askConfirm } from '../utils/confirmPrompt';
import { createPortal } from 'react-dom';
import { Backend } from '../utils/backend';
import { disposeAllPanes, paneKind } from '../panes/registry';
import { planLayout, type Layout, type TabPlan } from '../store/layoutsFormat';
// Reading a live pane tree back into a plan, so a duplicate goes through the same
// opener a layout does rather than a second tree-walker.
import { planFromTree } from '../store/tabPlan';
import { useLayouts, startupAlreadyRan, markStartupRan } from '../store/layouts';
import { useToolbar } from '../store/toolbar';
import { type ConnectionInfo, type ConnectionsSource } from '../store/connectionsStore';
import { useSettingsStore } from '../store/settingsStore';
import { useFocusMode } from '../store/focusMode';
import { SecretPrompt } from './SecretPrompt';
import { useTranslation } from '../i18n/i18n';
import { LibrarySidebar } from './LibrarySidebar';
import { ProfilePastille } from './ProfilePastille';
import { VaultPastille } from './VaultPastille';
import { OverflowNav, type NavAction } from './OverflowNav';
import { useSettingsModal } from '../store/settingsModal';
import { CommandPalette } from './CommandPalette';
import { ShortcutsCheatsheet } from './ShortcutsCheatsheet';
import { useBroadcast } from '../store/broadcast';
import { ConnectionForm } from './ConnectionForm';
import { TerminalManager, type TerminalSession } from './TerminalManager';
import { CollectionView } from './CollectionView';
import { MachineDashboard } from './MachineDashboard';
import { MemberPicker } from './MemberPicker';
import { BoardModal } from './BoardModal';
import { CollectionEditDialog } from './CollectionEditDialog';
import { CollectionFolderDialog } from './CollectionFolderDialog';
import { IconTerminal, IconBolt, IconLock, IconChevronDown } from './icons';
import { LibraryFolderDialog } from './LibraryFolderDialog';
import { MoveToFolderDialog } from './MoveToFolderDialog';
import { MoveMachineDialog } from './MoveMachineDialog';
import { useLibraryTree } from '../store/libraryTree';
import {
  useServerSession,
  quickSshAllowed,
  serverShellChoices,
  effectiveServerShell,
} from '../store/serverSessionStore';
import { deleteCollectionFolder } from '../utils/collectionHeader';
import { Settings } from './Settings';
import { QuickSSHModal, type QuickSSHConnectionInfo } from './QuickSSHModal';
import { ImportSSHConfigModal } from './ImportSSHConfigModal';
import { ImportSSHPasteModal } from './ImportSSHPasteModal';
import { HostKeyModal, type HostKeyPrompt } from './HostKeyModal';
import { KbdInteractiveModal, type KbdChallenge } from './KbdInteractiveModal';
import { PreconnectModal } from './PreconnectModal';
import { PortForwardModal } from './PortForwardModal';
import { ContextPill } from './ContextPill';
import {
  isNativeShell,
  nativeVaults,
  nativeContext,
  sendVaultCommand,
  setNativeFullscreen,
  requestOpenContext,
  requestSwitchContext,
  requestReloadContext,
  onVaultsChanged,
  openCreateVault,
  onCreateVault,
  type NativeVault,
} from '../utils/nativeShell';
import { shellToStart } from '../utils/localShellSource';
import { SHELL_CANDIDATES } from '../utils/shells';
import { VaultRemoveDialog } from './VaultRemoveDialog';
import { CreateVaultDialog } from './CreateVaultDialog';
import { transport } from '../utils/transport';
import { Toast } from './Toast';
import { ErrorBoundary } from './ErrorBoundary';
import { AnyPaneNode, SplitDirection, Tab, type SplitTarget } from '../types/pane';
import {
  createTerminalPane,
  splitPane,
  closePane,
  setFocusedPane,
  updateSplitRatio,
  getFocusedPane,
  getAllPanes,
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
  // First run for THIS window's local vault: no master password set yet, so "unlock" is really
  // "create a vault". Undefined for accounts contexts (no first-run master-password concept).
  isFirstRun?: boolean;
  lock: () => void;
  renderUnlockModal: (props: { onClose: () => void }) => ReactNode;
}

/** How close to the left edge reveals the arrow for a closed sidebar, in CSS pixels.
    48 is the mock's rail width, so the arrow appears where it will be drawn. */
const REVEAL_EDGE = 48;

export function Workspace({
  auth,
  conns,
  headerExtra,
  instanceName,
  identity,
  navActions,
}: {
  auth: WorkspaceAuth;
  conns: ConnectionsSource;
  // A shell-provided slot in the header's action cluster (e.g. the admin surface
  // entry for an org-admin). Context-agnostic: local shells pass nothing.
  headerExtra?: ReactNode;
  // A global instance name (accounts context) shown by the brand so users can
  // tell which server they're on. The browser has no context pill.
  instanceName?: string | null;
  // Accounts context only: the signed-in identity. When present, the header shows the
  // profile pastille (Settings + Sign out live in its menu) instead of the standalone
  // gear + lock. Local vault shells pass nothing and keep the gear/lock controls.
  identity?: { username: string; role: string };
  // Accounts context only: the collapsible header nav (Teams / Collections / Admin). Rendered
  // through OverflowNav so it folds into a "⋯" menu before the row wraps. Local shells omit it.
  navActions?: NavAction[];
}) {
  const { isLocked, lock } = auth;
  // First run = no master password on this window's vault yet ⇒ "unlock" is really "create".
  const isFirstRun = auth.isFirstRun ?? false;
  const { t } = useTranslation();
  // Locking moved into the pastille's menu, so it gets a chord: a safety action should
  // not cost a click and an aim (ADR-less, but see commands.ts for why Mod+Shift+L).
  useShortcut('vault.lock', () => lock(), !isLocked && !identity);
  // Locked-state vault picker (ADR 0014 multi-vault): the vaults the shell knows about + which
  // one this window holds, so "no vault open" offers the list + new/open instead of one button.
  const lockedVaults = isNativeShell() ? nativeVaults() : [];
  const currentVaultPath = nativeContext()?.path ?? null;
  // A brand-new vault whose master password was never set: the shell created its `.db` and
  // switched this window onto it with a `pendingLabel`, but it's not in the roster yet. Once
  // registered (vault-ready), it appears in `nativeVaults()` and is no longer "pending".
  // Only a *user-created* new vault (kind:'local') offers the abandon+delete dialog on ×; the
  // default launch window (kind:'hub') is base-first — its × just returns to the base workspace.
  const pendingCtx = isNativeShell() ? nativeContext() : undefined;
  const pendingNewVaultPath =
    pendingCtx?.kind === 'local' &&
    pendingCtx?.pendingLabel &&
    pendingCtx.path &&
    !lockedVaults.some((v) => v.path === pendingCtx.path)
      ? pendingCtx.path
      : null;
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
  // Whether the pointer is near the left edge, which is the only thing that shows the
  // reveal arrow for a collapsed library (see the arrow below, and `.side-rail` in
  // design/mock/rite.css — the mock has read this way all along).
  const [nearLeftEdge, setNearLeftEdge] = useState(false);
  // Focus mode (client/native only): hide the header so terminals fill the screen. `active` + the
  // auto-collapse-sidebar preference live in a small store; `reveal` is local (hover-to-peek).
  const focusActive = useFocusMode((s) => s.active);
  const setFocusActive = useFocusMode((s) => s.setActive);
  const focusAutoCollapse = useFocusMode((s) => s.autoCollapse);
  const [focusReveal, setFocusReveal] = useState(false);
  const sidebarBeforeFocusRef = useRef(true);
  // Settings modal is global (store) so the accounts overlay pages can open it too; here we own
  // the toggle. The modal element is rendered by this component in local mode, and by AccountsShell
  // in a server session (so it stays reachable above the Teams/Collections/… overlays).
  const showSettings = useSettingsModal((s) => s.open);
  const setShowSettings = useSettingsModal((s) => s.setOpen);
  // The palette, and one action reachable only through it. Registering `settings.open`
  // here is what makes it runnable at all: the registry holds a command while a mounted
  // component implements it, and this is the component that always is (see
  // `shortcuts/registry.ts`). Both are off while the vault is locked — nothing behind the
  // lock screen is worth running, and listing it would say otherwise.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  useShortcut('palette.open', () => setPaletteOpen(true), !isLocked);
  useShortcut('settings.open', () => setShowSettings(true), !isLocked);
  useShortcut('shortcuts.cheatsheet', () => setCheatsheetOpen(true), !isLocked);

  /**
   * Broadcasting: every keystroke in the active tab also reaches its other panes.
   *
   * The session ids are published to the store by this component, because it is the one
   * that holds the trees. They are REPUBLISHED while the mode is on, so a pane opened
   * mid-broadcast joins and a closed one drops out — `synchronize-panes` includes new
   * panes too, and a stale list would silently stop reaching one of them.
   */
  const broadcastTab = useBroadcast((s) => s.tabId);
  const toggleBroadcast = useBroadcast((s) => s.toggle);
  const retargetBroadcast = useBroadcast((s) => s.retarget);
  const activeSessions = (tabId: string | null) =>
    getAllPanes(tabGroups.find((t) => t.id === tabId)?.paneTree ?? null).map(
      (pane) => pane.session.id,
    );
  useShortcut(
    'terminal.broadcast',
    () => activeTabId && toggleBroadcast(activeTabId, activeSessions(activeTabId)),
    !isLocked && !!activeTabId,
  );
  useEffect(() => {
    if (!broadcastTab) return;
    // Computed inline rather than through the helper above: the helper is rebuilt on every
    // render, so listing it as a dependency would run this on every render — and leaving
    // it out would be a lie the linter is right to refuse. `tabGroups` is what changes
    // when a pane opens or closes, which is the only thing that can make the list wrong.
    const sessions = getAllPanes(
      tabGroups.find((t) => t.id === broadcastTab)?.paneTree ?? null,
    ).map((pane) => pane.session.id);
    retargetBroadcast(broadcastTab, sessions);
  }, [broadcastTab, tabGroups, retargetBroadcast]);

  // Quick SSH and Unlock modals
  const [showQuickSSH, setShowQuickSSH] = useState(false);
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [showVaultPicker, setShowVaultPicker] = useState(false); // multi-vault picker (ADR 0014)
  const [unlockFromPicker, setUnlockFromPicker] = useState(false); // came from the picker → back returns there
  const [removeVault, setRemoveVault] = useState<NativeVault | null>(null); // picker remove/delete target
  const [showCreateVault, setShowCreateVault] = useState(false); // create-vault dialog (any surface triggers it)
  const [abandonNewVault, setAbandonNewVault] = useState(false); // × on a not-yet-set-up new vault
  const [abandonDeleteFile, setAbandonDeleteFile] = useState(true); // its file was just created

  // Collection opened in the main area (ADR 0016): which one + which main view is
  // showing (terminal is kept mounted underneath). Plus the members dialog target
  // and the create-into-collection default for the machine form.
  const [openCollectionId, setOpenCollectionId] = useState<string | null>(null);
  const [openMachineId, setOpenMachineId] = useState<string | null>(null);
  const [mainView, setMainView] = useState<'terminal' | 'collection' | 'machine'>('terminal');
  const [membersCollectionId, setMembersCollectionId] = useState<string | null>(null);
  const [boardCollectionId, setBoardCollectionId] = useState<string | null>(null);
  const [formDefaultCollectionId, setFormDefaultCollectionId] = useState<string | null>(null);
  const [formDefaultFolder, setFormDefaultFolder] = useState<string | null>(null);
  const [collectionEdit, setCollectionEdit] = useState<{
    id?: string;
    name?: string;
    color?: string | null;
    hc?: boolean | null;
  } | null>(null);
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
  const [deleteSubfolder, setDeleteSubfolder] = useState<{
    collectionId: string;
    path: string;
  } | null>(null);
  // Server session keys (accounts context) for the folder-delete re-tag; null in local.
  const serverKeys = useServerSession();
  // Quick SSH is a server-governed capability: forbidden when a server says so (off by
  // default). In a local vault (not accounts) the user is their own authority → allowed.
  const allowQuickSsh = quickSshAllowed(serverKeys.mode);
  // In a server context terminals run on the server, so the shell is the server's default
  // (no local-shell picker); locally, the user picks their own shell.
  const isServerCtx = !!serverKeys.mode?.accounts;
  // …unless the instance delegates the choice, in which case these are the shells it
  // offers and `serverShell` is this person's pick within them. Empty list ⇒ the
  // instance keeps the decision, which is every server that says nothing.
  const serverShellChoiceList = serverShellChoices(serverKeys.mode);
  const serverShell = effectiveServerShell(serverKeys.mode, settings.defaultShell);
  /**
   * What the "+" beside the tabs offers for one terminal.
   *
   * A machine: the shells Rite looks for, greyed out where absent. A server: the ones it
   * reported, by name — a name is what the request carries there, so the "path" is the
   * name. Empty on a server that keeps the shell to itself, which is why the chevron is
   * absent there without a second condition anywhere.
   */
  const newTerminalShells = isServerCtx
    ? serverShellChoiceList.map((name) => ({
        name,
        path: name,
        icon: SHELL_CANDIDATES.find((c) => c.name === name)?.icon ?? '🐚',
      }))
    : SHELL_CANDIDATES;
  // The layouts file (docs/LAYOUTS.md). Read here for `startup = true`; the menu
  // beside the tabs reads the same store for the rest.
  // Which toolbar buttons this person keeps. Hiding one hides it and nothing else:
  // the shortcut still fires, and a server's Quick SSH policy still decides.
  const toolbarPrefs = useToolbar();
  const layoutsFromFile = useLayouts((s) => s.layouts);
  const layoutsLoaded = useLayouts((s) => s.loaded);
  // No workspace to read, no Layouts button: the instance may refuse the feature, or the
  // reader may have turned it off, and a button that can only say "none" is not an answer
  // (ADR 0027).
  const layoutsAvailable = useLayouts((s) => s.available);
  const loadLayouts = useLayouts((s) => s.load);
  // Re-read when the key arrives: on the account support the document is sealed under it,
  // so a load before sign-in found nothing to unseal (ADR 0027).
  useEffect(() => {
    void loadLayouts();
  }, [loadLayouts, serverKeys.userKey]);

  /*
   * The reveal arrow's visibility, read from the pointer rather than from `:hover`.
   *
   * Neither shipped shape worked. A `:hover` reveal cannot be hovered: an element at
   * opacity 0 is still hit-testable, so the arrow sat invisible over the terminal and
   * caught clicks meant for it — which is why it was made permanent, and a permanent
   * arrow covers the output it was meant to stay out of. Reading the pointer needs no
   * element over the terminal at all, and the mock has done it this way for the focus
   * toolbar at the top edge since it existed.
   *
   * Only mounted while the sidebar is closed: there is nothing to reveal otherwise, and a
   * mousemove listener is not free.
   */
  useEffect(() => {
    if (isSidebarOpen) return;
    const onMove = (e: MouseEvent) => {
      // State only on a change: mousemove fires on every pixel, and a setState per pixel
      // re-renders the whole workspace.
      setNearLeftEdge((was) => {
        const near = e.clientX <= REVEAL_EDGE;
        return near === was ? was : near;
      });
    };
    // Leaving the window is the whole difficulty, and only on the LEFT. Go out the top or
    // the right and the last clientX seen is beyond REVEAL_EDGE, so the arrow hides on its
    // own and nothing below is needed. Go out the left and the last clientX is inside the
    // zone, so the state is `true` with no further event coming — the arrow stayed revealed
    // for good. Three listeners rather than one because `mouseleave` on `document` is not
    // delivered on every engine, and the desktop shell is WebKitGTK while the suites drive
    // Chromium: `mouseout` with no `relatedTarget` is the pointer actually crossing out,
    // and `blur` covers the pointer parked at the screen edge while another window takes
    // focus — an unfocused window has nothing to reveal.
    const onLeave = () => setNearLeftEdge(false);
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget) setNearLeftEdge(false);
    };
    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    document.addEventListener('mouseout', onOut);
    window.addEventListener('blur', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('mouseout', onOut);
      window.removeEventListener('blur', onLeave);
    };
  }, [isSidebarOpen]);
  const [deleteCollectionTarget, setDeleteCollectionTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  // Top-level library folders (ADR 0016 view hierarchy) — the encrypted per-user tree.
  const tree = useLibraryTree();
  const [libraryFolderEdit, setLibraryFolderEdit] = useState<{
    id?: string;
    name?: string;
    color?: string | null;
    parent?: string | null;
  } | null>(null);
  const [moveCollectionTarget, setMoveCollectionTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [moveMachineTarget, setMoveMachineTarget] = useState<ConnectionInfo | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<{ id: string; name: string } | null>(
    null,
  );

  // Host-key confirmation (strict mode): the pending prompt + the connection that
  // triggered it, so accepting can retry that exact connection.
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt | null>(null);
  const [hostKeyBusy, setHostKeyBusy] = useState(false);
  const lastConnectionRef = useRef<ConnectionInfo | null>(null);
  // Pre-connect hook: the connection whose hook is running before we open SSH, and
  // the caller waiting on it. A layout opens several panes in a row and has to know
  // whether each hook passed, so the modal settles a promise instead of calling on.
  const [preconnectPrompt, setPreconnectPrompt] = useState<{
    conn: ConnectionInfo;
    settle: (passed: boolean) => void;
  } | null>(null);
  // Port forwarding: the connection whose forwards panel is open.
  const [forwardTarget, setForwardTarget] = useState<ConnectionInfo | null>(null);

  // Keyboard-interactive (2FA/PAM) challenge emitted by the backend during connect.
  const [kbdChallenge, setKbdChallenge] = useState<KbdChallenge | null>(null);
  const [kbdBusy, setKbdBusy] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await transport().listen<KbdChallenge>('ssh:kbd-interactive', (p) =>
        setKbdChallenge(p),
      );
    })();
    return () => unlisten?.();
  }, []);
  const handleKbdSubmit = useCallback(
    async (responses: string[]) => {
      const ch = kbdChallenge;
      if (!ch) return;
      setKbdBusy(true);
      try {
        await Backend.Ssh.kbdInteractiveRespond(ch.challengeId, responses);
      } catch (err) {
        console.error('[kbd-interactive] respond failed:', err);
      } finally {
        setKbdBusy(false);
        setKbdChallenge(null);
      }
    },
    [kbdChallenge],
  );
  const handleKbdCancel = useCallback(async () => {
    const ch = kbdChallenge;
    setKbdChallenge(null);
    if (ch) {
      try {
        await Backend.Ssh.kbdInteractiveRespond(ch.challengeId, null);
      } catch (err) {
        console.error('[kbd-interactive] cancel failed:', err);
      }
    }
  }, [kbdChallenge]);

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
  const [toastAction, setToastAction] = useState<
    { label: string; onClick: () => void } | undefined
  >(undefined);

  // Default shell selector state
  const [showDefaultShellDropdown, setShowDefaultShellDropdown] = useState(false);
  const [defaultShellDropdownPosition, setDefaultShellDropdownPosition] = useState({
    top: 0,
    left: 0,
  });
  const defaultShellButtonRef = useRef<HTMLButtonElement>(null);
  const appbarRef = useRef<HTMLElement>(null);

  // Installed shells state
  const [installedShells, setInstalledShells] = useState<string[]>([]);

  // The shells this picker offers. One list for the whole app (`utils/shells.ts`),
  // which is also the mock's (design/mock/desktop.html SHELLS) — this is the second
  // time these two have drifted, and last time it was the names and the icons.
  const shells = SHELL_CANDIDATES;

  // Store Quick SSH connection info for later saving
  const [quickSSHConnections, setQuickSSHConnections] = useState<
    Map<string, QuickSSHConnectionInfo>
  >(new Map());

  // Store pre-fill data for connection form (when saving Quick SSH)
  const [connectionFormPrefill, setConnectionFormPrefill] = useState<QuickSSHConnectionInfo | null>(
    null,
  );

  // Store pending action after unlock
  const [pendingActionAfterUnlock, setPendingActionAfterUnlock] = useState<(() => void) | null>(
    null,
  );

  // Execute pending action after unlock
  useEffect(() => {
    if (!isLocked && pendingActionAfterUnlock) {
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
      const allShellPaths = shells.map((s) => s.path);
      const installed = await Backend.Terminal.getInstalledShells(allShellPaths);
      setInstalledShells(installed);
    } catch (error) {
      console.error('[Workspace] Failed to check installed shells:', error);
      // If check fails, assume all shells are installed (backward compatibility)
      setInstalledShells(shells.map((s) => s.path));
    }
  };

  // Re-render when the shell pushes a roster change (ADR 0014) so the picker list stays live —
  // e.g. after deleting/forgetting a vault, without closing and reopening the picker.
  const [, bumpVaults] = useState(0);
  useEffect(() => onVaultsChanged(() => bumpVaults((n) => n + 1)), []);
  // Any surface (header, pill, hub, picker) can ask to create a vault; the one dialog lives here.
  useEffect(() => onCreateVault(() => setShowCreateVault(true)), []);

  // Escape closes the vault picker (a dialog needs a keyboard exit, not only a click-outside).
  useEffect(() => {
    if (!showVaultPicker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowVaultPicker(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showVaultPicker]);

  // Focus mode: enter/leave hides the header (terminals fill the screen), optionally collapses the
  // sidebar (opt-in, restored on exit), and asks the shell for real OS fullscreen. Native only.
  const native = isNativeShell();
  const toggleFocus = useCallback(() => {
    const entering = !focusActive;
    setFocusActive(entering);
    if (entering) {
      if (focusAutoCollapse) {
        sidebarBeforeFocusRef.current = isSidebarOpen;
        setIsSidebarOpen(false);
      }
      setNativeFullscreen(true);
    } else {
      setFocusReveal(false);
      if (focusAutoCollapse) setIsSidebarOpen(sidebarBeforeFocusRef.current);
      setNativeFullscreen(false);
    }
  }, [focusActive, focusAutoCollapse, isSidebarOpen, setFocusActive]);

  // F11 toggles focus; Esc exits it. Native shell only — the web UI doesn't offer focus mode.
  useEffect(() => {
    if (!native) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        toggleFocus();
      } else if (e.key === 'Escape' && focusActive) {
        e.preventDefault();
        toggleFocus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [native, focusActive, toggleFocus]);

  // Hover the top edge to peek the hidden header without leaving focus.
  useEffect(() => {
    if (!focusActive) return;
    const onMove = (e: MouseEvent) => setFocusReveal(e.clientY <= 56);
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [focusActive]);

  // A window opened *explicitly* for a vault (kind:'local' — via New/Open-vault) surfaces its
  // unlock/setup at once: the user asked for THAT vault, so prompt for it (SetupScreen on first
  // run, else UnlockScreen). The launch window (kind:'hub') stays base-first (ADR 0014) — the
  // terminal works with no vault, so it never auto-prompts. Runs once on mount; a fresh window's
  // server always starts locked, so no isLocked guard is needed.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-surface the opened vault
    if (isNativeShell() && nativeContext()?.kind === 'local') setShowUnlockModal(true);
  }, []);

  // Close unlock modal when unlocked (success ⇒ show the workspace, not back to the picker).
  useEffect(() => {
    if (!isLocked && showUnlockModal) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- close the unlock modal once the vault is unlocked
      setShowUnlockModal(false);
      setUnlockFromPicker(false);
      // A brand-new vault only joins the roster now that its master password exists
      // (register-after-password, ADR 0014): the shell carried its chosen name as pendingLabel.
      const ctx = nativeContext();
      if (isNativeShell() && ctx?.pendingLabel && ctx.path) {
        sendVaultCommand({ type: 'vault-ready', path: ctx.path, label: ctx.pendingLabel });
      }
      fetchConnections();
    }
  }, [isLocked, showUnlockModal, fetchConnections]);

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

    let timeoutId: ReturnType<typeof setTimeout>;

    const resetTimer = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(
        () => {
          lock();
        },
        settings.autoLockTimeout * 60 * 1000,
      ); // Convert minutes to milliseconds
    };

    // Start the timer
    resetTimer();

    // Listen for user activity events
    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];
    events.forEach((event) => {
      document.addEventListener(event, resetTimer);
    });

    // Cleanup on unmount or when settings change
    return () => {
      clearTimeout(timeoutId);
      events.forEach((event) => {
        document.removeEventListener(event, resetTimer);
      });
    };
  }, [settings.autoLockEnabled, settings.autoLockTimeout, lock]);

  // Clipboard auto-clear - clears clipboard after copy event
  useEffect(() => {
    if (!settings.clipboardClearEnabled) {
      return;
    }

    let clipboardTimeoutId: ReturnType<typeof setTimeout>;

    const handleCopy = async () => {
      // Clear any existing timer
      clearTimeout(clipboardTimeoutId);

      // Start new timer to clear clipboard
      clipboardTimeoutId = setTimeout(async () => {
        try {
          await navigator.clipboard.writeText('');
        } catch (error) {
          console.error('[Clipboard] Failed to clear clipboard:', error);
        }
      }, settings.clipboardClearTimeout * 1000); // Convert seconds to milliseconds
    };

    // Listen for copy events
    document.addEventListener('copy', handleCopy);

    // Cleanup on unmount or when settings change
    return () => {
      clearTimeout(clipboardTimeoutId);
      document.removeEventListener('copy', handleCopy);
    };
  }, [settings.clipboardClearEnabled, settings.clipboardClearTimeout]);

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

    setTabGroups((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
    // Always surface the terminal that was just opened. A machine dashboard or a
    // collection covers the workspace, and double-clicking a machine row fires the
    // single-click (open dashboard) first — without this the new session would open
    // behind the dashboard and connecting would look like it did nothing.
    setMainView('terminal');
  };

  /**
   * Run a machine's pre-connect hook, and say whether the connection may proceed.
   *
   * A machine with no hook passes without a modal. `gate` remembers what a hook
   * already answered during one layout, so four panes on one host ask once — and if
   * the hook failed, all four fall back rather than each asking again.
   */
  const runPreconnect = async (
    connection: ConnectionInfo,
    gate?: Map<string, boolean>,
  ): Promise<boolean> => {
    if (!connection.preconnect?.trim()) return true;
    const remembered = gate?.get(connection.id);
    if (remembered !== undefined) return remembered;
    const passed = await new Promise<boolean>((settle) =>
      setPreconnectPrompt({ conn: connection, settle }),
    );
    gate?.set(connection.id, passed);
    return passed;
  };

  // Handle connect - open terminal (allows multiple tabs for same connection).
  // A pre-connect hook (a local command — VPN up, SSO refresh) runs first in a
  // modal; the connection only proceeds when it exits 0.
  const handleConnect = async (connection: ConnectionInfo) => {
    if (!(await runPreconnect(connection))) return;
    await doConnect(connection);
  };

  const doConnect = async (connection: ConnectionInfo) => {
    // Remember the attempt so an accepted host-key prompt can retry it.
    lastConnectionRef.current = connection;

    try {
      // Open a session for this connection via the context's source (local =
      // server-decrypts; accounts = browser-decrypts → server-execute).
      const sessionId = await conns.connect(connection);

      // Create terminal session with backend session ID
      const session: TerminalSession = {
        id: sessionId,
        connectionId: connection.id,
        connectionName: connection.name,
      };

      addTerminalToTree(session);
    } catch (error) {
      console.error('[Workspace] Failed to connect to terminal:', error);
      let errorMsg =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : t('ws.errConnect');

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
          label: t('ws.editConfig'),
          onClick: () => handleEditConnection(connection),
        });
      } else {
        setToastAction(undefined);
      }

      setToastType('error');
      setToastMessage(errorMsg);
    }
  };

  // Open a terminal pane for a machine and run a command in it (dashboard actions:
  // exec into a container, tail logs/journal, restart a unit). The user sees it run
  // and stays in control — nothing executes silently. Switches to the terminal view.
  const handleRunInPane = async (connection: ConnectionInfo, command: string) => {
    try {
      const sessionId = await conns.connect(connection);
      // The pane runs it once its session is readable, rather than this guessing when
      // that is: the backend buffers a session's first output until the pane claims
      // it, and a shell discards queued input while it sets the tty up, so a timer
      // here loses the command outright instead of merely running it late.
      addTerminalToTree({
        id: sessionId,
        connectionId: connection.id,
        connectionName: connection.name,
        initialCommand: command,
      });
    } catch (error) {
      const msg =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : t('ws.errConnect');
      if (msg.includes('Disconnect')) return; // host-key modal handles it
      setToastType('error');
      setToastMessage(msg);
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
        // Pre-connect already ran before the host-key prompt — go straight to SSH.
        await doConnect(lastConnectionRef.current);
      }
    } catch (error) {
      console.error('[Workspace] Failed to accept host key:', error);
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
      console.error('[Workspace] Failed to reject host key:', error);
    } finally {
      setHostKeyPrompt(null);
      setHostKeyBusy(false);
    }
  };

  // Handle new local terminal
  const handleNewLocalTerminal = async (shell?: string) => {
    // Whose shell this is follows WHO RUNS IT, not which context is active (ADR 0031).
    // The rule itself is in `utils/localShellSource.ts`, pure and covered by
    // `e2e/local-shell-source-check.mjs` — its discriminator is a global the wry shell
    // injects, which no browser suite can see, so a rule written inline here would ship
    // its desktop arm untested.
    const sent = shellToStart({
      runsHere: isNativeShell(),
      serverContext: isServerCtx,
      asked: shell,
      localDefault: settings.defaultShell,
      instanceDefault: serverShell,
      instanceOffers: serverShellChoiceList,
    });
    // What the pane is labelled with: whatever will actually start, falling back to the
    // name the receiving end would apply.
    const shellToUse = sent ?? serverShell ?? settings.defaultShell;

    try {
      const sessionId = await Backend.Terminal.connectLocalTerminal(sent);

      // Create terminal session
      const shellName = shellToUse.split('/').pop() || 'shell';
      const session: TerminalSession = {
        id: sessionId,
        connectionId: 'local',
        connectionName: `Local Terminal (${shellName})`,
      };

      addTerminalToTree(session);
    } catch (error) {
      console.error('[Workspace] Failed to create local terminal:', error);
      // Show error message with toast
      const errorMsg = typeof error === 'string' ? error : t('ws.errLocalTerm');
      setToastType('error');
      setToastMessage(errorMsg);
    }
  };

  // Handle Quick SSH connected
  const handleQuickSSHConnected = (sessionId: string, connectionInfo: QuickSSHConnectionInfo) => {
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
  /**
   * Split a pane, optionally running something in the new one.
   *
   * With no preset this is the plain divider the button has always been — and that
   * stays the button, because a plain split is what most people want from a divider.
   * With one, the new pane is still an ordinary terminal: the command rides on the
   * session and the pane runs it once it is readable, so a preset adds a name and a
   * first command and nothing else.
   */
  /**
   * The session a split should open, from what was asked for.
   *
   * A layout may name a machine, and this computer may not be able to open it:
   * renamed, a locked vault whose names cannot even be read, or a file written on
   * another computer. None of those cancel the pane — it opens as a plain shell and
   * carries a `note` saying what was asked for, because a layout that silently drops
   * a pane costs you the workspace you asked for and tells you nothing.
   *
   * `localSession` is that fallback, and is also the plain split — one function, so a
   * pane that fell back is built exactly like a pane that was asked for.
   */
  const localSession = async (
    target?: SplitTarget,
    note?: string,
    /**
     * Open in the same directory as this session's shell.
     *
     * Only a split passes one. A new tab and a duplicate start where a shell would
     * normally start: "leave me where I was" is unambiguous for a split and a guess
     * anywhere else. The server reads the directory itself and refuses a session the
     * caller does not own.
     */
    inheritCwdFrom?: string,
  ): Promise<TerminalSession> => {
    // In a server context the shell is the instance's (`defaultShell`), so ask for
    // nothing and let the server use it: sending one made the administrator's choice
    // advisory, and the server would spawn whatever path it was handed.
    const shellToUse = isServerCtx ? serverShell : settings.defaultShell;
    const sessionId = await Backend.Terminal.connectLocalTerminal(
      isServerCtx ? (serverShellChoiceList.length > 0 ? serverShell : undefined) : shellToUse,
      inheritCwdFrom,
    );
    const shellName = shellToUse.split('/').pop() || 'shell';
    return {
      id: sessionId,
      connectionId: 'local',
      connectionName: target?.name || `Local Terminal (${shellName})`,
      // Run by the pane once its session is readable — see TerminalSession.
      initialCommand: target?.command || undefined,
      note,
    };
  };

  const sessionForTarget = async (
    target?: SplitTarget,
    gate?: Map<string, boolean>,
    inheritCwdFrom?: string,
  ): Promise<TerminalSession> => {
    const machine = target?.machine?.trim();
    // Only the local path can inherit a directory. A machine's working directory is on
    // another computer, and the fallbacks below are a plain shell standing in for a
    // machine that could not be opened — starting that somewhere else because of where an
    // unrelated pane happened to be would be noise, not a convenience.
    if (!machine) return localSession(target, undefined, inheritCwdFrom);

    // A locked vault is not a wrong name: the names are encrypted, so there is
    // nothing to compare against, and saying so is the honest message.
    if (isLocked) return localSession(target, t('layouts.fellBackLocked', { machine }));

    const connection = (conns.connections ?? []).find((c) => c.name === machine);
    if (!connection) return localSession(target, t('layouts.fellBackMissing', { machine }));

    // The hook belongs to the machine, so every way of opening it owes it the same
    // gate — a host behind a VPN used to open on a click and fail from a layout.
    if (!(await runPreconnect(connection, gate)))
      return localSession(target, t('layouts.fellBackPreconnect', { machine }));

    const sessionId = await conns.connect(connection);
    return {
      id: sessionId,
      connectionId: connection.id,
      connectionName: target?.name?.trim() || connection.name,
      initialCommand: target?.command || undefined,
    };
  };

  const handleSplitPane = async (
    paneId: string,
    direction: SplitDirection,
    target?: SplitTarget,
  ) => {
    if (!activeTabId) return;

    try {
      // The pane being cut, so its shell's directory is where the new one opens. A
      // terminal multiplexer does this and it is the whole of the "working directory per
      // tab" item: splitting leaves you where you were.
      const cutPane = getAllPanes(tabGroups.find((t) => t.id === activeTabId)?.paneTree ?? null)
        .find((pane) => pane.id === paneId);
      // The session is named whatever it is, local or SSH, and the SERVER decides whether
      // it can answer: `local_cwd` matches on a local session and returns nothing for
      // anything else. A matching check here would be the same rule in two places — and
      // the one that cannot be skipped is the server's, because it is the side that can
      // read a directory at all.
      const newSession = await sessionForTarget(target, undefined, cutPane?.session.id);

      // Split the pane in the active tab's tree
      setTabGroups((prev) =>
        prev.map((tab) => {
          if (tab.id === activeTabId) {
            const newTree = splitPane(tab.paneTree, paneId, direction, newSession);
            return { ...tab, paneTree: newTree };
          }
          return tab;
        }),
      );
    } catch (error) {
      console.error('[Workspace] Failed to split pane:', error);
      const errorMsg = typeof error === 'string' ? error : t('ws.errSplitTerm');
      setToastType('error');
      setToastMessage(errorMsg);
    }
  };

  /**
   * Open a layout: its own tabs, arranged as its file says (ADR 0023).
   *
   * A layout opens tabs rather than splitting whatever is on screen, so an eight-pane
   * file produces exactly eight panes and `startup` can be honoured before anything
   * else exists. `planLayout` turns the file into cuts; this applies them.
   *
   * Panes are tracked by the session they opened, because `splitPane` mints the new
   * node's id internally — and the pane being cut keeps its id, which is what lets a
   * later step anchor to a pane placed earlier.
   */
  const handleApplyLayout = async (layout: Layout) => {
    await openPlans(planLayout(layout), layout.name);
  };

  /**
   * Open a set of tab plans: the panes they name, arranged by the cuts they list.
   *
   * Lifted out of `handleApplyLayout` so duplicating a tab goes through the same code.
   * A duplicate IS a plan — `planFromTree` reads a live tree into one — so the only
   * alternative was a second tree-walker that would drift from this one. Rebuilding an
   * arrangement is subtle enough that having one implementation of it matters more than
   * the two callers looking different.
   */
  const openPlans = async (plans: TabPlan[], fallbackName: string) => {
    // One hook per machine for the whole run, however many panes name it.
    const gate = new Map<string, boolean>();
    const opened: Tab[] = [];

    for (const plan of plans) {
      const sessionFor = async (index: number): Promise<TerminalSession> => {
        try {
          return await sessionForTarget(plan.panes[index], gate);
        } catch (error) {
          // A machine that refuses costs this pane's content, never the arrangement:
          // the pane opens as a plain shell carrying why (ADR 0023 §5).
          const why =
            typeof error === 'string' ? error : error instanceof Error ? error.message : '';
          const machine = plan.panes[index].machine?.trim();
          return localSession(
            plan.panes[index],
            machine ? t('layouts.fellBackFailed', { machine, why }) : why,
          );
        }
      };

      let tree = createTerminalPane(await sessionFor(0), true) as AnyPaneNode;
      const paneIds = new Map<number, string>([[0, tree.id]]);

      for (const step of plan.steps) {
        const anchorId = paneIds.get(step.anchor);
        if (!anchorId) continue;
        const session = await sessionFor(step.pane);
        const grown = splitPane(tree, anchorId, step.direction, session, {
          before: step.before,
          ratio: step.ratio,
        });
        if (!grown) continue;
        tree = grown;
        const added = getAllPanes(tree).find((pane) => pane.session.id === session.id);
        if (added) paneIds.set(step.pane, added.id);
      }

      opened.push({ id: crypto.randomUUID(), name: plan.tab ?? fallbackName, paneTree: tree });
    }

    if (opened.length === 0) return;
    setTabGroups((prev) => [...prev, ...opened]);
    setActiveTabId(opened[0].id);
    // These are terminals; a dashboard or a collection covering the workspace would
    // hide every one of them.
    setMainView('terminal');
  };

  /**
   * Duplicate a tab: the same arrangement, against the same targets, with fresh sessions.
   *
   * Not a copy, and the menu label says so. A pane holds a live session — an SSH
   * connection, a PTY with a shell's history and whatever is running in it — and none of
   * that is a value that can be cloned. What can be rebuilt is the shape and the targets,
   * which is exactly what a layout is, so this reads the live tree into a plan and hands
   * it to the opener layouts use.
   *
   * A machine that cannot be reached gets the same treatment it gets from a layout: the
   * pane opens as a plain shell carrying why (ADR 0023 §5). The arrangement survives even
   * when a target does not.
   */
  const handleDuplicateTab = async (tabId: string) => {
    const tab = tabGroups.find((t) => t.id === tabId);
    if (!tab || !tab.paneTree) return;
    await openPlans([planFromTree(tab.paneTree, tab.name)], tab.name);
  };

  /** Close every tab but this one. The strip asks first; this does the closing. */
  const handleCloseOtherTabs = async (keepId: string) => {
    // Snapshotted before the first close: `handleCloseTab` edits `tabGroups`, and
    // iterating the live list while it shrinks skips tabs.
    const doomed = tabGroups.filter((t) => t.id !== keepId).map((t) => t.id);
    // One at a time, because each close disposes its own panes and a failure on one tab
    // must not take the rest of the loop with it.
    for (const id of doomed) await handleCloseTab(id);
    setActiveTabId(keepId);
  };

  /**
   * The layouts marked `startup = true` open themselves, once, as soon as the file
   * has been read.
   *
   * They no longer wait for a tab to exist: a layout opens its own tabs, so waiting
   * for one would mean never opening on a fresh start, which is the only moment a
   * startup layout is for.
   *
   * Once per run, not once per render and not once per context: a guard ref rather
   * than a dependency list, because the layouts arrive asynchronously. Switching vault
   * re-mounts this workspace, which is the one case where opening them again is the
   * right answer.
   *
   * In a browser the ref is not enough: F5 remounts everything, and "startup" means
   * sitting down to work, not pressing reload. A session-scoped flag there, so a new tab
   * or a relaunch honours it and a refresh does not (ADR 0027).
   */
  const startupOpened = useRef(false);
  useEffect(() => {
    if (startupOpened.current) return;
    if (!layoutsLoaded) return;
    if (startupAlreadyRan()) {
      startupOpened.current = true;
      return;
    }
    const atStartup = layoutsFromFile.filter((l) => l.startup);
    startupOpened.current = true;
    if (atStartup.length === 0) return;
    markStartupRan();
    void (async () => {
      for (const layout of atStartup) await handleApplyLayout(layout);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutsLoaded, layoutsFromFile]);

  // Handle close pane
  // async since the multi-terminal confirmation is the app's dialog now, not the browser's
  // blocking box. The caller does not await it: closing a pane has no result to report.
  const handleClosePane = async (paneId: string) => {
    if (!activeTabId) return;

    // Check how many terminals will be closed
    const activeTab = tabGroups.find((t) => t.id === activeTabId);
    if (!activeTab) return;

    // Check how many terminals are in this specific pane subtree
    const sessionsInPane = getSessionsInPane(activeTab.paneTree, paneId);
    const sessionCount = sessionsInPane.length;

    // Ask confirmation ONLY if closing this pane will close multiple terminals
    // (don't ask for single terminal in a tab with multiple terminals - that's annoying)
    if (sessionCount > 1) {
      const ok = await askConfirm({
        title: t('ws.closePaneTitle', { count: sessionCount }),
        body: t('ws.closePaneWhy', { count: sessionCount }),
        action: t('tm.closeAll'),
        danger: true,
      });
      if (!ok) return;
    }

    setTabGroups((prev) => {
      // Remember current tab index BEFORE any modifications
      const currentTabIndex = prev.findIndex((t) => t.id === activeTabId);

      const newTabs = prev
        .map((tab) => {
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
        })
        .filter((tab): tab is Tab => tab !== null);

      // If we removed the active tab, switch to the previous or next tab
      const stillExists = newTabs.find((t) => t.id === activeTabId);
      if (!stillExists && newTabs.length > 0) {
        // Try to go to the previous tab, or next tab if we were at index 0
        // Make sure the index is valid after removal
        const newIndex = Math.min(
          currentTabIndex > 0 ? currentTabIndex - 1 : 0,
          newTabs.length - 1,
        );
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
    if (!activeTabId) return;

    setTabGroups((prev) =>
      prev.map((tab) => {
        if (tab.id === activeTabId) {
          return { ...tab, paneTree: setFocusedPane(tab.paneTree, paneId) };
        }
        return tab;
      }),
    );
  };

  // Handle split ratio change
  const handleSplitRatioChange = (splitId: string, newRatio: number) => {
    if (!activeTabId) return;

    setTabGroups((prev) =>
      prev.map((tab) => {
        if (tab.id === activeTabId) {
          return { ...tab, paneTree: updateSplitRatio(tab.paneTree, splitId, newRatio) };
        }
        return tab;
      }),
    );
  };

  // Handle switch tab (now switches between tab groups)
  const handleSwitchTab = (tabId: string) => {
    setActiveTabId(tabId);
    // A terminal tab IS the terminal view. With the strips merged there is no separate
    // "Terminal" button left to come back with, so picking a tab has to do it — else
    // the tab changes underneath a dashboard that stays on screen.
    setMainView('terminal');
  };

  // Handle reorder tabs
  const handleReorderTabs = (newTabOrder: Tab[]) => {
    setTabGroups(newTabOrder);
  };

  // Handle close tab - gracefully close all terminals in a tab and remove it
  const handleCloseTab = async (tabId: string) => {
    const tabToClose = tabGroups.find((t) => t.id === tabId);
    if (!tabToClose) return;

    // Release what every pane in this tab held. Each kind knows what that means for
    // itself, which is why this is a list of panes and no longer a list of session
    // ids: a tab holding an SFTP or agent pane closes correctly with no change here.
    const panesToClose = getAllPanes(tabToClose.paneTree);
    const { failed } = await disposeAllPanes(panesToClose);
    for (const { pane, error } of failed) {
      console.error('[Workspace] Failed to dispose pane:', pane.id, error);
    }

    // Remove the tab
    setTabGroups((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);

      // If we're closing the active tab, switch to another tab
      if (activeTabId === tabId && newTabs.length > 0) {
        const closedTabIndex = prev.findIndex((t) => t.id === tabId);
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
    if (!activeTabId) return;

    const activeTab = tabGroups.find((t) => t.id === activeTabId);
    if (!activeTab) return;

    // Extract the pane from the current tab's tree
    const { extractedPane, remainingTree } = extractPane(activeTab.paneTree, paneId);

    if (!extractedPane) {
      console.error('[Workspace] Failed to extract pane:', paneId);
      return;
    }

    // Create a new tab with the extracted pane
    const newTab: Tab = {
      id: crypto.randomUUID(),
      name: paneKind(extractedPane).title(extractedPane),
      paneTree: { ...extractedPane, isFocused: true },
    };

    // Update tab groups
    setTabGroups((prev) => {
      // If remaining tree is empty, remove the old tab
      if (!remainingTree) {
        return [...prev.filter((t) => t.id !== activeTabId), newTab];
      }

      // Otherwise, update the old tab and add the new one
      return [
        ...prev.map((t) => (t.id === activeTabId ? { ...t, paneTree: remainingTree } : t)),
        newTab,
      ];
    });

    // Switch to the newly created tab
    setActiveTabId(newTab.id);
  };

  // Handle rename tab
  const handleRenameTab = (tabId: string, newName: string) => {
    setTabGroups((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, name: newName } : tab)));
  };

  // Handle merge tab - drag a tab and drop it into another tab's pane area
  const handleMergeTab = (sourceTabId: string, targetTabId: string) => {
    if (sourceTabId === targetTabId) return;

    const sourceTab = tabGroups.find((t) => t.id === sourceTabId);
    const targetTab = tabGroups.find((t) => t.id === targetTabId);

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
    setTabGroups((prev) =>
      prev
        .filter((t) => t.id !== sourceTabId)
        .map((t) => (t.id === targetTabId ? { ...t, paneTree: mergedTree } : t)),
    );

    // Keep active tab on the merged one
    setActiveTabId(targetTabId);
  };

  // Handle reorganize pane - drag a pane within the same tab to reorganize layout
  const handleReorganizePane = (
    sourcePaneId: string,
    targetPaneId: string,
    position: 'top' | 'bottom' | 'left' | 'right',
  ) => {
    if (!activeTabId) return;

    const activeTab = tabGroups.find((t) => t.id === activeTabId);
    if (!activeTab || !activeTab.paneTree) return;

    // Use the reorganizePane utility to restructure the tree
    const reorganizedTree = reorganizePane(
      activeTab.paneTree,
      sourcePaneId,
      targetPaneId,
      position,
    );

    // Update the active tab with the new tree
    setTabGroups((prev) =>
      prev.map((tab) => (tab.id === activeTabId ? { ...tab, paneTree: reorganizedTree } : tab)),
    );
  };

  // Handle save Quick SSH connection
  const handleSaveQuickSSH = (sessionId: string) => {
    // Get connection info for this session
    const connectionInfo = quickSSHConnections.get(sessionId);
    if (!connectionInfo) {
      console.error('[Workspace] No connection info found for session:', sessionId);
      return;
    }

    // Check if app is locked
    if (isLocked) {
      // Store the action to execute after unlock
      setPendingActionAfterUnlock(() => () => {
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

  // Open a collection in the main area (from the sidebar). Clear any selected machine so the
  // sidebar highlight follows what's actually focused instead of leaving a stale machine lit.
  const handleOpenCollection = (collectionId: string) => {
    selectConnection(null);
    setOpenCollectionId(collectionId);
    setMainView('collection');
  };
  const handleCloseCollection = () => {
    setOpenCollectionId(null);
    setMainView('terminal');
  };

  // Open a machine's dashboard in the main area (single-click). Selecting it too keeps the
  // sidebar highlight in sync; double-click on a row connects instead (handleConnect).
  const handleOpenMachine = (connection: ConnectionInfo) => {
    selectConnection(connection.id);
    setOpenMachineId(connection.id);
    setMainView('machine');
  };
  const handleCloseMachine = () => {
    setOpenMachineId(null);
    setMainView(openCollectionId ? 'collection' : 'terminal');
  };

  // Sidebar collection actions (accounts context).
  // Two different questions that used to share one answer (ADR 0018). A local
  // vault now has collections as well, so structure is gated on having them, and
  // only genuinely collaborative surfaces are gated on being a server.
  const hasCollections = conns.writableCollections !== undefined;
  const isServerContext = conns.isServerContext === true;
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
      // A vault deletes through the core; a server through the zero-knowledge API.
      if (conns.deleteCollection) await conns.deleteCollection(id);
      else await Backend.Collections.remove(id);
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
  const openMachine = openMachineId
    ? conns.connections.find((c) => c.id === openMachineId)
    : undefined;
  const openCollectionName =
    openCol?.name ?? openCollectionMeta?.collectionName ?? t('coll.fallbackName');
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
      for (const c of conns.connections)
        if (c.collectionId === m.collectionId && c.folder) add(c.folder);
    } else {
      for (const c of conns.connections) if (!c.collectionId && c.folder) add(c.folder);
    }
    return [...s].sort((a, b) => a.localeCompare(b));
  };

  // The collection and machine tabs live in the terminal strip, after the terminal
  // tabs and before the "+", which is where the mock keeps them (`#mtabs`). They had
  // their own strip above it, so opening a machine produced two bars — and the
  // terminal one, `relative z-10` like the dashboard overlay and later in the DOM,
  // painted over the dashboard it has nothing to say about.
  const viewTabs =
    openCollectionId || openMachine ? (
      <>
        {openCollectionId && (
          <div
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
              mainView === 'collection'
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            <button onClick={() => setMainView('collection')} className="flex items-center gap-1.5">
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.5 12L12 17l8.5-5M3.5 16L12 21l8.5-5"
                />
              </svg>
              <span className="max-w-[160px] truncate">{openCollectionName}</span>
            </button>
            <button
              onClick={handleCloseCollection}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
              aria-label={t('ws.closeCollection')}
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        {openMachine && (
          <div
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
              mainView === 'machine'
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            <button onClick={() => setMainView('machine')} className="flex items-center gap-1.5">
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <rect x="3" y="5" width="18" height="6" rx="1.5" />
                <rect x="3" y="13" width="18" height="6" rx="1.5" />
                <path strokeLinecap="round" d="M6.5 8h.01M6.5 16h.01" />
              </svg>
              <span className="max-w-[160px] truncate">{openMachine.name}</span>
            </button>
            <button
              onClick={handleCloseMachine}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
              aria-label={t('dash.close')}
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </>
    ) : null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header (design mock: brand · context pill · actions) */}
      {/* Accounts context: m-appbar-fit forces one row + non-shrinking children, so OverflowNav's
          scrollWidth measurement is meaningful and the pastille stays pinned right. */}
      <header
        ref={appbarRef}
        className={`m-appbar${navActions?.length ? ' m-appbar-fit' : ''}${
          focusActive
            ? ` fixed left-0 right-0 top-0 z-[55] shadow-lg transition-transform duration-200 ${
                focusReveal ? 'translate-y-0' : '-translate-y-full'
              }`
            : ''
        }`}
      >
        <div className="m-brand">
          <img src={riteLandscape} alt="Rite" className="h-[26px] rounded-[7px]" />
        </div>
        {instanceName && (
          <span className="m-chip" title={t('ws.serverInstance')}>
            <span className="m-dot" />
            {instanceName}
          </span>
        )}
        <ContextPill />
        <span className="m-spacer" />

        {/* New Terminal — server shell in a server context, the local pick otherwise */}
        <button
          onClick={() => handleNewLocalTerminal()}
          className="m-btn m-btn-primary m-btn-sm"
          title={
            isServerCtx
              ? `New server terminal (${serverShell})`
              : `New Local Terminal (${settings.defaultShell.split('/').pop()})`
          }
        >
          <IconTerminal className="h-4 w-4" />
          <span className="hidden md:inline">{t('ws.terminal')}</span>
        </button>

        {/* Local-shell selector — hidden in a server context (the server sets the
            shell), and hidden when this person took it out of their toolbar. */}
        {!isServerCtx && toolbarPrefs.shellPicker && (
          <button
            ref={defaultShellButtonRef}
            onClick={async () => {
              if (!showDefaultShellDropdown) await checkInstalledShells();
              setShowDefaultShellDropdown(!showDefaultShellDropdown);
            }}
            className="m-btn m-btn-sm"
            title={t('ws.selectShell')}
          >
            <span>{shells.find((s) => s.path === settings.defaultShell)?.icon || '🐚'}</span>
            <span className="hidden text-muted-foreground md:inline">
              {settings.defaultShell.split('/').pop()}
            </span>
            <IconChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        )}

        {/* Focus mode (client/native only): hide the toolbar, terminals fill the screen.
            F11 keeps working with the button hidden — that is the point of hiding. */}
        {native && toolbarPrefs.focusMode && (
          <button
            onClick={toggleFocus}
            className={`m-btn m-btn-sm${focusActive ? ' text-primary' : ''}`}
            title={t('ws.focusMode')}
            aria-pressed={focusActive}
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
              />
            </svg>
          </button>
        )}

        {/* Quick SSH — hidden when the server forbids it (server-governed capability),
            and when this person hid it. The two are not the same thing: the first is
            a rule, the second is a view, and only the rule decides what is allowed. */}
        {allowQuickSsh && toolbarPrefs.quickSsh && (
          <button
            onClick={() => setShowQuickSSH(true)}
            className="m-btn m-btn-sm"
            title={t('ws.quickSshConnect')}
          >
            <IconBolt className="h-4 w-4" />
            <span className="hidden md:inline">{t('ws.quickSsh')}</span>
          </button>
        )}

        {/* Collapsible nav (Teams / Collections / Admin) — folds into "⋯" before the row wraps. */}
        {navActions?.length ? <OverflowNav actions={navActions} appbarRef={appbarRef} /> : null}

        {/* Shell-provided always-visible actions (e.g. the notifications bell). */}
        {headerExtra}

        {identity ? (
          // Accounts context: the pastille owns Settings + Sign out.
          <ProfilePastille
            username={identity.username}
            role={identity.role}
            instanceName={instanceName}
            onSettings={() => setShowSettings(true)}
            onSignOut={() => lock()}
          />
        ) : (
          <>
            {/* First run, or a locked vault: the call to action stays a primary BUTTON and
                does not move into the menu. It is the one thing a new window is for, and
                hiding "Create vault" behind a chevron costs a first-time reader the only
                affordance that matters. The menu repeats it, for whoever opens the menu. */}
            {isLocked && (
              <button
                onClick={() => (isFirstRun ? openCreateVault() : setShowUnlockModal(true))}
                className="m-btn m-btn-primary m-btn-sm"
                title={isFirstRun ? t('ws.createVaultTitle') : t('ws.unlockVaultTitle')}
                data-testid="vault-primary-action"
              >
                <IconLock className="h-4 w-4" />
                <span className="hidden md:inline">
                  {isFirstRun ? t('ws.createVault') : t('ws.unlockVault')}
                </span>
              </button>
            )}
            {/* Settings is reachable while locked, on purpose (base-first, ADR 0014): the
                theme, the keyboard, the splits and the language are per-device and have
                nothing to do with a vault. They used to vanish with it. */}
            <VaultPastille
              isLocked={isLocked}
              isFirstRun={!!isFirstRun}
              vaultLabel={nativeContext()?.label ?? undefined}
              onLock={() => lock()}
              onUnlock={() => (isFirstRun ? openCreateVault() : setShowUnlockModal(true))}
              onSettings={() => setShowSettings(true)}
            />
          </>
        )}
      </header>

      {/* Focus-mode hint: shown only in focus mode so the exit affordances stay visible — the user
          is never trapped. Fades to faint but doesn't disappear. */}
      {focusActive && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-[56] flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-muted-foreground opacity-90 shadow-lg">
          {t('ws.focusMode')}{' '}
          <kbd className="rounded border border-border border-b-2 bg-background px-1.5 font-mono text-[11px] text-foreground">
            Esc
          </kbd>{' '}
          {t('ws.focusOr')}{' '}
          <kbd className="rounded border border-border border-b-2 bg-background px-1.5 font-mono text-[11px] text-foreground">
            F11
          </kbd>{' '}
          {t('ws.focusExit')}
        </div>
      )}

      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden relative">
        {/* Sidebar: saved connections when a vault is open; otherwise a prompt to
            open one (the local terminal + Quick SSH in the header work without it). */}
        <aside
          className={`m-side border-r border-border flex flex-col transition-all duration-300 overflow-hidden ${
            isSidebarOpen ? 'w-[290px]' : 'w-0'
          }`}
        >
          {isLocked ? (
            <div className="flex flex-1 flex-col overflow-hidden">
              {/* Collapse toggle — available locked too, so you can reclaim the space without
                  authenticating (the reveal button reopens it, same as when a vault is open). */}
              <div className="flex justify-end p-2">
                <button
                  onClick={() => setIsSidebarOpen(false)}
                  className="m-btn m-btn-ghost"
                  style={{ padding: '4px' }}
                  title={t('ws.hideSidebar')}
                  aria-label={t('ws.hideSidebar')}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                    />
                  </svg>
                </button>
              </div>
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-sm text-muted-foreground">
                  {isFirstRun && lockedVaults.length === 0
                    ? t('ws.noVaultYet')
                    : t('ws.openVaultHint')}
                </p>
                <button
                  onClick={() => {
                    if (lockedVaults.length > 0) setShowVaultPicker(true);
                    else if (isFirstRun) openCreateVault();
                    else setShowUnlockModal(true);
                  }}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {isFirstRun && lockedVaults.length === 0
                    ? t('ws.createLocalVault')
                    : t('ws.openLocalVault')}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Search (design mock: at the top of the sidebar) */}
              <div className="m-search">
                <svg
                  className="h-4 w-4 flex-none"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z"
                  />
                </svg>
                <input
                  value={sidebarQuery}
                  onChange={(e) => setSidebarQuery(e.target.value)}
                  placeholder={t('ws.searchConnections')}
                />
              </div>

              {/* Library header row: eyebrow · + menu · collapse */}
              <div className="m-side-hdr">
                <span className="m-eyebrow">{t('ws.library')}</span>
                <div className="relative ml-auto flex items-center gap-1">
                  <button
                    onClick={() => setShowNewMenu((v) => !v)}
                    aria-label={t('ws.addToLibrary')}
                    title={t('ws.addToLibrary')}
                    className="m-btn m-btn-ghost"
                    style={{ padding: '4px' }}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 5v14M5 12h14"
                      />
                    </svg>
                  </button>
                  {showNewMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowNewMenu(false)} />
                      <div className="m-menu absolute right-0 top-full z-20 mt-1">
                        {/* No loose machines (ADR 0016): machines & import are
                        collection-scoped, so the library + creates folders and
                        collections in both contexts. Since ADR 0018 a local vault
                        has collections too, so there is no longer a second branch
                        offering a machine with nowhere to put it. */}
                        <>
                          <button
                            onClick={() => {
                              setShowNewMenu(false);
                              setLibraryFolderEdit({});
                            }}
                          >
                            <svg
                              className="h-4 w-4 flex-none"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                              />
                            </svg>
                            {t('ws.newFolder')}
                          </button>
                          <button
                            onClick={() => {
                              setShowNewMenu(false);
                              setShowNewCollection(true);
                            }}
                          >
                            <svg
                              className="h-4 w-4 flex-none"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 3l9 5-9 5-9-5 9-5z"
                              />
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M3.5 12L12 17l8.5-5M3.5 16L12 21l8.5-5"
                              />
                            </svg>
                            {t('ws.newCollection')}
                          </button>
                        </>
                      </div>
                    </>
                  )}
                  <button
                    onClick={() => setIsSidebarOpen(false)}
                    className="m-btn m-btn-ghost"
                    style={{ padding: '4px' }}
                    title={t('ws.hideSidebar')}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                      />
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
                  onOpenMachine={handleOpenMachine}
                  onEdit={handleEditConnection}
                  onDelete={handleDeleteConnection}
                  onConnect={handleConnect}
                  onForward={setForwardTarget}
                  onMoveMachine={setMoveMachineTarget}
                  onOpenCollection={handleOpenCollection}
                  openCollectionId={mainView === 'collection' ? openCollectionId : null}
                  collections={conns.collections}
                  onNewMachineInCollection={
                    hasCollections ? handleNewMachineInCollection : undefined
                  }
                  onNewFolderInCollection={
                    hasCollections ? (id) => setFolderDialog({ collectionId: id }) : undefined
                  }
                  onNewSubfolder={
                    hasCollections
                      ? (id, parentPath) => setFolderDialog({ collectionId: id, parentPath })
                      : undefined
                  }
                  onNewMachineInFolder={
                    hasCollections
                      ? (id, folderPath) => handleNewMachineInCollection(id, folderPath)
                      : undefined
                  }
                  onRenameFolder={
                    hasCollections
                      ? (id, path, color) =>
                          setFolderDialog({
                            collectionId: id,
                            renamePath: path,
                            initialName: path.split('/').pop() ?? path,
                            initialColor: color,
                          })
                      : undefined
                  }
                  onDeleteFolder={
                    hasCollections
                      ? (id, path) => setDeleteSubfolder({ collectionId: id, path })
                      : undefined
                  }
                  onImportToCollection={
                    hasCollections
                      ? (id) => {
                          setImportCollectionId(id);
                          setShowImportSSH(true);
                        }
                      : undefined
                  }
                  onOpenMembers={isServerContext ? (id) => setMembersCollectionId(id) : undefined}
                  onOpenBoard={
                    hasCollections && conns.readBoard ? (id) => setBoardCollectionId(id) : undefined
                  }
                  onRenameCollection={
                    hasCollections
                      ? (id, name, color) =>
                          setCollectionEdit({
                            id,
                            name,
                            color,
                            hc: conns.collections?.find((c) => c.id === id)?.hc,
                          })
                      : undefined
                  }
                  onDeleteCollection={
                    hasCollections
                      ? (id, name) => setDeleteCollectionTarget({ id, name })
                      : undefined
                  }
                  libraryFolders={hasCollections ? tree.folders : undefined}
                  collectionPlacement={hasCollections ? tree.placement : undefined}
                  onNewLibrarySubfolder={
                    hasCollections ? (parent) => setLibraryFolderEdit({ parent }) : undefined
                  }
                  onNewCollectionInFolder={
                    hasCollections
                      ? (folderId) => {
                          setPendingCollectionFolder(folderId);
                          setShowNewCollection(true);
                        }
                      : undefined
                  }
                  onRenameLibraryFolder={
                    hasCollections
                      ? (id, name, color) => setLibraryFolderEdit({ id, name, color })
                      : undefined
                  }
                  onDeleteLibraryFolder={
                    hasCollections ? (id, name) => setDeleteFolderTarget({ id, name }) : undefined
                  }
                  onMoveCollection={
                    hasCollections ? (id, name) => setMoveCollectionTarget({ id, name }) : undefined
                  }
                />
              </div>
            </>
          )}
        </aside>

        {/* The reveal arrow for a closed sidebar: shown while the pointer is near the left
            edge, and while it has keyboard focus. `pointer-events-none` when hidden is the
            half that matters — an invisible button still catches clicks, and this one sits
            over the terminal. */}
        {!isSidebarOpen && (
          <button
            onClick={() => setIsSidebarOpen(true)}
            title={t('ws.showSidebar')}
            aria-label={t('ws.showSidebar')}
            data-testid="sidebar-reveal"
            className={`absolute left-0 top-1/2 z-30 -translate-y-1/2 rounded-r-md border border-l-0 border-border bg-card p-2 shadow-lg transition-opacity hover:bg-muted focus:pointer-events-auto focus:opacity-100 ${
              nearLeftEdge ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 5l7 7-7 7M5 5l7 7-7 7"
              />
            </svg>
          </button>
        )}

        {/* Main content: a Terminal / Collection tab strip (only when a collection
            is open), then the terminal manager (kept mounted so sessions survive)
            with the collection view overlaid when its tab is active. */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Collection view overlay (kept above the terminal when its tab is active) */}
            {openCollectionId && mainView === 'collection' && (
              <div className="absolute inset-0 z-10 overflow-hidden bg-background">
                <CollectionView
                  key={openCollectionId}
                  name={openCollectionName}
                  color={openCollectionColor}
                  role={isServerContext ? openCollectionRole : null}
                  hc={openCol?.hc}
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
                    openCollectionId &&
                    setFolderDialog({ collectionId: openCollectionId, parentPath })
                  }
                  onImport={() => {
                    setImportCollectionId(openCollectionId);
                    setShowImportSSH(true);
                  }}
                  isPersonal={openCol?.isPersonal}
                  // A vault has one member by definition, so there is nothing to
                  // manage and no role worth showing (ADR 0018).
                  onOpenMembers={
                    isServerContext && !openCol?.isPersonal
                      ? () => setMembersCollectionId(openCollectionId)
                      : undefined
                  }
                  onOpenBoard={
                    hasCollections && conns.readBoard
                      ? () => setBoardCollectionId(openCollectionId)
                      : undefined
                  }
                />
              </div>
            )}

            {/* Machine dashboard overlay (its own view when a machine tab is active) */}
            {openMachine && mainView === 'machine' && (
              <div className="absolute inset-0 z-10 overflow-hidden bg-background">
                <MachineDashboard
                  key={openMachine.id}
                  connection={openMachine}
                  connections={conns.connections}
                  onConnect={handleConnect}
                  onEdit={handleEditConnection}
                  onForward={setForwardTarget}
                  startForward={conns.startForward}
                  onPersistForwards={async (c, forwards) => {
                    await conns.update({ id: c.id, forwards });
                    await conns.refresh();
                  }}
                  execRemote={conns.execRemote}
                  onRunInPane={handleRunInPane}
                />
              </div>
            )}

            {/* Main panel - Terminal Manager */}
            <ErrorBoundary level="feature" name="TerminalManager">
              <TerminalManager
                viewTabs={viewTabs}
                tabGroups={tabGroups}
                activeTabId={activeTabId}
                onSplitPane={handleSplitPane}
                onClosePane={handleClosePane}
                onFocusPane={handleFocusPane}
                onSplitRatioChange={handleSplitRatioChange}
                onSwitchTab={handleSwitchTab}
                onApplyLayout={
                  toolbarPrefs.layouts && layoutsAvailable ? handleApplyLayout : undefined
                }
                layoutConnections={conns.connections ?? []}
                layoutLibraryReadable={!isLocked}
                onReorderTabs={handleReorderTabs}
                onDetachPane={handleDetachPane}
                onRenameTab={handleRenameTab}
                onMergeTab={handleMergeTab}
                onCloseTab={handleCloseTab}
                onDuplicateTab={(id) => void handleDuplicateTab(id)}
                onCloseOtherTabs={(id) => void handleCloseOtherTabs(id)}
                onToggleBroadcast={(id) => toggleBroadcast(id, activeSessions(id))}
                onReorganizePane={handleReorganizePane}
                onNewLocalTerminal={handleNewLocalTerminal}
                shellMenu={toolbarPrefs.newTerminalMenu ? newTerminalShells : undefined}
                probeShells={!isServerCtx}
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
          reveal={conns.reveal}
          jumpCandidates={conns.connections}
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
      {boardCollectionId &&
        conns.readBoard &&
        conns.saveBoard &&
        (() => {
          const col = conns.collections?.find((c) => c.id === boardCollectionId);
          return (
            <BoardModal
              collectionId={boardCollectionId}
              collectionName={col?.name ?? ''}
              memberCount={col?.memberCount ?? 1}
              isPersonal={col?.isPersonal ?? false}
              shared={isServerContext}
              canWrite={col?.role === 'owner' || col?.role === 'editor'}
              readBoard={conns.readBoard}
              saveBoard={conns.saveBoard}
              onClose={() => setBoardCollectionId(null)}
            />
          );
        })()}
      {/* Creating a collection: on a server it starts with members (MemberPicker, which
          seals the keys to them); in a vault there is nobody to add, so it is the plain
          name/colour form and the core wraps the keys with the master key (ADR 0018). */}
      {showNewCollection &&
        (() => {
          const close = () => {
            setShowNewCollection(false);
            setPendingCollectionFolder(null);
          };
          const placeInFolder = (id: string) => {
            if (pendingCollectionFolder) tree.moveCollection(id, pendingCollectionFolder);
          };
          if (isServerContext) {
            return (
              <MemberPicker
                mode="create"
                onClose={close}
                onSaved={fetchConnections}
                onCreated={placeInFolder}
              />
            );
          }
          const create = conns.createCollection;
          if (!create) return null;
          return (
            <CollectionEditDialog
              onClose={close}
              onSaved={fetchConnections}
              onPersist={async (name, color, hc) => {
                placeInFolder(await create(name, color, hc));
              }}
            />
          );
        })()}
      {folderDialog && (
        <CollectionFolderDialog
          collectionId={folderDialog.collectionId}
          collectionName={
            conns.collections?.find((c) => c.id === folderDialog.collectionId)?.name ??
            openCollectionName
          }
          parentPath={folderDialog.parentPath}
          renamePath={folderDialog.renamePath}
          initialName={folderDialog.initialName}
          initialColor={folderDialog.initialColor}
          onClose={() => setFolderDialog(null)}
          onSaved={fetchConnections}
          onPersist={conns.saveFolder}
        />
      )}
      {deleteSubfolder && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setDeleteSubfolder(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-lg font-semibold">
              {t('ws.deleteFolderTitle', { name: deleteSubfolder.path.split('/').pop() ?? '' })}
            </h3>
            <p className="mb-4 text-sm text-muted-foreground">
              {isServerContext ? t('ws.deleteSubfolderWhyShared') : t('ws.deleteSubfolderWhy')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteSubfolder(null)}
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
              >
                {t('dlg.cancel')}
              </button>
              <button
                onClick={async () => {
                  const target = deleteSubfolder;
                  setDeleteSubfolder(null);
                  try {
                    if (conns.deleteFolder) {
                      await conns.deleteFolder(target.collectionId, target.path);
                    } else {
                      if (!serverKeys.publicKey || !serverKeys.privateKey) return;
                      await deleteCollectionFolder(
                        target.collectionId,
                        serverKeys.publicKey,
                        serverKeys.privateKey,
                        target.path,
                      );
                    }
                    await fetchConnections();
                  } catch (err) {
                    console.error('Failed to delete folder:', err);
                  }
                }}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                {t('dlg.delete')}
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
          rootLabel={moveMachineTarget.collectionId ? t('ws.collectionRoot') : t('ws.noFolder')}
          onClose={() => setMoveMachineTarget(null)}
          onPick={async (folder) => {
            await conns.update({ id: moveMachineTarget.id, folder });
            await fetchConnections();
          }}
        />
      )}
      {deleteFolderTarget && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setDeleteFolderTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-lg font-semibold">
              {t('ws.deleteFolderTitle', { name: deleteFolderTarget.name })}
            </h3>
            <p className="mb-4 text-sm text-muted-foreground">{t('ws.removeFolderWhy')}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteFolderTarget(null)}
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
              >
                {t('dlg.cancel')}
              </button>
              <button
                onClick={() => {
                  tree.deleteFolder(deleteFolderTarget.id);
                  setDeleteFolderTarget(null);
                }}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                {t('dlg.delete')}
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
          initialHc={collectionEdit.hc}
          onClose={() => setCollectionEdit(null)}
          onSaved={fetchConnections}
          onPersist={
            conns.renameCollection && collectionEdit.id
              ? (name, color, hc) => conns.renameCollection!(collectionEdit.id!, name, color, hc)
              : undefined
          }
        />
      )}

      {/* Delete collection confirmation (ADR 0016) */}
      {deleteCollectionTarget && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setDeleteCollectionTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-lg font-semibold">
              {t('ws.deleteCollTitle', { name: deleteCollectionTarget.name })}
            </h3>
            <p className="mb-4 text-sm text-muted-foreground">
              {isServerContext ? t('ws.deleteCollWhyShared') : t('ws.deleteCollWhy')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteCollectionTarget(null)}
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
              >
                {t('dlg.cancel')}
              </button>
              <button
                onClick={handleDeleteCollectionConfirmed}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                {t('dlg.delete')}
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
            <p className="mb-6 text-sm text-muted-foreground">{t('connections.deleteConfirm')}</p>
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

      {/* Settings Modal — local mode only. In a server session AccountsShell renders it (once,
          above the overlay pages) since it drives the same global store. */}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {cheatsheetOpen && <ShortcutsCheatsheet onClose={() => setCheatsheetOpen(false)} />}

      {showSettings && !identity && (
        <Settings
          onClose={() => setShowSettings(false)}
          connections={conns.connections ?? []}
          libraryReadable={!isLocked}
        />
      )}

      {/* Quick SSH Modal */}
      {/* Raised by `askSecret` from wherever a connection is opened (ADR 0024 §4).
          Mounted once, like the create-vault dialog, for the same reason. */}
      <SecretPrompt />

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

      {kbdChallenge && (
        <KbdInteractiveModal
          challenge={kbdChallenge}
          busy={kbdBusy}
          onSubmit={handleKbdSubmit}
          onCancel={handleKbdCancel}
        />
      )}

      {/* Port forwarding panel for a machine */}
      {forwardTarget && (
        <PortForwardModal
          connection={forwardTarget}
          onPersist={async (forwards) => {
            await conns.update({ id: forwardTarget.id, forwards });
            setForwardTarget((prev) => (prev ? { ...prev, forwards } : prev));
            fetchConnections();
          }}
          onStart={conns.startForward && ((f) => conns.startForward!(forwardTarget, f))}
          onClose={() => setForwardTarget(null)}
        />
      )}

      {/* Pre-connect hook: runs a local command before opening SSH */}
      {preconnectPrompt && preconnectPrompt.conn.preconnect && (
        <PreconnectModal
          command={preconnectPrompt.conn.preconnect}
          connectionName={preconnectPrompt.conn.name}
          onSuccess={() => {
            const settle = preconnectPrompt.settle;
            setPreconnectPrompt(null);
            settle(true);
          }}
          onCancel={() => {
            const settle = preconnectPrompt.settle;
            setPreconnectPrompt(null);
            settle(false);
          }}
        />
      )}

      {/* Import SSH Config Modal */}
      {showImportSSH &&
        (isServerContext ? (
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
              setToastMessage(t('ws.importedMachines', { count }));
            }}
          />
        ) : (
          <ImportSSHConfigModal
            collectionTargets={conns.writableCollections ?? []}
            defaultCollectionId={importCollectionId}
            create={conns.create}
            onClose={() => setShowImportSSH(false)}
            onImported={(count) => {
              void conns.refresh();
              setToastType('success');
              setToastMessage(t('ws.importedConnections', { count }));
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
            className="relative mx-4 w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setShowVaultPicker(false)}
              aria-label={t('common.close')}
              title={t('common.close')}
              className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <h2 className="text-lg font-semibold">{t('ws.openAVault')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('ws.openAVaultHint')}</p>
            <div className="mt-4 flex flex-col gap-2">
              {lockedVaults.map((v) => {
                const isThisWindow = currentVaultPath != null && v.path === currentVaultPath;
                return (
                  <div
                    key={v.path}
                    className="group flex items-center gap-1 rounded-lg border border-border bg-background pr-1 hover:border-primary"
                  >
                    <button
                      onClick={() => {
                        setShowVaultPicker(false);
                        if (isThisWindow) {
                          setUnlockFromPicker(true);
                          setShowUnlockModal(true);
                        } else requestSwitchContext({ kind: 'local', path: v.path });
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-muted"
                    >
                      {v.icon?.startsWith('data:') ? (
                        <img
                          src={v.icon}
                          alt=""
                          className="h-6 w-6 flex-none rounded object-cover"
                        />
                      ) : (
                        <span className="text-xl leading-none" aria-hidden>
                          {v.icon || '🔒'}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{v.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {v.path}
                        </span>
                      </span>
                      <span className="flex-none text-xs text-muted-foreground">
                        {isThisWindow ? t('unlock.submit') : t('hub.open')}
                      </span>
                    </button>
                    {!isThisWindow && (
                      <button
                        onClick={() => {
                          setShowVaultPicker(false);
                          requestOpenContext({ kind: 'local', path: v.path });
                        }}
                        title={t('ws.openInNewWindow')}
                        aria-label={t('ws.openInNewWindowOf', { name: v.label })}
                        className="flex-none rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M14 3h7v7m0-7l-9 9M10 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-4"
                          />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => setRemoveVault(v)}
                      title={t('ws.removeFromList')}
                      aria-label={t('ws.removeOf', { name: v.label })}
                      className="flex-none rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                    >
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13"
                        />
                      </svg>
                    </button>
                  </div>
                );
              })}
              <button
                onClick={() => {
                  setShowVaultPicker(false);
                  openCreateVault();
                }}
                className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-sm text-muted-foreground hover:border-primary hover:text-foreground"
              >
                <span aria-hidden>＋</span> {t('ws.newLocalVault')}
              </button>
              <button
                onClick={() => {
                  setShowVaultPicker(false);
                  sendVaultCommand({ type: 'vault-open-file' });
                }}
                className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-sm text-muted-foreground hover:border-primary hover:text-foreground"
              >
                <span aria-hidden>📂</span> {t('ws.openVaultFile')}
              </button>
            </div>
          </div>
        </div>
      )}

      {removeVault && (
        <VaultRemoveDialog vault={removeVault} onClose={() => setRemoveVault(null)} />
      )}

      {showCreateVault && <CreateVaultDialog onClose={() => setShowCreateVault(false)} />}

      {/* Unlock Modal (context-specific, provided by the shell). Closing it returns to the vault
          picker when we came from there, so the user doesn't have to start over. */}
      {showUnlockModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-lg">
            {auth.renderUnlockModal({
              onClose: () => {
                // Closing a brand-new vault before its password is set: confirm the abandon
                // (and offer to delete the file we just created) instead of silently leaving it.
                if (pendingNewVaultPath) {
                  setAbandonDeleteFile(true);
                  setAbandonNewVault(true);
                  return; // keep the setup modal mounted behind the confirm
                }
                setShowUnlockModal(false);
                if (unlockFromPicker) {
                  setUnlockFromPicker(false);
                  setShowVaultPicker(true);
                }
              },
            })}
          </div>
        </div>
      )}

      {abandonNewVault && pendingNewVaultPath && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl">
            <h3 className="font-semibold">{t('ws.abandonTitle')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('ws.abandonWhy')}</p>
            <p className="mt-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
              {pendingNewVaultPath}
            </p>
            <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
              <input
                type="checkbox"
                checked={abandonDeleteFile}
                onChange={(e) => setAbandonDeleteFile(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-none accent-red-500"
              />
              <span className="min-w-0 text-sm">
                <span className="font-medium text-red-500">{t('ws.deleteFile')}</span>
                <span className="block text-xs text-muted-foreground">{t('ws.deleteFileWhy')}</span>
              </span>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setAbandonNewVault(false)}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-muted"
              >
                {t('ws.keepSettingUp')}
              </button>
              <button
                onClick={() => {
                  if (abandonDeleteFile)
                    sendVaultCommand({ type: 'vault-delete', path: pendingNewVaultPath });
                  setAbandonNewVault(false);
                  setShowUnlockModal(false);
                  // Leave the abandoned vault and return to the base workspace on the default vault
                  // (no forced setup) — the shell recreates the default if it was the one abandoned.
                  requestReloadContext();
                }}
                className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600"
              >
                {abandonDeleteFile ? t('ws.abandonDelete') : t('ws.abandonKeep')}
              </button>
            </div>
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

      {/* {t('ws.defaultShell')} Dropdown (Portal) */}
      {showDefaultShellDropdown &&
        createPortal(
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
                <p className="text-xs font-medium text-muted-foreground">{t('ws.defaultShell')}</p>
                <p className="text-xs text-muted-foreground/70 mt-1">{t('ws.defaultShellWhy')}</p>
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
                      isInstalled
                        ? 'hover:bg-muted cursor-pointer'
                        : 'opacity-50 cursor-not-allowed'
                    }`}
                    title={!isInstalled ? `${shell.name} is not installed` : ''}
                  >
                    <span className="text-lg">{shell.icon}</span>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{shell.name}</span>
                        {!isInstalled && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-500 border border-red-500/30">
                            {t('ws.notInstalled')}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">{shell.path}</span>
                    </div>
                    {/* The default is marked, the others are not — and with the mock's ★,
                      a text glyph, rather than ⭐, which is an emoji and therefore the
                      platform's picture rather than this design's mark. */}
                    <span className="text-lg text-yellow-500">
                      {settings.defaultShell === shell.path ? '★' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
