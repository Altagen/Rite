//! Authentication module
//!
//! Handles master password setup, verification, and unlock rate limiting.

use crate::db::Database;
use anyhow::{Context, Result, anyhow};
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use rite_crypto::{EncryptedData, decrypt, encrypt, generate_salt, validate_password_strength};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

// Re-export MasterKey for use in other modules
pub use rite_crypto::MasterKey;

/// Outcome of a master-password change (ADR 0014).
pub enum ChangeMasterOutcome {
    Success,
    /// The supplied current password didn't match.
    WrongPassword,
    /// The new password failed the strength check; carries a human message.
    TooWeak(String),
}

/// Authentication manager
#[derive(Clone)]
pub struct AuthManager {
    db: Database,
    /// Master key in memory (zeroized on drop)
    /// None when locked, Some when unlocked
    master_key: Arc<RwLock<Option<Arc<MasterKey>>>>,
}

impl AuthManager {
    pub fn new(db: Database) -> Self {
        Self {
            db,
            master_key: Arc::new(RwLock::new(None)),
        }
    }

    /// Check if this is the first run (no master password set)
    pub async fn is_first_run(&self) -> Result<bool> {
        self.db.is_first_run().await
    }

    /// Set up master password (first run only)
    pub async fn setup_master_password(&self, password: &str) -> Result<()> {
        // Verify this is first run
        if !self.is_first_run().await? {
            return Err(anyhow!("Master password already set"));
        }

        // Validate password strength
        let (is_valid, score, feedback) = validate_password_strength(password);
        if !is_valid {
            return Err(anyhow!(
                "Password too weak (score: {}/7): {}",
                score,
                feedback.join(", ")
            ));
        }

        info!("Setting up master password (strength score: {}/7)", score);

        // Generate salt for Argon2
        let salt = generate_salt();
        let salt_string =
            SaltString::encode_b64(&salt).map_err(|e| anyhow!("Failed to encode salt: {}", e))?;

        // Hash password with Argon2id
        let argon2 = Argon2::default();
        let password_hash = argon2
            .hash_password(password.as_bytes(), &salt_string)
            .map_err(|e| anyhow!("Password hashing failed: {}", e))?
            .to_string();

        // Store hash and salt in database
        self.db
            .store_master_password(&password_hash, &salt)
            .await
            .context("Failed to store master password")?;

        // Derive and store master key in memory
        let master_key =
            Arc::new(MasterKey::derive(password, &salt).context("Failed to derive master key")?);

        *self.master_key.write().await = Some(master_key);

        info!("Master password setup completed");
        Ok(())
    }

    /// Unlock the application with master password
    pub async fn unlock(&self, password: &str) -> Result<UnlockResult> {
        // Check rate limiting
        if let Some(wait_time) = self.check_rate_limit().await? {
            return Ok(UnlockResult::RateLimited {
                wait_seconds: wait_time,
            });
        }

        // Get stored password hash and salt
        let (stored_hash, salt) = self
            .db
            .get_master_password()
            .await?
            .ok_or_else(|| anyhow!("No master password set"))?;

        // Verify password
        let parsed_hash = PasswordHash::new(&stored_hash)
            .map_err(|e| anyhow!("Invalid stored password hash: {}", e))?;

        let is_valid = Argon2::default()
            .verify_password(password.as_bytes(), &parsed_hash)
            .is_ok();

        // Record attempt
        self.db.record_unlock_attempt(is_valid).await?;

        if !is_valid {
            warn!("Failed unlock attempt");
            return Ok(UnlockResult::InvalidPassword);
        }

        // Derive master key
        let master_key =
            Arc::new(MasterKey::derive(password, &salt).context("Failed to derive master key")?);

        // Store in memory
        *self.master_key.write().await = Some(master_key);

        info!("Application unlocked successfully");

        // Clean old attempts
        let _ = self.db.clean_old_unlock_attempts().await;

        Ok(UnlockResult::Success)
    }

    /// Change the local-vault master password (ADR 0014). Verifies the current password, then
    /// re-encrypts every connection's credentials under a key derived from the new password and
    /// updates the stored hash/salt — all atomically (see `Database::rekey_vault`), so a failure
    /// can't corrupt the vault. On success the in-memory key is swapped to the new one.
    pub async fn change_master_password(
        &self,
        old: &str,
        new: &str,
    ) -> Result<ChangeMasterOutcome> {
        let (stored_hash, old_salt) = self
            .db
            .get_master_password()
            .await?
            .ok_or_else(|| anyhow!("No master password set"))?;
        let parsed =
            PasswordHash::new(&stored_hash).map_err(|e| anyhow!("bad stored hash: {e}"))?;
        if Argon2::default()
            .verify_password(old.as_bytes(), &parsed)
            .is_err()
        {
            return Ok(ChangeMasterOutcome::WrongPassword);
        }
        let (is_valid, score, feedback) = validate_password_strength(new);
        if !is_valid {
            return Ok(ChangeMasterOutcome::TooWeak(format!(
                "score {score}/7: {}",
                feedback.join(", ")
            )));
        }
        let old_key = MasterKey::derive(old, &old_salt).context("derive old key")?;
        let new_salt = generate_salt();
        let new_key = MasterKey::derive(new, &new_salt).context("derive new key")?;
        // Re-encrypt each connection's credential blob (decrypt with old, encrypt with new).
        let mut updates = Vec::new();
        for (id, blob, nonce) in self.db.all_connection_crypto().await? {
            let nonce_arr: [u8; 12] = nonce
                .as_slice()
                .try_into()
                .map_err(|_| anyhow!("invalid nonce for {id}"))?;
            let plain = decrypt(
                &old_key,
                &EncryptedData {
                    data: blob,
                    nonce: nonce_arr,
                    salt: None,
                },
            )
            .context("decrypt with old key")?;
            let enc = encrypt(&new_key, &plain).context("encrypt with new key")?;
            updates.push((id, enc.data, enc.nonce.to_vec()));
        }
        let new_hash = Argon2::default()
            .hash_password(
                new.as_bytes(),
                &SaltString::encode_b64(&new_salt).map_err(|e| anyhow!("encode salt: {e}"))?,
            )
            .map_err(|e| anyhow!("hash new password: {e}"))?
            .to_string();
        self.db.rekey_vault(&updates, &new_hash, &new_salt).await?;
        *self.master_key.write().await = Some(Arc::new(new_key));
        info!(
            "Master password changed ({} connections re-keyed)",
            updates.len()
        );
        Ok(ChangeMasterOutcome::Success)
    }

    /// Lock the application (zeroize master key)
    pub async fn lock(&self) -> Result<()> {
        info!("Locking application");
        *self.master_key.write().await = None;
        Ok(())
    }

    /// Check if the application is locked
    pub async fn is_locked(&self) -> bool {
        self.master_key.read().await.is_none()
    }

    /// Get master key (if unlocked)
    pub async fn get_master_key(&self) -> Result<Arc<MasterKey>> {
        self.master_key
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow!("Application is locked"))
    }

    /// Check rate limiting for unlock attempts
    /// Returns Some(wait_seconds) if rate limited, None if okay to proceed
    async fn check_rate_limit(&self) -> Result<Option<u64>> {
        const MAX_ATTEMPTS: usize = 5;
        const WINDOW_MINUTES: i64 = 1;
        const LOCKOUT_SECONDS: u64 = 30;

        let attempts = self.db.get_recent_unlock_attempts(WINDOW_MINUTES).await?;

        // Count failed attempts
        let failed_count = attempts.iter().filter(|a| !a.is_success()).count();

        if failed_count >= MAX_ATTEMPTS {
            // Check if we should still be locked out
            if let Some(last_attempt) = attempts.first() {
                let now = chrono::Utc::now().timestamp_millis();
                let elapsed_ms = (now - last_attempt.timestamp) as u64;
                let elapsed_secs = elapsed_ms / 1000;

                if elapsed_secs < LOCKOUT_SECONDS {
                    let remaining = LOCKOUT_SECONDS - elapsed_secs;
                    debug!("Rate limited: {} seconds remaining", remaining);
                    return Ok(Some(remaining));
                }
            }
        }

        Ok(None)
    }

    /// Reset the database (emergency recovery)
    /// WARNING: This will delete ALL data including connections!
    pub async fn reset_database(&self) -> Result<()> {
        warn!("EMERGENCY: Resetting database - all data will be lost!");

        // Lock the application first
        self.lock().await?;

        // Reset database
        self.db.reset().await?;

        info!("Database reset completed");
        Ok(())
    }

    /// Get statistics about recent unlock attempts (used in tests)
    #[cfg(test)]
    pub async fn get_unlock_stats(&self) -> Result<UnlockStats> {
        let attempts = self.db.get_recent_unlock_attempts(60).await?; // Last hour

        let total = attempts.len();
        let successful = attempts.iter().filter(|a| a.is_success()).count();
        let failed = total - successful;

        Ok(UnlockStats {
            total_attempts_last_hour: total,
            successful_attempts: successful,
            failed_attempts: failed,
        })
    }
}

/// Result of an unlock attempt
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnlockResult {
    Success,
    InvalidPassword,
    RateLimited { wait_seconds: u64 },
}

/// Statistics about unlock attempts (used in tests)
#[cfg(test)]
#[derive(Debug, Clone)]
pub struct UnlockStats {
    pub total_attempts_last_hour: usize,
    pub successful_attempts: usize,
    pub failed_attempts: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn create_test_auth() -> (AuthManager, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let db = Database::new(&db_path).await.unwrap();
        let auth = AuthManager::new(db);
        (auth, temp_dir)
    }

    #[tokio::test]
    async fn test_first_run() {
        let (auth, _temp) = create_test_auth().await;
        assert!(auth.is_first_run().await.unwrap());
    }

    #[tokio::test]
    async fn change_master_password_rekeys_connections() {
        use crate::connection::{AuthMethod, CreateConnectionInput};
        use crate::connections_manager::ConnectionsManager;
        let temp = TempDir::new().unwrap();
        let db = Database::new(&temp.path().join("v.db")).await.unwrap();
        let auth = AuthManager::new(db.clone());
        auth.setup_master_password("Old-Str0ng!P@ss1")
            .await
            .unwrap();
        let conns = ConnectionsManager::new(db.clone(), auth.clone());
        conns
            .create_connection(CreateConnectionInput {
                name: "box".into(),
                protocol: "SSH".into(),
                hostname: "h".into(),
                port: 22,
                username: "u".into(),
                auth_method: AuthMethod::Password {
                    password: "s3cret-pw".into(),
                },
                color: None,
                icon: None,
                folder: None,
                notes: None,
                ssh_keep_alive_override: None,
                ssh_keep_alive_interval: None,
                preconnect: None,
                jump: None,
            })
            .await
            .unwrap();

        // Wrong current password is rejected.
        assert!(matches!(
            auth.change_master_password("nope", "New-Str0ng!P@ss2")
                .await
                .unwrap(),
            ChangeMasterOutcome::WrongPassword
        ));
        // Change succeeds with the right current password.
        assert!(matches!(
            auth.change_master_password("Old-Str0ng!P@ss1", "New-Str0ng!P@ss2")
                .await
                .unwrap(),
            ChangeMasterOutcome::Success
        ));

        // The old password no longer unlocks; the new one does.
        auth.lock().await.unwrap();
        assert!(matches!(
            auth.unlock("Old-Str0ng!P@ss1").await.unwrap(),
            UnlockResult::InvalidPassword
        ));
        assert!(matches!(
            auth.unlock("New-Str0ng!P@ss2").await.unwrap(),
            UnlockResult::Success
        ));

        // The connection's credentials survived the re-key (decrypt under the new key).
        let all = conns.get_all_connections().await.unwrap();
        let one = conns.get_connection(&all[0].id).await.unwrap().unwrap();
        match one.auth_method {
            AuthMethod::Password { password } => assert_eq!(password, "s3cret-pw"),
            _ => panic!("wrong auth method after re-key"),
        }
    }

    #[tokio::test]
    async fn test_setup_master_password() {
        let (auth, _temp) = create_test_auth().await;

        // Weak password should fail
        let result = auth.setup_master_password("weak").await;
        assert!(result.is_err());

        // Strong password should succeed
        let strong_password = "MyStr0ng!P@ssw0rd#2024";
        auth.setup_master_password(strong_password).await.unwrap();

        // Should no longer be first run
        assert!(!auth.is_first_run().await.unwrap());

        // Should be unlocked after setup
        assert!(!auth.is_locked().await);
    }

    #[tokio::test]
    async fn test_unlock_with_correct_password() {
        let (auth, _temp) = create_test_auth().await;

        let password = "MyStr0ng!P@ssw0rd#2024";
        auth.setup_master_password(password).await.unwrap();

        // Lock the app
        auth.lock().await.unwrap();
        assert!(auth.is_locked().await);

        // Unlock with correct password
        let result = auth.unlock(password).await.unwrap();
        assert_eq!(result, UnlockResult::Success);
        assert!(!auth.is_locked().await);
    }

    #[tokio::test]
    async fn test_unlock_with_wrong_password() {
        let (auth, _temp) = create_test_auth().await;

        let correct_password = "MyStr0ng!P@ssw0rd#2024";
        auth.setup_master_password(correct_password).await.unwrap();
        auth.lock().await.unwrap();

        // Try wrong password
        let result = auth.unlock("WrongPassword123!").await.unwrap();
        assert_eq!(result, UnlockResult::InvalidPassword);
        assert!(auth.is_locked().await);
    }

    #[tokio::test]
    async fn test_rate_limiting() {
        let (auth, _temp) = create_test_auth().await;

        let password = "MyStr0ng!P@ssw0rd#2024";
        auth.setup_master_password(password).await.unwrap();
        auth.lock().await.unwrap();

        // Make 5 failed attempts
        for _ in 0..5 {
            let result = auth.unlock("WrongPassword").await.unwrap();
            assert_eq!(result, UnlockResult::InvalidPassword);
        }

        // 6th attempt should be rate limited
        let result = auth.unlock("WrongPassword").await.unwrap();
        match result {
            UnlockResult::RateLimited { wait_seconds } => {
                assert!(wait_seconds > 0 && wait_seconds <= 30);
            }
            _ => panic!("Expected rate limiting"),
        }
    }

    #[tokio::test]
    async fn test_database_reset() {
        let (auth, _temp) = create_test_auth().await;

        let password = "MyStr0ng!P@ssw0rd#2024";
        auth.setup_master_password(password).await.unwrap();

        // Reset database
        auth.reset_database().await.unwrap();

        // Should be first run again
        assert!(auth.is_first_run().await.unwrap());
        assert!(auth.is_locked().await);
    }

    #[tokio::test]
    async fn test_unlock_stats() {
        let (auth, _temp) = create_test_auth().await;

        let password = "MyStr0ng!P@ssw0rd#2024";
        auth.setup_master_password(password).await.unwrap();
        auth.lock().await.unwrap();

        // Make some attempts
        auth.unlock("wrong").await.unwrap();
        auth.unlock("wrong2").await.unwrap();
        auth.unlock(password).await.unwrap();

        let stats = auth.get_unlock_stats().await.unwrap();
        assert_eq!(stats.total_attempts_last_hour, 3);
        assert_eq!(stats.successful_attempts, 1);
        assert_eq!(stats.failed_attempts, 2);
    }
}
