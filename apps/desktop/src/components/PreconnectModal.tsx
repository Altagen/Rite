/**
 * Pre-connect Modal
 *
 * Runs a connection's pre-connect hook (a local command — bring up a VPN,
 * refresh an SSO token) in a PTY before the SSH session opens, streaming its
 * output into a compact live terminal. The command runs fail-fast: exit 0 lets
 * the connection proceed, a non-zero exit cancels it and offers a retry. The
 * terminal is interactive, so helpers that prompt (a passphrase, an SSO code)
 * work here just as they would in a shell.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { transport, Unlisten } from '../utils/transport';
import { Backend } from '../utils/backend';

interface Props {
  command: string;
  connectionName: string;
  onSuccess: () => void;
  onCancel: () => void;
}

type Phase = 'running' | 'success' | 'failed';

interface TerminalDataEvent {
  sessionId: string;
  data: string;
}
interface TerminalExitEvent {
  sessionId: string;
  exitStatus: number;
}

export function PreconnectModal({ command, connectionName, onSuccess, onCancel }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<Unlisten[]>([]);
  const [phase, setPhase] = useState<Phase>('running');
  const [exitCode, setExitCode] = useState<number | null>(null);

  // Detach listeners and close the current pre-connect session (best-effort).
  const teardownSession = () => {
    unlistenersRef.current.forEach((u) => u());
    unlistenersRef.current = [];
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    if (id) void Backend.Terminal.disconnectTerminal(id).catch(() => {});
  };

  const run = async () => {
    const term = termRef.current;
    if (!term) return;

    teardownSession(); // clear any previous attempt's session/listeners
    term.clear();
    setPhase('running');
    setExitCode(null);

    const unlistenData = await transport().listen<TerminalDataEvent>('terminal-data', (p) => {
      if (p.sessionId === sessionIdRef.current && termRef.current) {
        const bytes = Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0));
        termRef.current.write(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
      }
    });
    const unlistenExit = await transport().listen<TerminalExitEvent>('terminal-exit', (p) => {
      if (p.sessionId !== sessionIdRef.current) return;
      setExitCode(p.exitStatus);
      if (p.exitStatus === 0) {
        setPhase('success');
        // Give the eye a beat to register the green dot, then proceed.
        window.setTimeout(() => onSuccess(), 550);
      } else {
        setPhase('failed');
      }
    });
    unlistenersRef.current = [unlistenData, unlistenExit];

    try {
      const sessionId = await Backend.Terminal.runPreconnect(command);
      sessionIdRef.current = sessionId;
      const buffered = await Backend.Terminal.claimSessionOutput(sessionId).catch(() => '');
      if (buffered && termRef.current) {
        const bytes = Uint8Array.from(atob(buffered), (c) => c.charCodeAt(0));
        termRef.current.write(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      termRef.current?.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
      setPhase('failed');
    }
  };

  const handleCancel = () => {
    teardownSession();
    onCancel();
  };

  // Create the xterm instance once, when the modal mounts, then kick off the run.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      fontFamily: 'monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
      theme: { background: '#0b0e14' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    term.onData((data) => {
      const id = sessionIdRef.current;
      if (!id) return;
      const bytes = Array.from(new TextEncoder().encode(data));
      void Backend.Terminal.sendTerminalInput(id, bytes);
    });
    termRef.current = term;

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);

    void run();

    return () => {
      window.removeEventListener('resize', onResize);
      teardownSession();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dotClass =
    phase === 'success'
      ? 'bg-green-500'
      : phase === 'failed'
        ? 'bg-red-500'
        : 'bg-amber-400 animate-pulse';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
          <div className="min-w-0">
            <div className="text-sm font-medium">{t('preconnect.title')}</div>
            <div className="truncate text-xs text-muted-foreground">
              {t('preconnect.runningFor', { name: connectionName })}
            </div>
          </div>
          <code className="ml-auto max-w-[40%] truncate rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
            {command.split('\n')[0]}
          </code>
        </div>

        <div ref={containerRef} className="h-64 bg-[#0b0e14] px-2 py-1" />

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          {phase === 'failed' && (
            <span className="mr-auto text-xs text-red-500">
              {t('preconnect.failed')}
              {exitCode !== null ? ` (exit ${exitCode})` : ''}
            </span>
          )}
          {phase === 'running' && (
            <span className="mr-auto text-xs text-muted-foreground">
              {t('preconnect.runningFor', { name: connectionName })}
            </span>
          )}
          {phase === 'success' && (
            <span className="mr-auto text-xs text-green-500">✓</span>
          )}

          {phase === 'failed' && (
            <button
              type="button"
              onClick={() => void run()}
              className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t('preconnect.retry')}
            </button>
          )}
          <button
            type="button"
            onClick={handleCancel}
            disabled={phase === 'success'}
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {t('preconnect.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
