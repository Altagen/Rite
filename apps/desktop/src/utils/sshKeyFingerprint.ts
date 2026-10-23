/**
 * The fingerprint of a private key, read in the page (ADR 0028 §6).
 *
 * A record that carries a key used to show an empty file input, which reads as *nothing was
 * saved*. What it needs is the key's identity — the same string `ssh-keygen -lf` prints, so
 * it can be compared against an `authorized_keys` line.
 *
 * Nothing is stored and nothing is sent: an OpenSSH-format key holds its PUBLIC half in the
 * clear, even when the private half is encrypted by a passphrase, so this is a binary parse
 * and a SHA-256. A key in another format (PKCS#8, traditional RSA) does not hand its public
 * half over, and gets `null` — the row then says a key is stored without naming it, which is
 * worse than a fingerprint and much better than guessing.
 *
 * The file layout, from PROTOCOL.key:
 *
 *   "openssh-key-v1\0" | ciphername | kdfname | kdfoptions | nkeys | pubkey[0] | …
 *
 * where each field after the magic is a uint32 length followed by that many bytes. `pubkey`
 * is the wire-format public key, which is exactly what OpenSSH fingerprints.
 */

const MAGIC = 'openssh-key-v1\0';

export interface KeyIdentity {
  /** The algorithm as the key names itself: `ssh-ed25519`, `ecdsa-sha2-nistp256`, … */
  algorithm: string;
  /** `SHA256:` followed by unpadded base64, as `ssh-keygen -l` writes it. */
  fingerprint: string;
}

/** The base64 body between the PEM header and footer, or null if there is no OpenSSH key. */
function pemBody(text: string): string | null {
  const match = text.match(
    /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/,
  );
  return match ? match[1].replace(/\s+/g, '') : null;
}

function decodeBase64(body: string): Uint8Array | null {
  try {
    const raw = atob(body);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * A cursor over the length-prefixed fields, refusing anything that runs off the end.
 *
 * Fields written out rather than declared as constructor parameters: `e2e/key-identity-check.mjs`
 * loads this module as it ships, and Node's type stripping does not implement parameter
 * properties.
 */
class Reader {
  private at: number;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.at = 0;
  }

  uint32(): number | null {
    if (this.at + 4 > this.bytes.length) return null;
    const b = this.bytes;
    const n =
      b[this.at] * 0x1000000 + b[this.at + 1] * 0x10000 + b[this.at + 2] * 0x100 + b[this.at + 3];
    this.at += 4;
    return n;
  }

  /** A `string` in the SSH sense: a uint32 length and that many bytes. */
  field(): Uint8Array | null {
    const len = this.uint32();
    // A length larger than what is left is a truncated or non-OpenSSH file, not a key with
    // a very long field: refuse rather than read past the buffer.
    if (len === null || len < 0 || this.at + len > this.bytes.length) return null;
    const slice = this.bytes.subarray(this.at, this.at + len);
    this.at += len;
    return slice;
  }

  skip(count: number): boolean {
    for (let i = 0; i < count; i++) {
      if (this.field() === null) return false;
    }
    return true;
  }
}

/** Unpadded base64 of a byte string, which is how OpenSSH prints a fingerprint. */
function base64(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/=+$/, '');
}

/**
 * The key's algorithm and fingerprint, or null when the text is not an OpenSSH private key.
 *
 * Never throws: it is handed a file somebody chose, and a form that cannot name a key must
 * still render.
 */
export async function keyIdentity(pem: string): Promise<KeyIdentity | null> {
  const body = pemBody(pem);
  if (!body) return null;
  const bytes = decodeBase64(body);
  if (!bytes) return null;

  const magic = MAGIC.split('').map((c) => c.charCodeAt(0));
  if (bytes.length < magic.length) return null;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return null;
  }

  const reader = new Reader(bytes.subarray(magic.length));
  // ciphername, kdfname, kdfoptions — read and dropped: an encrypted key still publishes
  // its public half, which is the whole reason this works without a passphrase.
  if (!reader.skip(3)) return null;
  const count = reader.uint32();
  // One key per file in practice; zero would leave nothing to fingerprint.
  if (count === null || count < 1) return null;
  const pub = reader.field();
  if (!pub || pub.length === 0) return null;

  // The algorithm is the first field INSIDE the public blob, and the blob as a whole is
  // what gets hashed — not the algorithm, and not the base64 text.
  const algorithmBytes = new Reader(pub).field();
  if (!algorithmBytes) return null;
  const algorithm = new TextDecoder().decode(algorithmBytes);
  if (!/^[\x20-\x7e]+$/.test(algorithm)) return null;

  // A copy, because `subarray` borrows the decoded buffer and WebCrypto wants a plain
  // `ArrayBuffer` behind what it hashes.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(pub).slice().buffer);
  return { algorithm, fingerprint: `SHA256:${base64(new Uint8Array(digest))}` };
}
