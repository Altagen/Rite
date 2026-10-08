//! Anonymous sealed boxes for team-key sharing (ADR 0013).
//!
//! "Wrap a symmetric key to a recipient's public key" = a libsodium
//! `crypto_box_seal` (X25519 + XSalsa20-Poly1305, ephemeral sender). Byte-
//! compatible with the browser's `libsodium-wrappers` (pinned by a cross-impl
//! test). Used to seal a team key to each member's public key; the sealed bytes
//! travel base64-encoded.

use anyhow::{Result, anyhow};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
// dryoc 2.0 is a set of renames, not a change of primitive: the stack-allocated keypair
// alias is now `StackKeyPair` (the generic `KeyPair<PK, SK>` it aliases is what
// `open_to_vec` takes), `unseal_to_vec` is now `open_to_vec`, and `gen` is now
// `generate` — which also retires the raw identifier that `gen` being reserved in
// edition 2024 forced on us. It is still libsodium's `crypto_box_seal` underneath, so
// the bytes on the wire are unchanged; the pinned browser-produced box in the tests
// below is what proves that rather than assumes it.
use dryoc::dryocbox::{DryocBox, PublicKey, StackKeyPair};

/// A fresh X25519 keypair, returned as (public, secret) raw bytes.
pub fn generate_keypair() -> (Vec<u8>, Vec<u8>) {
    let kp = StackKeyPair::generate();
    (kp.public_key.to_vec(), kp.secret_key.to_vec())
}

/// Seal `plaintext` to `recipient_public` (raw 32 bytes) → base64 sealed box.
pub fn seal(recipient_public: &[u8], plaintext: &[u8]) -> Result<String> {
    let pk = PublicKey::try_from(recipient_public).map_err(|_| anyhow!("bad public key"))?;
    let sealed = DryocBox::seal_to_vecbox(plaintext, &pk).map_err(|e| anyhow!("seal: {e}"))?;
    Ok(B64.encode(sealed.to_vec()))
}

/// Open a base64 sealed box with the recipient's keypair (raw bytes).
pub fn open(public: &[u8], secret: &[u8], sealed_b64: &str) -> Result<Vec<u8>> {
    let bytes = B64
        .decode(sealed_b64)
        .map_err(|e| anyhow!("bad base64: {e}"))?;
    let sealed = DryocBox::from_sealed_bytes(&bytes).map_err(|e| anyhow!("bad sealed box: {e}"))?;
    let kp = StackKeyPair::from_slices(public, secret).map_err(|_| anyhow!("bad keypair"))?;
    sealed
        .open_to_vec(&kp)
        .map_err(|_| anyhow!("unseal failed (wrong key or tampered)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let (pk, sk) = generate_keypair();
        let sealed = seal(&pk, b"team-key-bytes").unwrap();
        assert_eq!(open(&pk, &sk, &sealed).unwrap(), b"team-key-bytes");
    }

    #[test]
    fn wrong_key_fails() {
        let (pk, _) = generate_keypair();
        let (_, other_sk) = generate_keypair();
        let (other_pk, _) = generate_keypair();
        let sealed = seal(&pk, b"secret").unwrap();
        assert!(open(&other_pk, &other_sk, &sealed).is_err());
    }

    fn hex(h: &str) -> Vec<u8> {
        (0..h.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Cross-impl: open a sealed box produced by the browser's `libsodium-wrappers`
    /// (see `e2e/sealbox-check.mjs`) with the pinned keypair. Proves Rust (dryoc)
    /// and the browser agree on `crypto_box_seal` byte-for-byte (the JS→Rust
    /// direction; the Rust→JS direction is asserted in the check script).
    #[test]
    fn opens_a_browser_sealed_box() {
        let pk = hex("f1e708d2d28121dae7e360cbcd9764e2a49f3181f63f74d11b119e9ab1882435");
        let sk = hex("9369583ab7fb00c0422863576d238369a693b1039b534fac19af628fa4bb704e");
        // Produced by libsodium-wrappers sealing "rite-sealed-secret" to pk.
        let sealed_j = "XREv/mUQRz15xBBTuiyEGeL4MedHBMi8WoSeKY7oLUAfoBdb15bcTUa1Gbe9dSywY/E4N8RSh67m1ySERmgurty8";
        assert_eq!(open(&pk, &sk, sealed_j).unwrap(), b"rite-sealed-secret");
    }
}
