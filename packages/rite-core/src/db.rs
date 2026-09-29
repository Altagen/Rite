//! Database module
//!
//! Handles SQLite database initialization, migrations, and CRUD operations.

use anyhow::{Context, Result};
use sqlx::Row;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
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

        // Opening a vault is serialized across processes by a lock file beside it.
        // Two things race otherwise, and both are real: several connections setting
        // `journal_mode = WAL` on a fresh file (one gets "database is locked" and the
        // process never starts), and the migration runner (both read version 0, both
        // apply, the loser meets tables that exist and dies on a column a later
        // migration drops — the vault then opens in one window and refuses in another).
        //
        // A SQLite transaction cannot serve as this lock: held open, it is what makes
        // the other process's `journal_mode` pragma fail, and that pragma does not wait
        // for busy_timeout. A file lock leaves SQLite alone.
        let lock_path = std::path::PathBuf::from(format!("{}.lock", db_path.display()));
        let mut open_lock = tokio::task::spawn_blocking(move || -> Result<fslock::LockFile> {
            let mut lock = fslock::LockFile::open(&lock_path)
                .with_context(|| format!("Failed to open the vault lock at {lock_path:?}"))?;
            lock.lock().context("Failed to take the vault lock")?;
            Ok(lock)
        })
        .await
        .context("Vault lock task failed")??;

        // Set up connection options. WAL + a busy timeout let the vault survive brief overlaps
        // where two single-context servers hold the same file at once — e.g. an in-place context
        // switch or a reset+reload (ADR 0014), where the outgoing server is still shutting down as
        // the new one writes. Without these, that write hit an immediate "database is locked"
        // ("Failed to store master password"). WAL also allows concurrent readers + one writer.
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(std::time::Duration::from_secs(5));

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
        let migrated = db.run_migrations().await;

        let _ = tokio::task::spawn_blocking(move || open_lock.unlock()).await;
        migrated?;

        Ok(db)
    }

    /// Get the database pool
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Run database migrations.
    ///
    /// Serialized across processes. Two servers opening the same vault at once — a
    /// context switch or a reset+reload, where the outgoing one is still shutting
    /// down, or simply two `rite-server` instances on one data dir — both read
    /// version 0 and both start applying. One wins; the other then meets tables that
    /// already exist, drops into the tolerant path, and dies on a statement naming a
    /// column a later migration removed:
    ///
    /// ```text
    /// statement failed while reconciling a drifted migration
    /// no such column: protected_collection_key
    /// ```
    ///
    /// The vault opens in one window and refuses to open in the other. Taking the
    /// write lock first and re-reading the version underneath it means the loser
    /// waits, then finds the work already done and has nothing to do.
    async fn run_migrations(&self) -> Result<()> {
        info!("Running database migrations");
        self.apply_migrations().await
    }

    /// The migration sequence itself, under the lock `Database::new` holds.
    async fn apply_migrations(&self) -> Result<()> {
        // Read the version *under the lock*: read before it and a concurrent starter
        // sees a version that was true a moment ago and re-applies what just landed.
        let mut guard = self.pool.acquire().await?;
        let current_version = self.schema_version_of(&mut guard).await?;
        info!("Current schema version: {}", current_version);

        // Define all migrations with their SQL and version number
        let migrations = vec![
            (1, include_str!("../migrations/001_initial_schema.sql")),
            (2, include_str!("../migrations/002_pending_host_keys.sql")),
            (3, include_str!("../migrations/003_server_accounts.sql")),
            (4, include_str!("../migrations/004_user_vault_keys.sql")),
            (5, include_str!("../migrations/005_vault_connections.sql")),
            (6, include_str!("../migrations/006_teams.sql")),
            (7, include_str!("../migrations/007_user_keypair.sql")),
            (8, include_str!("../migrations/008_team_keys.sql")),
            (9, include_str!("../migrations/009_team_connections.sql")),
            (10, include_str!("../migrations/010_collections.sql")),
            (11, include_str!("../migrations/011_user_library.sql")),
            (
                12,
                include_str!("../migrations/012_collection_split_keys.sql"),
            ),
            (
                13,
                include_str!("../migrations/013_drop_legacy_collection_key.sql"),
            ),
            (14, include_str!("../migrations/014_drop_team_keys.sql")),
            (15, include_str!("../migrations/015_collection_offer.sql")),
            (16, include_str!("../migrations/016_access_requests.sql")),
            (
                17,
                include_str!("../migrations/017_must_change_password.sql"),
            ),
            (18, include_str!("../migrations/018_enrollment_tokens.sql")),
            (19, include_str!("../migrations/019_preconnect.sql")),
            (20, include_str!("../migrations/020_jump.sql")),
            (21, include_str!("../migrations/021_forwards.sql")),
            (22, include_str!("../migrations/022_collection_board.sql")),
            (23, include_str!("../migrations/023_machine_last_used.sql")),
            // Future migrations go here:
            // (19, include_str!("../migrations/019_another_feature.sql")),
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
                    if let Err(e) = self.create_migration_backup(version).await {
                        warn!(
                            "Failed to create backup: {}. Continuing with migration...",
                            e
                        );
                        // Don't fail migration if backup fails, but warn user
                    }
                }

                let conn = &mut *guard;

                // Normal path: run the whole migration file. On a *drifted* vault (schema
                // objects already present but schema_version behind — e.g. an old dev vault
                // whose columns predate the migration that adds them), a non-idempotent
                // `ADD COLUMN`/`CREATE` errors; reconcile by re-running statement-by-statement
                // and skipping the parts already applied, so the vault converges instead of
                // bricking (graceful-handling bar). Non-benign errors still abort.
                if let Err(e) = sqlx::raw_sql(sql).execute(&mut *conn).await {
                    if is_benign_ddl_conflict(&e) {
                        warn!(
                            "Migration {} meets an already-present schema object ({}); \
                             reconciling statement-by-statement",
                            version,
                            e.as_database_error()
                                .map(|d| d.message())
                                .unwrap_or_default()
                        );
                        apply_migration_tolerant(conn, sql)
                            .await
                            .with_context(|| format!("Failed to run migration {}", version))?;
                    } else {
                        return Err(e)
                            .with_context(|| format!("Failed to run migration {}", version));
                    }
                }

                // Record the applied version so it is never re-run. The runner owns
                // this (not each migration file) so it can't be forgotten — a missed
                // record leaves the DB half-migrated and the next launch re-applies
                // non-idempotent DDL (`ADD COLUMN` → "duplicate column"), which is
                // exactly what happened before this was centralized here.
                sqlx::query(
                    "INSERT OR IGNORE INTO schema_version (version, applied_at) \
                     VALUES (?1, strftime('%s', 'now'))",
                )
                .bind(version)
                .execute(&mut *conn)
                .await
                .with_context(|| format!("Failed to record schema version {}", version))?;

                info!("Migration {} completed successfully", version);
            }
        }

        if current_version == latest_version {
            info!(
                "Database schema is up to date (version {})",
                current_version
            );
        } else {
            info!(
                "Database migrations completed: {} → {}",
                current_version, latest_version
            );
        }

        Ok(())
    }

    /// The schema version as seen on one specific connection — used under the
    /// migration lock, where reading through the pool would defeat the point.
    async fn schema_version_of(
        &self,
        conn: &mut sqlx::pool::PoolConnection<sqlx::Sqlite>,
    ) -> Result<i64> {
        let table_exists: bool = sqlx::query_scalar(
            "SELECT COUNT(*) > 0 FROM sqlite_master \
             WHERE type='table' AND name='schema_version'",
        )
        .fetch_one(&mut **conn)
        .await?;
        if !table_exists {
            return Ok(0);
        }
        let version: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM schema_version")
            .fetch_one(&mut **conn)
            .await?;
        Ok(version.unwrap_or(0))
    }

    /// Get current schema version (returns 0 if schema_version table doesn't exist)
    #[allow(dead_code)]
    async fn get_current_schema_version(&self) -> Result<i64> {
        // Check if schema_version table exists
        let table_exists: bool = sqlx::query_scalar(
            "SELECT COUNT(*) > 0 FROM sqlite_master \
             WHERE type='table' AND name='schema_version'",
        )
        .fetch_one(&self.pool)
        .await?;

        if !table_exists {
            return Ok(0); // Fresh database
        }

        // Get max version from schema_version table
        let version: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM schema_version")
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

    /// Get the current schema version (used in tests)
    #[cfg(test)]
    pub async fn get_schema_version(&self) -> Result<i64> {
        let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM schema_version")
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

        sqlx::query("INSERT INTO unlock_attempts (timestamp, success) VALUES (?1, ?2)")
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

    /// Tables a reset leaves alone: the migration ledger, and the settings, which are
    /// preferences rather than content — the reset dialog promises to erase the master
    /// password, the connections and the vault's name/icon, not your auto-lock timeout.
    const RESET_KEEPS: [&'static str; 2] = ["schema_version", "settings"];

    /// Reset the vault: erase everything it holds, keep the file and its schema.
    ///
    /// Enumerated from `sqlite_master` rather than from a hand-written list, because a
    /// hand-written list is a trap that only springs later. It listed `connections`,
    /// `master_password` and `unlock_attempts`, and then ADR 0018 added collections —
    /// so a reset wiped the master key and left every collection behind, sealed with a
    /// key that no longer existed anywhere. The next launch did not merely show a stale
    /// collection: `local_collections::list` tries to unwrap those keys and fails, so
    /// the whole sidebar answered HTTP 500 and the vault was unusable rather than fresh.
    ///
    /// WARNING: This permanently deletes all data in the vault.
    pub async fn reset(&self) -> Result<()> {
        warn!("Resetting database - all data will be lost!");

        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut tx = self.pool.begin().await?;

        // Rows reference each other (a collection member points at a user, an item at a
        // collection), and sqlx has foreign keys on. Deferring the checks to commit time
        // means the order of the DELETEs stops mattering.
        sqlx::query("PRAGMA defer_foreign_keys = ON")
            .execute(&mut *tx)
            .await?;

        for table in &tables {
            if Self::RESET_KEEPS.contains(&table.as_str()) {
                continue;
            }
            // The name comes from sqlite_master, not from a caller.
            sqlx::query(&format!("DELETE FROM \"{table}\""))
                .execute(&mut *tx)
                .await
                .with_context(|| format!("Failed to clear {table} during reset"))?;
        }

        tx.commit().await?;

        info!("Database reset completed ({} tables cleared)", tables.len());
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

    /// Create automatic migration backup with timestamp. The version is part of the name so
    /// several migrations applied in the same second don't collide on one filename (which made
    /// `VACUUM INTO` fail — "database already exists" — and lost all but the first backup).
    async fn create_migration_backup(&self, version: i64) -> Result<()> {
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_filename = format!("vault_pre_migration_{}_v{}.db", timestamp, version);

        let backup_dir = self
            .db_path
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
        preconnect: Option<&str>,
        jump: Option<&str>,
        forwards: Option<&str>,
        created_at: i64,
        updated_at: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO connections (
                id, name, protocol, hostname, port, username,
                encrypted_credentials, nonce,
                color, icon, folder, notes,
                ssh_keep_alive_override, ssh_keep_alive_interval, preconnect, jump, forwards,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
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
        .bind(preconnect)
        .bind(jump)
        .bind(forwards)
        .bind(created_at)
        .bind(updated_at)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Get connection by ID
    pub async fn get_connection(&self, id: &str) -> Result<Option<ConnectionRow>> {
        let connection =
            sqlx::query_as::<_, ConnectionRow>("SELECT * FROM connections WHERE id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;

        Ok(connection)
    }

    /// Get all connections
    pub async fn get_all_connections(&self) -> Result<Vec<ConnectionRow>> {
        let connections = sqlx::query_as::<_, ConnectionRow>(
            "SELECT * FROM connections ORDER BY name COLLATE NOCASE",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(connections)
    }

    /// Get connections by folder
    pub async fn get_connections_by_folder(&self, folder: &str) -> Result<Vec<ConnectionRow>> {
        let connections = sqlx::query_as::<_, ConnectionRow>(
            "SELECT * FROM connections WHERE folder = ?1 ORDER BY name COLLATE NOCASE",
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
        preconnect: Option<&str>,
        jump: Option<&str>,
        forwards: Option<&str>,
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
                preconnect = ?15,
                jump = ?16,
                forwards = ?17,
                updated_at = ?18
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
        .bind(preconnect)
        .bind(jump)
        .bind(forwards)
        .bind(updated_at)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Update connection last used timestamp
    /// Stamp a legacy connection row as just used. Returns false when no such row
    /// exists — the id may belong to a collection item instead (ADR 0018), which
    /// records this beside the item rather than in a column.
    pub async fn update_connection_last_used(&self, id: &str, last_used_at: i64) -> Result<bool> {
        let n =
            sqlx::query("UPDATE connections SET last_used_at = ?1, updated_at = ?2 WHERE id = ?3")
                .bind(last_used_at)
                .bind(last_used_at)
                .bind(id)
                .execute(&self.pool)
                .await?
                .rows_affected();

        Ok(n > 0)
    }

    /// Every connection's stored credential blob: (id, encrypted_credentials, nonce). Used to
    /// re-encrypt them when the master password changes.
    pub async fn all_connection_crypto(&self) -> Result<Vec<(String, Vec<u8>, Vec<u8>)>> {
        let rows = sqlx::query("SELECT id, encrypted_credentials, nonce FROM connections")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                (
                    r.get::<String, _>("id"),
                    r.get::<Vec<u8>, _>("encrypted_credentials"),
                    r.get::<Vec<u8>, _>("nonce"),
                )
            })
            .collect())
    }

    /// Atomically re-key the vault (ADR 0014): replace each connection's re-encrypted credentials
    /// AND the master-password hash/salt in ONE transaction, so a mid-way failure can never leave a
    /// mixed-key vault (some connections under the old key, some the new).
    /// Apply a master-password change atomically.
    ///
    /// `conns` are legacy credential blobs re-encrypted with the new key, and
    /// `collection_keys` are `(collection_id, protected_meta_key,
    /// protected_items_key)` re-wrapped for it (ADR 0018). Both must land in the
    /// same transaction as the new password: if the password changed and the keys
    /// did not, every collection would be permanently unreadable.
    pub async fn rekey_vault(
        &self,
        conns: &[(String, Vec<u8>, Vec<u8>)],
        collection_keys: &[(String, String, Option<String>)],
        new_hash: &str,
        new_salt: &[u8],
    ) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut tx = self.pool.begin().await?;
        for (collection_id, meta, items) in collection_keys {
            sqlx::query(
                "UPDATE collection_members SET protected_meta_key = ?1, protected_items_key = ?2 \
                 WHERE collection_id = ?3 AND user_id = ?4",
            )
            .bind(meta)
            .bind(items)
            .bind(collection_id)
            .bind(crate::local_user::LOCAL_USER_ID)
            .execute(&mut *tx)
            .await?;
        }
        for (id, blob, nonce) in conns {
            sqlx::query(
                "UPDATE connections SET encrypted_credentials = ?1, nonce = ?2, updated_at = ?3 WHERE id = ?4",
            )
            .bind(blob)
            .bind(nonce)
            .bind(now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query(
            "INSERT INTO master_password (id, hash, salt, created_at, updated_at) VALUES (1, ?1, ?2, ?3, ?3) \
             ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, salt = excluded.salt, updated_at = excluded.updated_at",
        )
        .bind(new_hash)
        .bind(new_salt)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
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
    pub preconnect: Option<String>,
    pub jump: Option<String>,
    pub forwards: Option<String>,
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

/// A SQLite error that means "this DDL was already applied" — safe to skip on a drifted vault
/// (adding a column that exists, or creating a table/index that exists). Idempotent by intent.
fn is_benign_ddl_conflict(e: &sqlx::Error) -> bool {
    e.as_database_error().is_some_and(|db| {
        let m = db.message().to_ascii_lowercase();
        m.contains("duplicate column name") || m.contains("already exists")
    })
}

/// Re-run a migration one statement at a time, skipping statements that hit a benign DDL
/// conflict (the object already exists). Only used as a fallback after the whole-file run hit
/// such a conflict, so a drifted vault converges. Non-benign errors abort.
async fn apply_migration_tolerant(conn: &mut sqlx::SqliteConnection, sql: &str) -> Result<()> {
    for stmt in split_sql_statements(sql) {
        if let Err(e) = sqlx::raw_sql(&stmt).execute(&mut *conn).await {
            if is_benign_ddl_conflict(&e) {
                continue; // already applied on this vault — skip
            }
            let detail = e.as_database_error().map(|d| d.message().to_string());
            warn!("reconcile: non-benign failure ({detail:?}) on statement: {stmt}");
            return Err(e).context("statement failed while reconciling a drifted migration");
        }
    }
    Ok(())
}

/// Split a migration file into individual statements on `;`. Comments are stripped FIRST so a
/// `;` inside a `-- …` comment (e.g. "a team key; it is sealed") isn't mistaken for a statement
/// separator. The migrations are simple DDL/DML with no triggers or `BEGIN…END` blocks and no
/// `--`/`;` inside string literals, so this is safe. Only ever used on the tolerant fallback path.
fn split_sql_statements(sql: &str) -> Vec<String> {
    let code: String = sql
        .lines()
        .map(|line| match line.find("--") {
            Some(i) => &line[..i], // keep only the code before the line comment
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    code.split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rite_crypto::vault::KEY_LEN;
    use tempfile::TempDir;

    async fn create_test_db() -> (Database, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let db = Database::new(&db_path).await.unwrap();
        (db, temp_dir)
    }

    // Two single-context servers briefly hold the same vault file during a reset+reload / switch
    // (ADR 0014). With WAL + a busy timeout, a write from one succeeds while the other is still
    // open — before, this raced to an immediate "database is locked" ("Failed to store master
    // password"). This opens a second pool on the same file and writes through both.
    #[tokio::test]
    async fn concurrent_writers_on_the_same_file_dont_deadlock() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("shared.db");
        let outgoing = Database::new(&db_path).await.unwrap();
        // The "new" server opens the same file while the outgoing one is still alive.
        let incoming = Database::new(&db_path).await.unwrap();
        incoming
            .store_master_password("hash-a", b"salt-a")
            .await
            .expect("write from the incoming server should not be locked out");
        // The outgoing server can still read + write too (WAL: readers + one writer).
        assert!(outgoing.get_master_password().await.unwrap().is_some());
        outgoing
            .store_master_password("hash-b", b"salt-b")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_database_initialization() {
        let (db, _temp) = create_test_db().await;

        // Should be first run
        assert!(db.is_first_run().await.unwrap());

        // A fresh DB migrates all the way to the latest schema (each applied
        // migration records its version).
        assert_eq!(db.get_schema_version().await.unwrap(), 23);
    }

    #[test]
    fn split_sql_statements_drops_comments_and_blanks() {
        let sql =
            "-- a comment\nALTER TABLE t ADD COLUMN a TEXT; -- trailing\n\nCREATE INDEX i ON t(a);";
        let stmts = super::split_sql_statements(sql);
        assert_eq!(stmts.len(), 2);
        assert_eq!(stmts[0], "ALTER TABLE t ADD COLUMN a TEXT");
        assert_eq!(stmts[1], "CREATE INDEX i ON t(a)");
    }

    #[test]
    fn split_sql_statements_ignores_semicolons_inside_comments() {
        // Regression (migration 008): a ';' inside a comment must not split a statement.
        let sql = "-- a team key; it is sealed per member\nALTER TABLE t ADD COLUMN k TEXT;";
        assert_eq!(
            super::split_sql_statements(sql),
            vec!["ALTER TABLE t ADD COLUMN k TEXT"]
        );
    }

    #[tokio::test]
    async fn migration_runner_tolerates_a_preexisting_column() {
        // Reproduces the drifted-vault case (schema object already present, version behind):
        // a migration that adds an existing column plus a new one must skip the dup and still
        // apply the new column — converge, not brick.
        let (db, _temp) = create_test_db().await;
        let mut conn = db.pool().acquire().await.unwrap();
        super::apply_migration_tolerant(
            &mut conn,
            "ALTER TABLE users ADD COLUMN kdf_master_salt BLOB;\n\
             ALTER TABLE users ADD COLUMN drift_probe_col TEXT;",
        )
        .await
        .expect("tolerant migration should converge on a drifted vault");
        let cols: Vec<String> = sqlx::query("PRAGMA table_info(users)")
            .fetch_all(&mut *conn)
            .await
            .unwrap()
            .iter()
            .map(|r| r.get::<String, _>("name"))
            .collect();
        assert!(
            cols.contains(&"drift_probe_col".to_string()),
            "new column applied"
        );
    }

    #[tokio::test]
    async fn migrations_are_not_reapplied_on_reopen() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");

        // First open runs every migration to the latest version.
        let db1 = Database::new(&db_path).await.unwrap();
        assert_eq!(db1.get_schema_version().await.unwrap(), 23);
        drop(db1);

        // Reopening the SAME vault must be a clean no-op: without the recorded
        // versions the runner would re-apply non-idempotent DDL (`ADD COLUMN` →
        // "duplicate column") and fail — the exact desktop second-launch bug.
        let db2 = Database::new(&db_path).await.unwrap();
        assert_eq!(db2.get_schema_version().await.unwrap(), 23);
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

    /// Two processes opening the same vault at once must both end up with a usable
    /// vault. Before the migration lock, they both read version 0 and both applied:
    /// one won, the other met tables that already existed, fell into the tolerant
    /// path and died on `no such column: protected_collection_key` — a column
    /// migration 013 drops. The vault opened in one window and refused in the other.
    #[test]
    fn concurrent_opens_do_not_race_the_migrations() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("contended.db");

        // Real threads with their own runtimes, not tasks: the lock being tested is
        // held by a connection, and two connections contending for it is the whole
        // point. Four at once on a fresh file, which is the case that actually raced —
        // an already-migrated vault has nothing to apply and never collided.
        let openers: Vec<_> = (0..4)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    tokio::runtime::Runtime::new()
                        .unwrap()
                        .block_on(async { Database::new(&path).await.map(|db| db.pool().clone()) })
                })
            })
            .collect();

        for (i, opener) in openers.into_iter().enumerate() {
            let pool = opener
                .join()
                .expect("opener panicked")
                .unwrap_or_else(|e| panic!("opener {i} failed to open the vault: {e:#}"));
            let version: i64 = tokio::runtime::Runtime::new().unwrap().block_on(async {
                sqlx::query_scalar("SELECT MAX(version) FROM schema_version")
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            });
            assert_eq!(version, 23, "opener {i} left the schema at {version}");
        }
    }

    /// A reset must leave the vault indistinguishable from a fresh one.
    ///
    /// Enumerated from `sqlite_master` on purpose: the point is to fail when someone
    /// adds a table and forgets the reset, which is exactly what happened when ADR 0018
    /// brought collections in. Asserting a hand-written list here would have passed
    /// happily while the bug shipped.
    #[tokio::test]
    async fn reset_leaves_nothing_behind() {
        let (db, _temp) = create_test_db().await;
        let key = [7u8; KEY_LEN];

        db.store_master_password("hash", &[1, 2, 3]).await.unwrap();
        db.record_unlock_attempt(false).await.unwrap();

        // Content that only exists since ADR 0018 — a collection, its member row and an
        // encrypted machine inside it. This is what the old reset walked straight past.
        crate::local_user::ensure(db.pool()).await.unwrap();
        let coll = crate::local_collections::create(db.pool(), &key, "Prod", None)
            .await
            .unwrap();
        let record: crate::local_collections::MachineRecord = serde_json::from_str(
            r#"{"name":"web-01","protocol":"ssh","hostname":"10.0.0.5","port":22,
                "username":"deploy","authMethod":{"type":"password","password":"s3cret"}}"#,
        )
        .unwrap();
        crate::local_collections::create_machine(db.pool(), &key, &coll.id, &record)
            .await
            .unwrap();

        db.reset().await.unwrap();

        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .fetch_all(db.pool())
        .await
        .unwrap();
        assert!(
            tables.len() > 15,
            "expected the full schema, got {tables:?}"
        );

        for table in tables {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{table}\""))
                .fetch_one(db.pool())
                .await
                .unwrap();
            if Database::RESET_KEEPS.contains(&table.as_str()) {
                continue; // the migration ledger and the preferences survive, by design
            }
            assert_eq!(
                count, 0,
                "`{table}` still holds {count} row(s) after a reset — a reset that leaves \
                 content behind leaves it sealed with a master key that no longer exists"
            );
        }

        // And the vault is usable again rather than 500ing on its own leftovers.
        assert!(db.is_first_run().await.unwrap());
        let listed = crate::local_collections::list(db.pool(), &[9u8; KEY_LEN])
            .await
            .expect("a reset vault lists collections instead of failing to decrypt");
        assert!(listed.is_empty());
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
