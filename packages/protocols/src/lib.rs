//! RITE Protocol Implementations
//!
//! Provides abstractions and implementations for various remote protocols:
//! - SSH (via russh)
//! - SFTP (via russh)
//! - FTP/FTPS (future)
//! - Local terminal (future)
//!
//! Architecture is designed to support future protocols (Telnet, Mosh, Serial)
//! and the "profiles/termconfs" feature.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;

pub mod ssh;

#[derive(Error, Debug)]
pub enum ProtocolError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Authentication failed: {0}")]
    AuthenticationFailed(String),

    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Protocol error: {0}")]
    ProtocolError(String),

    #[error("Timeout")]
    Timeout,

    #[error("Not connected")]
    NotConnected,
}

pub type Result<T> = std::result::Result<T, ProtocolError>;

/// Protocol type identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProtocolType {
    Local,
    Ssh,
    Sftp,
    #[cfg(feature = "ftp")]
    Ftp,
    // Future protocols (not yet implemented)
    // Telnet,
    // Mosh,
    // Serial,
}

/// Authentication method
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AuthMethod {
    Password { password: String },
    PublicKey { key_path: PathBuf, passphrase: Option<String> },
    Agent,
}

/// Connection configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub protocol: ProtocolType,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,

    /// Jump host configuration (for SSH bastion)
    pub jump_host: Option<Box<ConnectionConfig>>,

    /// Connection timeout in seconds
    pub timeout: Option<u64>,

    /// Keep-alive interval in seconds
    pub keepalive: Option<u64>,
}

/// Abstract protocol trait
///
/// This trait allows the architecture to support multiple protocols
/// and enables the future "profiles/termconfs" feature.
#[async_trait]
pub trait Protocol: Send + Sync {
    /// Get protocol type
    fn protocol_type(&self) -> ProtocolType;

    /// Connect to remote host
    async fn connect(&mut self, config: &ConnectionConfig) -> Result<()>;

    /// Disconnect from remote host
    async fn disconnect(&mut self) -> Result<()>;

    /// Check if connected
    fn is_connected(&self) -> bool;

    /// Send data to remote
    async fn send(&mut self, data: &[u8]) -> Result<()>;

    /// Receive data from remote
    async fn receive(&mut self) -> Result<Vec<u8>>;
}

/// Terminal protocol trait
///
/// Extended trait for interactive terminal sessions
#[async_trait]
pub trait TerminalProtocol: Protocol {
    /// Request a PTY (pseudo-terminal)
    async fn request_pty(&mut self, term: &str, width: u32, height: u32) -> Result<()>;

    /// Resize the PTY
    async fn resize_pty(&mut self, width: u32, height: u32) -> Result<()>;

    /// Execute a command
    async fn exec(&mut self, command: &str) -> Result<()>;

    /// Start an interactive shell
    async fn shell(&mut self) -> Result<()>;
}

/// File transfer protocol trait
///
/// For protocols that support file operations (SFTP, FTP, SCP)
#[async_trait]
pub trait FileTransferProtocol: Protocol {
    /// List directory contents
    async fn list_dir(&mut self, path: &str) -> Result<Vec<FileEntry>>;

    /// Download file
    async fn download(&mut self, remote_path: &str, local_path: &PathBuf) -> Result<()>;

    /// Upload file
    async fn upload(&mut self, local_path: &PathBuf, remote_path: &str) -> Result<()>;

    /// Delete file or directory
    async fn delete(&mut self, path: &str) -> Result<()>;

    /// Create directory
    async fn mkdir(&mut self, path: &str) -> Result<()>;
}

/// File entry for directory listings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    pub permissions: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_protocol_type_serialization() {
        let protocol = ProtocolType::Ssh;
        let json = serde_json::to_string(&protocol).unwrap();
        assert_eq!(json, "\"ssh\"");
    }

    #[test]
    fn test_connection_config() {
        let config = ConnectionConfig {
            protocol: ProtocolType::Ssh,
            hostname: "example.com".to_string(),
            port: 22,
            username: "user".to_string(),
            auth: AuthMethod::PublicKey {
                key_path: PathBuf::from("~/.ssh/id_ed25519"),
                passphrase: None,
            },
            jump_host: None,
            timeout: Some(30),
            keepalive: Some(60),
        };

        assert_eq!(config.protocol, ProtocolType::Ssh);
        assert_eq!(config.port, 22);
    }
}
