/**
 * Instance settings (org-admin): a global name for this Rite server so users can
 * tell which instance they're on (the browser has no context pill). Stored
 * server-side as a setting and surfaced publicly on the login screen + header.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type DashboardPolicy, type HealthcheckPolicy } from '../utils/backend';

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
  return (
    <p className="mt-1 text-xs text-amber-500">
      Set by this instance&apos;s configuration (<code className="font-mono">{origin}</code>) — change it there, not here.
    </p>
  );
}

export function InstanceSettingsPanel() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [persistence, setPersistence] = useState(true);
  const [hostKey, setHostKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shell, setShell] = useState('bash');
  const [quickSsh, setQuickSsh] = useState(false);
  const [openReg, setOpenReg] = useState(false);
  const [allowInv, setAllowInv] = useState(true);
  const [confirmRole, setConfirmRole] = useState(false);
  const [hc, setHc] = useState<HealthcheckPolicy>(DEFAULT_HC);
  const [dash, setDash] = useState<DashboardPolicy>(DEFAULT_DASH);
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
      setQuickSsh(mode.allowQuickSsh === true);
      setOpenReg(mode.openRegistration === true);
      setAllowInv(mode.allowInvitations !== false);
      setConfirmRole(mode.confirmRoleChange === true);
      setHc(mode.healthcheck ?? DEFAULT_HC);
      setDash(mode.dashboardPolicy ?? DEFAULT_DASH);
      setManaged(mode.managed ?? {});
    } catch {
      setError('Failed to load instance settings');
    }
  }, []);

  // Optimistic save of the whole policy; revert on failure.
  const saveHc = async (next: HealthcheckPolicy) => {
    const prev = hc;
    setHc(next);
    try {
      await Backend.Admin.setHealthcheck(next);
    } catch (err) {
      setHc(prev);
      setError(err instanceof Error ? err.message : 'Failed to save');
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
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const changeShell = async (next: string) => {
    const prev = shell;
    setShell(next);
    try {
      await Backend.Admin.setDefaultShell(next);
    } catch (err) {
      setShell(prev);
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const toggleQuickSsh = async () => {
    const next = !quickSsh;
    setQuickSsh(next);
    try {
      await Backend.Admin.setQuickSsh(next);
    } catch (err) {
      setQuickSsh(!next);
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const toggleOpenReg = async () => {
    const next = !openReg;
    setOpenReg(next);
    try {
      await Backend.Admin.setOpenRegistration(next);
    } catch (err) {
      setOpenReg(!next);
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const toggleAllowInv = async () => {
    const next = !allowInv;
    setAllowInv(next);
    try {
      await Backend.Admin.setAllowInvitations(next);
    } catch (err) {
      setAllowInv(!next);
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const toggleConfirmRole = async () => {
    const next = !confirmRole;
    setConfirmRole(next);
    try {
      await Backend.Admin.setConfirmRoleChange(next);
    } catch (err) {
      setConfirmRole(!next);
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const togglePersistence = async () => {
    const next = !persistence;
    setPersistence(next);
    try {
      await Backend.Admin.setSessionPersistence(next);
    } catch (err) {
      setPersistence(!next); // revert on failure
      setError(err instanceof Error ? err.message : 'Failed to save');
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
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Instance</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A global name for this server (e.g. your company or team). Shown to everyone on the sign-in screen and in the
          header, so users can tell instances apart.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">{error}</div>
      )}

      <form onSubmit={save} className="flex items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex-1 space-y-1">
          <label htmlFor="instance-name" className="text-xs font-medium text-muted-foreground">
            Instance name
          </label>
          <input
            id="instance-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Corp"
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
          Save
        </button>
      </form>

      {saved !== null && saved === name.trim() && (
        <p className="text-xs text-muted-foreground">
          Saved. It appears for everyone after their next page load.
        </p>
      )}

      {/* Host key (ADR 0012 TOFU): publish it so users can pin this server out-of-band. */}
      {hostKey && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
          <div className="min-w-0">
            <div className="font-medium">Host key</div>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">SHA256:{hostKey}</p>
            <p className="mt-1 text-xs text-muted-foreground">Share this so users can pin this server on first connect.</p>
          </div>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(`SHA256:${hostKey}`);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">Keep users signed in across reloads</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Stores each user's vault key in their browser's session storage so a page reload doesn't force a
              re-login. Still zero-knowledge — the key never leaves the browser and is cleared when the tab closes.
              Turn this off to enforce a RAM-only key (re-login on every reload).
            </p>
            {managed.session_persistence && <ManagedBy origin={managed.session_persistence} />}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={persistence}
            aria-label="Keep users signed in across reloads"
            disabled={!!managed.session_persistence}
            onClick={togglePersistence}
            className={`inline-flex h-6 w-11 flex-none items-center rounded-full p-0.5 transition-colors ${
              persistence ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                persistence ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">Open registration</div>
            <p className="mt-1 text-sm text-muted-foreground">
              <b>Off by default.</b> When on, the sign-in screen offers <b>Create an account</b> — anyone who can reach
              this server can self-register (role <b>user</b>, no team). They generate their own keys, so you never see
              them. Leave off for an invite-only instance (admin-provisioned accounts or enrollment tokens).
            </p>
            {managed.open_registration && <ManagedBy origin={managed.open_registration} />}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={openReg}
            aria-label="Open registration"
            disabled={!!managed.open_registration}
            onClick={toggleOpenReg}
            className={`inline-flex h-6 w-11 flex-none items-center rounded-full p-0.5 transition-colors ${
              openReg ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                openReg ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">Allow invitations</div>
            <p className="mt-1 text-sm text-muted-foreground">
              <b>On by default.</b> The master switch for enrollment-token invitations (Invitations tab). Turn it off to
              close the invite path instance-wide — no new tokens can be minted and existing ones stop working, enforced
              on the server. Independent of open registration (invitations are the invite-only path).
            </p>
            {managed.allow_invitations && <ManagedBy origin={managed.allow_invitations} />}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={allowInv}
            aria-label="Allow invitations"
            disabled={!!managed.allow_invitations}
            onClick={toggleAllowInv}
            className={`inline-flex h-6 w-11 flex-none items-center rounded-full p-0.5 transition-colors ${
              allowInv ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                allowInv ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">Confirm role changes</div>
            <p className="mt-1 text-sm text-muted-foreground">
              <b>Off by default.</b> When on, changing an account&apos;s role in Users asks for a confirmation first — a
              guard against an accidental promotion or demotion. A UX safety prompt, applied on every client.
            </p>
            {managed.confirm_role_change && <ManagedBy origin={managed.confirm_role_change} />}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={confirmRole}
            aria-label="Confirm role changes"
            disabled={!!managed.confirm_role_change}
            onClick={toggleConfirmRole}
            className={`inline-flex h-6 w-11 flex-none items-center rounded-full p-0.5 transition-colors ${
              confirmRole ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                confirmRole ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Client capabilities — what connected clients may do, governed here. */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="text-base font-semibold">Client capabilities</div>
          <p className="mt-0.5 text-xs text-muted-foreground">What connected clients may do on this server.</p>
        </div>

        <div className="flex items-start justify-between gap-4 border-b border-border p-4">
          <div>
            <div className="font-medium">Default shell</div>
            <p className="mt-1 text-sm text-muted-foreground">
              The shell for terminals opened on this server. Web-UI users don&apos;t pick their own — this is it.
              (Desktop users choose their own <b>local</b> shell.)
            </p>
            {managed.default_shell && <ManagedBy origin={managed.default_shell} />}
          </div>
          <select
            value={shell}
            onChange={(e) => changeShell(e.target.value)}
            className="flex-none rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {['bash', 'sh', 'zsh', 'fish'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-start justify-between gap-4 p-4">
          <div>
            <div className="font-medium">Allow Quick SSH</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Ad-hoc one-off SSH from the toolbar. <b>Off by default</b> — connections on a server should live in{' '}
              <b>collections</b> (saved, shared, auditable). Turn on for teams that need quick throwaway sessions.
            </p>
            {managed.allow_quick_ssh && <ManagedBy origin={managed.allow_quick_ssh} />}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={quickSsh}
            aria-label="Allow Quick SSH"
            disabled={!!managed.allow_quick_ssh}
            onClick={toggleQuickSsh}
            className={`inline-flex h-6 w-11 flex-none items-center rounded-full p-0.5 transition-colors ${quickSsh ? 'bg-primary' : 'bg-muted'}`}
          >
            <span
              className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                quickSsh ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Machine health-check (ADR 0017): passive "last seen" is free; active is governed. */}
        <div className="border-t border-border p-4">
          <div className="font-medium">Machine health-check</div>
          <p className="mt-1 text-sm text-muted-foreground">
            <b>Passive “last seen”</b> (from users&apos; own connections) costs no traffic. <b>Active probing</b> makes
            network requests from every client — a scan-like footprint at scale — so it&apos;s governed here.
          </p>
          {managed.healthcheck_policy && <ManagedBy origin={managed.healthcheck_policy} />}
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border p-4">
          <div>
            <div className="font-medium">Show status</div>
            <p className="mt-1 text-sm text-muted-foreground">The passive “last seen” pastille. No probing.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={hc.passiveStatus}
            aria-label="Show machine status"
            onClick={() => saveHc({ ...hc, passiveStatus: !hc.passiveStatus })}
            className={`inline-flex h-6 w-11 flex-none items-center rounded-full p-0.5 transition-colors ${hc.passiveStatus ? 'bg-primary' : 'bg-muted'}`}
          >
            <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${hc.passiveStatus ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4 border-t border-border p-4">
          <div className="min-w-[220px] flex-1">
            <div className="font-medium">Active probing</div>
            <p className="mt-1 text-sm text-muted-foreground">
              <b>Off</b> passive only · <b>On-demand</b> only when a user asks · <b>Full</b> background polling allowed ·
              <b>Client&apos;s choice</b> each client picks its cadence.
            </p>
          </div>
          <div className="inline-flex flex-wrap overflow-hidden rounded-md border border-input">
            {(['off', 'on-demand', 'full', 'client-choice'] as const).map((m) => (
              <button
                key={m}
                onClick={() => saveHc({ ...hc, active: m })}
                className={`border-r border-input px-3 py-1.5 text-xs last:border-r-0 ${
                  hc.active === m ? 'bg-primary/20 font-semibold text-primary' : 'bg-background text-muted-foreground hover:bg-muted'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className={`flex flex-wrap items-start justify-between gap-4 border-t border-border p-4 ${hc.active === 'off' ? 'pointer-events-none opacity-40' : ''}`}>
          <div>
            <div className="font-medium">Allowed methods</div>
            <p className="mt-1 text-sm text-muted-foreground">
              ICMP is blocked on some networks and required on others. Clients may use only a method enabled here.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {HC_METHODS.map((m) => {
              const on = hc.methods.includes(m.id);
              return (
                <label key={m.id} className="flex cursor-pointer select-none items-center gap-1.5 text-sm">
                  <span className={`grid h-[17px] w-[17px] place-items-center rounded border text-[11px] font-bold ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}`}>
                    {on ? '✓' : ''}
                  </span>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() =>
                      saveHc({ ...hc, methods: on ? hc.methods.filter((x) => x !== m.id) : [...hc.methods, m.id] })
                    }
                  />
                  {m.label}
                </label>
              );
            })}
          </div>
        </div>

        <div className={`flex flex-col gap-2 border-t border-border p-4 ${hc.active === 'off' ? 'pointer-events-none opacity-40' : ''}`}>
          <div>
            <div className="font-medium">Who can run active checks</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Empty means everyone. Add usernames to restrict active probing to specific people; passive “last seen” stays available to all.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {hc.restrictUsers.length === 0 && (
              <span className="text-sm text-muted-foreground">Everyone allowed</span>
            )}
            {hc.restrictUsers.map((u) => (
              <span key={u} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-sm">
                {u}
                <button
                  onClick={() => saveHc({ ...hc, restrictUsers: hc.restrictUsers.filter((x) => x !== u) })}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${u}`}
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
              if (u && !hc.restrictUsers.includes(u)) saveHc({ ...hc, restrictUsers: [...hc.restrictUsers, u] });
              setUserInput('');
            }}
          >
            <input
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="username"
              className="w-40 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
            <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted">
              Add
            </button>
          </form>
        </div>

        <div className={`flex flex-wrap items-start justify-between gap-4 border-t border-border p-4 ${hc.active === 'off' || hc.active === 'on-demand' ? 'pointer-events-none opacity-40' : ''}`}>
          <div>
            <div className="font-medium">Minimum interval</div>
            <p className="mt-1 text-sm text-muted-foreground">Floor for background polling, so status never saturates the network.</p>
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
            <span className="text-sm text-muted-foreground">seconds</span>
          </div>
        </div>

        {/* Machine dashboard (ADR 0019): only the cards that execute on a host are governed.
            Overview, port forwarding and the Board touch no host and are never gated. */}
        <div className="border-t border-border p-4">
          <div className="font-medium">Machine dashboard — container &amp; service cards</div>
          <p className="mt-1 text-sm text-muted-foreground">
            These two cards run a command on the host every time they refresh. Everything else on the
            dashboard — address, port forwarding, the Board — reads what Rite already holds and is never
            affected by the switches below.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            The two halves are not equally strong, and it is worth knowing which is which.{' '}
            <b>Web UI</b> is <b>enforcement</b>: the browser cannot open SSH, this server executes, so off
            means nothing runs. <b>Clients</b> is <b>policy</b>: a desktop client probes from its own network
            and this server never sees the request — the official client honours the switch by hiding the
            cards, a modified one could ignore it. What it buys you is the traffic stopped in normal use, no
            trigger left in the UI to fire by accident, and a recorded statement of intent.
          </p>
          {managed.dashboard_policy && <ManagedBy origin={managed.dashboard_policy} />}
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border p-4">
          <div>
            <div className="font-medium">Allow in the web UI</div>
            <p className="mt-1 text-sm text-muted-foreground">
              This server runs the commands, so its own egress pays. Off means off for everyone in a browser —
              not a matter of preference.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={dash.webui}
            disabled={!!managed.dashboard_policy}
            aria-label="Allow the dashboard probing cards in the web UI"
            onClick={() => saveDash({ ...dash, webui: !dash.webui })}
            className={`inline-flex h-6 w-11 flex-none items-center rounded-full p-0.5 transition-colors ${dash.webui ? 'bg-primary' : 'bg-muted'}`}
          >
            <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${dash.webui ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-border p-4">
          <div>
            <div className="font-medium">Allow in attached clients</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Each client probes from its own network position, so your users&apos; endpoints pay. A user may
              also turn the cards off for themselves; neither side can override the other upward.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={dash.clients}
            disabled={!!managed.dashboard_policy}
            aria-label="Allow the dashboard probing cards in attached clients"
            onClick={() => saveDash({ ...dash, clients: !dash.clients })}
            className={`inline-flex h-6 w-11 flex-none items-center rounded-full p-0.5 transition-colors ${dash.clients ? 'bg-primary' : 'bg-muted'}`}
          >
            <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${dash.clients ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        <div
          className={`flex flex-wrap items-start justify-between gap-4 border-t border-border p-4 ${!dash.webui && !dash.clients ? 'pointer-events-none opacity-40' : ''}`}
        >
          <div>
            <div className="font-medium">Minimum refresh interval</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Floor between <b>automatic</b> refreshes: an open dashboard re-runs these two cards on
              its own, and never faster than this. Clients apply a floor of their own as well, so a
              very small number here does not buy a very fast refresh. It does not rate-limit a
              person pressing Refresh, and a dashboard nobody is looking at does not poll.
            </p>
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
            <span className="text-sm text-muted-foreground">seconds</span>
          </div>
        </div>
      </div>
    </div>
  );
}
