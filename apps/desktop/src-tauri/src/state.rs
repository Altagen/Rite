/// Application state
///
/// Manages global state across Tauri commands
use crate::auth::AuthManager;
use crate::connections_manager::ConnectionsManager;
use crate::db::Database;
use crate::terminal::SessionManager;
use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    /// Authentication manager
    pub auth: Arc<AuthManager>,

    /// Connections manager
    pub connections: Arc<ConnectionsManager>,

    /// Terminal session manager
    pub sessions: Arc<SessionManager>,

    /// Database connection
    pub db: Database,
}

impl AppState {
    /// Initialize application state
    pub async fn new() -> Result<Self> {
        // Get database path
        let db_path = Self::get_db_path()?;

        // Initialize database
        let db = Database::new(&db_path).await?;

        // Initialize auth manager
        let auth = Arc::new(AuthManager::new(db.clone()));

        // Initialize connections manager
        let connections = Arc::new(ConnectionsManager::new(db.clone(), auth.as_ref().clone()));

        // Initialize session manager
        let sessions = Arc::new(SessionManager::new(db.clone(), auth.as_ref().clone()));

        Ok(Self {
            auth,
            connections,
            sessions,
            db,
        })
    }

    /// Get the database file path
    ///
    /// Uses platform-specific data directories:
    /// - Linux: ~/.local/share/rite/vault.db
    /// - macOS: ~/Library/Application Support/rite/vault.db
    /// - Windows: %APPDATA%\rite\vault.db
    fn get_db_path() -> Result<PathBuf> {
        // Compile-time OS detection for logging
        #[cfg(target_os = "linux")]
        const OS_NAME: &str = "Linux";
        #[cfg(target_os = "macos")]
        const OS_NAME: &str = "macOS";
        #[cfg(target_os = "windows")]
        const OS_NAME: &str = "Windows";
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        compile_error!("RITE only supports Linux, macOS, and Windows");

        // Runtime detection via dirs crate
        let data_dir = dirs::data_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not determine data directory for {}", OS_NAME))?;

        let app_dir = data_dir.join("rite");
        let db_path = app_dir.join("vault.db");

        tracing::info!("Database path for {}: {}", OS_NAME, db_path.display());

        Ok(db_path)
    }
}
