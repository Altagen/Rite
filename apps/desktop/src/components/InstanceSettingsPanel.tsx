/**
 * Instance settings (org-admin): a global name for this Rite server so users can
 * tell which instance they're on (the browser has no context pill). Stored
 * server-side as a setting and surfaced publicly on the login screen + header.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import {
  Backend,
  type DashboardPolicy,
  type HealthcheckPolicy,
  type LayoutsPolicy,
} from '../utils/backend';
import { Switch } from './Switch';

const DEFAULT_HC: HealthcheckPolicy = {
  passiveStatus: true,
  active: 'off',
  methods: ['tcp-connect'],
  restrictUsers: [],
  minInterval: 60,
};
/** ADR 0019 defaults: both shells allowed. A server that has never been configured has
 *  not said no, and reading silence as a refusal would disable a shipped feature. */
const DEFAULT_DASH: DashboardPolicy = { webui: true, clients: true, minInterval: 30 };
/** ADR 0027: both true, so an instance that says nothing has the feature on. */
const DEFAULT_LAYOUTS: LayoutsPolicy = { webui: true, clients: true };
const HC_METHODS: { id: string; label: string }[] = [
  { id: 'tcp-connect', label: 'TCP-connect' },
  { id: 'icmp', label: 'ICMP' },
  { id: 'ssh-handshake', label: 'SSH handshake' },
];

/**
 * A setting the instance configuration owns (ADR 0020).
 *
 * The control stays on screen and goes inert, with the file or variable that set it named
 * underneath. Hiding it would leave an administrator wondering where the switch went;
 * greying it out without a reason sends them hunting through a deployment for a variable
 * nobody told them about. The server refuses the change either way — this is the part that
 * explains why before they try.
 */
function ManagedBy({ origin }: { origin: string }) {
  const { t } = useTranslation();
  return <p className="mt-1 text-xs text-amber-500">{t('admin.inst.managedBy', { origin })}</p>;
}

export function InstanceSettingsPanel() {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [persistence, setPersistence] = useState(true);
  const [hostKey, setHostKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shell, setShell] = useState('bash');
  // What this instance can run, from the server's own probe — not the four Rite knows
  // about. Empty until loaded, and on an older server that never probed.
  const [shells, setShells] = useState<string[]>([]);
  const [shellChoice, setShellChoice] = useState(false);
  // ADR 0024 §4: what may rest in a member's vault, and whether it can be read back.
  const [secretStorage, setSecretStorage] = useState(true);
  const [secretReveal, setSecretReveal] = useState(true);
  // How this server verifies host keys, for every connection it opens. It was reported to
  // clients and shown read-only there, with nowhere here to set it.
  const [hostKeyMode, setHostKeyMode] = useState<'strict' | 'warn' | 'accept'>('strict');
  const [quickSsh, setQuickSsh] = useState(false);
  const [openReg, setOpenReg] = useState(false);
  const [allowInv, setAllowInv] = useState(true);
  const [confirmRole, setConfirmRole] = useState(false);
  const [hc, setHc] = useState<HealthcheckPolicy>(DEFAULT_HC);
  const [dash, setDash] = useState<DashboardPolicy>(DEFAULT_DASH);
  const [layouts, setLayouts] = useState<LayoutsPolicy>(DEFAULT_LAYOUTS);
  // ADR 0020: keys this instance holds as code, mapped to where each was declared.
  const [managed, setManaged] = useState<Record<string, string>>({});
  const [userInput, setUserInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const mode = await Backend.Server.mode();
      const current = mode.instanceName ?? '';
      setName(current);
      setSaved(current);
      setPersistence(mode.sessionPersistence !== false);
      setHostKey(mode.hostKey ?? null);
      setShell(mode.defaultShell ?? 'bash');
      setShells(mode.shells ?? []);
      setShellChoice(mode.allowShellChoice === true);
      setSecretStorage(mode.allowSecretStorage !== false);
      setSecretReveal(mode.allowSecretReveal !== false);
      setHostKeyMode((mode.hostKeyVerification as 'strict' | 'warn' | 'accept') ?? 'strict');
      setQuickSsh(mode.allowQuickSsh === true);
      setOpenReg(mode.openRegistration === true);
      setAllowInv(mode.allowInvitations !== false);
      setConfirmRole(mode.confirmRoleChange === true);
      setHc(mode.healthcheck ?? DEFAULT_HC);
      setDash(mode.dashboardPolicy ?? DEFAULT_DASH);
      setLayouts(mode.layoutsPolicy ?? DEFAULT_LAYOUTS);
      setManaged(mode.managed ?? {});
    } catch {
      setError(t('admin.inst.errLoad'));
    }
    // `t` is a dependency now that the message comes from the locales: a language change
    // must re-render with the new one rather than keep the string this closure captured.
  }, [t]);

  // Optimistic save of the whole policy; revert on failure.
  const saveHc = async (next: HealthcheckPolicy) => {
    const prev = hc;
    setHc(next);
    try {
      await Backend.Admin.setHealthcheck(next);
    } catch (err) {
      setHc(prev);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  // Same optimistic shape as saveHc: the switch moves, and goes back if the server refuses.
  const saveDash = async (next: DashboardPolicy) => {
    const prev = dash;
    setDash(next);
    try {
      await Backend.Admin.setDashboardPolicy(next);
    } catch (err) {
      setDash(prev);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const saveLayouts = async (next: LayoutsPolicy) => {
    const prev = layouts;
    setLayouts(next);
    try {
      await Backend.Admin.setLayoutsPolicy(next);
    } catch (err) {
      setLayouts(prev);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const changeShell = async (next: string) => {
    const prev = shell;
    setShell(next);
    try {
      await Backend.Admin.setDefaultShell(next);
    } catch (err) {
      setShell(prev);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const toggleShellChoice = async () => {
    const next = !shellChoice;
    setShellChoice(next);
    try {
      await Backend.Admin.setShellChoice(next);
    } catch (err) {
      setShellChoice(!next);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const changeHostKeyMode = async (next: 'strict' | 'warn' | 'accept') => {
    const prev = hostKeyMode;
    setHostKeyMode(next);
    try {
      await Backend.Admin.setHostKeyMode(next);
    } catch (err) {
      setHostKeyMode(prev);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const toggleSecretStorage = async () => {
    const next = !secretStorage;
    setSecretStorage(next);
    try {
      await Backend.Admin.setSecretStorage(next);
    } catch (err) {
      setSecretStorage(!next);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const toggleSecretReveal = async () => {
    const next = !secretReveal;
    setSecretReveal(next);
    try {
      await Backend.Admin.setSecretReveal(next);
    } catch (err) {
      setSecretReveal(!next);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const toggleQuickSsh = async () => {
    const next = !quickSsh;
    setQuickSsh(next);
    try {
      await Backend.Admin.setQuickSsh(next);
    } catch (err) {
      setQuickSsh(!next);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const toggleOpenReg = async () => {
    const next = !openReg;
    setOpenReg(next);
    try {
      await Backend.Admin.setOpenRegistration(next);
    } catch (err) {
      setOpenReg(!next);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const toggleAllowInv = async () => {
    const next = !allowInv;
    setAllowInv(next);
    try {
      await Backend.Admin.setAllowInvitations(next);
    } catch (err) {
      setAllowInv(!next);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const toggleConfirmRole = async () => {
    const next = !confirmRole;
    setConfirmRole(next);
    try {
      await Backend.Admin.setConfirmRoleChange(next);
    } catch (err) {
      setConfirmRole(!next);
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  const togglePersistence = async () => {
    const next = !persistence;
    setPersistence(next);
    try {
      await Backend.Admin.setSessionPersistence(next);
    } catch (err) {
      setPersistence(!next); // revert on failure
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    load();
  }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await Backend.Admin.setInstanceName(name.trim());
      setSaved(name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.inst.errSave'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <div>
        <h2 className="text-xl font-semibold">{t('admin.inst.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.lead')}</p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <form
        onSubmit={save}
        className="flex items-end gap-3 rounded-lg border border-border bg-card p-4"
      >
        <div className="flex-1 space-y-1">
          <label htmlFor="instance-name" className="text-xs font-medium text-muted-foreground">
            {t('admin.inst.nameLabel')}
          </label>
          <input
            id="instance-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('admin.inst.namePlaceholder')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-60"
            disabled={busy || !!managed.instance_name}
          />
          {managed.instance_name && <ManagedBy origin={managed.instance_name} />}
        </div>
        <button
          type="submit"
          disabled={busy || !!managed.instance_name || name.trim() === (saved ?? '')}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('admin.inst.save')}
        </button>
      </form>

      {saved !== null && saved === name.trim() && (
        <p className="text-xs text-muted-foreground">{t('admin.inst.saved')}</p>
      )}

      {/* Host key (ADR 0012 TOFU): publish it so users can pin this server out-of-band. */}
      {hostKey && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
          <div className="min-w-0">
            <div className="font-medium">{t('admin.inst.hostKey')}</div>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              SHA256:{hostKey}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t('admin.inst.hostKeyShare')}</p>
          </div>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(`SHA256:${hostKey}`);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            {copied ? t('admin.inst.copied') : t('admin.inst.copy')}
          </button>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">{t('admin.inst.persistence')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.persistenceDesc')}</p>
            {managed.session_persistence && <ManagedBy origin={managed.session_persistence} />}
          </div>
          <Switch
            checked={persistence}
            label={t('admin.inst.persistence')}
            disabled={!!managed.session_persistence}
            onChange={togglePersistence}
            testId="instance-session-persistence"
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">{t('admin.inst.openReg')}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              <b>{t('admin.inst.offByDefault')}</b> {t('admin.inst.openRegDesc')}
            </p>
            {managed.open_registration && <ManagedBy origin={managed.open_registration} />}
          </div>
          <Switch
            checked={openReg}
            label={t('admin.inst.openReg')}
            disabled={!!managed.open_registration}
            onChange={toggleOpenReg}
            testId="instance-open-registration"
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">{t('admin.inst.allowInv')}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              <b>{t('admin.inst.onByDefault')}</b> {t('admin.inst.allowInvDesc')}
            </p>
            {managed.allow_invitations && <ManagedBy origin={managed.allow_invitations} />}
          </div>
          <Switch
            checked={allowInv}
            label={t('admin.inst.allowInv')}
            disabled={!!managed.allow_invitations}
            onChange={toggleAllowInv}
            testId="instance-allow-invitations"
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">{t('admin.inst.confirmRole')}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              <b>{t('admin.inst.offByDefault')}</b> {t('admin.inst.confirmRoleDesc')}
            </p>
            {managed.confirm_role_change && <ManagedBy origin={managed.confirm_role_change} />}
          </div>
          <Switch
            checked={confirmRole}
            label={t('admin.inst.confirmRole')}
            disabled={!!managed.confirm_role_change}
            onChange={toggleConfirmRole}
            testId="instance-confirm-role-change"
          />
        </div>
      </div>

      {/* Client capabilities — what connected clients may do, governed here. */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="text-base font-semibold">{t('admin.inst.caps')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('admin.inst.capsDesc')}</p>
        </div>

        <div className="flex items-start justify-between gap-4 border-b border-border p-4">
          <div>
            <div className="font-medium">{t('admin.inst.defaultShell')}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('admin.inst.shellPrefix')}{' '}
              {shellChoice ? t('admin.inst.shellOpensChoice') : t('admin.inst.shellOpensFixed')}{' '}
              {t('admin.inst.shellDesktop')}{' '}
              <b data-testid="instance-shells">{shells.join(', ')}</b>.
            </p>
            {managed.default_shell && <ManagedBy origin={managed.default_shell} />}
          </div>
          {/* Only what the probe found. Offering all four set the instance to a program the
              container did not have, and every terminal on it then opened nothing. */}
          <select
            value={shell}
            onChange={(e) => changeShell(e.target.value)}
            data-testid="instance-shell"
            className="flex-none rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {shells.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-start justify-between gap-4 border-b border-border p-4">
          <div>
            <div className="font-medium">{t('admin.inst.shellChoice')}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              <b>{t('admin.inst.offByDefault')}</b> {t('admin.inst.shellChoiceDesc')}
            </p>
            {managed.allow_shell_choice && <ManagedBy origin={managed.allow_shell_choice} />}
          </div>
          <Switch
            checked={shellChoice}
            label={t('admin.inst.shellChoice')}
            onChange={toggleShellChoice}
            disabled={!!managed.allow_shell_choice}
            testId="instance-shell-choice"
          />
        </div>

        <div className="flex items-start justify-between gap-4 p-4">
          <div>
            <div className="font-medium">{t('admin.inst.quickSsh')}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              <b>{t('admin.inst.offByDefault')}</b> {t('admin.inst.quickSshDesc')}
            </p>
            {managed.allow_quick_ssh && <ManagedBy origin={managed.allow_quick_ssh} />}
          </div>
          <Switch
            checked={quickSsh}
            label={t('admin.inst.quickSsh')}
            disabled={!!managed.allow_quick_ssh}
            onChange={toggleQuickSsh}
            testId="instance-quick-ssh"
          />
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border p-4">
          <div>
            <div className="font-medium">{t('admin.inst.hostKeyMode')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.hostKeyModeDesc')}</p>
            {managed.host_key_verification_mode && (
              <ManagedBy origin={managed.host_key_verification_mode} />
            )}
          </div>
          <select
            value={hostKeyMode}
            onChange={(e) => changeHostKeyMode(e.target.value as 'strict' | 'warn' | 'accept')}
            disabled={!!managed.host_key_verification_mode}
            data-testid="instance-host-key-mode"
            className="flex-none rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {['strict', 'warn', 'accept'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        {/* Stored secrets (ADR 0024 §4). One switch over every secret a record can keep,
            because forbidding one while allowing another hardens nothing. Permissive by
            default, so an instance that upgrades and says nothing is unchanged. */}
        <div className="border-t border-border p-4">
          <div className="font-medium">{t('admin.inst.storedSecrets')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('admin.inst.storedSecretsDesc')}
          </p>
        </div>

        <div className="flex items-start justify-between gap-4 border-b border-border px-4 pb-4">
          <div>
            <div className="font-medium">{t('admin.inst.secretStorage')}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('admin.inst.secretStorageWhat')} <b>{t('admin.inst.onByDefault')}</b>{' '}
              {t('admin.inst.secretStorageDefault')} <b>{t('admin.inst.bindsClient')}</b>{' '}
              {t('admin.inst.secretStorageBinds')}
            </p>
            {managed.allow_secret_storage && <ManagedBy origin={managed.allow_secret_storage} />}
          </div>
          <Switch
            checked={secretStorage}
            label={t('admin.inst.secretStorage')}
            disabled={!!managed.allow_secret_storage}
            onChange={toggleSecretStorage}
            testId="instance-secret-storage"
          />
        </div>

        <div className="flex items-start justify-between gap-4 p-4">
          <div>
            <div className="font-medium">{t('admin.inst.secretReveal')}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              <b>{t('admin.inst.onByDefault')}</b> {t('admin.inst.secretRevealWhen')}{' '}
              <b>{t('admin.inst.bindsClient')}</b> {t('admin.inst.secretRevealBinds')}
            </p>
            {managed.allow_secret_reveal && <ManagedBy origin={managed.allow_secret_reveal} />}
          </div>
          <Switch
            checked={secretReveal}
            label={t('admin.inst.secretReveal')}
            disabled={!!managed.allow_secret_reveal}
            onChange={toggleSecretReveal}
            testId="instance-secret-reveal"
          />
        </div>

        {/* Machine health-check (ADR 0017): passive "last seen" is free; active is governed. */}
        <div className="border-t border-border p-4">
          <div className="font-medium">{t('admin.inst.hc')}</div>
          <p className="mt-1 text-sm text-muted-foreground">
            <b>{t('admin.inst.hcPassive')}</b> {t('admin.inst.hcDesc')}{' '}
            <b>{t('admin.inst.hcActive')}</b> {t('admin.inst.hcActiveDesc')}
          </p>
          {managed.healthcheck_policy && <ManagedBy origin={managed.healthcheck_policy} />}
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border p-4">
          <div>
            <div className="font-medium">{t('admin.inst.showStatus')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.showStatusDesc')}</p>
          </div>
          <Switch
            checked={hc.passiveStatus}
            label={t('admin.inst.showStatusLabel')}
            onChange={() => saveHc({ ...hc, passiveStatus: !hc.passiveStatus })}
            testId="instance-hc-passive"
          />
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4 border-t border-border p-4">
          <div className="min-w-[220px] flex-1">
            <div className="font-medium">{t('admin.inst.hcActive')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.probeLegend')}</p>
          </div>
          <div className="inline-flex flex-wrap overflow-hidden rounded-md border border-input">
            {(['off', 'on-demand', 'full', 'client-choice'] as const).map((m) => (
              <button
                key={m}
                onClick={() => saveHc({ ...hc, active: m })}
                className={`border-r border-input px-3 py-1.5 text-xs last:border-r-0 ${
                  hc.active === m
                    ? 'bg-primary/20 font-semibold text-primary'
                    : 'bg-background text-muted-foreground hover:bg-muted'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div
          className={`flex flex-wrap items-start justify-between gap-4 border-t border-border p-4 ${hc.active === 'off' ? 'pointer-events-none opacity-40' : ''}`}
        >
          <div>
            <div className="font-medium">{t('admin.inst.methods')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.methodsDesc')}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {HC_METHODS.map((m) => {
              const on = hc.methods.includes(m.id);
              return (
                <label
                  key={m.id}
                  className="flex cursor-pointer select-none items-center gap-1.5 text-sm"
                >
                  <span
                    className={`grid h-[17px] w-[17px] place-items-center rounded border text-[11px] font-bold ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}`}
                  >
                    {on ? '✓' : ''}
                  </span>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() =>
                      saveHc({
                        ...hc,
                        methods: on ? hc.methods.filter((x) => x !== m.id) : [...hc.methods, m.id],
                      })
                    }
                  />
                  {m.label}
                </label>
              );
            })}
          </div>
        </div>

        <div
          className={`flex flex-col gap-2 border-t border-border p-4 ${hc.active === 'off' ? 'pointer-events-none opacity-40' : ''}`}
        >
          <div>
            <div className="font-medium">{t('admin.inst.whoProbes')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.whoProbesDesc')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {hc.restrictUsers.length === 0 && (
              <span className="text-sm text-muted-foreground">{t('admin.inst.everyone')}</span>
            )}
            {hc.restrictUsers.map((u) => (
              <span
                key={u}
                className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-sm"
              >
                {u}
                <button
                  onClick={() =>
                    saveHc({ ...hc, restrictUsers: hc.restrictUsers.filter((x) => x !== u) })
                  }
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t('admin.inst.removeUser', { name: u })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const u = userInput.trim();
              if (u && !hc.restrictUsers.includes(u))
                saveHc({ ...hc, restrictUsers: [...hc.restrictUsers, u] });
              setUserInput('');
            }}
          >
            <input
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder={t('admin.inst.usernamePlaceholder')}
              className="w-40 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
            <button
              type="submit"
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              {t('admin.inst.add')}
            </button>
          </form>
        </div>

        <div
          className={`flex flex-wrap items-start justify-between gap-4 border-t border-border p-4 ${hc.active === 'off' || hc.active === 'on-demand' ? 'pointer-events-none opacity-40' : ''}`}
        >
          <div>
            <div className="font-medium">{t('admin.inst.minInterval')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.minIntervalDesc')}</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={5}
              value={hc.minInterval}
              onChange={(e) => setHc({ ...hc, minInterval: Number(e.target.value) })}
              onBlur={() => saveHc(hc)}
              className="w-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
            <span className="text-sm text-muted-foreground">{t('admin.inst.seconds')}</span>
          </div>
        </div>

        {/* Machine dashboard (ADR 0019): only the cards that execute on a host are governed.
            Overview, port forwarding and the Board touch no host and are never gated. */}
        <div className="border-t border-border p-4">
          <div className="font-medium">{t('admin.inst.dash')}</div>
          <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.dashDesc')}</p>
          <p className="mt-2 text-sm text-muted-foreground">{t('admin.inst.dashStrength')}</p>
          {managed.dashboard_policy && <ManagedBy origin={managed.dashboard_policy} />}
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border p-4">
          <div>
            <div className="font-medium">{t('admin.inst.dashWebui')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.dashWebuiDesc')}</p>
          </div>
          <Switch
            checked={dash.webui}
            label={t('admin.inst.dashWebuiLabel')}
            disabled={!!managed.dashboard_policy}
            onChange={() => saveDash({ ...dash, webui: !dash.webui })}
            testId="instance-dash-webui"
          />
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border p-4">
          <div>
            <div className="font-medium">{t('admin.inst.dashClients')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.dashClientsDesc')}</p>
          </div>
          <Switch
            checked={dash.clients}
            label={t('admin.inst.dashClientsLabel')}
            disabled={!!managed.dashboard_policy}
            onChange={() => saveDash({ ...dash, clients: !dash.clients })}
            testId="instance-dash-clients"
          />
        </div>

        <div
          className={`flex flex-wrap items-start justify-between gap-4 border-t border-border p-4 ${!dash.webui && !dash.clients ? 'pointer-events-none opacity-40' : ''}`}
        >
          <div>
            <div className="font-medium">{t('admin.inst.dashInterval')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.dashIntervalDesc')}</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={3600}
              value={dash.minInterval}
              disabled={!!managed.dashboard_policy}
              onChange={(e) => setDash({ ...dash, minInterval: Number(e.target.value) })}
              onBlur={() => saveDash(dash)}
              className="w-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
            <span className="text-sm text-muted-foreground">{t('admin.inst.seconds')}</span>
          </div>
        </div>

        {/* Layouts (ADR 0027). Two booleans and no third `enabled` flag: both off is the
            feature off, and there is no second switch to contradict them. */}
        <div className="border-t border-border p-4">
          <div className="font-medium">{t('admin.inst.layouts')}</div>
          <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.layoutsDesc')}</p>
          <p className="mt-2 text-sm text-muted-foreground">{t('admin.inst.layoutsStrength')}</p>
          {managed.layouts_policy && <ManagedBy origin={managed.layouts_policy} />}
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border p-4">
          <div>
            <div className="font-medium">{t('admin.inst.layoutsWebui')}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin.inst.layoutsWebuiDesc')}</p>
          </div>
          <Switch
            checked={layouts.webui}
            label={t('admin.inst.layoutsWebuiLabel')}
            disabled={!!managed.layouts_policy}
            onChange={() => saveLayouts({ ...layouts, webui: !layouts.webui })}
            testId="instance-layouts-webui"
          />
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border p-4">
          <div>
            <div className="font-medium">{t('admin.inst.layoutsClients')}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('admin.inst.layoutsClientsDesc')}
            </p>
          </div>
          <Switch
            checked={layouts.clients}
            label={t('admin.inst.layoutsClientsLabel')}
            disabled={!!managed.layouts_policy}
            onChange={() => saveLayouts({ ...layouts, clients: !layouts.clients })}
            testId="instance-layouts-clients"
          />
        </div>
      </div>
    </div>
  );
}
