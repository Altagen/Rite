/**
 * Connections Manager
 *
 * Manages SSH connections with encrypted credentials storage
 */
use anyhow::Result;
use tracing::{debug, info};

use crate::auth::AuthManager;
use crate::connection::{Connection, ConnectionInfo, CreateConnectionInput, UpdateConnectionInput};
use crate::db::{ConnectionRow, Database};

pub struct ConnectionsManager {
    db: Database,
    auth: AuthManager,
}

impl ConnectionsManager {
    pub fn new(db: Database, auth: AuthManager) -> Self {
        Self { db, auth }
    }

    /// Create a new connection
    pub async fn create_connection(&self, input: CreateConnectionInput) -> Result<ConnectionInfo> {
        info!("Creating new connection: {}", input.name);

        // Get the master key (requires application to be unlocked)
        let master_key = self.auth.get_master_key().await?;

        // Create connection object
        let connection = Connection::new(input)?;

        // Encrypt credentials
        let (encrypted_credentials, nonce) = connection.encrypt_credentials(&master_key)?;

        // Store in database
        self.db
            .create_connection(
                &connection.id,
                &connection.name,
                connection.protocol.as_str(),
                &connection.hostname,
                connection.port,
                &connection.username,
                &encrypted_credentials,
                &nonce,
                connection.metadata.color.as_deref(),
                connection.metadata.icon.as_deref(),
                connection.metadata.folder.as_deref(),
                connection.metadata.notes.as_deref(),
                connection.ssh_keep_alive_override.as_deref(),
                connection.ssh_keep_alive_interval,
                connection.created_at,
                connection.updated_at,
            )
            .await?;

        debug!("Connection created with ID: {}", connection.id);
        Ok(connection.to_info())
    }

    /// Get all connections (without decrypted credentials)
    pub async fn get_all_connections(&self) -> Result<Vec<ConnectionInfo>> {
        debug!("Fetching all connections");
        let rows = self.db.get_all_connections().await?;
        let connections: Vec<ConnectionInfo> =
            rows.iter().map(|row| self.row_to_info(row)).collect();
        Ok(connections)
    }

    /// Get connection by ID (with decrypted credentials)
    pub async fn get_connection(&self, id: &str) -> Result<Option<Connection>> {
        debug!("Fetching connection: {}", id);
        let row = self.db.get_connection(id).await?;

        match row {
            Some(row) => {
                let master_key = self.auth.get_master_key().await?;
                let connection = self.row_to_connection(&row, &master_key)?;
                Ok(Some(connection))
            }
            None => Ok(None),
        }
    }

    /// Get connections by folder
    pub async fn get_connections_by_folder(&self, folder: &str) -> Result<Vec<ConnectionInfo>> {
        debug!("Fetching connections in folder: {}", folder);
        let rows = self.db.get_connections_by_folder(folder).await?;
        let connections: Vec<ConnectionInfo> =
            rows.iter().map(|row| self.row_to_info(row)).collect();
        Ok(connections)
    }

    /// Update a connection
    pub async fn update_connection(&self, input: UpdateConnectionInput) -> Result<ConnectionInfo> {
        info!("Updating connection: {}", input.id);

        // Get existing connection
        let mut connection = self
            .get_connection(&input.id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Connection not found"))?;

        // Update fields
        connection.update(input)?;

        // Get master key and re-encrypt credentials
        let master_key = self.auth.get_master_key().await?;
        let (encrypted_credentials, nonce) = connection.encrypt_credentials(&master_key)?;

        // Update in database
        self.db
            .update_connection(
                &connection.id,
                &connection.name,
                connection.protocol.as_str(),
                &connection.hostname,
                connection.port,
                &connection.username,
                &encrypted_credentials,
                &nonce,
                connection.metadata.color.as_deref(),
                connection.metadata.icon.as_deref(),
                connection.metadata.folder.as_deref(),
                connection.metadata.notes.as_deref(),
                connection.ssh_keep_alive_override.as_deref(),
                connection.ssh_keep_alive_interval,
                connection.updated_at,
            )
            .await?;

        debug!("Connection updated: {}", connection.id);
        Ok(connection.to_info())
    }

    /// Delete a connection
    pub async fn delete_connection(&self, id: &str) -> Result<()> {
        info!("Deleting connection: {}", id);
        self.db.delete_connection(id).await?;
        debug!("Connection deleted: {}", id);
        Ok(())
    }

    /// Mark connection as used
    pub async fn mark_connection_used(&self, id: &str) -> Result<()> {
        debug!("Marking connection as used: {}", id);
        let now = chrono::Utc::now().timestamp_millis();
        self.db.update_connection_last_used(id, now).await?;
        Ok(())
    }

    // Helper methods

    /// Convert database row to Connection (with decrypted credentials)
    fn row_to_connection(
        &self,
        row: &ConnectionRow,
        master_key: &crate::auth::MasterKey,
    ) -> Result<Connection> {
        let protocol = crate::connection::Protocol::from_str(&row.protocol)?;
        let auth_method =
            Connection::decrypt_credentials(&row.encrypted_credentials, &row.nonce, master_key)?;

        Ok(Connection {
            id: row.id.clone(),
            name: row.name.clone(),
            protocol,
            hostname: row.hostname.clone(),
            port: row.port as u16,
            username: row.username.clone(),
            auth_method,
            metadata: crate::connection::ConnectionMetadata {
                color: row.color.clone(),
                icon: row.icon.clone(),
                folder: row.folder.clone(),
                notes: row.notes.clone(),
            },
            ssh_keep_alive_override: row.ssh_keep_alive_override.clone(),
            ssh_keep_alive_interval: row.ssh_keep_alive_interval,
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_used_at: row.last_used_at,
        })
    }

    /// Convert database row to ConnectionInfo (without credentials)
    fn row_to_info(&self, row: &ConnectionRow) -> ConnectionInfo {
        // Determine auth type from encrypted credentials (we can't decrypt without master key)
        // For now, we'll parse the encrypted JSON to get the type
        // In production, you might want to store the auth type separately
        let auth_type = "password".to_string(); // Default, will be overridden if we can determine

        ConnectionInfo {
            id: row.id.clone(),
            name: row.name.clone(),
            protocol: row.protocol.clone(),
            hostname: row.hostname.clone(),
            port: row.port as u16,
            username: row.username.clone(),
            auth_type,
            color: row.color.clone(),
            icon: row.icon.clone(),
            folder: row.folder.clone(),
            notes: row.notes.clone(),
            ssh_keep_alive_override: row.ssh_keep_alive_override.clone(),
            ssh_keep_alive_interval: row.ssh_keep_alive_interval,
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_used_at: row.last_used_at,
        }
    }
}
