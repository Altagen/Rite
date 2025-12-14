//! Database module
//!
//! Handles SQLite database initialization, migrations, and CRUD operations.

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use std::path::Path;
use tracing::{info, warn};

/// Database connection pool
#[derive(Clone)]
pub struct Database {
    pool: SqlitePool,
    db_path: std::path::PathBuf,
}

impl Database {
    /// Initialize database connection
    ///
    /// Creates the database file if it doesn't exist and runs migrations.
    pub async fn new(db_path: &Path) -> Result<Self> {
        // Create parent directories if they don't exist
        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .context("Failed to create database directory")?;
        }

        info!("Connecting to database at: {}", db_path.display());

        // Set up connection options
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true);

        // Create connection pool
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await
            .context("Failed to connect to database")?;

        let db = Self {
            pool,
            db_path: db_path.to_path_buf(),
        };

        // Run migrations
        db.run_migrations().await?;

        Ok(db)
    }

    /// Get the database pool
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Run database migrations
    async fn run_migrations(&self) -> Result<()> {
        info!("Running database migrations");

        // Get current schema version (0 if fresh DB)
        let current_version = self.get_current_schema_version().await?;
        info!("Current schema version: {}", current_version);

        // Define all migrations with their SQL and version number
        let migrations = vec![
            (1, include_str!("../migrations/001_initial_schema.sql")),
            // Future migrations go here:
            // (2, include_str!("../migrations/002_new_feature.sql")),
            // (3, include_str!("../migrations/003_another_feature.sql")),
        ];

        // Expected latest version
        let latest_version = migrations.last().map(|(v, _)| *v).unwrap_or(0);

        // Safety check: DB version too new for this app version
        if current_version > latest_version {
            anyhow::bail!(
                "Database schema version ({}) is newer than application supports ({}). \
                 Please upgrade RITE to the latest version.",
                current_version,
                latest_version
            );
        }

        // Run only pending migrations
        for (version, sql) in migrations {
            if version > current_version {
                info!("Applying migration {}/{}", version, latest_version);

                // Backup before migration (only if not initial setup)
                if current_version > 0 {
                    info!("Creating backup before migration {}...", version);
                    if let Err(e) = self.create_migration_backup().await {
                        warn!("Failed to create backup: {}. Continuing with migration...", e);
                        // Don't fail migration if backup fails, but warn user
                    }
                }

                let mut conn = self.pool.acquire().await?;

                sqlx::raw_sql(sql)
                    .execute(&mut *conn)
                    .await
                    .with_context(|| format!("Failed to run migration {}", version))?;

                info!("Migration {} completed successfully", version);
            }
        }

        if current_version == latest_version {
            info!("Database schema is up to date (version {})", current_version);
        } else {
            info!(
                "Database migrations completed: {} → {}",
                current_version, latest_version
            );
        }

        Ok(())
    }

    /// Get current schema version (returns 0 if schema_version table doesn't exist)
    async fn get_current_schema_version(&self) -> Result<i64> {
        // Check if schema_version table exists
        let table_exists: bool = sqlx::query_scalar(
            "SELECT COUNT(*) > 0 FROM sqlite_master \
             WHERE type='table' AND name='schema_version'"
        )
        .fetch_one(&self.pool)
        .await?;

        if !table_exists {
            return Ok(0); // Fresh database
        }

        // Get max version from schema_version table
        let version: Option<i64> = sqlx::query_scalar(
            "SELECT MAX(version) FROM schema_version"
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(version.unwrap_or(0))
    }

    /// Check if this is the first run (no master password set)
    pub async fn is_first_run(&self) -> Result<bool> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_password")
            .fetch_one(&self.pool)
            .await?;

        Ok(count == 0)
    }

    /// Get the current schema version
    pub async fn get_schema_version(&self) -> Result<i64> {
        let version: i64 =
            sqlx::query_scalar("SELECT MAX(version) FROM schema_version")
                .fetch_one(&self.pool)
                .await?;

        Ok(version)
    }

    /// Store master password hash
    pub async fn store_master_password(&self, hash: &str, salt: &[u8]) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();

        sqlx::query(
            r#"
            INSERT INTO master_password (id, hash, salt, created_at, updated_at)
            VALUES (1, ?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
                hash = excluded.hash,
                salt = excluded.salt,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(hash)
        .bind(salt)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await
        .context("Failed to store master password")?;

        Ok(())
    }

    /// Get master password hash and salt
    pub async fn get_master_password(&self) -> Result<Option<(String, Vec<u8>)>> {
        let result = sqlx::query("SELECT hash, salt FROM master_password WHERE id = 1")
            .fetch_optional(&self.pool)
            .await?;

        Ok(result.map(|row| {
            let hash: String = row.get("hash");
            let salt: Vec<u8> = row.get("salt");
            (hash, salt)
        }))
    }

    /// Record an unlock attempt
    pub async fn record_unlock_attempt(&self, success: bool) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();

        sqlx::query(
            "INSERT INTO unlock_attempts (timestamp, success) VALUES (?1, ?2)",
        )
        .bind(now)
        .bind(success as i32)
        .execute(&self.pool)
        .await
        .context("Failed to record unlock attempt")?;

        Ok(())
    }

    /// Get recent unlock attempts (last N minutes)
    pub async fn get_recent_unlock_attempts(&self, minutes: i64) -> Result<Vec<UnlockAttempt>> {
        let cutoff = chrono::Utc::now().timestamp_millis() - (minutes * 60 * 1000);

        let attempts = sqlx::query_as::<_, UnlockAttempt>(
            "SELECT timestamp, success FROM unlock_attempts WHERE timestamp > ?1 ORDER BY timestamp DESC"
        )
        .bind(cutoff)
        .fetch_all(&self.pool)
        .await?;

        Ok(attempts)
    }

    /// Clean old unlock attempts (older than 24 hours)
    pub async fn clean_old_unlock_attempts(&self) -> Result<()> {
        let cutoff = chrono::Utc::now().timestamp_millis() - (24 * 60 * 60 * 1000);

        sqlx::query("DELETE FROM unlock_attempts WHERE timestamp < ?1")
            .bind(cutoff)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    /// Reset the database (delete master password and all connections)
    /// WARNING: This will permanently delete all data!
    pub async fn reset(&self) -> Result<()> {
        warn!("Resetting database - all data will be lost!");

        let mut tx = self.pool.begin().await?;

        sqlx::query("DELETE FROM connections")
            .execute(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM master_password")
            .execute(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM unlock_attempts")
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;

        info!("Database reset completed");
        Ok(())
    }

    /// Create a backup of the database file
    pub async fn create_backup(&self, backup_path: &Path) -> Result<()> {
        info!("Creating database backup at: {}", backup_path.display());

        // Create parent directories if they don't exist
        if let Some(parent) = backup_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .context("Failed to create backup directory")?;
        }

        // Execute SQLite VACUUM INTO to create a clean, compacted backup
        // This is the recommended way to backup SQLite databases
        let backup_path_str = backup_path.to_string_lossy();
        let query = format!("VACUUM INTO '{}'", backup_path_str);

        sqlx::query(&query)
            .execute(&self.pool)
            .await
            .context("Failed to create database backup")?;

        info!("Database backup created successfully");
        Ok(())
    }

    /// Create automatic migration backup with timestamp
    async fn create_migration_backup(&self) -> Result<()> {
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_filename = format!(
            "vault_pre_migration_{}.db",
            timestamp
        );

        let backup_dir = self.db_path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Invalid database path"))?
            .join("backups");

        let backup_path = backup_dir.join(backup_filename);

        self.create_backup(&backup_path).await
    }

    // ===== Connection CRUD Operations =====

    /// Create a new connection
    #[allow(clippy::too_many_arguments)]
    pub async fn create_connection(
        &self,
        id: &str,
        name: &str,
        protocol: &str,
        hostname: &str,
        port: u16,
        username: &str,
        encrypted_credentials: &[u8],
        nonce: &[u8],
        color: Option<&str>,
        icon: Option<&str>,
        folder: Option<&str>,
        notes: Option<&str>,
        ssh_keep_alive_override: Option<&str>,
        ssh_keep_alive_interval: Option<i64>,
        created_at: i64,
        updated_at: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO connections (
                id, name, protocol, hostname, port, username,
                encrypted_credentials, nonce,
                color, icon, folder, notes,
                ssh_keep_alive_override, ssh_keep_alive_interval,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
            "#,
        )
        .bind(id)
        .bind(name)
        .bind(protocol)
        .bind(hostname)
        .bind(port as i64)
        .bind(username)
        .bind(encrypted_credentials)
        .bind(nonce)
        .bind(color)
        .bind(icon)
        .bind(folder)
        .bind(notes)
        .bind(ssh_keep_alive_override)
        .bind(ssh_keep_alive_interval)
        .bind(created_at)
        .bind(updated_at)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Get connection by ID
    pub async fn get_connection(&self, id: &str) -> Result<Option<ConnectionRow>> {
        let connection = sqlx::query_as::<_, ConnectionRow>(
            "SELECT * FROM connections WHERE id = ?1"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(connection)
    }

    /// Get all connections
    pub async fn get_all_connections(&self) -> Result<Vec<ConnectionRow>> {
        let connections = sqlx::query_as::<_, ConnectionRow>(
            "SELECT * FROM connections ORDER BY name COLLATE NOCASE"
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(connections)
    }

    /// Get connections by folder
    pub async fn get_connections_by_folder(&self, folder: &str) -> Result<Vec<ConnectionRow>> {
        let connections = sqlx::query_as::<_, ConnectionRow>(
            "SELECT * FROM connections WHERE folder = ?1 ORDER BY name COLLATE NOCASE"
        )
        .bind(folder)
        .fetch_all(&self.pool)
        .await?;

        Ok(connections)
    }

    /// Update connection
    #[allow(clippy::too_many_arguments)]
    pub async fn update_connection(
        &self,
        id: &str,
        name: &str,
        protocol: &str,
        hostname: &str,
        port: u16,
        username: &str,
        encrypted_credentials: &[u8],
        nonce: &[u8],
        color: Option<&str>,
        icon: Option<&str>,
        folder: Option<&str>,
        notes: Option<&str>,
        ssh_keep_alive_override: Option<&str>,
        ssh_keep_alive_interval: Option<i64>,
        updated_at: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE connections SET
                name = ?2,
                protocol = ?3,
                hostname = ?4,
                port = ?5,
                username = ?6,
                encrypted_credentials = ?7,
                nonce = ?8,
                color = ?9,
                icon = ?10,
                folder = ?11,
                notes = ?12,
                ssh_keep_alive_override = ?13,
                ssh_keep_alive_interval = ?14,
                updated_at = ?15
            WHERE id = ?1
            "#,
        )
        .bind(id)
        .bind(name)
        .bind(protocol)
        .bind(hostname)
        .bind(port as i64)
        .bind(username)
        .bind(encrypted_credentials)
        .bind(nonce)
        .bind(color)
        .bind(icon)
        .bind(folder)
        .bind(notes)
        .bind(ssh_keep_alive_override)
        .bind(ssh_keep_alive_interval)
        .bind(updated_at)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Update connection last used timestamp
    pub async fn update_connection_last_used(&self, id: &str, last_used_at: i64) -> Result<()> {
        sqlx::query("UPDATE connections SET last_used_at = ?1, updated_at = ?2 WHERE id = ?3")
            .bind(last_used_at)
            .bind(last_used_at)
            .bind(id)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    /// Delete connection
    pub async fn delete_connection(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM connections WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;

        Ok(())
    }
}

/// Unlock attempt record
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UnlockAttempt {
    pub timestamp: i64,
    pub success: i32,
}

impl UnlockAttempt {
    pub fn is_success(&self) -> bool {
        self.success != 0
    }
}

/// Connection row from database
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ConnectionRow {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: i64,
    pub username: String,
    pub encrypted_credentials: Vec<u8>,
    pub nonce: Vec<u8>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub folder: Option<String>,
    pub notes: Option<String>,
    pub ssh_keep_alive_override: Option<String>,
    pub ssh_keep_alive_interval: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
}

impl Database {
    /// Get a setting value
    pub async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let result = sqlx::query("SELECT value FROM settings WHERE key = ?1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;

        Ok(result.map(|row| row.get("value")))
    }

    /// Set a setting value
    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let now = chrono::Utc::now().timestamp();

        sqlx::query(
            r#"
            INSERT INTO settings (key, value, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(key)
        .bind(value)
        .bind(now)
        .execute(&self.pool)
        .await
        .context("Failed to set setting")?;

        Ok(())
    }

    /// Get all settings
    pub async fn get_all_settings(&self) -> Result<std::collections::HashMap<String, String>> {
        let rows = sqlx::query("SELECT key, value FROM settings")
            .fetch_all(&self.pool)
            .await?;

        let mut settings = std::collections::HashMap::new();
        for row in rows {
            let key: String = row.get("key");
            let value: String = row.get("value");
            settings.insert(key, value);
        }

        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn create_test_db() -> (Database, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let db = Database::new(&db_path).await.unwrap();
        (db, temp_dir)
    }

    #[tokio::test]
    async fn test_database_initialization() {
        let (db, _temp) = create_test_db().await;

        // Should be first run
        assert!(db.is_first_run().await.unwrap());

        // Schema version should be 1
        assert_eq!(db.get_schema_version().await.unwrap(), 1);
    }

    #[tokio::test]
    async fn test_master_password_storage() {
        let (db, _temp) = create_test_db().await;

        let hash = "test_hash_123";
        let salt = vec![1, 2, 3, 4, 5, 6, 7, 8];

        // Store master password
        db.store_master_password(hash, &salt).await.unwrap();

        // Should no longer be first run
        assert!(!db.is_first_run().await.unwrap());

        // Retrieve and verify
        let (retrieved_hash, retrieved_salt) = db.get_master_password().await.unwrap().unwrap();
        assert_eq!(retrieved_hash, hash);
        assert_eq!(retrieved_salt, salt);
    }

    #[tokio::test]
    async fn test_unlock_attempts() {
        let (db, _temp) = create_test_db().await;

        // Record some attempts
        db.record_unlock_attempt(false).await.unwrap();
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        db.record_unlock_attempt(false).await.unwrap();
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        db.record_unlock_attempt(true).await.unwrap();

        // Get recent attempts
        let attempts = db.get_recent_unlock_attempts(10).await.unwrap();
        assert_eq!(attempts.len(), 3);

        // Most recent should be success (DESC order)
        assert!(attempts[0].is_success());
        assert!(!attempts[1].is_success());
        assert!(!attempts[2].is_success());
    }

    #[tokio::test]
    async fn test_database_reset() {
        let (db, _temp) = create_test_db().await;

        // Set up master password
        db.store_master_password("hash", &[1, 2, 3]).await.unwrap();
        assert!(!db.is_first_run().await.unwrap());

        // Reset
        db.reset().await.unwrap();

        // Should be first run again
        assert!(db.is_first_run().await.unwrap());
        assert!(db.get_master_password().await.unwrap().is_none());
    }
}
