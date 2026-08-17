/**
 * Keyboard-interactive challenge modal (2FA / OTP / PAM).
 *
 * The sibling of the host-key modal: when a server drives auth via
 * keyboard-interactive, the backend emits `ssh:kbd-interactive` with the
 * server's prompts and this collects the answers. It's fully dynamic — one or
 * many prompts, masked per the server's `echo` flag — and re-appears for another
 * round if the server issues one. A password Rite already holds is auto-answered
 * upstream, so this only ever asks for what Rite can't know (a one-time code).
 */

import { useState } from 'react';

export interface KbdPromptItem {
  prompt: string;
  echo: boolean;
}

export interface KbdChallenge {
  challengeId: string;
  name: string;
  instructions: string;
  prompts: KbdPromptItem[];
}

interface KbdInteractiveModalProps {
  challenge: KbdChallenge;
  onSubmit: (responses: string[]) => void;
  onCancel: () => void;
  busy?: boolean;
}

export function KbdInteractiveModal({ challenge, onSubmit, onCancel, busy }: KbdInteractiveModalProps) {
  const [answers, setAnswers] = useState<string[]>(() => challenge.prompts.map(() => ''));
  const title = challenge.name.trim() || 'Server verification';
  const setAnswer = (i: number, v: string) =>
    setAnswers((a) => a.map((x, idx) => (idx === i ? v : x)));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(answers);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kbd-interactive-title"
        className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-xl"
      >
        <div className="mb-1 flex items-center gap-3">
          <span className="text-2xl">🔐</span>
          <h2 id="kbd-interactive-title" className="text-lg font-semibold">
            {title}
          </h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">The server needs more to sign you in.</p>

        {challenge.instructions.trim() && <p className="mb-3 text-sm">{challenge.instructions}</p>}

        <div className="space-y-3">
          {challenge.prompts.map((p, i) => (
            <div key={i}>
              <label className="mb-1 block text-sm font-medium">{p.prompt}</label>
              <input
                type={p.echo ? 'text' : 'password'}
                value={answers[i]}
                onChange={(e) => setAnswer(i, e.target.value)}
                autoFocus={i === 0}
                autoComplete="off"
                className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
              />
            </div>
          ))}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Requested by the server (keyboard-interactive). Your answer is sent to the server to sign
          in — <span className="font-medium">nothing is stored by Rite</span>.
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        </div>
      </form>
    </div>
  );
}
