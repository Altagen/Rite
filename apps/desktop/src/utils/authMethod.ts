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
  passphrase: string;
  /** SHA256 fingerprint of a pinned agent identity; '' ⇒ offer all. */
  agentIdentity: string;
  agentForward: boolean;
}

export function makeAuthState(partial?: Partial<AuthState>): AuthState {
  return {
    authType: 'password',
    password: '',
    keyPath: '',
    passphrase: '',
    agentIdentity: '',
    agentForward: false,
    ...partial,
  };
}

/** Build the backend auth method (mirrors the Rust `AuthMethod` enum). */
export function toAuthMethodInput(s: AuthState): AuthMethodInput {
  switch (s.authType) {
    case 'publicKey':
      return { type: 'publicKey', keyPath: s.keyPath, ...(s.passphrase ? { passphrase: s.passphrase } : {}) };
    case 'agent':
      return { type: 'agent', ...(s.agentIdentity ? { identity: s.agentIdentity } : {}), forward: s.agentForward };
    case 'password':
    default:
      return { type: 'password', password: s.password };
  }
}
