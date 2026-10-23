/**
 * The weakest key derivation this client will perform, whatever it is asked for (ADR 0029).
 *
 * `POST /api/server/prelogin` hands back the salt AND the Argon2 parameters, read from the
 * account's row, and the client derived with them verbatim. So a server that lies —
 * compromised, or hostile from the start — could answer `mem: 8, iter: 1` and receive an
 * auth hash that costs nothing to brute-force back to the password offline. The vault's own
 * key uses a FIXED local KDF (`vaultCrypto.ts`), so the blobs are not handed over directly;
 * but the password is what derives that key, so recovering it is recovering the vault.
 *
 * That is the server putting itself in a position to learn a secret, which is the one thing
 * ADR 0011 says it must not be able to do. A floor is the whole mitigation, and it has to
 * live on the CLIENT: a parameter the server chose cannot be policed by the server.
 *
 * Its own module, importing nothing: `e2e/kdf-floor-check.mjs` loads it as it ships, and a
 * policy with no dependencies is a policy that cannot fail to load.
 */

export interface KdfParams {
  mem: number; // memory in KiB
  iter: number; // iterations
  par: number; // parallelism
}

/**
 * Equal to what this client has always registered with, so no account it created is locked
 * out by the floor. Below it would leave a gap nobody notices; above it would lock those
 * accounts out of their own vaults.
 */
export const MIN_KDF_PARAMS: KdfParams = { mem: 19456, iter: 2, par: 1 };

/** True when every parameter meets the floor. */
export function kdfIsStrongEnough(params: KdfParams): boolean {
  return (
    params.mem >= MIN_KDF_PARAMS.mem &&
    params.iter >= MIN_KDF_PARAMS.iter &&
    params.par >= MIN_KDF_PARAMS.par
  );
}

/**
 * Thrown rather than returned: every caller of the derivation proceeds to send the result,
 * and none of them may.
 *
 * The field is declared rather than taken as a constructor parameter property, because the
 * check loads this module directly and Node's type stripping does not implement those.
 */
export class WeakKdfError extends Error {
  readonly params: KdfParams;

  constructor(params: KdfParams) {
    super(
      `the server asked for a key derivation weaker than this client allows ` +
        `(memory ${params.mem} KiB, ${params.iter} pass(es), parallelism ${params.par}; ` +
        `minimum ${MIN_KDF_PARAMS.mem}/${MIN_KDF_PARAMS.iter}/${MIN_KDF_PARAMS.par})`,
    );
    this.name = 'WeakKdfError';
    this.params = params;
  }
}
