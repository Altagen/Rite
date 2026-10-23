/**
 * Anonymous sealed boxes for team-key sharing (ADR 0013) — browser/webview side.
 *
 * libsodium `crypto_box_seal` (X25519 + XSalsa20-Poly1305), byte-compatible with
 * the Rust `rite_crypto::sealbox` (dryoc), pinned by `e2e/sealbox-check.mjs`.
 * Sealed bytes travel base64 (standard, padded — matching Rust's base64 STANDARD).
 */

/**
 * Loaded on demand, not at startup.
 *
 * libsodium is a WASM blob and the largest single thing the bundle carried, and it is
 * needed on exactly one path: a shared server's key sharing (ADR 0013). A local vault
 * never touches it, and neither does anyone who has not signed in yet — so making it part
 * of first paint cost every reader of the page for something most of them never run.
 *
 * Every export here was already `async` and already awaited `sodium.ready`, so the import
 * moves inside without changing a single call site. Memoised: the second caller awaits the
 * same promise rather than a second fetch.
 */
let loading: Promise<typeof import('libsodium-wrappers').default> | null = null;
async function sodiumReady() {
  loading ??= import('libsodium-wrappers').then(async (m) => {
    await m.default.ready;
    return m.default;
  });
  return loading;
}

/** A fresh X25519 keypair (raw bytes). */
export async function generateKeypair(): Promise<{
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}> {
  const sodium = await sodiumReady();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

/** Seal `plaintext` to `recipientPublic` (raw 32 bytes) → base64 sealed box. */
export async function seal(recipientPublic: Uint8Array, plaintext: Uint8Array): Promise<string> {
  const sodium = await sodiumReady();
  return b64encode(sodium.crypto_box_seal(plaintext, recipientPublic));
}

/** Open a base64 sealed box with the recipient's keypair (raw bytes). */
export async function open(
  publicKey: Uint8Array,
  secretKey: Uint8Array,
  sealedB64: string,
): Promise<Uint8Array> {
  const sodium = await sodiumReady();
  return sodium.crypto_box_seal_open(b64decode(sealedB64), publicKey, secretKey);
}

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
