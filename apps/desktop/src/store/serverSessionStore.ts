/**
 * Server-mode session (ADR 0010).
 *
 * Holds whether the current endpoint is a shared server and, if so, the logged-in
 * user. Login/bootstrap derive the auth hash client-side (the password never
 * leaves the browser) and store the returned opaque session token.
 */

import { create } from 'zustand';
import { Backend, type ServerMode, type ServerUser } from '../utils/backend';
import { deriveAuthHash, randomSaltHex, DEFAULT_KDF_PARAMS } from '../utils/serverAuth';
import { setSessionToken, clearSessionToken, getSessionToken } from '../utils/session';

interface ServerSessionState {
  mode: ServerMode | null; // null until loaded
  user: ServerUser | null; // current server user (server mode only)
  loading: boolean;
  error: string | null;
  loadMode: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  bootstrap: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useServerSession = create<ServerSessionState>((set, get) => ({
  mode: null,
  user: null,
  loading: false,
  error: null,

  loadMode: async () => {
    const mode = await Backend.Server.mode();
    set({ mode });
    // Resume an existing session if we still hold a token.
    if (mode.accounts && getSessionToken()) {
      try {
        const user = await Backend.Server.me();
        set({ user });
      } catch {
        clearSessionToken();
        set({ user: null });
      }
    }
  },

  login: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const { salt, params } = await Backend.Server.prelogin(username);
      const authHash = await deriveAuthHash(password, salt, params);
      const { token, user } = await Backend.Server.login(username, authHash);
      setSessionToken(token);
      set({ user, loading: false });
    } catch (e) {
      set({ error: 'Invalid username or password', loading: false });
      throw e;
    }
  },

  bootstrap: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const salt = randomSaltHex();
      const authHash = await deriveAuthHash(password, salt, DEFAULT_KDF_PARAMS);
      const { token, user } = await Backend.Server.bootstrap(
        username,
        salt,
        DEFAULT_KDF_PARAMS,
        authHash,
      );
      setSessionToken(token);
      const mode = get().mode;
      set({ user, loading: false, mode: mode ? { ...mode, needsBootstrap: false } : mode });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to create the admin', loading: false });
      throw e;
    }
  },

  logout: async () => {
    try {
      await Backend.Server.logout();
    } catch {
      // best-effort
    }
    clearSessionToken();
    set({ user: null });
  },

  clearError: () => set({ error: null }),
}));
