//! Per-user zero-knowledge vault crypto (ADR 0011).
//!
//! The **client** holds the keys; the remote server only ever stores ciphertext.
//! Key hierarchy, all derived client-side from the login password:
//!
//! - `masterKey`  = Argon2id(password, master-salt) → 32 bytes (never sent).
//! - `userKey`    = random 32 bytes, generated once per account.
//! - `protectedUserKey` = AES-256-GCM(masterKey, userKey), stored on the server.
//! - vault items  = AES-256-GCM(userKey, plaintext).
//!
//! AES-256-GCM (not the offline vault's ChaCha20-Poly1305) so the browser can use
//! WebCrypto natively; this module is byte-compatible with the TS implementation
//! in `apps/desktop/src/utils/vaultCrypto.ts` (pinned by a cross-impl test).
//!
//! Wire format for an encrypted value: `v1.<b64url(iv)>.<b64url(ciphertext‖tag)>`
//! with a 12-byte GCM IV and the 16-byte tag appended to the ciphertext.

// aes-gcm 0.11 stopped re-exporting `OsRng`; random material now comes from the
// `Generate` trait, which draws on the system RNG and panics if it fails — the same
// contract `OsRng.fill_bytes` had, so nothing about the failure mode changes. The
// algorithm, the 12-byte IV and the appended tag are all untouched, which is what
// keeps the wire format below byte-compatible with the TS side.
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, Generate, KeyInit},
};
use anyhow::{Result, anyhow};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};

/// Length of the symmetric keys (master key, user key).
pub const KEY_LEN: usize = 32;
const IV_LEN: usize = 12;

/// Argon2id params for the master key — identical to the ADR 0010 auth-hash KDF
/// (m=19456 KiB, t=2, p=1, 32-byte output), matching the browser `hash-wasm`.
const KDF_MEM: u32 = 19456;
const KDF_ITER: u32 = 2;
const KDF_PAR: u32 = 1;

/// Derive the 32-byte master key from a password + salt (Argon2id). The salt MUST
/// be distinct from the auth-hash salt so the encryption key is not a sibling of
/// the value sent to the server at login.
pub fn derive_master_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN]> {
    let params = argon2::Params::new(KDF_MEM, KDF_ITER, KDF_PAR, Some(KEY_LEN))
        .map_err(|e| anyhow!("argon2 params: {e}"))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| anyhow!("argon2 derive: {e}"))?;
    Ok(out)
}

/// Generate a fresh random user key.
pub fn generate_user_key() -> [u8; KEY_LEN] {
    <[u8; KEY_LEN]>::generate()
}

/// Encrypt `plaintext` under `key` (AES-256-GCM), returning the `v1.iv.ct` string.
pub fn encrypt_string(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<String> {
    let iv = <[u8; IV_LEN]>::generate();
    encrypt_with_iv(key, &iv, plaintext)
}

/// Deterministic variant with a caller-supplied IV — for cross-impl test vectors
/// only. Reusing an IV under the same key breaks GCM; never do it in production.
pub fn encrypt_with_iv(key: &[u8; KEY_LEN], iv: &[u8; IV_LEN], plaintext: &[u8]) -> Result<String> {
    let cipher = Aes256Gcm::new(key.into());
    let ct = cipher
        .encrypt(&Nonce::from(*iv), plaintext)
        .map_err(|e| anyhow!("aes-gcm encrypt: {e}"))?;
    Ok(format!("v1.{}.{}", B64.encode(iv), B64.encode(ct)))
}

/// Decrypt a `v1.iv.ct` string produced by [`encrypt_string`].
pub fn decrypt_string(key: &[u8; KEY_LEN], token: &str) -> Result<Vec<u8>> {
    let mut parts = token.split('.');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("v1"), Some(iv_b64), Some(ct_b64), None) => {
            let iv = B64.decode(iv_b64).map_err(|e| anyhow!("bad iv: {e}"))?;
            let ct = B64
                .decode(ct_b64)
                .map_err(|e| anyhow!("bad ciphertext: {e}"))?;
            let nonce = Nonce::try_from(&iv[..]).map_err(|_| anyhow!("bad iv length"))?;
            let cipher = Aes256Gcm::new(key.into());
            cipher
                .decrypt(&nonce, ct.as_ref())
                .map_err(|_| anyhow!("aes-gcm decrypt failed (wrong key or tampered)"))
        }
        _ => Err(anyhow!("malformed encrypted value")),
    }
}

/// Wrap (encrypt) the user key with the master key → the stored `protectedUserKey`.
pub fn wrap_user_key(master_key: &[u8; KEY_LEN], user_key: &[u8; KEY_LEN]) -> Result<String> {
    encrypt_string(master_key, user_key)
}

/// Unwrap the stored `protectedUserKey` back to the 32-byte user key.
pub fn unwrap_user_key(master_key: &[u8; KEY_LEN], protected: &str) -> Result<[u8; KEY_LEN]> {
    let bytes = decrypt_string(master_key, protected)?;
    bytes
        .try_into()
        .map_err(|_| anyhow!("unwrapped user key has wrong length"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn round_trip() {
        let key = generate_user_key();
        let token = encrypt_string(&key, b"top secret").unwrap();
        assert_eq!(decrypt_string(&key, &token).unwrap(), b"top secret");
    }

    #[test]
    fn wrong_key_fails() {
        let token = encrypt_string(&generate_user_key(), b"x").unwrap();
        assert!(decrypt_string(&generate_user_key(), &token).is_err());
    }

    #[test]
    fn user_key_wrap_round_trip() {
        let master = derive_master_key("pw", b"saltsaltsalt").unwrap();
        let user_key = generate_user_key();
        let protected = wrap_user_key(&master, &user_key).unwrap();
        assert_eq!(unwrap_user_key(&master, &protected).unwrap(), user_key);
    }

    /// Cross-impl vectors — MUST match `apps/desktop/src/utils/vaultCrypto.ts`
    /// (see `e2e/vault-check.mjs`). Pins the Argon2id master key and an AES-256-GCM
    /// ciphertext with a fixed IV so both implementations are byte-identical.
    #[test]
    fn cross_impl_vectors() {
        let master = derive_master_key("correct horse battery staple", b"rite-master-salt");
        assert_eq!(
            hex(&master.unwrap()),
            "e55975c388c8b9fc9109cab6d6911195edc0b11ae937efcdebbc599f189be4df"
        );
        let key = [7u8; KEY_LEN];
        let iv = [0u8; IV_LEN];
        let token = encrypt_with_iv(&key, &iv, b"rite-secret").unwrap();
        assert_eq!(decrypt_string(&key, &token).unwrap(), b"rite-secret");
        // The pinned token both impls must agree on:
        assert_eq!(
            token,
            "v1.AAAAAAAAAAAAAAAA.E7HQ19bhbouTYvuw6lZG9L8YnnKYj2V5ZPNN"
        );
    }
}
