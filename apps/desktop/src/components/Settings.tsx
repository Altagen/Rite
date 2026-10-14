/**
 * Settings Component
 *
 * Modal for application settings configuration
 */

import { useEffect, useState } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';
import { useDisplayPrefs } from '../store/displayPrefs';
import { useTranslation } from '../i18n/i18n';
import { SplitsModal } from './SplitsModal';
import { LayoutsModal } from './LayoutsModal';
import { LayoutCards } from './LayoutCards';
import { Dropdown } from './Dropdown';
import { useToolbar, type ToolbarPrefs } from '../store/toolbar';
import { useLayouts } from '../store/layouts';
import { installedShells, type ShellChoice } from '../utils/shells';
import { ShortcutsSettings } from './ShortcutsSettings';
import { terminalPool, getTerminalThemeName, type TerminalThemeName } from '../utils/terminalPool';
import { useHealthPref, type HealthPref } from '../store/healthPrefStore';
import { useServerSession } from '../store/serverSessionStore';
import { useFocusMode } from '../store/focusMode';
import { useAutoReconnect } from '../store/autoReconnect';
import { isNativeShell } from '../utils/nativeShell';
import { probeVerdict } from '../utils/dashboardProbes';
import { Backend } from '../utils/backend';
import { RiteHttpError } from '../utils/httpError';

/**
 * The two chords that are not in the bindings table, and why.
 *
 * There used to be a second, static list here naming all six — written by hand,
 * which is how it came to advertise `Ctrl+Shift+V` for the vertical split after the
 * default moved off it, and `Ctrl+W` with no mention of Cmd. A dialog that
 * contradicts itself about its own keyboard is worse than one that says less, so the
 * four bindable commands are now read from the engine that runs them, and only these
 * two are listed by hand — because neither is a binding:
 *
 *   * F11 is focus mode, which the native shell owns and the web UI does not have;
 *   * Escape dismisses. Making it remappable would let someone remove the only way
 *     out of a find bar that covers the terminal.
 */
const KBD = 'rounded border border-border border-b-2 bg-background px-1.5 font-mono text-[11px] text-foreground';
const FIXED_CHORDS: { key: string; i18n: string; nativeOnly?: boolean }[] = [
  { key: 'F11', i18n: 'shortcuts.fixed.focusMode', nativeOnly: true },
  { key: 'Esc', i18n: 'shortcuts.fixed.dismiss' },
];

interface SettingsProps {
  onClose: () => void;
  /**
   * The machines a layout can name, for the layouts editor to resolve against.
   *
   * Passed in rather than read from a store: which machines exist depends on the
   * context this workspace is on, and the editor would rather show nothing than
   * show the wrong library. Absent (the accounts shell) ⇒ the editor says it cannot
   * check the names, which is true there.
   */
  connections?: { name: string }[];
  /** False when the vault is locked: the names are encrypted and cannot be read. */
  libraryReadable?: boolean;
}

/**
 * The sections, in rail order. This list is the only place that order is decided.
 *
 * `local` marks a section that belongs to a local vault (a server governs its own
 * shell, holds its own accounts, and has no master password of yours); `native`
 * marks one the browser does not have; `vault` marks one that needs a vault to
 * **exist**. A section hidden by any of them is hidden from the rail too — a rail
 * entry that leads to nothing is worse than no entry.
 *
 * `vault` is as narrow as it looks, deliberately. A *locked* vault is no reason to
 * hide anything: the settings table is plaintext in the vault's database, and it
 * reads (200) and writes (204) with the vault locked — only the connection blobs are
 * gated, and those answer 410. So the theme, the keyboard, the splits, the language,
 * the shell, auto-lock, the clipboard and host-key verification are all reachable
 * before unlocking, which is what ADR 0014's base-first workspace already promised.
 * The two exceptions are the two with nothing to act on until a vault exists.
 */
type SectionId =
  | 'appearance'
  | 'toolbar'
  | 'keyboard'
  | 'splits'
  | 'layouts'
  | 'shell'
  | 'machines'
  | 'security'
  | 'ssh'
  | 'clipboard'
  | 'focus'
  | 'language'
  | 'password'
  | 'danger';

const RAIL: {
  id: SectionId;
  i18n: string;
  local?: true;
  native?: true;
  vault?: true;
  /** Needs a workspace file, which a shared server does not have (ADR 0023). */
  file?: true;
  danger?: true;
}[] = [
  { id: 'appearance', i18n: 'settings.sec.appearance' },
  { id: 'toolbar', i18n: 'settings.sec.toolbar' },
  { id: 'keyboard', i18n: 'settings.keyboard' },
  // Two entries, because they are two features. A preset is one command in one pane;
  // a layout is what opens when you sit down, and it lives in a file.
  { id: 'splits', i18n: 'split.presets', file: true },
  { id: 'layouts', i18n: 'layouts.title', file: true },
  { id: 'shell', i18n: 'settings.sec.shell', local: true },
  { id: 'machines', i18n: 'settings.sec.machines' },
  { id: 'security', i18n: 'settings.security' },
  { id: 'ssh', i18n: 'settings.sec.ssh' },
  { id: 'clipboard', i18n: 'settings.clipboard' },
  { id: 'focus', i18n: 'settings.sec.focus', native: true },
  { id: 'language', i18n: 'settings.language' },
  { id: 'password', i18n: 'settings.sec.password', local: true, vault: true },
  { id: 'danger', i18n: 'settings.sec.danger', local: true, vault: true, danger: true },
];

export function Settings({ onClose, connections, libraryReadable }: SettingsProps) {
  const { t, locale, setLocale } = useTranslation();
  const { settings, fetchSettings, updateSettings } = useSettingsStore();
  const native = isNativeShell();
  const focusAutoCollapse = useFocusMode((s) => s.autoCollapse);
  const setFocusAutoCollapse = useFocusMode((s) => s.setAutoCollapse);
  const autoReconnect = useAutoReconnect((s) => s.enabled);
  const setAutoReconnect = useAutoReconnect((s) => s.setEnabled);
  const showMemberCount = useDisplayPrefs((s) => s.showMemberCount);
  const setShowMemberCount = useDisplayPrefs((s) => s.setShowMemberCount);
  const machineProbes = useDisplayPrefs((s) => s.machineProbes);
  const setMachineProbes = useDisplayPrefs((s) => s.setMachineProbes);
  const healthPref = useHealthPref((s) => s.pref);
  const setHealthPref = useHealthPref((s) => s.setPref);
  // Local terminals only: on a server the shell is server-governed (no per-user picker).
  const serverMode = useServerSession((s) => s.mode);
  const isLocalContext = !serverMode?.accounts;
  // Does a vault exist at all? `isFirstRun` means there is none yet, so the two
  // sections that act on one have nothing to act on. A vault that exists but is
  // locked is a different thing and hides nothing — see the note on RAIL.
  const hasVault = useAuthStore((a) => a.isFirstRun) === false;
  // ADR 0019: the toggle below can only narrow the server's answer, so when the server
  // already says no the switch is told it changes nothing rather than pretending to.
  const probesVerdict = probeVerdict({ mode: serverMode ?? null, userWants: true });
  const probesRefusedByServer = !probesVerdict.allowed && probesVerdict.by === 'server';
  const [shellDraft, setShellDraft] = useState('');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync draft to async-loaded value
    setShellDraft(settings.defaultShell);
  }, [settings.defaultShell]);

  // Two libraries, two dialogs. They shared one and that is what made them look
  // like one feature.
  const hasWorkspaceFile = useLayouts((st) => st.available);
  // The cards, and the switch that writes `startup` back into the file. Selected one
  // by one so a change to the file's text does not re-render this whole dialog.
  const fileLayouts = useLayouts((st) => st.layouts);
  const layoutsError = useLayouts((st) => st.error);
  const setLayoutStartup = useLayouts((st) => st.setStartup);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [layoutsOpen, setLayoutsOpen] = useState(false);

  // The toolbar is a view preference: hiding a button changes nothing but the view.
  const toolbar = useToolbar();

  // The shells this computer has, for the picker that used to be a path you typed.
  const [shellChoices, setShellChoices] = useState<ShellChoice[]>([]);
  useEffect(() => {
    if (!isLocalContext) return;
    void installedShells().then(setShellChoices);
  }, [isLocalContext]);

  const toolbarRow = (key: keyof ToolbarPrefs, labelKey: string, descKey: string) => (
    <label className="flex cursor-pointer items-center gap-3">
      <input
        type="checkbox"
        checked={toolbar[key]}
        onChange={(e) => toolbar.set(key, e.target.checked)}
        className="h-5 w-5 rounded border-border bg-background text-primary focus:ring-2 focus:ring-primary"
        data-testid={`toolbar-${key}`}
      />
      <div>
        <div className="font-medium">{t(labelKey)}</div>
        <div className="text-sm text-muted-foreground">{t(descKey)}</div>
      </div>
    </label>
  );

  /**
   * Which section the rail is showing.
   *
   * Everything used to be one column of eleven sections in one scroll, which made
   * finding the clipboard timeout a matter of knowing roughly how far down it lived.
   * The rail is the index; `hidden` on each section is what keeps only one of them
   * in view, so the sections themselves did not have to move.
   */
  const [active, setActive] = useState<SectionId>('appearance');
  // Change master password (local vault): re-keys all connections server-side.
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const changeMaster = async () => {
    if (pwBusy) return;
    if (pwNew !== pwConfirm) {
      setPwMsg({ kind: 'err', text: 'The new passwords don’t match.' });
      return;
    }
    setPwBusy(true);
    setPwMsg(null);
    try {
      await Backend.Auth.changeMasterPassword(pwCurrent, pwNew);
      setPwCurrent('');
      setPwNew('');
      setPwConfirm('');
      setPwMsg({ kind: 'ok', text: 'Master password changed.' });
    } catch (e) {
      const text =
        e instanceof RiteHttpError && e.status === 401
          ? 'The current password is incorrect.'
          : e instanceof RiteHttpError && e.status === 400
            ? 'The new password is too weak.'
            : 'Could not change the master password.';
      setPwMsg({ kind: 'err', text });
    } finally {
      setPwBusy(false);
    }
  };
  // Reset vault (local vault only): wipe the master password + all connections, then reboot to
  // first-run. Guarded by typing the confirmation phrase (mirrors the unlock screen).
  const [resetText, setResetText] = useState('');
  const resetVault = async () => {
    if (resetText !== 'DELETE ALL DATA') return;
    try {
      await Backend.Auth.resetDatabase();
      window.location.reload();
    } catch (e) {
      console.error('Reset vault failed:', e);
    }
  };

  const [selectedTimeout, setSelectedTimeout] = useState<number>(0);
  const [customTimeout, setCustomTimeout] = useState('');
  const [clipboardClearEnabled, setClipboardClearEnabled] = useState(settings.clipboardClearEnabled);
  const [hostKeyVerificationMode, setHostKeyVerificationMode] = useState<'strict' | 'warn' | 'accept'>(settings.hostKeyVerificationMode);
  const [terminalTheme, setTerminalTheme] = useState<TerminalThemeName>(getTerminalThemeName());


  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    // Initialize the editable form state from the loaded settings. These
    // setState calls intentionally run only when `settings` changes.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!settings.autoLockEnabled) {
      setSelectedTimeout(0);
    } else if ([1, 3, 5].includes(settings.autoLockTimeout)) {
      setSelectedTimeout(settings.autoLockTimeout);
    } else if (settings.autoLockTimeout > 0) {
      setSelectedTimeout(-1);
      setCustomTimeout(String(settings.autoLockTimeout));
    } else {
      setSelectedTimeout(0);
    }

    setClipboardClearEnabled(settings.clipboardClearEnabled);
    setHostKeyVerificationMode(settings.hostKeyVerificationMode);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [settings]);

  // Closing on an outside click now belongs to the dropdown itself — one place
  // instead of one effect per dropdown in every dialog that has one.

  /**
   * Everything in this dialog applies the moment it is changed.
   *
   * Four settings used not to: the auto-lock switch, its delay, the clipboard
   * auto-clear and the SSH host-key mode waited for a Save button at the bottom,
   * while every other control here wrote immediately. Closing with the ✕ — the
   * control that closes every other dialog in the app — therefore threw those four
   * away without a word, including the host-key policy, which is a security setting.
   * One rule now: change it, it is stored. That is also why there is no footer.
   */
  const handleTimeoutChange = (value: number) => {
    setSelectedTimeout(value);
    if (value !== -1) {
      setCustomTimeout('');
      void updateSettings({ autoLockEnabled: value !== 0, autoLockTimeout: value === 0 ? 0 : value });
    }
    // `-1` is "custom": there is no delay to store until a number is typed, so the
    // input below persists it rather than this storing a zero in the meantime.
  };

  const applyCustomTimeout = (text: string) => {
    const minutes = parseInt(text, 10);
    if (Number.isFinite(minutes) && minutes > 0) {
      void updateSettings({ autoLockEnabled: true, autoLockTimeout: minutes });
    }
  };

  const getTimeoutLabel = () => {
    if (selectedTimeout === 0) return t('settings.disabled');
    if (selectedTimeout === 1) return t('settings.oneMinute');
    if (selectedTimeout === 3) return t('settings.threeMinutes');
    if (selectedTimeout === 5) return t('settings.fiveMinutes');
    if (selectedTimeout === -1) {
      return customTimeout ? `${customTimeout} ${t('settings.customMinutes')}` : t('settings.custom');
    }
    return t('settings.disabled');
  };



  // A section the current context does not have is not reachable from the rail. The
  // workspace file is one of those: on a shared server there is no file, so presets
  // and layouts are absent rather than shown empty (ADR 0023).
  const rail = RAIL.filter(
    (r) =>
      (!r.local || isLocalContext) &&
      (!r.native || native) &&
      (!r.vault || hasVault) &&
      (!r.file || hasWorkspaceFile),
  );
  // …and if the active one disappears (a context switch), fall back to the first.
  const shown: SectionId = rail.some((r) => r.id === active) ? active : (rail[0]?.id ?? 'appearance');

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="mx-4 flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
        {/* Header */}
        <div className="flex flex-none items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-xl font-bold">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label={t('settings.close')}
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* The rail. A row of chips at phone width, a column beside the body above it. */}
          <nav
            aria-label={t('settings.sections')}
            className="flex flex-none gap-1 overflow-x-auto border-b border-border p-2 sm:w-52 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r"
          >
            {rail.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setActive(r.id)}
                aria-current={shown === r.id ? 'page' : undefined}
                className={`flex-none whitespace-nowrap rounded px-3 py-1.5 text-left text-sm transition-colors sm:w-full ${
                  shown === r.id
                    ? 'bg-muted font-medium text-foreground'
                    : r.danger
                      ? 'text-red-500 hover:bg-muted'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                data-testid={`settings-nav-${r.id}`}
              >
                {t(r.i18n)}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {/* Appearance */}
          <section hidden={shown !== 'appearance'} className="pb-2">
            <h3 className="mb-4 text-lg font-semibold">Appearance</h3>
            <div>
              <label className="mb-1 block text-sm font-medium">Terminal theme</label>
              <Dropdown<TerminalThemeName>
                value={terminalTheme}
                label="Terminal theme"
                testId="terminal-theme"
                options={[
                  { value: 'dark', label: 'Dark (default)' },
                  { value: 'grey', label: 'Grey' },
                  { value: 'translucent', label: 'Translucent' },
                ]}
                onChange={(name) => {
                  setTerminalTheme(name);
                  terminalPool.setTheme(name);
                }}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Applies live; translucency shows on terminals opened afterwards.
              </p>
            </div>
            <label className="mt-4 flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={showMemberCount}
                onChange={(e) => setShowMemberCount(e.target.checked)}
                className="h-4 w-4"
              />
              <span>
                <span className="text-sm font-medium">Show member count on collections</span>
                <span className="block text-xs text-muted-foreground">The number next to shared collections (the icon stays)</span>
              </span>
            </label>
          </section>

          {/* Machine status (ADR 0017) — a client-side narrowing of the server's health policy. */}
          <section hidden={shown !== 'machines'} className="pb-2">
            <h3 className="mb-4 text-lg font-semibold">Machine status</h3>
            <div>
              <label className="mb-1 block text-sm font-medium">Health-check</label>
              <Dropdown<HealthPref>
                value={healthPref}
                label="Health-check"
                testId="health-pref"
                options={[
                  { value: 'inherit', label: 'Follow the server policy' },
                  { value: 'off', label: 'Off — no status' },
                  { value: 'passive', label: 'Passive — last seen only' },
                  { value: 'on-demand', label: 'On-demand checks' },
                  { value: 'full', label: 'Background polling' },
                ]}
                onChange={setHealthPref}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="text-amber-500">Governed by your server</span> — you can only narrow it.
                Passive “last seen” costs no network traffic; active probing does.
              </p>
            </div>
            <label className="mt-4 flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={machineProbes}
                onChange={(e) => setMachineProbes(e.target.checked)}
                className="h-4 w-4"
              />
              <span>
                <span className="text-sm font-medium">Container and service cards on the machine dashboard</span>
                <span className="block text-xs text-muted-foreground">
                  These two cards run a command on the host each time they refresh. Turning them off
                  leaves the rest of the dashboard — address, port forwarding, the Board — untouched.
                  {probesRefusedByServer && (
                    <>
                      {' '}
                      <span className="text-amber-500">Your server turns them off for this client</span>, so
                      this setting changes nothing here.
                    </>
                  )}
                </span>
              </span>
            </label>
          </section>

          {/* Default shell — local terminals only (a server governs its own shell).

              The same setting as the toolbar's picker, and now the same control. This
              used to be a path you typed, while the toolbar listed the shells actually
              installed: one stored value, two editors, and the worse one was the one in
              the preferences. The field below stays for a shell we did not find. */}
          {isLocalContext && (
            <section hidden={shown !== 'shell'} className="pb-2">
              <h3 className="mb-1 text-lg font-semibold">{t('settings.sec.shell')}</h3>
              <p className="mb-4 text-xs text-muted-foreground">{t('settings.shellHint')}</p>
              <div className="space-y-3">
                {shellChoices.length > 0 && (
                  <ul className="flex flex-col gap-1.5" data-testid="shell-choices">
                    {shellChoices.map((shell) => (
                      <li key={shell.path}>
                        <button
                          type="button"
                          onClick={() => void updateSettings({ defaultShell: shell.path })}
                          aria-pressed={settings.defaultShell === shell.path}
                          className={`flex w-full items-center gap-2 rounded border px-3 py-2 text-left text-sm transition-colors ${
                            settings.defaultShell === shell.path
                              ? 'border-primary bg-primary/10'
                              : 'border-border hover:bg-muted'
                          }`}
                          data-testid={`shell-${shell.name}`}
                        >
                          <span className="font-medium">{shell.name}</span>
                          <code className="truncate font-mono text-xs text-muted-foreground">{shell.path}</code>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">{t('settings.shellCustom')}</label>
                  <input
                    value={shellDraft}
                    onChange={(e) => setShellDraft(e.target.value)}
                    onBlur={() => {
                      const v = shellDraft.trim();
                      if (v && v !== settings.defaultShell) void updateSettings({ defaultShell: v });
                    }}
                    placeholder="/usr/bin/fish"
                    className="w-full rounded border border-border bg-input px-3 py-2 font-mono text-sm"
                    data-testid="shell-path"
                  />
                </div>
              </div>
            </section>
          )}

          {/* Keyboard — one table owning every binding. */}
          <section hidden={shown !== 'keyboard'} className="pb-2">
            <h3 className="mb-4 text-lg font-semibold">{t('settings.keyboard')}</h3>
            <ShortcutsSettings />
            <ul className="mt-3 flex flex-col gap-1">
              {FIXED_CHORDS.filter((c) => native || !c.nativeOnly).map((c) => (
                <li key={c.key} className="text-xs text-muted-foreground">
                  <kbd className={KBD}>{c.key}</kbd> <span className="ml-1">{t(c.i18n)}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Splits — what a divider can open, beyond a plain terminal. */}
          {/* Split presets: one command, one pane. Layouts are next door, in their
              own section, because they are not a bigger preset — see LayoutsModal. */}
          <section hidden={shown !== 'splits'} className="pb-2">
            <h3 className="mb-4 text-lg font-semibold">{t('split.presets')}</h3>
            <p className="mb-3 text-xs text-muted-foreground">{t('settings.splitsHint')}</p>
            <button
              type="button"
              onClick={() => setPresetsOpen(true)}
              className="rounded border border-border px-3 py-1.5 text-xs hover:bg-muted"
              data-testid="open-splits-settings"
            >
              {t('settings.editPresets')}
            </button>
          </section>

          {/* Layouts: a file (docs/LAYOUTS.md). What opens, where, on which machine.
              The cards lead, because the section used to be a title and a button that
              sent you somewhere else, while what you wanted to know — what do I have
              — was behind that button and below a textarea. */}
          <section hidden={shown !== 'layouts'} className="pb-2">
            <h3 className="mb-4 text-lg font-semibold">{t('layouts.title')}</h3>
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{t('layouts.lede')}</p>

            {/* A broken file is reported where you look first, not only inside the
                editor: "no layouts" and "your file has a typo on line 12" are very
                different facts and used to look identical here. */}
            {layoutsError && (
              <p
                className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs leading-relaxed"
                data-testid="settings-layouts-error"
              >
                <span className="font-semibold">{t('layouts.notLoaded')}</span>{' '}
                {layoutsError.line > 0 ? t('layouts.atLine', { line: layoutsError.line }) : null}{' '}
                {layoutsError.message}
                <span className="mt-1 block text-muted-foreground">{t('layouts.keptRunning')}</span>
              </p>
            )}

            {fileLayouts.length > 0 ? (
              <LayoutCards
                layouts={fileLayouts}
                connections={connections ?? []}
                libraryReadable={libraryReadable ?? false}
                onToggleStartup={(index, on) => void setLayoutStartup(index, on)}
              />
            ) : (
              !layoutsError && (
                <p className="mb-3 text-xs text-muted-foreground" data-testid="settings-layouts-empty">
                  {t('layouts.noneYet')}
                </p>
              )
            )}

            <button
              type="button"
              onClick={() => setLayoutsOpen(true)}
              className="mt-3 rounded border border-border px-3 py-1.5 text-xs hover:bg-muted"
              data-testid="open-layouts-settings"
            >
              {t('layouts.openFile')}
            </button>
            <p className="mt-3 text-xs text-muted-foreground">{t('layouts.startupHint')}</p>
          </section>

          {/* The toolbar is the person's own row. Hiding never grants or revokes. */}
          <section hidden={shown !== 'toolbar'} className="pb-2">
            <h3 className="mb-1 text-lg font-semibold">{t('settings.sec.toolbar')}</h3>
            <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{t('settings.toolbarHint')}</p>
            <div className="space-y-3">
              {toolbarRow('shellPicker', 'settings.toolbarShell', 'settings.toolbarShellDesc')}
              {native && toolbarRow('focusMode', 'settings.toolbarFocus', 'settings.toolbarFocusDesc')}
              {toolbarRow('quickSsh', 'settings.toolbarQuickSsh', 'settings.toolbarQuickSshDesc')}
              {hasWorkspaceFile && toolbarRow('layouts', 'settings.toolbarLayouts', 'settings.toolbarLayoutsDesc')}
            </div>
          </section>

          {/* Auto-lock settings */}
          <section hidden={shown !== 'security'} className="pb-2">
            <h3 className="text-lg font-semibold mb-4">{t('settings.security')}</h3>

            <div className="space-y-4">
              {/* Auto-lock. One dropdown component for every choice in this dialog:
                  see Dropdown.tsx for why there used to be two. */}
              <div>
                <label className="mb-1 block text-sm font-medium">{t('settings.autoLockTimeout')}</label>
                <Dropdown<number>
                  value={selectedTimeout}
                  label={t('settings.autoLockTimeout')}
                  testId="auto-lock"
                  options={[
                    { value: 0, label: t('settings.disabled') },
                    { value: 1, label: t('settings.oneMinute') },
                    { value: 3, label: t('settings.threeMinutes') },
                    { value: 5, label: t('settings.fiveMinutes') },
                    { value: -1, label: getTimeoutLabel() === t('settings.custom') ? t('settings.custom') : t('settings.custom') },
                  ]}
                  onChange={handleTimeoutChange}
                />
                <p className="text-sm text-muted-foreground mt-2">{t('settings.autoLockEnabledDesc')}</p>
              </div>

              {/* Custom Timeout Input */}
              {selectedTimeout === -1 && (
                <div>
                  <label className="mb-1 block text-sm font-medium">{t('settings.customMinutes')}</label>
                  <input
                    type="number"
                    value={customTimeout}
                    onChange={(e) => {
                      setCustomTimeout(e.target.value);
                      applyCustomTimeout(e.target.value);
                    }}
                    placeholder={t('settings.customMinutes')}
                    min="1"
                    className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
                  />
                </div>
              )}

              {/* Host-key verification */}
              <div>
                <label className="mb-1 block text-sm font-medium">{t('settings.hostKeyVerification')}</label>
                <Dropdown<'strict' | 'warn' | 'accept'>
                  value={hostKeyVerificationMode}
                  label={t('settings.hostKeyVerification')}
                  testId="host-key-mode"
                  options={[
                    { value: 'strict', label: t('settings.hostKeyVerificationStrict') },
                    { value: 'warn', label: t('settings.hostKeyVerificationWarn') },
                    { value: 'accept', label: t('settings.hostKeyVerificationAccept') },
                  ]}
                  onChange={(mode) => {
                    setHostKeyVerificationMode(mode);
                    void updateSettings({ hostKeyVerificationMode: mode });
                  }}
                />
                <p className="text-sm text-muted-foreground mt-2">{t('settings.hostKeyVerificationDesc')}</p>
              </div>
            </div>
          </section>

          {/* Clipboard settings */}
          <section hidden={shown !== 'clipboard'} className="pb-2">
            <h3 className="text-lg font-semibold mb-4">{t('settings.clipboard')}</h3>

            <div className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={clipboardClearEnabled}
                  onChange={(e) => {
                    setClipboardClearEnabled(e.target.checked);
                    void updateSettings({ clipboardClearEnabled: e.target.checked });
                  }}
                  className="h-5 w-5 rounded border-border bg-background text-primary focus:ring-2 focus:ring-primary"
                />
                <div>
                  <div className="font-medium">{t('settings.clipboardClearEnabled')}</div>
                  <div className="text-sm text-muted-foreground">{t('settings.clipboardClearEnabledDesc')}</div>
                </div>
              </label>
            </div>
          </section>

          {/* Language settings */}
          <section hidden={shown !== 'language'} className="pb-2">
            <h3 className="text-lg font-semibold mb-4">{t('settings.language')}</h3>

            <div>
              <label className="mb-1 block text-sm font-medium">{t('settings.languageLabel')}</label>
              <Dropdown<'en' | 'fr'>
                value={locale}
                label={t('settings.languageLabel')}
                testId="locale"
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'fr', label: 'Français' },
                ]}
                onChange={setLocale}
              />
            </div>
          </section>

          {/* Master password — change it (local vault). Re-keys every connection. */}
          {isLocalContext && (
            <section hidden={shown !== 'password'} className="pb-2">
              <h3 className="mb-4 text-lg font-semibold">Master password</h3>
              <div className="max-w-sm space-y-2">
                <input
                  type="password"
                  value={pwCurrent}
                  onChange={(e) => setPwCurrent(e.target.value)}
                  placeholder="Current password"
                  autoComplete="current-password"
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                />
                <input
                  type="password"
                  value={pwNew}
                  onChange={(e) => setPwNew(e.target.value)}
                  placeholder="New password"
                  autoComplete="new-password"
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                />
                <input
                  type="password"
                  value={pwConfirm}
                  onChange={(e) => setPwConfirm(e.target.value)}
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                />
                {pwMsg && (
                  <p className={`text-xs ${pwMsg.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
                    {pwMsg.text}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void changeMaster()}
                  disabled={pwBusy || !pwCurrent || !pwNew || !pwConfirm}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                >
                  {pwBusy ? 'Changing…' : 'Change password'}
                </button>
              </div>
            </section>
          )}

          {/* Danger zone — reset this local vault (wipe + reboot to first-run). Local only. */}
          {isLocalContext && (
            <section hidden={shown !== 'danger'} className="pb-2">
              <h3 className="mb-4 text-lg font-semibold text-red-500">Danger zone</h3>
              <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4">
                <div className="font-medium">Reset vault</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Erase the master password and all connections on this device. This is
                  irreversible.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    value={resetText}
                    onChange={(e) => setResetText(e.target.value)}
                    placeholder="Type DELETE ALL DATA"
                    aria-label="Reset confirmation"
                    className="w-52 rounded border border-input bg-background px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void resetVault()}
                    disabled={resetText !== 'DELETE ALL DATA'}
                    className="rounded-md border border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                  >
                    Reset vault
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* SSH connections */}
          <section hidden={shown !== 'ssh'} className="pb-2">
            <h3 className="mb-4 text-lg font-semibold">SSH connections</h3>
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={autoReconnect}
                onChange={(e) => setAutoReconnect(e.target.checked)}
                className="h-5 w-5 rounded border-border bg-background text-primary focus:ring-2 focus:ring-primary"
              />
              <div>
                <div className="font-medium">Auto-reconnect lost SSH connections</div>
                <div className="text-sm text-muted-foreground">
                  Off by default. When on, a dropped session reconnects automatically — a new shell,
                  so your history, on-screen output and any running job are lost. When off, the pane
                  shows a Reconnect button instead. Either way you&apos;re told you were disconnected.
                </div>
              </div>
            </label>
          </section>

          {/* Focus mode (client/native only) */}
          {native && (
            <section hidden={shown !== 'focus'} className="pb-2">
              <h3 className="mb-4 text-lg font-semibold">Focus mode</h3>
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={focusAutoCollapse}
                  onChange={(e) => setFocusAutoCollapse(e.target.checked)}
                  className="h-5 w-5 rounded border-border bg-background text-primary focus:ring-2 focus:ring-primary"
                />
                <div>
                  <div className="font-medium">Auto-collapse sidebar in focus mode</div>
                  <div className="text-sm text-muted-foreground">
                    When you enter focus mode (F11), also hide the library sidebar for a terminals-only view.
                  </div>
                </div>
              </label>
            </section>
          )}

          </div>
        </div>


      </div>
      {/* Both libraries sit above this dialog, not inside its scroll area. */}
      {presetsOpen && <SplitsModal onClose={() => setPresetsOpen(false)} />}
      {layoutsOpen && (
        <LayoutsModal
          connections={connections ?? []}
          libraryReadable={libraryReadable ?? false}
          onClose={() => setLayoutsOpen(false)}
        />
      )}
    </div>
  );
}
