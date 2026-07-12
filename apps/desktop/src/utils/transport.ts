/**
 * Backend transport abstraction.
 *
 * The frontend reaches the Rust backend through one of three interchangeable
 * transports, chosen once at startup:
 *   - Tauri  — in-process IPC (the desktop app).
 *   - Mock   — local mock data (Vite dev preview, no backend).
 *   - Http   — HTTP + WebSocket to rite-server (browser served by the server).
 *
 * `utils/tauri.ts` calls `transport().invoke(...)` and terminal components call
 * `transport().listen(...)`, so nothing else in the app knows which transport is
 * live. This is the seam the whole multi-shell architecture hangs on.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { isTauri, mockInvoke } from './tauriMock';
import { httpInvoke } from './httpRoutes';

export type Unlisten = () => void;

export interface Transport {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to a backend event; the handler receives the event payload. */
  listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<Unlisten>;
}

class TauriTransport implements Transport {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    return tauriInvoke(command, args);
  }

  async listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
    return tauriListen<T>(event, (e) => handler(e.payload));
  }
}

class MockTransport implements Transport {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    return mockInvoke(command, args);
  }

  async listen<T>(_event: string, _handler: (payload: T) => void): Promise<Unlisten> {
    // The mock has no live backend, so no events stream. No-op unsubscribe.
    return () => {};
  }
}

class HttpTransport implements Transport {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    return httpInvoke(command, args ?? {});
  }

  async listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
    this.ensureSocket();
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const cb = handler as (payload: unknown) => void;
    set.add(cb);
    return () => set!.delete(cb);
  }

  private ensureSocket(): void {
    if (this.ws) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    socket.onmessage = (ev) => {
      try {
        const { event, payload } = JSON.parse(ev.data) as { event: string; payload: unknown };
        this.handlers.get(event)?.forEach((h) => h(payload));
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      this.ws = null;
    };
    this.ws = socket;
  }
}

let current: Transport | null = null;

/** The active transport, selected once: Tauri in the app, Mock in dev, else HTTP. */
export function transport(): Transport {
  if (current) return current;
  if (isTauri()) {
    current = new TauriTransport();
  } else if (import.meta.env.DEV) {
    current = new MockTransport();
  } else {
    current = new HttpTransport();
  }
  return current;
}
