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
import { bytesToHex, hexToBytes } from '../utils/vaultCrypto';
import { setUnauthorizedHandler, RiteHttpError, type HttpErrorKind } from '../utils/httpError';

/**
 * When a remote context is active (native multiplexer), hand the unwrapped vault
 * key to the trusted local server so it survives reloads and can decrypt the
 * user's connections (ADR 0011). In a plain server/browser session the context
 * is 'local' and nothing is sent — the key never leaves the client.
 */
// Optional vault-key persistence (admin-controlled, default on). The unwrapped
// keys are kept in sessionStorage so a page reload doesn't force re-login. This is
// still zero-knowledge — the key never leaves the browser and is cleared when the
// tab closes — but it does put the key at rest in the browser store, so an admin
// who wants stricter security can turn it off (RAM-only, re-login on every reload).
const VAULT_KEYS_STORAGE = 'rite.vaultKeys';

interface StoredKeys {
  userKey: Uint8Array;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function persistKeys(keys: StoredKeys): void {
  try {
    sessionStorage.setItem(
      VAULT_KEYS_STORAGE,
      JSON.stringify({
        u: bytesToHex(keys.userKey),
        p: bytesToHex(keys.privateKey),
        k: bytesToHex(keys.publicKey),
      }),
    );
  } catch {
    // sessionStorage unavailable (private mode / disabled) — stay RAM-only.
  }
}

function restoreKeys(): StoredKeys | null {
  try {
    const raw = sessionStorage.getItem(VAULT_KEYS_STORAGE);
    if (!raw) return null;
    const { u, p, k } = JSON.parse(raw) as { u: string; p: string; k: string };
    return { userKey: hexToBytes(u), privateKey: hexToBytes(p), publicKey: hexToBytes(k) };
  } catch {
    return null;
  }
}

function clearKeys(): void {
  try {
    sessionStorage.removeItem(VAULT_KEYS_STORAGE);
  } catch {
    // ignore
  }
}

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
  // The unwrapped per-user keys (ADR 0011 userKey + ADR 0013 X25519 private key),
  // RAM only, never persisted. Set after login/bootstrap; null after a token-only
  // resume (no password) — a later phase lets the trusted local server hold them.
  userKey: Uint8Array | null;
  privateKey: Uint8Array | null;
  publicKey: Uint8Array | null; // the user's own X25519 public key (from the vault)
  loading: boolean;
  error: string | null;
  // Boot-time connection failure (server unreachable / starting) → a full-page state with
  // auto-retry, instead of an endless "Loading…". Null once the mode loads.
  connError: HttpErrorKind | null;
  // A mid-session 401 signed us out — show the "session expired" notice on the sign-in screen.
  sessionExpired: boolean;
  loadMode: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  bootstrap: (username: string, password: string) => Promise<void>;
  /** Self-service signup (ADR 0015): generate own keys, create the account, sign in. An optional
   *  invitation token redeems an enrollment recipe (and works even when open registration is off). */
  register: (username: string, password: string, token?: string) => Promise<void>;
  /** Set my own password (first login / after reset): fresh vault + keypair, clears the flag. */
  changePassword: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useServerSession = create<ServerSessionState>((set, get) => ({
  mode: null,
  user: null,
  userKey: null,
  privateKey: null,
  publicKey: null,
  loading: false,
  error: null,
  connError: null,
  sessionExpired: false,

  loadMode: async () => {
    let mode: ServerMode;
    try {
      mode = await Backend.Server.mode();
    } catch (e) {
      // Couldn't learn the mode → the app can't boot. Surface a clear state (unreachable /
      // starting) with auto-retry instead of an endless spinner.
      set({ connError: e instanceof RiteHttpError ? e.kind : 'unreachable' });
      return;
    }
    set({ mode, connError: null });
    // Resume an existing session if we still hold a token.
    if (mode.accounts && getSessionToken()) {
      try {
        const { user } = await Backend.Server.me();
        set({ user });
        // If key persistence is enabled (default) and we stashed the keys this tab,
        // restore them so a reload skips the re-login prompt. Otherwise drop them.
        if (mode.sessionPersistence !== false) {
          const keys = restoreKeys();
          if (keys) {
            await syncLocalVault(keys.userKey);
            set({ userKey: keys.userKey, privateKey: keys.privateKey, publicKey: keys.publicKey });
          }
        } else {
          clearKeys();
        }
      } catch {
        clearSessionToken();
        clearKeys();
        set({ user: null, userKey: null, privateKey: null, publicKey: null });
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
      // Unwrap the per-user keys with the password (never sent).
      const keys = vault
        ? await unwrapVaultKey(
            password,
            vault.kdfMasterSalt,
            vault.protectedUserKey,
            vault.protectedPrivateKey,
          )
        : null;
      await syncLocalVault(keys?.userKey ?? null);
      const publicKey = vault ? hexToBytes(vault.publicKey) : null;
      // Persist the unwrapped keys for this tab if the server allows it (default on).
      if (keys && publicKey && get().mode?.sessionPersistence !== false) {
        persistKeys({ userKey: keys.userKey, privateKey: keys.privateKey, publicKey });
      } else {
        clearKeys();
      }
      set({
        user,
        userKey: keys?.userKey ?? null,
        privateKey: keys?.privateKey ?? null,
        publicKey,
        loading: false,
        sessionExpired: false,
      });
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
      const { token, user } = await Backend.Server.bootstrap(username, salt, DEFAULT_KDF_PARAMS, authHash, {
        masterSalt: vaultKey.masterSaltHex,
        protectedUserKey: vaultKey.protectedUserKey,
        publicKey: vaultKey.publicKeyHex,
        protectedPrivateKey: vaultKey.protectedPrivateKey,
      });
      setSessionToken(token);
      await syncLocalVault(vaultKey.userKey);
      const mode = get().mode;
      const publicKey = hexToBytes(vaultKey.publicKeyHex);
      if (mode?.sessionPersistence !== false) {
        persistKeys({ userKey: vaultKey.userKey, privateKey: vaultKey.privateKey, publicKey });
      } else {
        clearKeys();
      }
      set({
        user,
        userKey: vaultKey.userKey,
        privateKey: vaultKey.privateKey,
        publicKey,
        loading: false,
        mode: mode ? { ...mode, needsBootstrap: false } : mode,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to create the admin', loading: false });
      throw e;
    }
  },

  register: async (username, password, inviteToken) => {
    set({ loading: true, error: null });
    try {
      const salt = randomSaltHex();
      // Same client-side crypto as bootstrap: derive the auth hash + generate a fresh vault
      // key/keypair (both Argon2id) in parallel. The server never sees the password.
      const [authHash, vaultKey] = await Promise.all([
        deriveAuthHash(password, salt, DEFAULT_KDF_PARAMS),
        createVaultKey(password),
      ]);
      const { token, user } = await Backend.Server.register(
        username,
        salt,
        DEFAULT_KDF_PARAMS,
        authHash,
        {
          masterSalt: vaultKey.masterSaltHex,
          protectedUserKey: vaultKey.protectedUserKey,
          publicKey: vaultKey.publicKeyHex,
          protectedPrivateKey: vaultKey.protectedPrivateKey,
        },
        inviteToken,
      );
      setSessionToken(token);
      await syncLocalVault(vaultKey.userKey);
      const mode = get().mode;
      const publicKey = hexToBytes(vaultKey.publicKeyHex);
      if (mode?.sessionPersistence !== false) {
        persistKeys({ userKey: vaultKey.userKey, privateKey: vaultKey.privateKey, publicKey });
      } else {
        clearKeys();
      }
      set({
        user,
        userKey: vaultKey.userKey,
        privateKey: vaultKey.privateKey,
        publicKey,
        loading: false,
        sessionExpired: false,
      });
    } catch (e) {
      const msg =
        e instanceof RiteHttpError && e.status === 409
          ? 'That username is already taken'
          : e instanceof RiteHttpError && e.status === 429
            ? 'Too many sign-up attempts — please try again in a few minutes'
            : e instanceof RiteHttpError && e.status === 403
              ? inviteToken
                ? 'That invitation is invalid or has expired'
                : 'Registration is closed on this server'
              : e instanceof Error
                ? e.message
                : 'Failed to create your account';
      set({ error: msg, loading: false });
      throw e;
    }
  },

  changePassword: async (password) => {
    set({ loading: true, error: null });
    try {
      const salt = randomSaltHex();
      const [authHash, vaultKey] = await Promise.all([
        deriveAuthHash(password, salt, DEFAULT_KDF_PARAMS),
        createVaultKey(password), // fresh keypair → the old (admin-set) password becomes useless
      ]);
      await Backend.Server.changePassword(salt, DEFAULT_KDF_PARAMS, authHash, {
        masterSalt: vaultKey.masterSaltHex,
        protectedUserKey: vaultKey.protectedUserKey,
        publicKey: vaultKey.publicKeyHex,
        protectedPrivateKey: vaultKey.protectedPrivateKey,
      });
      await syncLocalVault(vaultKey.userKey);
      const publicKey = hexToBytes(vaultKey.publicKeyHex);
      if (get().mode?.sessionPersistence !== false) {
        persistKeys({ userKey: vaultKey.userKey, privateKey: vaultKey.privateKey, publicKey });
      } else {
        clearKeys();
      }
      const current = get().user;
      set({
        user: current ? { ...current, mustChangePassword: false } : current,
        userKey: vaultKey.userKey,
        privateKey: vaultKey.privateKey,
        publicKey,
        loading: false,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to set the password', loading: false });
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
    clearKeys();
    set({ user: null, userKey: null, privateKey: null, publicKey: null });
  },

  clearError: () => set({ error: null }),
}));

// A mid-session 401 (token revoked/expired) → sign out and flag the session-expired notice.
setUnauthorizedHandler(() => {
  const s = useServerSession.getState();
  if (!s.user) return; // already signed out
  clearSessionToken();
  clearKeys();
  set_session_expired();
});
function set_session_expired() {
  useServerSession.setState({
    user: null,
    userKey: null,
    privateKey: null,
    publicKey: null,
    sessionExpired: true,
  });
}
