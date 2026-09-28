//! Collection crypto, core side (ADR 0016 / ADR 0018).
//!
//! A collection has two symmetric keys (ADR 0016 split-key model): `meta_key`
//! encrypts the `{name, color}` header, `items_key` the machines and the board.
//! They are independent so a name can be escrowed without the credentials.
//!
//! How a key is *protected* depends on the context (ADR 0018):
//!
//! - **Server** — sealed to each member's X25519 public key (`rite_crypto::sealbox`),
//!   so only members can open it and the server never holds a key.
//! - **Local vault** — there are no members to seal to, so the key is wrapped with
//!   the vault's master key (`rite_crypto::vault::wrap_user_key`). One implicit
//!   local user, no recipients.
//!
//! Field encryption itself is identical in both cases, and identical to the browser:
//! AES-256-GCM over `serde_json`, wire format `v1.<b64url(iv)>.<b64url(ct‖tag)>`.
//! `rite_crypto::vault` is already byte-compatible with
//! `apps/desktop/src/utils/vaultCrypto.ts`; this module only adds the JSON layer
//! that `collectionCrypto.ts` puts on top, so a blob written by either side is
//! readable by the other. `e2e/collection-crypto-check.mjs` pins that both ways.

use anyhow::Result;
use rite_crypto::vault::{self, KEY_LEN};
use serde::{Serialize, de::DeserializeOwned};

/// The pair of keys a collection is created with.
#[derive(Debug, Clone)]
pub struct CollectionKeys {
    /// Encrypts the `{name, color}` header.
    pub meta_key: [u8; KEY_LEN],
    /// Encrypts machines and the board.
    pub items_key: [u8; KEY_LEN],
}

/// Generate a fresh pair of collection keys.
pub fn generate_collection_keys() -> CollectionKeys {
    CollectionKeys {
        meta_key: vault::generate_user_key(),
        items_key: vault::generate_user_key(),
    }
}

/// Encrypt a value (a header, an item record, a board) into an opaque blob.
///
/// Mirrors `encryptCollectionField` in the browser: JSON, then AES-256-GCM.
pub fn encrypt_field<T: Serialize>(key: &[u8; KEY_LEN], value: &T) -> Result<String> {
    vault::encrypt_string(key, &serde_json::to_vec(value)?)
}

/// Decrypt a blob back into its value. Mirrors `decryptCollectionField`.
pub fn decrypt_field<T: DeserializeOwned>(key: &[u8; KEY_LEN], blob: &str) -> Result<T> {
    Ok(serde_json::from_slice(&vault::decrypt_string(key, blob)?)?)
}

/// Protect a collection key for a **local vault**: wrapped with the master key
/// rather than sealed to a recipient, since a local collection has no members.
pub fn wrap_key_local(master_key: &[u8; KEY_LEN], key: &[u8; KEY_LEN]) -> Result<String> {
    vault::wrap_user_key(master_key, key)
}

/// Recover a locally-wrapped collection key.
pub fn unwrap_key_local(master_key: &[u8; KEY_LEN], protected: &str) -> Result<[u8; KEY_LEN]> {
    vault::unwrap_user_key(master_key, protected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Header {
        name: String,
        color: Option<String>,
    }

    #[test]
    fn field_round_trips_through_json_and_aes() {
        let keys = generate_collection_keys();
        let header = Header {
            name: "Home lab".into(),
            color: Some("#9ece6a".into()),
        };
        let blob = encrypt_field(&keys.meta_key, &header).unwrap();
        // The envelope is the shared wire format, not something bespoke.
        assert!(blob.starts_with("v1."), "unexpected envelope: {blob}");
        // Nothing readable leaks into the blob.
        assert!(!blob.contains("Home lab"));
        let back: Header = decrypt_field(&keys.meta_key, &blob).unwrap();
        assert_eq!(back, header);
    }

    #[test]
    fn the_two_keys_are_independent() {
        let keys = generate_collection_keys();
        assert_ne!(keys.meta_key, keys.items_key);
        let blob = encrypt_field(&keys.items_key, &"a machine").unwrap();
        // Holding the metaKey (the name) must not open the items.
        assert!(decrypt_field::<String>(&keys.meta_key, &blob).is_err());
    }

    #[test]
    fn a_local_key_is_recovered_with_the_master_key() {
        let master = vault::generate_user_key();
        let keys = generate_collection_keys();
        let protected = wrap_key_local(&master, &keys.items_key).unwrap();
        assert_eq!(
            unwrap_key_local(&master, &protected).unwrap(),
            keys.items_key
        );

        // A different master key cannot: the vault's password is the only way in.
        let other = vault::generate_user_key();
        assert!(unwrap_key_local(&other, &protected).is_err());
    }

    /// Pinned against the browser implementation — `e2e/collection-crypto-check.mjs`
    /// produces this blob with `encryptCollectionField` and asserts the reverse.
    /// If either side's envelope changes, one of the two fails.
    #[test]
    fn cross_impl_vector_from_the_browser() {
        let key = [7u8; KEY_LEN];
        const BLOB: &str = "v1.AAAAAAAAAAAAAAAA.GvrK05b3KdLDT-AJoVsnz9_NhdsQs8c0ZDe66mzQfwWI_yh2_hHzcXACJ94nccUUERMhthg";
        let header: Header = decrypt_field(&key, BLOB).expect("browser blob must decrypt");
        let expected = Header {
            name: "Home lab".into(),
            color: Some("#9ece6a".into()),
        };
        assert_eq!(header, expected);

        // …and the other direction: with the same key and IV we must reproduce it
        // byte for byte. Field order is part of the contract — serde_json emits
        // struct fields in declaration order, JSON.stringify in insertion order.
        let iv = [0u8; 12];
        let ours =
            rite_crypto::vault::encrypt_with_iv(&key, &iv, &serde_json::to_vec(&expected).unwrap())
                .unwrap();
        assert_eq!(ours, BLOB, "Rust and the browser must agree byte for byte");
    }
}
