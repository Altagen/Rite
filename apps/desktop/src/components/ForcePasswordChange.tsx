/**
 * Force-password-change screen (ADR 0010 addendum). Shown when the account still uses an
 * admin-set password (first login, or after an admin reset): the user must set a password
 * only they know, which mints a fresh vault + keypair so the admin can no longer derive the
 * key. Mirrors design/mock/setup.html. Blocks the app until done.
 */

import { useMemo, useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';

function strength(p: string): number {
  if (!p) return 0;
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return p.length < 8 ? Math.min(s, 1) : Math.min(s, 4);
}
const LABEL = ['', 'Too weak', 'Fair', 'Good', 'Strong'];
const COLOR = ['', 'bg-red-500', 'bg-amber-500', 'bg-green-500', 'bg-green-500'];

export function ForcePasswordChange() {
  const { user, changePassword, loading, error } = useServerSession();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);

  const score = useMemo(() => strength(pw), [pw]);
  const mismatch = pw2.length > 0 && pw !== pw2;
  const canSubmit = score >= 2 && pw.length > 0 && pw === pw2 && !loading;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    void changePassword(pw);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-xl">
        <h1 className="mb-2 text-xl font-bold">Set your password</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          {user ? (
            <>
              Welcome, <b className="text-foreground">{user.username}</b> — choose a password{' '}
              <b className="text-foreground">only you know</b>. Until you do, the initial password an admin set
              could unlock your data. This one is yours alone, and it can&apos;t be recovered — keep it safe.
            </>
          ) : (
            'Choose a password only you know.'
          )}
        </p>

        {error && (
          <div className="mb-4 rounded-md border border-red-500/20 bg-red-500/10 p-2 text-sm text-red-600">{error}</div>
        )}

        <label className="mb-1 block text-xs font-medium text-muted-foreground">New password</label>
        <div className="relative mb-2">
          <input
            type={show ? 'text' : 'password'}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoFocus
            autoComplete="new-password"
            placeholder="A password only you know"
            className="w-full rounded-md border border-input bg-background px-3 py-2 pr-16 text-sm"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
          >
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
        <div className="mb-1 flex gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`h-1 flex-1 rounded ${i < score ? COLOR[score] : 'bg-muted'}`} />
          ))}
        </div>
        <div className="mb-4 h-4 text-xs text-muted-foreground">{pw ? `Password strength: ${LABEL[score]}` : ''}</div>

        <label className="mb-1 block text-xs font-medium text-muted-foreground">Confirm password</label>
        <input
          type={show ? 'text' : 'password'}
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          autoComplete="new-password"
          placeholder="Type it again"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <div className="mb-4 mt-1 h-4 text-xs text-red-500">{mismatch ? 'Passwords don’t match.' : ''}</div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? 'Setting…' : 'Set password & continue'}
        </button>
      </form>
    </div>
  );
}
