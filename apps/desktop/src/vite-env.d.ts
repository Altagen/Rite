/// <reference types="vite/client" />

/** The context a native window was opened for (ADR 0014 phase 4). `hub` is the
 * launch window: it shows the context picker before any context is chosen. */
interface RiteNativeContext {
  kind: 'local' | 'server' | 'hub';
  id?: string | null;
  url?: string | null;
  label?: string | null;
  /** For a local window (multi-vault, ADR 0014): the vault `.db` this window opened. */
  path?: string | null;
}

/** A local vault the shell knows about (multi-vault roster, ADR 0014). */
interface RiteNativeVault {
  path: string;
  label: string;
  icon?: string;
}

interface Window {
  /**
   * Bearer token injected by the desktop shell (wry) so the frontend can
   * authenticate to the loopback rite-server. Absent in browser/dev mode.
   */
  __RITE_TOKEN__?: string;
  /**
   * Which context this native window should show (injected by the shell). The
   * local window gets `{kind:'local'}`; a server window carries the roster entry.
   */
  __RITE_CONTEXT__?: RiteNativeContext;
  /** wry IPC bridge: the frontend asks the shell to open a context in a window. */
  ipc?: { postMessage: (message: string) => void };
  /** Local vaults the shell knows about (multi-vault roster, ADR 0014). */
  __RITE_VAULTS__?: RiteNativeVault[];
}

declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.svg' {
  const value: string;
  export default value;
}
