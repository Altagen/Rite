/**
 * Server-mode session (ADR 0010).
 *
 * Holds whether the current endpoint is a shared server and, if so, the logged-in
 * user. Login/bootstrap derive the auth hash client-side (the password never
 * leaves the browser) and store the returned opaque session token.
 */

import { create } from 'zustand';
import { Backend, type ServerMode, type ServerUser } from '../utils/backend';
import {
  deriveAuthHash,
  randomSaltHex,
  DEFAULT_KDF_PARAMS,
  createVaultKey,
  unwrapVaultKey,
} from '../utils/serverAuth';
import { setSessionToken, clearSessionToken, getSessionToken } from '../utils/session';
import { bytesToHex } from '../utils/vaultCrypto';

/**
 * When a remote context is active (native multiplexer), hand the unwrapped vault
 * key to the trusted local server so it survives reloads and can decrypt the
 * user's connections (ADR 0011). In a plain server/browser session the context
 * is 'local' and nothing is sent — the key never leaves the client.
 */
async function syncLocalVault(userKey: Uint8Array | null): Promise<void> {
  if (!userKey) return;
  try {
    const ctx = await Backend.Context.get();
    if (ctx.active !== 'local') {
      await Backend.Context.vaultUnlock(bytesToHex(userKey));
    }
  } catch {
    // No context control plane here (not a multiplexer) — nothing to unlock.
  }
}

interface ServerSessionState {
  mode: ServerMode | null; // null until loaded
  user: ServerUser | null; // current server user (server mode only)
  // The unwrapped per-user vault key (ADR 0011), RAM only, never persisted. Set
  // after login/bootstrap; null after a token-only resume (no password to unwrap)
  // — phase 3 will let the trusted local server hold it across reloads.
  userKey: Uint8Array | null;
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
  userKey: null,
  loading: false,
  error: null,

  loadMode: async () => {
    const mode = await Backend.Server.mode();
    set({ mode });
    // Resume an existing session if we still hold a token.
    if (mode.accounts && getSessionToken()) {
      try {
        const { user } = await Backend.Server.me();
        set({ user });
      } catch {
        clearSessionToken();
        set({ user: null, userKey: null });
      }
    }
  },

  login: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const { salt, params } = await Backend.Server.prelogin(username);
      const authHash = await deriveAuthHash(password, salt, params);
      const { token, user, vault } = await Backend.Server.login(username, authHash);
      setSessionToken(token);
      // Unwrap the per-user vault key with the password (never sent).
      const userKey = vault
        ? await unwrapVaultKey(password, vault.kdfMasterSalt, vault.protectedUserKey)
        : null;
      await syncLocalVault(userKey);
      set({ user, userKey, loading: false });
    } catch (e) {
      set({ error: 'Invalid username or password', loading: false });
      throw e;
    }
  },

  bootstrap: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const salt = randomSaltHex();
      // Derive the auth hash and generate the vault key in parallel (both run
      // Argon2id) so the extra crypto doesn't slow signup down.
      const [authHash, vaultKey] = await Promise.all([
        deriveAuthHash(password, salt, DEFAULT_KDF_PARAMS),
        createVaultKey(password),
      ]);
      const { token, user } = await Backend.Server.bootstrap(
        username,
        salt,
        DEFAULT_KDF_PARAMS,
        authHash,
        vaultKey.masterSaltHex,
        vaultKey.protectedUserKey,
      );
      setSessionToken(token);
      await syncLocalVault(vaultKey.userKey);
      const mode = get().mode;
      set({
        user,
        userKey: vaultKey.userKey,
        loading: false,
        mode: mode ? { ...mode, needsBootstrap: false } : mode,
      });
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
    set({ user: null, userKey: null });
  },

  clearError: () => set({ error: null }),
}));
