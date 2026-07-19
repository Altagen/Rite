/// <reference types="vite/client" />

/** The context a native window was opened for (ADR 0014 phase 4). */
interface RiteNativeContext {
  kind: 'local' | 'server';
  id?: string | null;
  url?: string | null;
  label?: string | null;
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
