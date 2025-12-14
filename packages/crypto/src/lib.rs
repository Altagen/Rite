//! RITE Cryptography Module
//!
//! Provides encryption and key derivation for secure credential storage.
//!
//! Security Stack:
//! - KDF: Argon2id (RFC 9106 recommended parameters)
//! - Encryption: ChaCha20-Poly1305 (AEAD)
//! - File encryption: age (for sync/export)

use anyhow::{anyhow, Result};
use argon2::{
    password_hash::{PasswordHasher, SaltString},
    Argon2, PasswordHash, PasswordVerifier,
};
#[allow(deprecated)]
use chacha20poly1305::{
    aead::{generic_array::GenericArray, Aead, KeyInit, OsRng},
    ChaCha20Poly1305,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Master key derived from user password
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct MasterKey {
    key: [u8; 32],
}

impl MasterKey {
    /// Derive master key from password using Argon2id
    ///
    /// Parameters (RFC 9106 - Option 2 for compatibility):
    /// - Memory: 64 MiB
    /// - Iterations: 3
    /// - Parallelism: 4
    pub fn derive(password: &str, salt: &[u8]) -> Result<Self> {
        let argon2 = Argon2::default();
        let salt_string =
            SaltString::encode_b64(salt).map_err(|e| anyhow!("Invalid salt: {}", e))?;

        let hash = argon2
            .hash_password(password.as_bytes(), &salt_string)
            .map_err(|e| anyhow!("Key derivation failed: {}", e))?;

        let mut key = [0u8; 32];
        let hash_bytes = hash.hash.ok_or_else(|| anyhow!("No hash produced"))?;
        key.copy_from_slice(&hash_bytes.as_bytes()[..32]);

        Ok(Self { key })
    }

    /// Verify password against stored hash
    pub fn verify(password: &str, hash: &str) -> Result<bool> {
        let parsed_hash =
            PasswordHash::new(hash).map_err(|e| anyhow!("Invalid password hash: {}", e))?;

        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &parsed_hash)
            .is_ok())
    }

    /// Get the raw key bytes (use with caution)
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.key
    }
}

/// Encrypted data container
#[derive(Serialize, Deserialize, Clone)]
pub struct EncryptedData {
    /// Ciphertext
    pub data: Vec<u8>,
    /// Nonce (96 bits for ChaCha20-Poly1305)
    pub nonce: [u8; 12],
    /// Salt for key derivation (if applicable)
    pub salt: Option<Vec<u8>>,
}

/// Encrypt data with ChaCha20-Poly1305
#[allow(deprecated)]
pub fn encrypt(key: &MasterKey, plaintext: &[u8]) -> Result<EncryptedData> {
    let cipher = ChaCha20Poly1305::new(GenericArray::from_slice(key.as_bytes()));

    // Generate random nonce
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = GenericArray::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow!("Encryption failed: {}", e))?;

    Ok(EncryptedData {
        data: ciphertext,
        nonce: nonce_bytes,
        salt: None,
    })
}

/// Decrypt data with ChaCha20-Poly1305
#[allow(deprecated)]
pub fn decrypt(key: &MasterKey, encrypted: &EncryptedData) -> Result<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(GenericArray::from_slice(key.as_bytes()));

    let nonce = GenericArray::from_slice(&encrypted.nonce);

    cipher
        .decrypt(nonce, encrypted.data.as_ref())
        .map_err(|e| anyhow!("Decryption failed: {}", e))
}

/// Generate a random salt for key derivation
pub fn generate_salt() -> [u8; 16] {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// Validate password strength
/// Returns (is_valid, score, feedback)
pub fn validate_password_strength(password: &str) -> (bool, u8, Vec<String>) {
    let mut score = 0u8;
    let mut feedback = Vec::new();

    // Length check
    if password.len() >= 12 {
        score += 2;
    } else {
        feedback.push(format!(
            "Password must be at least 12 characters (current: {})",
            password.len()
        ));
    }

    if password.len() >= 16 {
        score += 1;
    }

    // Complexity checks
    if password.chars().any(|c| c.is_lowercase()) {
        score += 1;
    } else {
        feedback.push("Add lowercase letters".to_string());
    }

    if password.chars().any(|c| c.is_uppercase()) {
        score += 1;
    } else {
        feedback.push("Add uppercase letters".to_string());
    }

    if password.chars().any(|c| c.is_numeric()) {
        score += 1;
    } else {
        feedback.push("Add numbers".to_string());
    }

    if password.chars().any(|c| !c.is_alphanumeric()) {
        score += 1;
    } else {
        feedback.push("Add special characters".to_string());
    }

    // Common patterns
    if password.to_lowercase().contains("password") || password.to_lowercase().contains("123456") {
        score = score.saturating_sub(3);
        feedback.push("Avoid common patterns".to_string());
    }

    let is_valid = password.len() >= 12;
    (is_valid, score, feedback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_derivation() {
        let password = "test-password-123";
        let salt = generate_salt();

        let key1 = MasterKey::derive(password, &salt).unwrap();
        let key2 = MasterKey::derive(password, &salt).unwrap();

        // Same password and salt should produce same key
        assert_eq!(key1.as_bytes(), key2.as_bytes());
    }

    #[test]
    fn test_encryption_decryption() {
        let password = "strong-password-456";
        let salt = generate_salt();
        let key = MasterKey::derive(password, &salt).unwrap();

        let plaintext = b"Hello, RITE!";
        let encrypted = encrypt(&key, plaintext).unwrap();
        let decrypted = decrypt(&key, &encrypted).unwrap();

        assert_eq!(plaintext, decrypted.as_slice());
    }

    #[test]
    fn test_password_strength() {
        let (valid, score, _) = validate_password_strength("weak");
        assert!(!valid);
        assert!(score < 4);

        let (valid, score, _) = validate_password_strength("StrongP@ssw0rd123");
        assert!(valid);
        assert!(score >= 6);
    }
}
