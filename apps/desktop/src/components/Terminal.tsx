/**
 * Terminal Component
 *
 * Displays an interactive terminal using xterm.js connected to an SSH session
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';
import { terminalPool } from '../utils/terminalPool';
import { Tauri } from '../utils/tauri';
import { errorHandler, ErrorSeverity, ErrorCategory } from '../utils/errorHandler';

// Global cache to track if a terminal has already been initialized
// This prevents re-writing initial content on remount
const terminalInitializedCache = new Set<string>();

interface TerminalProps {
  connectionId: string;
  connectionName: string;
  onClose: () => void;
  sessionId?: string; // Optional - if provided, use existing session instead of creating new one
  isFocused?: boolean; // Optional - whether this terminal pane is focused
  onSplitHorizontal?: () => void; // Optional - callback to split this terminal horizontally
  onSplitVertical?: () => void; // Optional - callback to split this terminal vertically
  onDetach?: () => void; // Optional - callback to detach this pane into a new tab
  onDragStart?: (e: React.DragEvent) => void; // Optional - callback when pane drag starts
  onDragEnd?: () => void; // Optional - callback when pane drag ends
  onDragOver?: (e: React.DragEvent) => void; // Optional - callback when dragging over this pane
  onDrop?: (e: React.DragEvent) => void; // Optional - callback when dropping on this pane
  isDragging?: boolean; // Optional - whether a drag is in progress (to disable pointer events)
}

interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

interface TerminalExitEvent {
  sessionId: string;
  exitStatus: number;
}

interface TerminalClosedEvent {
  sessionId: string;
}

interface ConnectionDeadEvent {
  sessionId: string;
  reason: string;
}

export function Terminal({ connectionId, connectionName, onClose, sessionId: existingSessionId, isFocused, onSplitHorizontal, onSplitVertical, onDetach, onDragStart, onDragEnd, onDragOver, onDrop, isDragging }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Intelligent prompt detection state
  const promptDetectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptDetectedRef = useRef<boolean>(false);

  // Store props in refs to avoid recreating terminal on prop changes
  const connectionIdRef = useRef(connectionId);
  const connectionNameRef = useRef(connectionName);
  const isLocalTerminal = connectionId === 'local';

  // Track if terminal was explicitly closed by user
  const isClosedByUserRef = useRef(false);

  // Update refs when props change (without triggering terminal recreation)
  useEffect(() => {
    connectionIdRef.current = connectionId;
    connectionNameRef.current = connectionName;
  }, [connectionId, connectionName]);

  // Helper to focus the terminal's textarea
  const focusTerminalTextarea = () => {
    if (!terminalRef.current) return;
    const textarea = terminalRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    if (textarea) {
      textarea.focus();
    }
  };

  // Helper to send input to backend terminal
  const sendTerminalInput = async (data: string) => {
    if (!sessionIdRef.current) {
      errorHandler.handle('Cannot send input: session ID is null', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.TERMINAL,
        context: { component: 'Terminal', function: 'sendTerminalInput' },
      });
      return;
    }

    try {
      const encoder = new TextEncoder();
      const bytes = Array.from(encoder.encode(data));
      await Tauri.Terminal.sendTerminalInput(sessionIdRef.current, bytes);
    } catch (err) {
      errorHandler.handle('Failed to send terminal input', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.TERMINAL,
        originalError: err,
        context: { component: 'Terminal', sessionId: sessionIdRef.current },
      });
    }
  };

  // Helper to make terminal read-only
  const makeTerminalReadOnly = (term: XTerm) => {
    term.options.cursorBlink = false;
    term.options.disableStdin = true;
  };

  // Focus the DOM when isFocused prop becomes true
  // This ensures keyboard shortcuts work when programmatically focusing a pane
  useEffect(() => {
    if (isFocused && terminalRef.current) {
      console.log('[Terminal] Focusing textarea for session:', existingSessionId);
      focusTerminalTextarea();
    }
  }, [isFocused, existingSessionId]);

  useEffect(() => {
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let unlistenClosed: UnlistenFn | null = null;
    let unlistenDead: UnlistenFn | null = null;

    async function initializeTerminal() {
      if (!terminalRef.current || !existingSessionId) return;

      // Get or create terminal instance from pool
      const instance = terminalPool.getOrCreate(existingSessionId);
      const { term, fitAddon, searchAddon } = instance;

      // Only call term.open() if the terminal hasn't been opened yet
      if (!instance.isOpen) {
        term.open(terminalRef.current);
        instance.isOpen = true;
        instance.container = terminalRef.current;
      } else {
        // Terminal is already open - need to move the DOM element to this container
        // Get the xterm DOM element and move it to the new container
        const terminalElement = instance.container?.querySelector('.xterm');
        if (terminalElement && terminalRef.current) {
          terminalRef.current.appendChild(terminalElement);
        }

        // Always update the container reference
        instance.container = terminalRef.current;
      }

      fitAddon.fit();

      // NOTE: Keyboard shortcuts (Ctrl+W, Ctrl+Shift+H, Ctrl+Shift+V) are handled
      // at the TerminalManager level using capture phase to intercept before xterm
      // gets them. This is simpler and more reliable than attachCustomKeyEventHandler.

      // IMPORTANT: Focus the terminal after reattach/init to enable keyboard input
      // We use requestAnimationFrame to ensure the DOM is fully rendered
      requestAnimationFrame(() => {
        // Focus the terminal
        term.focus();
        focusTerminalTextarea();
      });

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      // Listen to window resize
      const handleResize = () => {
        fitAddon.fit();
      };
      window.addEventListener('resize', handleResize);

      // Listen to container resize (for responsive layout)
      let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        // Clear existing timeout
        if (resizeTimeout) {
          clearTimeout(resizeTimeout);
        }

        // Use a very short debounce to avoid excessive calls while still being responsive
        resizeTimeout = setTimeout(() => {
          if (fitAddonRef.current && xtermRef.current) {
            try {
              fitAddonRef.current.fit();
            } catch (e) {
              errorHandler.handle('Error fitting terminal', {
                severity: ErrorSeverity.WARNING,
                category: ErrorCategory.TERMINAL,
                originalError: e,
                context: { component: 'Terminal', function: 'resizeObserver' },
                silent: true, // Don't show to user as this can be transient
              });
            }
          }
        }, 5);
      });

      if (terminalRef.current) {
        resizeObserver.observe(terminalRef.current);
      }

      // Force initial fit after a short delay
      setTimeout(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
        }
      }, 100);

      // IMPORTANT: Always register input/output handlers on every mount
      // These handlers are needed for terminal interaction and must be re-registered
      // when the component remounts (e.g., after tab switch)

      // First, dispose any existing I/O handlers to prevent duplicates
      if (instance.ioDisposables.length > 0) {
        instance.ioDisposables.forEach(d => d.dispose());
        instance.ioDisposables = [];
      }

      // Handle terminal input (both text and binary data)
      const onDataDisposable = term.onData((data) => sendTerminalInput(data));
      const onBinaryDisposable = term.onBinary((data) => sendTerminalInput(data));

      // Handle terminal resize
      const onResizeDisposable = term.onResize(async ({ cols, rows }) => {
        if (sessionIdRef.current) {
          try {
            await Tauri.Terminal.resizeTerminal(sessionIdRef.current, cols, rows);
          } catch (err) {
            errorHandler.handle('Failed to resize terminal', {
              severity: ErrorSeverity.WARNING,
              category: ErrorCategory.TERMINAL,
              originalError: err,
              context: { component: 'Terminal', sessionId: sessionIdRef.current, cols, rows },
              silent: true, // Don't show to user, just log
            });
          }
        }
      });

      // Store disposables in the pool to track them across remounts
      instance.ioDisposables.push(onDataDisposable, onBinaryDisposable, onResizeDisposable);

      // IMPORTANT: Always register backend event listeners on every mount
      // These listeners must be re-registered when the component remounts (e.g., after tab switch)

      // Set up event listeners for terminal data
      // This must be done on EVERY mount to receive backend output
      unlistenData = await listen<TerminalDataEvent>('terminal-data', (event) => {
        if (event.payload.sessionId === sessionIdRef.current && xtermRef.current) {
          // Decode base64 to get raw bytes, then decode bytes to UTF-8 string
          // This preserves terminal control sequences that would be lost with from_utf8_lossy
          const dataBase64 = event.payload.data;
          const dataBytes = Uint8Array.from(atob(dataBase64), c => c.charCodeAt(0));
          const decoder = new TextDecoder('utf-8', { fatal: false });
          const dataString = decoder.decode(dataBytes);

          xtermRef.current.write(dataString);

          // Intelligent prompt detection: check if we have printable characters
          if (isLocalTerminal && !promptDetectedRef.current) {
            const hasPrintable = dataString.split('').some((c: string) => {
              const code = c.charCodeAt(0);
              // Printable ASCII range (space to ~) or common unicode
              return (code >= 32 && code <= 126) || code > 127;
            });

            if (hasPrintable) {
              promptDetectedRef.current = true;
              if (promptDetectionTimerRef.current) {
                clearTimeout(promptDetectionTimerRef.current);
                promptDetectionTimerRef.current = null;
              }
            }
          }
        }
      });

      unlistenExit = await listen<TerminalExitEvent>('terminal-exit', (event) => {
        if (event.payload.sessionId === sessionIdRef.current && xtermRef.current) {
          xtermRef.current.write(`\r\n\nSession ended with exit status ${event.payload.exitStatus}\r\n`);
          setStatus('disconnected');
          makeTerminalReadOnly(xtermRef.current);
        }
      });

      unlistenClosed = await listen<TerminalClosedEvent>('terminal-closed', (event) => {
        if (event.payload.sessionId === sessionIdRef.current && xtermRef.current) {
          xtermRef.current.write('\r\n\nConnection closed\r\n');
          setStatus('disconnected');
          makeTerminalReadOnly(xtermRef.current);
        }
      });

      unlistenDead = await listen<ConnectionDeadEvent>('connection-dead', (event) => {
        if (event.payload.sessionId === sessionIdRef.current && xtermRef.current) {
          xtermRef.current.write(`\r\n\n\x1b[31mConnection lost: ${event.payload.reason}\x1b[0m\r\n`);
          xtermRef.current.write('\x1b[33mThe connection appears to be dead. You can try to reconnect.\x1b[0m\r\n');
          setError(`Connection dead: ${event.payload.reason}`);
          setStatus('error');
          makeTerminalReadOnly(xtermRef.current);
        }
      });

      // Only initialize session if this is a new terminal (not reattached)
      const isNewTerminal = !terminalInitializedCache.has(existingSessionId);

      if (isNewTerminal) {
        // Start intelligent prompt detection for local terminals
        if (isLocalTerminal) {
          promptDetectedRef.current = false;

          promptDetectionTimerRef.current = setTimeout(() => {
            if (!promptDetectedRef.current && sessionIdRef.current && xtermRef.current) {
              // Send newline to trigger prompt display if no output yet
              sendTerminalInput('\n');
            }
          }, 150); // 150ms for ultra-fast UX
        }

        // Connect to SSH or use existing session (listeners are now ready)
        try {
          if (existingSessionId) {
            // Use existing session (for local terminals and quick SSH)
            sessionIdRef.current = existingSessionId;
            setStatus('connected');

            // Mark session as initialized
            terminalInitializedCache.add(existingSessionId);

            // For local terminals, don't write connection message - let shell display directly
            // For SSH, write connection message
            if (!isLocalTerminal) {
              term.write(`Connected to ${connectionNameRef.current}\r\n\n`);
            }
            // For local terminals: do nothing, shells display their own prompt
          } else {
            // Create new SSH session (for saved connections)
            term.write(`Connecting to ${connectionNameRef.current}...\r\n`);

            const sessionId = await Tauri.Terminal.connectTerminal(connectionIdRef.current);

            sessionIdRef.current = sessionId;
            setStatus('connected');
            term.write('Connected!\r\n\n');
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          errorHandler.handle('Terminal connection failed', {
            severity: ErrorSeverity.ERROR,
            category: ErrorCategory.TERMINAL,
            originalError: err,
            context: {
              component: 'Terminal',
              connectionId: connectionIdRef.current,
              connectionName: connectionNameRef.current,
            },
          });
          setError(errorMessage);
          setStatus('error');
          term.write(`\x1b[31mConnection failed: ${errorMessage}\x1b[0m\r\n`);
        }
      } else {
        // Terminal already exists - reattaching to existing instance
        sessionIdRef.current = existingSessionId;
        setStatus('connected');

        // Focus the terminal when reattaching
        if (xtermRef.current) {
          requestAnimationFrame(() => {
            xtermRef.current?.focus();
            focusTerminalTextarea();
          });
        }
      }

      return () => {
        window.removeEventListener('resize', handleResize);
        resizeObserver.disconnect();
        if (resizeTimeout) {
          clearTimeout(resizeTimeout);
        }
        // Note: I/O disposables are managed by the terminal pool and will be
        // disposed when we re-register handlers on the next mount
      };
    }

    initializeTerminal();

    return () => {
      // Cleanup
      if (promptDetectionTimerRef.current) {
        clearTimeout(promptDetectionTimerRef.current);
        promptDetectionTimerRef.current = null;
      }
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      if (unlistenClosed) unlistenClosed();
      if (unlistenDead) unlistenDead();

      if (sessionIdRef.current) {
        if (isClosedByUserRef.current) {
          // User explicitly closed - remove from pool
          // Note: disconnect_terminal is already called in handleClose()
          terminalInitializedCache.delete(sessionIdRef.current);
          terminalPool.remove(sessionIdRef.current);
        } else {
          // React remount - keep terminal in pool
          // Don't clear instance.container - the DOM element is still alive
        }
      }
    };
  }, [existingSessionId]); // Only recreate terminal if session ID changes (should never happen)

  const handleClose = async () => {
    // Mark that user explicitly closed this terminal
    isClosedByUserRef.current = true;

    if (sessionIdRef.current) {
      try {
        await Tauri.Terminal.disconnectTerminal(sessionIdRef.current);
      } catch (err) {
        errorHandler.handle('Failed to disconnect terminal', {
          severity: ErrorSeverity.WARNING,
          category: ErrorCategory.TERMINAL,
          originalError: err,
          context: { component: 'Terminal', sessionId: sessionIdRef.current },
          silent: true, // Don't show to user on close
        });
      }
    }
    onClose();
  };

  const handleReconnect = async () => {
    if (!xtermRef.current) return;

    setIsReconnecting(true);
    setError(null);
    setStatus('connecting');

    const term = xtermRef.current;

    // Re-enable terminal input
    term.options.cursorBlink = true;
    term.options.disableStdin = false;

    // Clear terminal and show reconnecting message
    term.clear();
    term.write(`Reconnecting to ${connectionName}...\r\n`);

    try {
      const sessionId = await Tauri.Terminal.connectTerminal(connectionId);

      sessionIdRef.current = sessionId;
      setStatus('connected');
      term.write('Connected!\r\n\n');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      errorHandler.handle('Terminal reconnection failed', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.TERMINAL,
        originalError: err,
        context: {
          component: 'Terminal',
          connectionId,
          connectionName,
        },
      });
      setError(errorMessage);
      setStatus('error');
      term.write(`\x1b[31mReconnection failed: ${errorMessage}\x1b[0m\r\n`);
    } finally {
      setIsReconnecting(false);
    }
  };

  // Handle Ctrl+F for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
      }
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false);
        setSearchTerm('');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSearch]);

  const handleSearch = (direction: 'next' | 'previous') => {
    if (!searchAddonRef.current || !searchTerm) return;

    if (direction === 'next') {
      searchAddonRef.current.findNext(searchTerm, { caseSensitive: false });
    } else {
      searchAddonRef.current.findPrevious(searchTerm, { caseSensitive: false });
    }
  };

  // Handle click to focus terminal
  const handleTerminalClick = () => {
    focusTerminalTextarea();
  };

  return (
    <div
      className="flex flex-1 flex-col bg-[#1e1e1e] overflow-hidden w-full"
      onClick={handleTerminalClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Terminal Header - keep pointer events enabled for grip dots */}
      <div
        className="flex w-full items-center justify-between border-b border-border bg-card px-4 py-2 flex-shrink-0"
        style={{ pointerEvents: 'auto' }}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {/* Only show connection status for remote terminals */}
            {!isLocalTerminal && (
              <>
                {status === 'connecting' && (
                  <div className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
                )}
                {status === 'connected' && (
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                )}
                {status === 'disconnected' && (
                  <div className="h-2 w-2 rounded-full bg-gray-500" />
                )}
                {status === 'error' && (
                  <div className="h-2 w-2 rounded-full bg-red-500" />
                )}
              </>
            )}
            <span className="text-sm font-medium">{connectionName}</span>
          </div>
          {!isLocalTerminal && (
            <>
              {status === 'connecting' && (
                <span className="text-xs text-muted-foreground">
                  {isReconnecting ? 'Reconnecting...' : 'Connecting...'}
                </span>
              )}
              {status === 'error' && error && (
                <span className="text-xs text-red-500">{error}</span>
              )}
              {status === 'disconnected' && (
                <span className="text-xs text-muted-foreground">Disconnected</span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Drag handle - 6 grip dots */}
          {onDragStart && onDragEnd && (
            <div
              draggable
              onDragStart={(e) => {
                e.stopPropagation();
                if (onDragStart) onDragStart(e);
              }}
              onDragEnd={(e) => {
                e.stopPropagation();
                if (onDragEnd) onDragEnd();
              }}
              className="flex flex-col gap-0.5 p-1 cursor-move rounded hover:bg-muted transition-colors"
              title="Drag to reorganize pane"
            >
              <div className="flex gap-0.5">
                <div className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                <div className="h-1 w-1 rounded-full bg-muted-foreground/50" />
              </div>
              <div className="flex gap-0.5">
                <div className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                <div className="h-1 w-1 rounded-full bg-muted-foreground/50" />
              </div>
              <div className="flex gap-0.5">
                <div className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                <div className="h-1 w-1 rounded-full bg-muted-foreground/50" />
              </div>
            </div>
          )}

          {/* Reconnect button - shown when disconnected or error (not for local terminals) */}
          {!isLocalTerminal && (status === 'disconnected' || status === 'error') && (
            <button
              onClick={handleReconnect}
              disabled={isReconnecting}
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              title="Reconnect to server"
            >
              <div className="flex items-center gap-1">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>Reconnect</span>
              </div>
            </button>
          )}

          {/* Split buttons */}
          {onSplitHorizontal && (
            <button
              onClick={onSplitHorizontal}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="Split horizontal (Ctrl+Shift+H)"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4m10-2V6a2 2 0 00-2-2h-4" />
              </svg>
            </button>
          )}
          {onSplitVertical && (
            <button
              onClick={onSplitVertical}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="Split vertical (Ctrl+Shift+V)"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ transform: 'rotate(90deg)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4m10-2V6a2 2 0 00-2-2h-4" />
              </svg>
            </button>
          )}

          {/* Detach button - move pane to new tab */}
          {onDetach && (
            <button
              onClick={onDetach}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="Detach to new tab"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
          )}

          {/* Search button */}
          <button
            onClick={() => setShowSearch(!showSearch)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Search in terminal (Ctrl+F)"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>

          <button
            onClick={handleClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Close terminal"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search Bar */}
      {showSearch && (
        <div className="flex w-full items-center gap-2 border-b border-border bg-card px-4 py-2 flex-shrink-0">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSearch(e.shiftKey ? 'previous' : 'next');
              }
            }}
            placeholder="Search in terminal..."
            className="flex-1 rounded border border-border bg-input px-3 py-1 text-sm text-foreground focus:border-primary focus:outline-none"
            autoFocus
          />
          <button
            onClick={() => handleSearch('previous')}
            disabled={!searchTerm}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="Previous (Shift+Enter)"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            onClick={() => handleSearch('next')}
            disabled={!searchTerm}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="Next (Enter)"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            onClick={() => {
              setShowSearch(false);
              setSearchTerm('');
            }}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Close (Escape)"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Terminal Container */}
      <div
        ref={terminalRef}
        className="flex-1 p-2 overflow-hidden min-h-0"
        style={{
          pointerEvents: isDragging ? 'none' : 'auto',
        }}
      />
    </div>
  );
}
