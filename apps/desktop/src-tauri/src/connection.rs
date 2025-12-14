/**
 * Connection Management Module
 *
 * Handles SSH connection data with encrypted credentials
 */
use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::MasterKey;
use rite_crypto::{decrypt, encrypt, EncryptedData};

/// SSH connection protocol type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(clippy::upper_case_acronyms)]
pub enum Protocol {
    SSH,
    SFTP,
    Local,
}

impl Protocol {
    pub fn as_str(&self) -> &str {
        match self {
            Protocol::SSH => "ssh",
            Protocol::SFTP => "sftp",
            Protocol::Local => "local",
        }
    }

    pub fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "ssh" => Ok(Protocol::SSH),
            "sftp" => Ok(Protocol::SFTP),
            "local" => Ok(Protocol::Local),
            _ => Err(anyhow::anyhow!("Invalid protocol: {}", s)),
        }
    }
}

/// Authentication method for SSH
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    PublicKey {
        key_path: String,
        passphrase: Option<String>,
    },
}

/// Connection metadata (not encrypted)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionMetadata {
    pub color: Option<String>,
    pub icon: Option<String>,
    pub folder: Option<String>,
    pub notes: Option<String>,
}

/// Full connection data (for database storage)
#[derive(Debug, Clone)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub metadata: ConnectionMetadata,
    pub ssh_keep_alive_override: Option<String>, // NULL, "disabled", or "enabled"
    pub ssh_keep_alive_interval: Option<i64>,    // Interval in seconds, NULL = use global
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
}

/// Connection data for frontend (without sensitive credentials)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String, // "password" or "publicKey"
    pub color: Option<String>,
    pub icon: Option<String>,
    pub folder: Option<String>,
    pub notes: Option<String>,
    pub ssh_keep_alive_override: Option<String>, // NULL, "disabled", or "enabled"
    pub ssh_keep_alive_interval: Option<i64>,    // Interval in seconds
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
}

/// Input for creating a new connection
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConnectionInput {
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub folder: Option<String>,
    pub notes: Option<String>,
    pub ssh_keep_alive_override: Option<String>, // NULL, "disabled", or "enabled"
    pub ssh_keep_alive_interval: Option<i64>,    // Interval in seconds
}

/// Input for updating a connection
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionInput {
    pub id: String,
    pub name: Option<String>,
    pub protocol: Option<String>,
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_method: Option<AuthMethod>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub folder: Option<String>,
    pub notes: Option<String>,
    pub ssh_keep_alive_override: Option<Option<String>>, // Nested Option to allow setting to NULL
    pub ssh_keep_alive_interval: Option<Option<i64>>,    // Nested Option to allow setting to NULL
}

impl Connection {
    /// Create a new connection
    pub fn new(input: CreateConnectionInput) -> Result<Self> {
        let now = Utc::now().timestamp_millis();
        let protocol = Protocol::from_str(&input.protocol)?;

        Ok(Connection {
            id: Uuid::new_v4().to_string(),
            name: input.name,
            protocol,
            hostname: input.hostname,
            port: input.port,
            username: input.username,
            auth_method: input.auth_method,
            metadata: ConnectionMetadata {
                color: input.color,
                icon: input.icon,
                folder: input.folder,
                notes: input.notes,
            },
            ssh_keep_alive_override: input.ssh_keep_alive_override,
            ssh_keep_alive_interval: input.ssh_keep_alive_interval,
            created_at: now,
            updated_at: now,
            last_used_at: None,
        })
    }

    /// Encrypt credentials for database storage
    pub fn encrypt_credentials(&self, master_key: &MasterKey) -> Result<(Vec<u8>, Vec<u8>)> {
        let credentials_json = serde_json::to_string(&self.auth_method)?;
        let encrypted = encrypt(master_key, credentials_json.as_bytes())?;
        Ok((encrypted.data, encrypted.nonce.to_vec()))
    }

    /// Decrypt credentials from database
    pub fn decrypt_credentials(
        encrypted_credentials: &[u8],
        nonce: &[u8],
        master_key: &MasterKey,
    ) -> Result<AuthMethod> {
        let nonce_array: [u8; 12] = nonce
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid nonce length"))?;
        let encrypted_data = EncryptedData {
            data: encrypted_credentials.to_vec(),
            nonce: nonce_array,
            salt: None,
        };
        let decrypted = decrypt(master_key, &encrypted_data)?;
        let credentials_json = String::from_utf8(decrypted)?;
        let auth_method: AuthMethod = serde_json::from_str(&credentials_json)?;
        Ok(auth_method)
    }

    /// Convert to ConnectionInfo (safe for frontend)
    pub fn to_info(&self) -> ConnectionInfo {
        let auth_type = match &self.auth_method {
            AuthMethod::Password { .. } => "password".to_string(),
            AuthMethod::PublicKey { .. } => "publicKey".to_string(),
        };

        ConnectionInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            protocol: self.protocol.as_str().to_string(),
            hostname: self.hostname.clone(),
            port: self.port,
            username: self.username.clone(),
            auth_type,
            color: self.metadata.color.clone(),
            icon: self.metadata.icon.clone(),
            folder: self.metadata.folder.clone(),
            notes: self.metadata.notes.clone(),
            ssh_keep_alive_override: self.ssh_keep_alive_override.clone(),
            ssh_keep_alive_interval: self.ssh_keep_alive_interval,
            created_at: self.created_at,
            updated_at: self.updated_at,
            last_used_at: self.last_used_at,
        }
    }

    /// Update connection with partial data
    pub fn update(&mut self, input: UpdateConnectionInput) -> Result<()> {
        if let Some(name) = input.name {
            self.name = name;
        }
        if let Some(protocol) = input.protocol {
            self.protocol = Protocol::from_str(&protocol)?;
        }
        if let Some(hostname) = input.hostname {
            self.hostname = hostname;
        }
        if let Some(port) = input.port {
            self.port = port;
        }
        if let Some(username) = input.username {
            self.username = username;
        }
        if let Some(auth_method) = input.auth_method {
            self.auth_method = auth_method;
        }
        if let Some(color) = input.color {
            self.metadata.color = Some(color);
        }
        if let Some(icon) = input.icon {
            self.metadata.icon = Some(icon);
        }
        if let Some(folder) = input.folder {
            self.metadata.folder = Some(folder);
        }
        if let Some(notes) = input.notes {
            self.metadata.notes = Some(notes);
        }
        if let Some(ssh_keep_alive_override) = input.ssh_keep_alive_override {
            self.ssh_keep_alive_override = ssh_keep_alive_override;
        }
        if let Some(ssh_keep_alive_interval) = input.ssh_keep_alive_interval {
            self.ssh_keep_alive_interval = ssh_keep_alive_interval;
        }

        self.updated_at = Utc::now().timestamp_millis();
        Ok(())
    }

    /// Mark connection as used
    pub fn mark_used(&mut self) {
        self.last_used_at = Some(Utc::now().timestamp_millis());
        self.updated_at = Utc::now().timestamp_millis();
    }
}
