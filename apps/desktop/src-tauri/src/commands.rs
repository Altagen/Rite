/// Tauri commands
///
/// Backend functions callable from the frontend
use crate::auth::UnlockResult;
use crate::connection::{AuthMethod, Connection};
use crate::state::AppState;
use rite_crypto::validate_password_strength;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize)]
pub struct PasswordStrength {
    pub is_valid: bool,
    pub score: u8,
    pub feedback: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UnlockResponse {
    Success,
    InvalidPassword,
    RateLimited { wait_seconds: u64 },
}

/// Health check command
#[tauri::command]
pub fn health_check() -> String {
    "RITE backend is running".to_string()
}

/// Validate password strength
#[tauri::command]
pub fn validate_password(password: String) -> PasswordStrength {
    let (is_valid, score, feedback) = validate_password_strength(&password);

    PasswordStrength {
        is_valid,
        score,
        feedback,
    }
}

// ============================================================================
// Authentication Commands
// ============================================================================

/// Check if this is the first run (no master password set)
#[tauri::command]
pub async fn is_first_run(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .auth
        .is_first_run()
        .await
        .map_err(|e| format!("Failed to check first run status: {}", e))
}

/// Check if the application is locked
#[tauri::command]
pub async fn is_locked(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.auth.is_locked().await)
}

/// Set up master password (first run only)
#[tauri::command]
pub async fn setup_master_password(
    password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .auth
        .setup_master_password(&password)
        .await
        .map_err(|e| format!("Failed to setup master password: {}", e))
}

/// Unlock the application
#[tauri::command]
pub async fn unlock(
    password: String,
    state: State<'_, AppState>,
) -> Result<UnlockResponse, String> {
    let result = state
        .auth
        .unlock(&password)
        .await
        .map_err(|e| format!("Unlock failed: {}", e))?;

    let response = match result {
        UnlockResult::Success => UnlockResponse::Success,
        UnlockResult::InvalidPassword => UnlockResponse::InvalidPassword,
        UnlockResult::RateLimited { wait_seconds } => UnlockResponse::RateLimited { wait_seconds },
    };

    Ok(response)
}

/// Lock the application
#[tauri::command]
pub async fn lock(state: State<'_, AppState>) -> Result<(), String> {
    state
        .auth
        .lock()
        .await
        .map_err(|e| format!("Lock failed: {}", e))
}

/// Reset the database (EMERGENCY ONLY - deletes all data)
#[tauri::command]
pub async fn reset_database(state: State<'_, AppState>) -> Result<(), String> {
    state
        .auth
        .reset_database()
        .await
        .map_err(|e| format!("Database reset failed: {}", e))
}

// ===== Connection Management Commands =====

/// Create a new connection
#[tauri::command]
pub async fn create_connection(
    state: State<'_, AppState>,
    input: crate::connection::CreateConnectionInput,
) -> Result<crate::connection::ConnectionInfo, String> {
    state
        .connections
        .create_connection(input)
        .await
        .map_err(|e| format!("Failed to create connection: {}", e))
}

/// Get all connections
#[tauri::command]
pub async fn get_all_connections(
    state: State<'_, AppState>,
) -> Result<Vec<crate::connection::ConnectionInfo>, String> {
    state
        .connections
        .get_all_connections()
        .await
        .map_err(|e| format!("Failed to get connections: {}", e))
}

/// Get connection by ID (with credentials for connection)
#[tauri::command]
pub async fn get_connection(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<crate::connection::ConnectionInfo>, String> {
    match state.connections.get_connection(&id).await {
        Ok(Some(conn)) => Ok(Some(conn.to_info())),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("Failed to get connection: {}", e)),
    }
}

/// Update a connection
#[tauri::command]
pub async fn update_connection(
    state: State<'_, AppState>,
    input: crate::connection::UpdateConnectionInput,
) -> Result<crate::connection::ConnectionInfo, String> {
    state
        .connections
        .update_connection(input)
        .await
        .map_err(|e| format!("Failed to update connection: {}", e))
}

/// Delete a connection
#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .connections
        .delete_connection(&id)
        .await
        .map_err(|e| format!("Failed to delete connection: {}", e))
}

/// Parse SSH config file and return entries for preview
#[tauri::command]
pub async fn parse_ssh_config(
    config_path: String,
) -> Result<Vec<crate::ssh_config::SshConfigEntry>, String> {
    crate::ssh_config::parse_ssh_config(&config_path)
        .map_err(|e| format!("Failed to parse SSH config: {}", e))
}

/// Import selected SSH config entries as connections
#[tauri::command]
pub async fn import_ssh_config_entries(
    state: State<'_, AppState>,
    entries: Vec<crate::ssh_config::SshConfigEntry>,
) -> Result<Vec<crate::connection::ConnectionInfo>, String> {
    let mut imported = Vec::new();

    for entry in entries {
        let input = entry.to_connection_input();
        match state.connections.create_connection(input).await {
            Ok(info) => imported.push(info),
            Err(e) => {
                tracing::warn!(
                    "[commands.rs] Failed to import entry '{}': {}",
                    entry.host,
                    e
                );
            }
        }
    }

    Ok(imported)
}

/// Get default SSH config path
#[tauri::command]
pub fn get_default_ssh_config_path() -> String {
    crate::ssh_config::get_default_ssh_config_path()
}

/// Get connections by folder
#[tauri::command]
pub async fn get_connections_by_folder(
    state: State<'_, AppState>,
    folder: String,
) -> Result<Vec<crate::connection::ConnectionInfo>, String> {
    state
        .connections
        .get_connections_by_folder(&folder)
        .await
        .map_err(|e| format!("Failed to get connections by folder: {}", e))
}

/// Count saved connections (for UI badge)
#[tauri::command]
pub async fn count_saved_connections(state: State<'_, AppState>) -> Result<usize, String> {
    match state.connections.get_all_connections().await {
        Ok(connections) => Ok(connections.len()),
        Err(e) => {
            // If we can't access connections (e.g., DB not unlocked), return 0
            tracing::debug!("[commands.rs] Failed to count connections: {}", e);
            Ok(0)
        }
    }
}

// ============================================================================
// Terminal Session Commands
// ============================================================================

/// Create a new SSH terminal session
#[tauri::command]
pub async fn connect_terminal(
    state: State<'_, AppState>,
    connection_id: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    tracing::info!(
        "[commands.rs] connect_terminal called with connection_id: {}",
        connection_id
    );

    match state
        .sessions
        .create_session(connection_id.clone(), app_handle)
        .await
    {
        Ok(session_id) => {
            tracing::info!("[commands.rs] Session created successfully: {}", session_id);
            Ok(session_id)
        }
        Err(e) => {
            tracing::error!(
                "[commands.rs] Failed to create session for connection {}: {}",
                connection_id,
                e
            );
            Err(format!("Failed to connect: {}", e))
        }
    }
}

/// Create a new local terminal session
#[tauri::command]
pub async fn connect_local_terminal(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    shell: Option<String>,
) -> Result<String, String> {
    tracing::info!("[commands.rs] connect_local_terminal called");

    match state.sessions.create_local_session(app_handle, shell).await {
        Ok(session_id) => {
            tracing::info!(
                "[commands.rs] Local session created successfully: {}",
                session_id
            );
            Ok(session_id)
        }
        Err(e) => {
            tracing::error!("[commands.rs] Failed to create local session: {}", e);
            Err(format!("Failed to create local terminal: {}", e))
        }
    }
}

/// Check which shells are installed on the system
#[tauri::command]
pub fn get_installed_shells(shells: Vec<String>) -> Vec<String> {
    tracing::debug!("[commands.rs] Checking installed shells: {:?}", shells);

    shells
        .into_iter()
        .filter(|shell_path| {
            let exists = std::path::Path::new(shell_path).exists();
            tracing::debug!("[commands.rs] Shell {} exists: {}", shell_path, exists);
            exists
        })
        .collect()
}

/// Quick SSH authentication method (credentials not encrypted)
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum QuickAuthMethod {
    Password {
        password: String,
    },
    PublicKey {
        key_path: String,
        passphrase: Option<String>,
    },
}

impl From<QuickAuthMethod> for AuthMethod {
    fn from(quick: QuickAuthMethod) -> Self {
        match quick {
            QuickAuthMethod::Password { password } => AuthMethod::Password { password },
            QuickAuthMethod::PublicKey {
                key_path,
                passphrase,
            } => AuthMethod::PublicKey {
                key_path,
                passphrase,
            },
        }
    }
}

/// Quick SSH connect (credentials not saved, no unlock required)
///
/// For ad-hoc SSH connections without saving credentials to vault
#[tauri::command]
pub async fn quick_ssh_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    auth_method: QuickAuthMethod,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    tracing::info!(
        "[commands.rs] quick_ssh_connect called for {}@{}:{}",
        username,
        host,
        port
    );

    // Build a temporary Connection object (not saved to DB)
    let connection = Connection {
        id: format!("quick-{}", uuid::Uuid::new_v4()),
        name: format!("{}@{}", username, host),
        protocol: crate::connection::Protocol::SSH,
        hostname: host,
        port,
        username,
        auth_method: auth_method.clone().into(),
        metadata: crate::connection::ConnectionMetadata {
            color: None,
            icon: Some("⚡".to_string()), // Quick connect indicator
            folder: None,
            notes: Some("Quick connect (not saved)".to_string()),
        },
        ssh_keep_alive_override: None,
        ssh_keep_alive_interval: None,
        last_used_at: None,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64,
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64,
    };

    // Create SSH session directly (no database, no encryption needed)
    match state
        .sessions
        .create_quick_ssh_session(connection, auth_method.into(), app_handle)
        .await
    {
        Ok(session_id) => {
            tracing::info!("[commands.rs] Quick SSH session created: {}", session_id);
            Ok(session_id)
        }
        Err(e) => {
            tracing::error!("[commands.rs] Failed to create quick SSH session: {}", e);
            Err(format!("Failed to connect: {}", e))
        }
    }
}

/// Send input to a terminal session
#[tauri::command]
pub async fn send_terminal_input(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    state
        .sessions
        .send_input(&session_id, data)
        .await
        .map_err(|e| format!("Failed to send input: {}", e))
}

/// Resize a terminal session
#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    state
        .sessions
        .resize_terminal(&session_id, cols, rows)
        .await
        .map_err(|e| format!("Failed to resize terminal: {}", e))
}

/// Close a terminal session
#[tauri::command]
pub async fn disconnect_terminal(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state
        .sessions
        .close_session(&session_id)
        .await
        .map_err(|e| format!("Failed to disconnect: {}", e))
}

/// List all active terminal sessions
#[tauri::command]
pub async fn list_terminal_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.sessions.list_sessions().await)
}

// ============================================================================
// Settings Commands
// ============================================================================

/// Get a setting value
#[tauri::command]
pub async fn get_setting(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    state
        .db
        .get_setting(&key)
        .await
        .map_err(|e| format!("Failed to get setting: {}", e))
}

/// Set a setting value
#[tauri::command]
pub async fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state
        .db
        .set_setting(&key, &value)
        .await
        .map_err(|e| format!("Failed to set setting: {}", e))
}

/// Get all settings
#[tauri::command]
pub async fn get_all_settings(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    state
        .db
        .get_all_settings()
        .await
        .map_err(|e| format!("Failed to get settings: {}", e))
}
