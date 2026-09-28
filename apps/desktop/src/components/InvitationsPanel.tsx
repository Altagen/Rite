/**
 * Enrollment tokens (ADR 0015 phase 3) — the admin/manager "Invitations" surface.
 *
 * Mint a single-use invitation encoding an org role + team membership(s) + expiry; the plaintext is
 * shown ONCE (only its hash is stored). Redeeming self-registers the holder with the recipe applied;
 * collection-secret access still follows the usual member grant. A manager may mint user tokens only.
 */

import { useCallback, useEffect, useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';
import { Backend, type EnrollmentToken, type MintedToken } from '../utils/backend';

type TeamOption = { id: string; name: string };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDaysISO = (n: number) => isoDate(new Date(Date.now() + n * 86400_000));
const TOMORROW = addDaysISO(1);
const QUICK_DAYS = [7, 30, 90];

function expiryLabel(t: EnrollmentToken): string {
  if (t.expiresAt === null) return 'never';
  const secs = t.expiresAt - Math.floor(Date.now() / 1000);
  if (secs <= 0) return 'expired';
  if (secs < 3600) return `in ${Math.max(1, Math.floor(secs / 60))}m`;
  if (secs < 86400) return `in ${Math.floor(secs / 3600)}h`;
  return `in ${Math.floor(secs / 86400)}d`;
}
function status(t: EnrollmentToken): 'used' | 'expired' | 'active' {
  if (t.consumedAt !== null) return 'used';
  if (t.expiresAt !== null && t.expiresAt <= Math.floor(Date.now() / 1000)) return 'expired';
  return 'active';
}

function RoleBadge({ role }: { role: EnrollmentToken['role'] }) {
  const cls =
    role === 'admin'
      ? 'bg-primary/15 text-primary'
      : role === 'manager'
        ? 'bg-amber-500/15 text-amber-600'
        : 'bg-secondary text-muted-foreground';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>{role}</span>
  );
}

export function InvitationsPanel() {
  const { user } = useServerSession();
  const isAdmin = user?.role === 'admin';
  const [tokens, setTokens] = useState<EnrollmentToken[] | null>(null);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showGen, setShowGen] = useState(false);
  const [reveal, setReveal] = useState<MintedToken | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    Backend.Admin.listEnrollmentTokens()
      .then(setTokens)
      .catch(() => setTokens([]));
  }, []);
  useEffect(() => {
    load();
    // Only offer teams the caller may grant into: an admin gets every team; a manager only the
    // teams they administer (the server enforces this too — mirror it here so the picker is honest).
    const source = isAdmin
      ? Backend.Teams.listAll()
      : Backend.Teams.mine().then((ts) => ts.filter((t) => t.role === 'admin'));
    source
      .then((ts) => setTeams(ts.map((t) => ({ id: t.id, name: t.name }))))
      .catch(() => setTeams([]));
  }, [load, isAdmin]);

  const revoke = async (id: string) => {
    setErr(null);
    try {
      await Backend.Admin.revokeEnrollmentToken(id);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to revoke');
    }
  };

  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <>
      <div className="mb-5 flex items-center gap-3.5">
        <h1 className="text-[22px] font-bold">Invitations</h1>
        <span className="text-[13px] text-muted-foreground">Enrollment tokens · single-use</span>
        <span className="flex-1" />
        <button
          onClick={() => setShowGen(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + Generate token
        </button>
      </div>

      <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-primary/25 bg-primary/[0.08] p-3.5 text-[13px] text-foreground/80">
        <span>
          A token grants <b>membership + role immediately</b> on redeem; access to a collection&apos;s encrypted machines
          still follows the usual <b>member grant</b>. Tokens are <b>single-use</b>, <b>hashed at rest</b>, and the full
          value is shown <b>once</b>.
        </span>
      </div>

      {err && <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">{err}</div>}

      {reveal && (
        <div className="mb-4 rounded-2xl border border-dashed border-primary/50 bg-card p-4">
          <div className="mb-1 text-sm font-semibold">Copy this token now</div>
          <p className="mb-3 text-xs text-muted-foreground">
            The server keeps only a hash — you won&apos;t be able to see it again. Share it out-of-band.
          </p>
          <div className="flex items-center gap-2.5">
            <code className="min-w-0 flex-1 break-all rounded-md bg-input px-3 py-2 font-mono text-sm">{reveal.token}</code>
            <button
              onClick={() => copy(reveal.token)}
              className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-secondary"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={() => setReveal(null)}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Done
            </button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="grid grid-cols-[1fr_auto_1.2fr_auto_auto] items-center gap-4 border-b border-border px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Token</span>
          <span>Role</span>
          <span>Teams</span>
          <span>Expires</span>
          <span className="text-right">Actions</span>
        </div>
        {tokens === null ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            No invitation tokens yet. Generate one to onboard a member without being present.
          </div>
        ) : (
          tokens.map((t) => {
            const st = status(t);
            return (
              <div
                key={t.id}
                className={`grid grid-cols-[1fr_auto_1.2fr_auto_auto] items-center gap-4 border-b border-border px-4 py-3 text-sm last:border-b-0 ${
                  st === 'active' ? '' : 'opacity-60'
                }`}
              >
                <code className="truncate rounded bg-input px-2 py-0.5 font-mono text-[13px]">{t.prefix}…</code>
                <RoleBadge role={t.role} />
                <span className="truncate text-[13px]">
                  {t.teams.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    t.teams.map((g, i) => (
                      <span key={g.teamId}>
                        {i > 0 && ', '}
                        {teamName(g.teamId)} <span className="text-muted-foreground">· {g.teamRole}</span>
                      </span>
                    ))
                  )}
                </span>
                <span className="text-[13px] text-muted-foreground">
                  {st === 'used' ? 'used' : expiryLabel(t)}
                </span>
                <span className="text-right">
                  <button
                    onClick={() => revoke(t.id)}
                    className="rounded px-2 py-1 text-sm font-medium text-red-500 hover:bg-red-500/10"
                  >
                    {st === 'active' ? 'Revoke' : 'Remove'}
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>

      {showGen && (
        <GenerateDialog
          isAdmin={isAdmin}
          teams={teams}
          onClose={() => setShowGen(false)}
          onCreated={(minted) => {
            setShowGen(false);
            setReveal(minted);
            load();
          }}
        />
      )}
    </>
  );
}

function GenerateDialog({
  isAdmin,
  teams,
  onClose,
  onCreated,
}: {
  isAdmin: boolean;
  teams: TeamOption[];
  onClose: () => void;
  onCreated: (minted: MintedToken) => void;
}) {
  const [role, setRole] = useState<'user' | 'manager'>('user');
  const [picked, setPicked] = useState<Record<string, 'admin' | 'member'>>({});
  // '' = never expires; otherwise a 'YYYY-MM-DD' date (the token dies at the end of that day).
  const [expiry, setExpiry] = useState<string>(addDaysISO(30));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleTeam = (id: string) =>
    setPicked((p) => {
      const next = { ...p };
      if (next[id]) delete next[id];
      else next[id] = 'member';
      return next;
    });

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      // A chosen date → seconds until end of that day; empty → never expires.
      const secs = expiry
        ? Math.max(60, Math.floor((new Date(expiry + 'T23:59:59').getTime() - Date.now()) / 1000))
        : null;
      const minted = await Backend.Admin.createEnrollmentToken({
        role,
        teams: Object.entries(picked).map(([teamId, teamRole]) => ({ teamId, teamRole })),
        expiresInSecs: secs,
      });
      onCreated(minted);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to generate the token');
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Generate an invitation token</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The holder self-registers with this recipe already applied. You&apos;ll see the token once.
        </p>

        {err && <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">{err}</div>}

        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="tk-role" className="text-sm font-medium">
              Org role
            </label>
            <select
              id="tk-role"
              value={role}
              onChange={(e) => setRole(e.target.value as 'user' | 'manager')}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="user">user</option>
              {isAdmin && <option value="manager">manager</option>}
            </select>
            <p className="text-xs text-muted-foreground">
              {isAdmin
                ? 'Admins can mint user or manager tokens (never admin).'
                : 'Managers can mint user tokens only.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <span className="text-sm font-medium">Add to teams</span>
            {teams.length === 0 ? (
              <p className="text-sm text-muted-foreground">No teams yet.</p>
            ) : (
              <div className="max-h-44 space-y-1 overflow-auto rounded-lg border border-border p-2">
                {teams.map((t) => {
                  const on = t.id in picked;
                  return (
                    <div
                      key={t.id}
                      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${on ? 'bg-primary/10' : ''}`}
                    >
                      <input type="checkbox" checked={on} onChange={() => toggleTeam(t.id)} />
                      <span className="flex-1">{t.name}</span>
                      {on && (
                        <select
                          value={picked[t.id]}
                          onChange={(e) => setPicked((p) => ({ ...p, [t.id]: e.target.value as 'admin' | 'member' }))}
                          className="rounded border border-input bg-background px-1.5 py-1 text-xs"
                        >
                          <option value="member">member</option>
                          <option value="admin">admin</option>
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="tk-expiry" className="text-sm font-medium">
              Expires
            </label>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_DAYS.map((d) => {
                const on = expiry === addDaysISO(d);
                return (
                  <button
                    type="button"
                    key={d}
                    onClick={() => setExpiry(addDaysISO(d))}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      on ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-secondary'
                    }`}
                  >
                    {d} days
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setExpiry('')}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  expiry === '' ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-secondary'
                }`}
              >
                No expiration
              </button>
            </div>
            <input
              id="tk-expiry"
              type="date"
              min={TOMORROW}
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {expiry ? `The token stops working after ${expiry}.` : 'The token never expires — revoke it manually.'}
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-secondary">
            Cancel
          </button>
          <button
            onClick={generate}
            disabled={busy}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  );
}
