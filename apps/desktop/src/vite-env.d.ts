/// <reference types="vite/client" />

interface Window {
  /**
   * Bearer token injected by the desktop shell (wry) so the frontend can
   * authenticate to the loopback rite-server. Absent in browser/dev mode.
   */
  __RITE_TOKEN__?: string;
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
