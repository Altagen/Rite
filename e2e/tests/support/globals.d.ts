/**
 * The UX mock's globals, for `page.evaluate` in mock.spec.ts.
 *
 * design/mock is plain scripts on a page — no modules, no types — so the functions the
 * spec drives it through are declared here rather than cast away at each call site.
 * Kept to what the spec actually uses.
 */
declare function openMachine(name: string): void;
declare function dlgBoard(collection: unknown): void;
declare function find(id: string): unknown;
/** ADR 0019: the shared precedence rule, in machine.js. */
declare function probeVerdict(): { allowed: true } | { allowed: false; by: 'server' | 'you' };
declare const STATE: {
  ctx?: { type: string; name?: string };
  dashPolicy: { webui: boolean; clients: boolean; minInterval: number };
  machineProbes: boolean;
};
