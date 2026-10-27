/**
 * Settings Component
 *
 * Modal for application settings configuration
 */

import { useEffect, useState } from 'react';
import { RESET_PHRASE } from '../utils/resetPhrase';
import { RevealToggle } from './RevealToggle';
import { useSettingsStore } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';
import { useDisplayPrefs } from '../store/displayPrefs';
import { useTranslation } from '../i18n/i18n';
import { KnownHostsList } from './KnownHostsList';
import { DEFAULT_CLIPBOARD_MODE } from '../utils/terminalClipboard';
import { SplitsModal } from './SplitsModal';
import { LayoutsModal } from './LayoutsModal';
import { LayoutCards } from './LayoutCards';
import {
  SettingsControl,
  SettingsField,
  SettingsHead,
  SettingsRow,
  SettingsToggle,
} from './SettingsRow';
import { Dropdown } from './Dropdown';
import { useToolbar, type ToolbarPrefs } from '../store/toolbar';
import { useLayouts } from '../store/layouts';
import { layoutsBlockedReason, type LayoutsSupport } from '../utils/layoutsPolicy';
import { installedShells, type ShellChoice } from '../utils/shells';
import { ShortcutsSettings } from './ShortcutsSettings';
import { terminalPool, getTerminalThemeName, type TerminalThemeName } from '../utils/terminalPool';
import { useHealthPref, type HealthPref } from '../store/healthPrefStore';
import { useServerSession, quickSshAllowed, serverShellChoices } from '../store/serverSessionStore';
import { useFocusMode } from '../store/focusMode';
import { useAutoReconnect } from '../store/autoReconnect';
import { isNativeShell } from '../utils/nativeShell';
import { probeVerdict } from '../utils/dashboardProbes';
import { Backend, type Capabilities } from '../utils/backend';
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
const KBD =
  'rounded border border-border border-b-2 bg-background px-1.5 font-mono text-[11px] text-foreground';
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
  | 'system'
  | 'password'
  | 'danger';

const RAIL: {
  id: SectionId;
  i18n: string;
  local?: true;
  native?: true;
  vault?: true;
  /** Needs a workspace to read: a file, or the account's sealed copy (ADR 0027). */
  file?: true;
  danger?: true;
}[] = [
  { id: 'appearance', i18n: 'settings.sec.appearance' },
  { id: 'toolbar', i18n: 'settings.sec.toolbar' },
  { id: 'keyboard', i18n: 'settings.keyboard' },
  // Two entries, because they are two features. A preset is one command in one pane;
  // a layout is what opens at the start of a session. One document holds both.
  { id: 'splits', i18n: 'split.presets', file: true },
  { id: 'layouts', i18n: 'layouts.title', file: true },
  // Not `local`: on a server the shell is the server's, and "which shell do my
  // terminals use" is a question a web user has as much as anyone. They get the answer
  // read-only instead of no section at all — the information was only in a tooltip on
  // the New-terminal button.
  { id: 'shell', i18n: 'settings.sec.shell' },
  { id: 'machines', i18n: 'settings.sec.machines' },
  { id: 'security', i18n: 'settings.security' },
  { id: 'ssh', i18n: 'settings.sec.ssh' },
  { id: 'clipboard', i18n: 'settings.clipboard' },
  { id: 'focus', i18n: 'settings.sec.focus', native: true },
  { id: 'language', i18n: 'settings.language' },
  { id: 'system', i18n: 'settings.sec.system' },
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
  // Local terminals only: on a server the shell is server-governed (no per-user picker),
  // unless the instance says otherwise — then these are the shells it offers, and empty
  // means the decision is not this person's to make.
  const serverMode = useServerSession((s) => s.mode);
  const isLocalContext = !serverMode?.accounts;
  const serverShells = serverShellChoices(serverMode);
  // Asked for once when Settings opens. It cannot change while the page is up: a new
  // build means a new page.
  const [build, setBuild] = useState<Capabilities | null>(null);
  useEffect(() => {
    let cancelled = false;
    Backend.Server.capabilities()
      .then((c) => {
        if (!cancelled) setBuild(c);
      })
      .catch(() => {
        /* an older server has no such route — the rows then read "…" and say nothing false */
      });
    return () => {
      cancelled = true;
    };
  }, []);
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
  // Not the same question: the reader's own switch lives inside the section, so the rail
  // keeps it when they turn layouts off and drops it only when the instance refused or
  // there is nothing to read (ADR 0027).
  const layoutsSupported = useLayouts((st) => st.supported);
  const layoutsSupport = useLayouts((st) => st.support);
  /** The copy convention the workspace document asks for; null ⇒ the shipped default. */
  const copyMode = useLayouts((st) => st.copyMode);
  const layoutsVerdictNow = useLayouts((st) => st.verdict);
  const layoutsEnabled = useLayouts((st) => st.enabled);
  const layoutsPrefer = useLayouts((st) => st.prefer);
  const setLayoutsEnabled = useLayouts((st) => st.setEnabled);
  const setLayoutsPrefer = useLayouts((st) => st.setPrefer);
  const layoutsUpdatedAt = useLayouts((st) => st.updatedAt);
  const layoutsBlocked = layoutsVerdictNow ? layoutsBlockedReason(layoutsVerdictNow) : null;
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
    <SettingsToggle
      title={t(labelKey)}
      hint={t(descKey)}
      checked={toolbar[key]}
      onChange={(next) => toolbar.set(key, next)}
      testId={`toolbar-${key}`}
    />
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
  const [pwReveal, setPwReveal] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const changeMaster = async () => {
    if (pwBusy) return;
    if (pwNew !== pwConfirm) {
      setPwMsg({ kind: 'err', text: t('settings.pwNoMatch') });
      return;
    }
    setPwBusy(true);
    setPwMsg(null);
    try {
      await Backend.Auth.changeMasterPassword(pwCurrent, pwNew);
      setPwCurrent('');
      setPwNew('');
      setPwConfirm('');
      setPwMsg({ kind: 'ok', text: t('settings.pwChanged') });
    } catch (e) {
      const text =
        e instanceof RiteHttpError && e.status === 401
          ? t('settings.pwWrongCurrent')
          : e instanceof RiteHttpError && e.status === 400
            ? t('settings.pwTooWeak')
            : t('settings.pwFailed');
      setPwMsg({ kind: 'err', text });
    } finally {
      setPwBusy(false);
    }
  };
  // {t('settings.resetVault')} (local vault only): wipe the master password + all connections, then reboot to
  // first-run. Guarded by typing the confirmation phrase (mirrors the unlock screen).
  const [resetText, setResetText] = useState('');
  const resetVault = async () => {
    if (resetText !== RESET_PHRASE) return;
    try {
      await Backend.Auth.resetDatabase();
      window.location.reload();
    } catch (e) {
      console.error('[Settings] vault reset failed:', e);
    }
  };

  const [selectedTimeout, setSelectedTimeout] = useState<number>(0);
  const [customTimeout, setCustomTimeout] = useState('');
  const [clipboardClearEnabled, setClipboardClearEnabled] = useState(
    settings.clipboardClearEnabled,
  );
  const [hostKeyVerificationMode, setHostKeyVerificationMode] = useState<
    'strict' | 'warn' | 'accept'
  >(settings.hostKeyVerificationMode);
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
      void updateSettings({
        autoLockEnabled: value !== 0,
        autoLockTimeout: value === 0 ? 0 : value,
      });
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

  // A section the current context does not have is not reachable from the rail. The
  // workspace file is one of those: on a shared server there is no file, so presets
  // and layouts are absent rather than shown empty (ADR 0023).
  const rail = RAIL.filter(
    (r) =>
      (!r.local || isLocalContext) &&
      (!r.native || native) &&
      (!r.vault || hasVault) &&
      (!r.file || layoutsSupported),
  );
  // …and if the active one disappears (a context switch), fall back to the first.
  const shown: SectionId = rail.some((r) => r.id === active)
    ? active
    : (rail[0]?.id ?? 'appearance');

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
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
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
              <SettingsHead title={t('settings.appearance')} />
              <SettingsRow
                title={t('settings.terminalTheme')}
                hint={t('settings.terminalThemeHint')}
              >
                <SettingsControl>
                  <Dropdown<TerminalThemeName>
                    value={terminalTheme}
                    label={t('settings.terminalTheme')}
                    testId="terminal-theme"
                    options={[
                      { value: 'dark', label: t('settings.themeDark') },
                      { value: 'grey', label: t('settings.themeGrey') },
                      { value: 'translucent', label: t('settings.themeTranslucent') },
                    ]}
                    onChange={(name) => {
                      setTerminalTheme(name);
                      terminalPool.setTheme(name);
                    }}
                  />
                </SettingsControl>
              </SettingsRow>
              <SettingsToggle
                title={t('settings.showMemberCount')}
                hint={t('settings.showMemberCountHint')}
                checked={showMemberCount}
                onChange={setShowMemberCount}
              />
            </section>

            {/* Machine status (ADR 0017) — a client-side narrowing of the server's health policy. */}
            <section hidden={shown !== 'machines'} className="pb-2">
              <SettingsHead title={t('settings.machineStatus')} />
              <SettingsRow
                title={t('settings.healthCheck')}
                hint={
                  <>
                    <span className="text-amber-500">{t('settings.governedByServer')}</span> — you
                    can only narrow it. Passive “last seen” costs no network traffic; active probing
                    does.
                  </>
                }
              >
                <SettingsControl>
                  <Dropdown<HealthPref>
                    value={healthPref}
                    label={t('settings.healthCheck')}
                    testId="health-pref"
                    options={[
                      { value: 'inherit', label: t('settings.hcFollow') },
                      { value: 'off', label: t('settings.hcOff') },
                      { value: 'passive', label: t('settings.hcPassive') },
                      { value: 'on-demand', label: t('settings.hcOnDemand') },
                      { value: 'full', label: t('settings.hcBackground') },
                    ]}
                    onChange={setHealthPref}
                  />
                </SettingsControl>
              </SettingsRow>
              <SettingsToggle
                title={t('settings.dashCards')}
                hint={
                  <>
                    {t('settings.dashCardsHint')}
                    {probesRefusedByServer && (
                      <>
                        {' '}
                        <span className="text-amber-500">{t('settings.serverTurnsOff')}</span>
                        {t('settings.changesNothingHere')}
                      </>
                    )}
                  </>
                }
                checked={machineProbes}
                onChange={setMachineProbes}
              />
            </section>

            {/* Default shell — local terminals only (a server governs its own shell).

              The same setting as the toolbar's picker, and now the same control. This
              used to be a path you typed, while the toolbar listed the shells actually
              installed: one stored value, two editors, and the worse one was the one in
              the preferences. The field below stays for a shell we did not find. */}
            <section hidden={shown !== 'shell'} className="pb-2">
              <SettingsHead
                title={t('settings.sec.shell')}
                hint={isLocalContext ? t('settings.shellHint') : t('settings.shellServerHint')}
              />
              {/* On a server the shells are the instance's; which of them you open is yours
                only if it says so. So: a value when it keeps the decision, a picker when
                it delegates — and the picker's first entry follows the default rather
                than copying it, so an administrator who changes it carries you along. */}
              {!isLocalContext && serverShells.length === 0 && (
                <SettingsRow title={t('settings.shellServer')} hint={t('settings.shellServerDesc')}>
                  <code
                    className="font-mono text-sm text-muted-foreground"
                    data-testid="server-shell"
                  >
                    {serverMode?.defaultShell ?? 'bash'}
                  </code>
                </SettingsRow>
              )}
              {!isLocalContext && serverShells.length > 0 && (
                <SettingsField label={t('settings.shellYours')} hint={t('settings.shellYoursDesc')}>
                  <ul className="flex flex-col gap-1.5" data-testid="server-shell-choices">
                    {['', ...serverShells].map((name) => (
                      <li key={name || 'default'}>
                        <button
                          type="button"
                          aria-pressed={(settings.defaultShell || '') === name}
                          data-testid={`server-shell-${name || 'default'}`}
                          onClick={() => void updateSettings({ defaultShell: name })}
                          className={`flex w-full items-center gap-2 rounded border px-3 py-2 text-left text-sm transition-colors ${
                            (settings.defaultShell || '') === name
                              ? 'border-primary bg-primary/10'
                              : 'border-border hover:bg-muted'
                          }`}
                        >
                          <span>
                            {name ||
                              t('settings.shellFollowInstance', {
                                shell: serverMode?.defaultShell ?? 'bash',
                              })}
                          </span>
                          {name === serverMode?.defaultShell && <span aria-hidden="true">★</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </SettingsField>
              )}
              {isLocalContext && (
                <>
                  <div>
                    {shellChoices.length > 0 && (
                      <SettingsField label={t('settings.shellInstalled')}>
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
                                <code className="truncate font-mono text-xs text-muted-foreground">
                                  {shell.path}
                                </code>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </SettingsField>
                    )}
                    <SettingsField label={t('settings.shellCustom')}>
                      <input
                        value={shellDraft}
                        onChange={(e) => setShellDraft(e.target.value)}
                        onBlur={() => {
                          const v = shellDraft.trim();
                          if (v && v !== settings.defaultShell)
                            void updateSettings({ defaultShell: v });
                        }}
                        placeholder="/usr/bin/fish"
                        className="w-full rounded border border-border bg-input px-3 py-2 font-mono text-sm"
                        data-testid="shell-path"
                      />
                    </SettingsField>
                  </div>
                </>
              )}
            </section>

            {/* Keyboard — one table owning every binding. */}
            <section hidden={shown !== 'keyboard'} className="pb-2">
              <SettingsHead title={t('settings.keyboard')} />
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
              <SettingsHead title={t('split.presets')} hint={t('settings.splitsHint')} />
              <button
                type="button"
                onClick={() => setPresetsOpen(true)}
                className="rounded border border-border px-3 py-1.5 text-xs hover:bg-muted"
                data-testid="open-splits-settings"
              >
                {t('settings.editPresets')}
              </button>
            </section>

            {/* Layouts (docs/LAYOUTS.md). What opens, where, on which machine.
              The cards lead, because the section used to be a title and a button that
              sent you somewhere else, while what you wanted to know — what do I have
              — was behind that button and below a textarea. */}
            <section hidden={shown !== 'layouts'} className="pb-2">
              <SettingsHead title={t('layouts.title')} hint={t('layouts.lede')} />

              {/* The reader's switch, then — on a server, in the desktop — this computer's
                choice of support. Both are this device's, so neither travels (ADR 0027). */}
              <SettingsToggle
                title={t('layouts.use')}
                hint={t('layouts.useHint')}
                checked={layoutsEnabled}
                onChange={(on) => void setLayoutsEnabled(on)}
                testId="layouts-enabled"
              />
              {!isLocalContext && native && (
                <SettingsRow title={t('layouts.source')} hint={t('layouts.sourceHint')}>
                  <SettingsControl>
                    <Dropdown<LayoutsSupport>
                      value={layoutsPrefer}
                      label={t('layouts.source')}
                      testId="layouts-source"
                      options={[
                        { value: 'account', label: t('layouts.sourceAccount') },
                        { value: 'file', label: t('layouts.sourceFile') },
                      ]}
                      onChange={(next) => void setLayoutsPrefer(next)}
                    />
                  </SettingsControl>
                </SettingsRow>
              )}

              {/* Where the document actually is, and what that costs. On the account that
                is the last-write-wins limitation, written where the editing happens. */}
              {hasWorkspaceFile && (
                <p className="mb-3 mt-3 text-xs leading-relaxed text-muted-foreground">
                  {layoutsSupport === 'account' ? t('layouts.onAccount') : t('layouts.onFile')}
                  {layoutsSupport === 'account' && (
                    <span className="mt-1 block">{t('layouts.lastWriteWins')}</span>
                  )}
                  {layoutsUpdatedAt !== null && (
                    <span className="mt-1 block">
                      {t('layouts.lastWritten', {
                        when: new Date(layoutsUpdatedAt * 1000).toLocaleString(),
                      })}
                    </span>
                  )}
                </p>
              )}

              {/* Turned off by the reader: say so where the cards would be, rather than
                leaving a section that looks broken. */}
              {!hasWorkspaceFile && layoutsBlocked && (
                <p
                  className="mb-3 mt-3 text-xs text-muted-foreground"
                  data-testid="settings-layouts-blocked"
                >
                  {t(layoutsBlocked)}
                </p>
              )}

              {hasWorkspaceFile && (
                <>
                  {/* A broken document is reported where you look first, not only inside
                    the editor: "no layouts" and "a typo on line 12" are very different
                    facts and used to look identical here. */}
                  {layoutsError && (
                    <p
                      className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs leading-relaxed"
                      data-testid="settings-layouts-error"
                    >
                      <span className="font-semibold">{t('layouts.notLoaded')}</span>{' '}
                      {layoutsError.line > 0
                        ? t('layouts.atLine', { line: layoutsError.line })
                        : null}{' '}
                      {layoutsError.message}
                      <span className="mt-1 block text-muted-foreground">
                        {t('layouts.keptRunning')}
                      </span>
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
                      <p
                        className="mb-3 text-xs text-muted-foreground"
                        data-testid="settings-layouts-empty"
                      >
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
                    {layoutsSupport === 'account' ? t('layouts.open') : t('layouts.openFile')}
                  </button>
                  <p className="mt-3 text-xs text-muted-foreground">{t('layouts.startupHint')}</p>
                </>
              )}
            </section>

            {/* The toolbar is the person's own row. Hiding never grants or revokes. */}
            <section hidden={shown !== 'toolbar'} className="pb-2">
              <SettingsHead title={t('settings.sec.toolbar')} hint={t('settings.toolbarHint')} />
              <div>
                {/* The shell picker is a LOCAL control: a server sets the shell for its own
                  terminals, so in a browser this row governed a button that never renders
                  (`Workspace.tsx`, `!isServerCtx`). A switch for something that cannot
                  appear is worse than a missing switch — it says you have a choice. */}
                {isLocalContext &&
                  toolbarRow('shellPicker', 'settings.toolbarShell', 'settings.toolbarShellDesc')}
                {/* Two shell controls, two questions: the picker above sets the default, this
                  menu overrides it for one terminal. Hiding the first was leaving the second,
                  which is why switching "the shell picker" off still asked which shell. On a
                  server the menu exists only where the instance offers a choice — and then
                  the switch does too, because there is a button to hide. */}
                {(isLocalContext || serverShells.length > 0) &&
                  toolbarRow(
                    'newTerminalMenu',
                    'settings.toolbarNewTermMenu',
                    'settings.toolbarNewTermMenuDesc',
                  )}
                {native &&
                  toolbarRow('focusMode', 'settings.toolbarFocus', 'settings.toolbarFocusDesc')}
                {/* Quick SSH is the server's to forbid (`quickSshAllowed`), and when it does the
                  row says so instead of vanishing: the preference is still this person's, the
                  button stays hidden either way, and someone looking for it gets an answer. The
                  probe-cards row above answers the same way, and so does design/mock/web.html. */}
                <SettingsToggle
                  title={t('settings.toolbarQuickSsh')}
                  hint={
                    quickSshAllowed(serverMode) ? (
                      t('settings.toolbarQuickSshDesc')
                    ) : (
                      <>
                        <span className="text-amber-500">{t('settings.toolbarQuickSshOff')}</span>
                        {t('settings.toolbarQuickSshOffWhy')}
                      </>
                    )
                  }
                  checked={toolbar.quickSsh}
                  onChange={(next) => toolbar.set('quickSsh', next)}
                  testId="toolbar-quickSsh"
                />
                {hasWorkspaceFile &&
                  toolbarRow('layouts', 'settings.toolbarLayouts', 'settings.toolbarLayoutsDesc')}
              </div>
            </section>

            {/* Auto-lock settings */}
            <section hidden={shown !== 'security'} className="pb-2">
              <SettingsHead title={t('settings.security')} />

              <div>
                {/* Auto-lock. One dropdown component for every choice in this dialog:
                  see Dropdown.tsx for why there used to be two. */}
                <SettingsRow
                  title={t('settings.autoLockTimeout')}
                  hint={t('settings.autoLockEnabledDesc')}
                >
                  <SettingsControl>
                    <Dropdown<number>
                      value={selectedTimeout}
                      label={t('settings.autoLockTimeout')}
                      testId="auto-lock"
                      options={[
                        { value: 0, label: t('settings.disabled') },
                        { value: 1, label: t('settings.oneMinute') },
                        { value: 3, label: t('settings.threeMinutes') },
                        { value: 5, label: t('settings.fiveMinutes') },
                        { value: -1, label: t('settings.custom') },
                      ]}
                      onChange={handleTimeoutChange}
                    />
                  </SettingsControl>
                </SettingsRow>

                {/* The custom delay only exists once "Custom" is the answer. */}
                {selectedTimeout === -1 && (
                  <SettingsRow title={t('settings.customMinutes')}>
                    <input
                      type="number"
                      value={customTimeout}
                      onChange={(e) => {
                        setCustomTimeout(e.target.value);
                        applyCustomTimeout(e.target.value);
                      }}
                      placeholder={t('settings.customMinutes')}
                      min="1"
                      className="w-24 rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
                    />
                  </SettingsRow>
                )}

              </div>
            </section>

            {/* Clipboard settings */}
            <section hidden={shown !== 'clipboard'} className="pb-2">
              <SettingsHead title={t('settings.clipboard')} />
              {/* Shown, not offered. The convention lives in the workspace document so it
                  travels between machines (ADR 0023, addendum) — a dropdown here would be
                  a second place to set one value, and the file would win or lose
                  depending on which was touched last. The row says what is in force, why,
                  and what it means. */}
              <SettingsRow
                title={t('settings.copyMode')}
                hint={
                  copyMode
                    ? t('settings.copyModeFile')
                    : t('settings.copyModeDefault')
                }
              >
                <div className="max-w-[22rem] text-right">
                  <code
                    className="font-mono text-sm text-foreground"
                    data-testid="copy-mode"
                  >
                    {copyMode ?? DEFAULT_CLIPBOARD_MODE}
                  </code>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {t(
                      `settings.copyMode${
                        (copyMode ?? DEFAULT_CLIPBOARD_MODE).charAt(0).toUpperCase() +
                        (copyMode ?? DEFAULT_CLIPBOARD_MODE).slice(1)
                      }`,
                    )}
                  </p>
                </div>
              </SettingsRow>
              <SettingsToggle
                title={t('settings.clipboardClearEnabled')}
                hint={t('settings.clipboardClearEnabledDesc')}
                checked={clipboardClearEnabled}
                onChange={(next) => {
                  setClipboardClearEnabled(next);
                  void updateSettings({ clipboardClearEnabled: next });
                }}
              />
            </section>

            {/* Language settings */}
            <section hidden={shown !== 'language'} className="pb-2">
              <SettingsHead title={t('settings.language')} />
              <SettingsRow title={t('settings.languageLabel')}>
                <SettingsControl>
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
                </SettingsControl>
              </SettingsRow>
            </section>

            {/* What is running, and what it talks to (ADR 0008). The first thing anyone is
              asked for in a bug report, and nothing showed it: not the version, not the
              build, not whether this client and its server are compatible at all. Read
              from the binary that served this page rather than compiled into the bundle,
              so the two cannot disagree about which they are. */}
            <section hidden={shown !== 'system'} className="pb-2">
              <SettingsHead title={t('settings.sec.system')} hint={t('settings.systemHint')} />
              <SettingsRow
                title={t('settings.systemRelease')}
                hint={t('settings.systemReleaseDesc')}
              >
                <code className="font-mono text-sm" data-testid="system-version">
                  {build ? build.version : '…'}
                </code>
              </SettingsRow>
              <SettingsRow title={t('settings.systemBuild')} hint={t('settings.systemBuildDesc')}>
                <code
                  className="font-mono text-sm text-muted-foreground"
                  data-testid="system-build"
                >
                  {build ? `${build.commit ?? 'unknown'} · ${build.builtAt ?? '—'}` : '…'}
                </code>
              </SettingsRow>
              <SettingsRow title={t('settings.systemShell')} hint={t('settings.systemShellDesc')}>
                <code
                  className="font-mono text-sm text-muted-foreground"
                  data-testid="system-shell"
                >
                  {native ? t('settings.systemShellDesktop') : t('settings.systemShellBrowser')}
                </code>
              </SettingsRow>
              <SettingsRow title={t('settings.systemApi')} hint={t('settings.systemApiDesc')}>
                <code className="font-mono text-sm text-muted-foreground" data-testid="system-api">
                  {build ? `v${build.apiVersion} · min ${build.minClient}` : '…'}
                </code>
              </SettingsRow>
            </section>

            {/* Master password — change it (local vault). Re-keys every connection. */}
            {isLocalContext && (
              <section hidden={shown !== 'password'} className="pb-2">
                <SettingsHead
                  title={t('settings.masterPassword')}
                  hint={t('settings.masterPasswordHint')}
                />
                <div className="max-w-sm space-y-2 pt-1">
                  <div className="relative">
                    <input
                      type={pwReveal ? 'text' : 'password'}
                      value={pwCurrent}
                      onChange={(e) => setPwCurrent(e.target.value)}
                      placeholder={t('settings.currentPassword')}
                      autoComplete="current-password"
                      className="w-full rounded border border-input bg-background px-3 py-2 pr-10 text-sm"
                    />
                    <RevealToggle shown={pwReveal} onToggle={() => setPwReveal((v) => !v)} />
                  </div>
                  <div className="relative">
                    <input
                      type={pwReveal ? 'text' : 'password'}
                      value={pwNew}
                      onChange={(e) => setPwNew(e.target.value)}
                      placeholder={t('settings.newPassword')}
                      autoComplete="new-password"
                      className="w-full rounded border border-input bg-background px-3 py-2 pr-10 text-sm"
                    />
                    <RevealToggle shown={pwReveal} onToggle={() => setPwReveal((v) => !v)} />
                  </div>
                  <div className="relative">
                    <input
                      type={pwReveal ? 'text' : 'password'}
                      value={pwConfirm}
                      onChange={(e) => setPwConfirm(e.target.value)}
                      placeholder={t('settings.confirmNewPassword')}
                      autoComplete="new-password"
                      className="w-full rounded border border-input bg-background px-3 py-2 pr-10 text-sm"
                    />
                    <RevealToggle shown={pwReveal} onToggle={() => setPwReveal((v) => !v)} />
                  </div>
                  {pwMsg && (
                    <p
                      className={`text-xs ${pwMsg.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}
                    >
                      {pwMsg.text}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => void changeMaster()}
                    disabled={pwBusy || !pwCurrent || !pwNew || !pwConfirm}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                  >
                    {pwBusy ? t('settings.changingPassword') : t('settings.changePassword')}
                  </button>
                </div>
              </section>
            )}

            {/* {t('settings.dangerZone')} — reset this local vault (wipe + reboot to first-run). Local only. */}
            {isLocalContext && (
              <section hidden={shown !== 'danger'} className="pb-2">
                <h3 className="text-lg font-semibold text-red-500">{t('settings.dangerZone')}</h3>
                <p className="mb-3 mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t('settings.dangerZoneWhy')}
                </p>
                <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4">
                  <div className="font-medium">{t('settings.resetVault')}</div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('settings.resetVaultWhy')}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      value={resetText}
                      onChange={(e) => setResetText(e.target.value)}
                      placeholder={t('settings.typeDelete')}
                      aria-label={t('settings.resetConfirmLabel')}
                      className="w-52 rounded border border-input bg-background px-2 py-1.5 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => void resetVault()}
                      disabled={resetText !== RESET_PHRASE}
                      className="rounded-md border border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-40"
                    >
                      {t('settings.resetVault')}
                    </button>
                  </div>
                </div>
              </section>
            )}

            {/* SSH connections.
                Host-key verification lives here, with the connections it governs, as the
                mock has always shown it (ADR 0019). It sat under Security because it
                predates the rail, and "security" is where nobody went looking for a
                setting about SSH. e2e/settings-rail-check.mjs now pins the section a row
                belongs to, not only that the section exists — which is why the two could
                disagree for two releases without anything failing. */}
            <section hidden={shown !== 'ssh'} className="pb-2">
              <SettingsHead title={t('settings.sshConnections')} />

              {/* On a shared server every connection is the server's, so there the policy
                  is the instance's and this row reports it instead of offering a dropdown.
                  It used to offer one to everyone, writing a single shared row: one person
                  choosing "accept" turned verification off for every account. */}
              {isLocalContext ? (
                <SettingsRow
                  title={t('settings.hostKeyVerification')}
                  hint={t('settings.hostKeyVerificationDesc')}
                >
                  <SettingsControl>
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
                  </SettingsControl>
                </SettingsRow>
              ) : (
                <SettingsRow
                  title={t('settings.hostKeyVerification')}
                  hint={t('settings.hostKeyServerDesc')}
                >
                  <code
                    className="font-mono text-sm text-muted-foreground"
                    data-testid="server-host-key"
                  >
                    {serverMode?.hostKeyVerification ?? 'strict'}
                  </code>
                </SettingsRow>
              )}

              {/* Beside the policy that produced them: the dropdown above decides what
                  happens to an unknown key, and this is the result of those decisions.
                  Mounted only while the section is open, so the request is not made on
                  every visit to Settings. */}
              {shown === 'ssh' && <KnownHostsList />}

              <SettingsToggle
                title={t('settings.autoReconnect')}
                hint={t('settings.autoReconnectHint')}
                checked={autoReconnect}
                onChange={setAutoReconnect}
              />
            </section>

            {/* Focus mode (client/native only) */}
            {native && (
              <section hidden={shown !== 'focus'} className="pb-2">
                <SettingsHead title={t('settings.focusMode')} />
                <SettingsToggle
                  title={t('settings.autoCollapse')}
                  hint={t('settings.autoCollapseHint')}
                  checked={focusAutoCollapse}
                  onChange={setFocusAutoCollapse}
                />
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
