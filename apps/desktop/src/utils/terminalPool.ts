/**
 * Terminal Pool
 *
 * Manages xterm.js instances independently of React component lifecycle
 * This allows terminals to persist when React remounts components during pane reorganization
 */

import { Terminal as XTerm, IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';

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
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Fira Code, monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        selectionForeground: '#ffffff',
      },
      scrollback: 10000,
      allowTransparency: false,
      windowsMode: false,
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
}

// Global singleton instance
export const terminalPool = new TerminalPool();
