/**
 * Snippets: a personal library of reusable commands.
 *
 * A snippet is a named command you run in a terminal — on one pane, or broadcast
 * to every open pane. Running just types the command (+ Enter) into the session's
 * stdin, so there's no backend: the library lives per-device in localStorage.
 */
import { create } from 'zustand';

export interface Snippet {
  id: string;
  name: string;
  command: string;
}

const KEY = 'rite-snippets';

// A few useful defaults on first run (no stored library yet).
const DEFAULTS: Snippet[] = [
  { id: 's-syslog', name: 'Tail syslog', command: 'sudo tail -f /var/log/syslog' },
  { id: 's-df', name: 'Disk usage', command: 'df -h' },
  { id: 's-ps', name: 'Running containers', command: 'docker ps' },
  { id: 's-failed', name: 'Failed units', command: 'systemctl --failed' },
];

const read = (): Snippet[] => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
};

const write = (snippets: Snippet[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(snippets));
  } catch {
    /* storage unavailable — keep it in memory only */
  }
};

const newId = () => `s-${Math.random().toString(36).slice(2, 9)}`;

interface SnippetsState {
  snippets: Snippet[];
  add: (name: string, command: string) => void;
  remove: (id: string) => void;
  update: (id: string, name: string, command: string) => void;
}

export const useSnippets = create<SnippetsState>((set) => ({
  snippets: read(),
  add: (name, command) =>
    set((s) => {
      const next = [...s.snippets, { id: newId(), name, command }];
      write(next);
      return { snippets: next };
    }),
  remove: (id) =>
    set((s) => {
      const next = s.snippets.filter((x) => x.id !== id);
      write(next);
      return { snippets: next };
    }),
  update: (id, name, command) =>
    set((s) => {
      const next = s.snippets.map((x) => (x.id === id ? { ...x, name, command } : x));
      write(next);
      return { snippets: next };
    }),
}));
