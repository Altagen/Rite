/**
 * Settings Component
 *
 * Modal for application settings configuration
 */

import { useEffect, useState, useRef } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { useDisplayPrefs } from '../store/displayPrefs';
import { useTranslation } from '../i18n/i18n';
import { terminalPool, getTerminalThemeName, type TerminalThemeName } from '../utils/terminalPool';
import { useHealthPref, type HealthPref } from '../store/healthPrefStore';
import { useServerSession } from '../store/serverSessionStore';
import { Backend } from '../utils/backend';

interface SettingsProps {
  onClose: () => void;
}

export function Settings({ onClose }: SettingsProps) {
  const { t, locale, setLocale } = useTranslation();
  const { settings, fetchSettings, updateSettings, isLoading } = useSettingsStore();
  const showMemberCount = useDisplayPrefs((s) => s.showMemberCount);
  const setShowMemberCount = useDisplayPrefs((s) => s.setShowMemberCount);
  const healthPref = useHealthPref((s) => s.pref);
  const setHealthPref = useHealthPref((s) => s.setPref);
  // Local terminals only: on a server the shell is server-governed (no per-user picker).
  const isLocalContext = !useServerSession((s) => s.mode)?.accounts;
  const [shellDraft, setShellDraft] = useState('');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync draft to async-loaded value
    setShellDraft(settings.defaultShell);
  }, [settings.defaultShell]);
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
  const [showTimeoutDropdown, setShowTimeoutDropdown] = useState(false);
  const [showLanguageDropdown, setShowLanguageDropdown] = useState(false);
  const [showHostKeyDropdown, setShowHostKeyDropdown] = useState(false);
  const [terminalTheme, setTerminalTheme] = useState<TerminalThemeName>(getTerminalThemeName());
  const timeoutDropdownRef = useRef<HTMLDivElement>(null);
  const languageDropdownRef = useRef<HTMLDivElement>(null);
  const hostKeyDropdownRef = useRef<HTMLDivElement>(null);


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

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (timeoutDropdownRef.current && !timeoutDropdownRef.current.contains(event.target as Node)) {
        setShowTimeoutDropdown(false);
      }
      if (languageDropdownRef.current && !languageDropdownRef.current.contains(event.target as Node)) {
        setShowLanguageDropdown(false);
      }
      if (hostKeyDropdownRef.current && !hostKeyDropdownRef.current.contains(event.target as Node)) {
        setShowHostKeyDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSave = async () => {
    let autoLockEnabled = false;
    let autoLockTimeout = 0;

    if (selectedTimeout === 0) {
      // Disabled
      autoLockEnabled = false;
      autoLockTimeout = 0;
    } else if (selectedTimeout === -1) {
      // Custom value
      const customValue = parseInt(customTimeout, 10);
      if (customValue > 0) {
        autoLockEnabled = true;
        autoLockTimeout = customValue;
      }
    } else {
      // Preset value (1, 3, or 5 minutes)
      autoLockEnabled = true;
      autoLockTimeout = selectedTimeout;
    }

    await updateSettings({
      autoLockEnabled,
      autoLockTimeout,
      clipboardClearEnabled,
      hostKeyVerificationMode,
    });

    onClose();
  };

  const handleTimeoutChange = (value: number) => {
    setSelectedTimeout(value);
    setShowTimeoutDropdown(false);
    if (value !== -1) {
      setCustomTimeout('');
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

  const getHostKeyLabel = () => {
    if (hostKeyVerificationMode === 'strict') return t('settings.hostKeyVerificationStrict');
    if (hostKeyVerificationMode === 'warn') return t('settings.hostKeyVerificationWarn');
    if (hostKeyVerificationMode === 'accept') return t('settings.hostKeyVerificationAccept');
    return t('settings.hostKeyVerificationStrict');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-2xl rounded-lg bg-background p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">{t('settings.title')}</h2>
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

        <div className="space-y-6">
          {/* Appearance */}
          <section className="border-b border-border pb-6">
            <h3 className="mb-4 text-lg font-semibold">Appearance</h3>
            <div>
              <label className="mb-1 block text-sm font-medium">Terminal theme</label>
              <select
                value={terminalTheme}
                onChange={(e) => {
                  const name = e.target.value as TerminalThemeName;
                  setTerminalTheme(name);
                  terminalPool.setTheme(name);
                }}
                className="w-full rounded border border-border bg-input px-3 py-2 text-sm"
              >
                <option value="dark">Dark (default)</option>
                <option value="grey">Grey</option>
                <option value="translucent">Translucent</option>
              </select>
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
          <section className="border-b border-border pb-6">
            <h3 className="mb-4 text-lg font-semibold">Machine status</h3>
            <div>
              <label className="mb-1 block text-sm font-medium">Health-check</label>
              <select
                value={healthPref}
                onChange={(e) => setHealthPref(e.target.value as HealthPref)}
                className="w-full rounded border border-border bg-input px-3 py-2 text-sm"
              >
                <option value="inherit">Follow the server policy</option>
                <option value="off">Off — no status</option>
                <option value="passive">Passive — last seen only</option>
                <option value="on-demand">On-demand checks</option>
                <option value="full">Background polling</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="text-amber-500">Governed by your server</span> — you can only narrow it.
                Passive “last seen” costs no network traffic; active probing does.
              </p>
            </div>
          </section>

          {/* Default shell — local terminals only (a server governs its own shell). */}
          {isLocalContext && (
            <section className="border-b border-border pb-6">
              <h3 className="mb-4 text-lg font-semibold">Default shell</h3>
              <div>
                <label className="mb-1 block text-sm font-medium">Shell for new local terminals</label>
                <input
                  value={shellDraft}
                  onChange={(e) => setShellDraft(e.target.value)}
                  onBlur={() => {
                    const v = shellDraft.trim();
                    if (v && v !== settings.defaultShell) void updateSettings({ defaultShell: v });
                  }}
                  placeholder="/usr/bin/bash"
                  className="w-full rounded border border-border bg-input px-3 py-2 font-mono text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">Path to the shell, e.g. /usr/bin/zsh or /usr/bin/fish.</p>
              </div>
            </section>
          )}

          {/* Auto-lock settings */}
          <section className="border-b border-border pb-6">
            <h3 className="text-lg font-semibold mb-4">{t('settings.security')}</h3>

            <div className="space-y-4">
              {/* Auto-lock Timeout Dropdown */}
              <div ref={timeoutDropdownRef}>
                <label className="mb-1 block text-sm font-medium">{t('settings.autoLockTimeout')}</label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowTimeoutDropdown(!showTimeoutDropdown)}
                    className="w-full rounded border border-border bg-input px-3 py-2 text-left text-foreground focus:border-primary focus:outline-none flex justify-between items-center"
                  >
                    <span>{getTimeoutLabel()}</span>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {/* Dropdown Menu */}
                  {showTimeoutDropdown && (
                    <div className="absolute z-10 mt-1 w-full rounded border border-border bg-background shadow-lg divide-y divide-border">
                      <button
                        type="button"
                        onClick={() => handleTimeoutChange(0)}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('settings.disabled')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTimeoutChange(1)}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('settings.oneMinute')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTimeoutChange(3)}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('settings.threeMinutes')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTimeoutChange(5)}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('settings.fiveMinutes')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTimeoutChange(-1)}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('settings.custom')}
                      </button>
                    </div>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-2">{t('settings.autoLockEnabledDesc')}</p>
              </div>

              {/* Custom Timeout Input */}
              {selectedTimeout === -1 && (
                <div>
                  <label className="mb-1 block text-sm font-medium">{t('settings.customMinutes')}</label>
                  <input
                    type="number"
                    value={customTimeout}
                    onChange={(e) => setCustomTimeout(e.target.value)}
                    placeholder={t('settings.customMinutes')}
                    min="1"
                    className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
                  />
                </div>
              )}

              {/* Host Key Verification Dropdown */}
              <div ref={hostKeyDropdownRef}>
                <label className="mb-1 block text-sm font-medium">{t('settings.hostKeyVerification')}</label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowHostKeyDropdown(!showHostKeyDropdown)}
                    className="w-full rounded border border-border bg-input px-3 py-2 text-left text-foreground focus:border-primary focus:outline-none flex justify-between items-center"
                  >
                    <span>{getHostKeyLabel()}</span>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {/* Dropdown Menu */}
                  {showHostKeyDropdown && (
                    <div className="absolute z-10 mt-1 w-full rounded border border-border bg-background shadow-lg divide-y divide-border">
                      <button
                        type="button"
                        onClick={() => {
                          setHostKeyVerificationMode('strict');
                          setShowHostKeyDropdown(false);
                        }}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('settings.hostKeyVerificationStrict')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setHostKeyVerificationMode('warn');
                          setShowHostKeyDropdown(false);
                        }}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('settings.hostKeyVerificationWarn')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setHostKeyVerificationMode('accept');
                          setShowHostKeyDropdown(false);
                        }}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('settings.hostKeyVerificationAccept')}
                      </button>
                    </div>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-2">{t('settings.hostKeyVerificationDesc')}</p>
              </div>
            </div>
          </section>

          {/* Clipboard settings */}
          <section className="border-b border-border pb-6">
            <h3 className="text-lg font-semibold mb-4">{t('settings.clipboard')}</h3>

            <div className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={clipboardClearEnabled}
                  onChange={(e) => setClipboardClearEnabled(e.target.checked)}
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
          <section className="pb-6">
            <h3 className="text-lg font-semibold mb-4">{t('settings.language')}</h3>

            <div ref={languageDropdownRef}>
              <label className="mb-1 block text-sm font-medium">{t('settings.languageLabel')}</label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowLanguageDropdown(!showLanguageDropdown)}
                  className="w-full rounded border border-border bg-input px-3 py-2 text-left text-foreground focus:border-primary focus:outline-none flex justify-between items-center"
                >
                  <span>{locale === 'en' ? 'English' : 'Français'}</span>
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {/* Dropdown Menu */}
                {showLanguageDropdown && (
                  <div className="absolute z-10 mt-1 w-full rounded border border-border bg-background shadow-lg divide-y divide-border">
                    <button
                      type="button"
                      onClick={() => {
                        setLocale('en');
                        setShowLanguageDropdown(false);
                      }}
                      className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                    >
                      English
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLocale('fr');
                        setShowLanguageDropdown(false);
                      }}
                      className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                    >
                      Français
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Danger zone — reset this local vault (wipe + reboot to first-run). Local only. */}
          {isLocalContext && (
            <section className="pb-6">
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
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="rounded bg-secondary px-4 py-2 font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            {t('settings.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isLoading}
            className="rounded bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
