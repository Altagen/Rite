/**
 * Shared authentication state for the connection forms (New machine + Quick SSH).
 *
 * Kept out of the component file so React Fast Refresh stays happy, and so the
 * UI state ↔ backend `AuthMethodInput` mapping lives in one place.
 */
import type { AuthType, AuthMethodInput } from '../store/connectionsStore';

export interface AuthState {
  authType: AuthType;
  password: string;
  keyPath: string;
  /**
   * A private key's text, when the key travels with the record instead of being named on
   * disk (ADR 0024). Set where SSH runs somewhere else than this machine — a browser, or a
   * desktop pointed at a server — and read by `FileReader` in the page, never uploaded.
   */
  key: string;
  /** The file the key was read from, to show which key this is. Not sent, not stored. */
  keyName: string;
  passphrase: string;
  /**
   * Whether the passphrase is written to the record (ADR 0024 §4). Starts false: the
   * careful default is the member's, and an instance may remove the choice entirely.
   */
  rememberPassphrase: boolean;
  /** SHA256 fingerprint of a pinned agent identity; '' ⇒ offer all. */
  agentIdentity: string;
  agentForward: boolean;
}

/**
 * The method a saved machine authenticates with, as the form's radio names it.
 *
 * `vaultKey` and `publicKey` are one choice to a reader — "a key" — and differ only in
 * where the key lives, which the form decides from the context rather than from what was
 * stored. Anything unknown (a record from a newer Rite) falls back to a password rather
 * than crashing the form, and leaves the stored method untouched if nothing is typed.
 */
export function storedAuthType(connection?: { authType?: string } | null): AuthType {
  switch (connection?.authType) {
    case 'publicKey':
    case 'vaultKey':
      return 'publicKey';
    case 'agent':
      return 'agent';
    default:
      return 'password';
  }
}

export function makeAuthState(partial?: Partial<AuthState>): AuthState {
  return {
    authType: 'password',
    password: '',
    keyPath: '',
    key: '',
    keyName: '',
    passphrase: '',
    rememberPassphrase: false,
    agentIdentity: '',
    agentForward: false,
    ...partial,
  };
}

/**
 * Build the backend auth method (mirrors the Rust `AuthMethod` enum).
 *
 * A key read from a file becomes `vaultKey` and travels inside the record; a key named on
 * disk stays `publicKey` and is read by whichever process opens SSH. The passphrase is
 * omitted unless this person asked for it to be kept — a passphrase left out is asked for
 * at connect time and never written (ADR 0024 §4).
 */
export function toAuthMethodInput(s: AuthState): AuthMethodInput {
  const passphrase = s.rememberPassphrase && s.passphrase ? { passphrase: s.passphrase } : {};
  switch (s.authType) {
    case 'publicKey':
      return s.key
        ? { type: 'vaultKey', key: s.key, ...passphrase }
        : { type: 'publicKey', keyPath: s.keyPath, ...passphrase };
    case 'agent':
      return {
        type: 'agent',
        ...(s.agentIdentity ? { identity: s.agentIdentity } : {}),
        forward: s.agentForward,
      };
    case 'password':
    default:
      return { type: 'password', password: s.password };
  }
}
