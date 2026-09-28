/**
 * Terminal Pool
 *
 * Manages xterm.js instances independently of React component lifecycle
 * This allows terminals to persist when React remounts components during pane reorganization
 */

import { Terminal as XTerm, IDisposable, ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';

// Terminal colour themes — a client-side display preference (localStorage, per
// browser). "dark" matches the design mock (bluish black + periwinkle cursor);
// "grey" is the classic editor grey; "translucent" lets the ground show through.
export type TerminalThemeName = 'dark' | 'grey' | 'translucent';

const THEME_STORAGE = 'rite.terminalTheme';

const THEMES: Record<TerminalThemeName, ITheme> = {
  dark: {
    background: '#0b0d14',
    foreground: '#e7eaf2',
    cursor: '#7c9cf5',
    cursorAccent: '#0b0d14',
    selectionBackground: '#2a3450',
    selectionForeground: '#ffffff',
  },
  grey: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#ffffff',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
  },
  translucent: {
    background: 'rgba(11, 13, 20, 0.62)',
    foreground: '#e7eaf2',
    cursor: '#7c9cf5',
    cursorAccent: '#0b0d14',
    selectionBackground: '#2a3450',
    selectionForeground: '#ffffff',
  },
};

export function getTerminalThemeName(): TerminalThemeName {
  const v = (typeof localStorage !== 'undefined' && localStorage.getItem(THEME_STORAGE)) as TerminalThemeName | null;
  return v && v in THEMES ? v : 'dark';
}

export interface TerminalInstance {
  term: XTerm;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  container: HTMLDivElement | null;
  isOpen: boolean; // Track if term.open() has been called
  ioDisposables: IDisposable[]; // Track I/O handlers (onData, onBinary, onResize) to prevent duplicates
}

class TerminalPool {
  private terminals = new Map<string, TerminalInstance>();

  /**
   * Get or create a terminal instance for a session
   */
  getOrCreate(sessionId: string): TerminalInstance {
    // Return existing instance if available
    if (this.terminals.has(sessionId)) {
      return this.terminals.get(sessionId)!;
    }

    // Create new terminal instance
    const themeName = getTerminalThemeName();
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Fira Code, monospace',
      theme: THEMES[themeName],
      scrollback: 10000,
      allowTransparency: themeName === 'translucent',
    });

    // Add addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);

    const instance: TerminalInstance = {
      term,
      fitAddon,
      searchAddon,
      container: null,
      isOpen: false,
      ioDisposables: [],
    };

    this.terminals.set(sessionId, instance);
    return instance;
  }

  /**
   * Get an existing terminal instance
   */
  get(sessionId: string): TerminalInstance | undefined {
    return this.terminals.get(sessionId);
  }

  /**
   * Remove and dispose a terminal instance
   */
  remove(sessionId: string): void {
    const instance = this.terminals.get(sessionId);
    if (instance) {
      instance.term.dispose();
      this.terminals.delete(sessionId);
    }
  }

  /**
   * Check if a terminal exists in the pool
   */
  has(sessionId: string): boolean {
    return this.terminals.has(sessionId);
  }

  /**
   * Get all session IDs
   */
  getAllSessionIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Switch the terminal colour theme (persisted per browser) and apply it live to
   * every open terminal. Note: turning translucency ON only affects terminals
   * created afterwards (allowTransparency is fixed at creation).
   */
  setTheme(name: TerminalThemeName): void {
    try {
      localStorage.setItem(THEME_STORAGE, name);
    } catch {
      // ignore storage failures — the theme still applies for this session
    }
    for (const inst of this.terminals.values()) {
      inst.term.options.theme = THEMES[name];
    }
  }
}

// Global singleton instance
export const terminalPool = new TerminalPool();
