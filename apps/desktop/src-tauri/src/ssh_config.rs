/**
 * SSH Config Parser Module
 *
 * Parses OpenSSH config files and converts them to Rite connections
 */
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::connection::{AuthMethod, CreateConnectionInput};

/// Parsed SSH config entry
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigEntry {
    pub host: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub server_alive_interval: Option<u32>,
}

impl SshConfigEntry {
    /// Convert to ConnectionInfo preview (for UI selection)
    pub fn to_preview(&self) -> String {
        let hostname = self
            .hostname
            .as_ref()
            .unwrap_or(&self.host);
        let user = self
            .user
            .as_ref()
            .map(|u| format!("{}@", u))
            .unwrap_or_default();
        let port = if let Some(p) = self.port {
            if p != 22 {
                format!(":{}", p)
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        format!("{}{}{}", user, hostname, port)
    }

    /// Convert to CreateConnectionInput (for import)
    pub fn to_connection_input(&self) -> CreateConnectionInput {
        let hostname = self
            .hostname
            .clone()
            .unwrap_or_else(|| self.host.clone());

        let username = self
            .user
            .clone()
            .unwrap_or_else(|| "root".to_string());

        let port = self.port.unwrap_or(22);

        // Determine auth method
        let auth_method = if let Some(identity_file) = &self.identity_file {
            // Expand ~ to home directory
            let key_path = expand_tilde(identity_file);
            AuthMethod::PublicKey {
                key_path,
                passphrase: None, // User will be prompted if needed
            }
        } else {
            // Default to password auth with empty password
            AuthMethod::Password {
                password: String::new(),
            }
        };

        // Convert server_alive_interval to seconds (if present)
        let ssh_keep_alive_interval = self
            .server_alive_interval
            .map(|seconds| seconds as i64);

        CreateConnectionInput {
            name: self.host.clone(),
            protocol: "ssh".to_string(),
            hostname,
            port,
            username,
            auth_method,
            color: None,
            icon: None,
            folder: None,
            notes: Some("Imported from SSH config".to_string()),
            ssh_keep_alive_override: if ssh_keep_alive_interval.is_some() {
                Some("enabled".to_string())
            } else {
                None
            },
            ssh_keep_alive_interval,
        }
    }
}

/// Parse SSH config file
pub fn parse_ssh_config<P: AsRef<Path>>(config_path: P) -> Result<Vec<SshConfigEntry>> {
    let content = fs::read_to_string(&config_path)
        .with_context(|| format!("Failed to read SSH config file: {:?}", config_path.as_ref()))?;

    let mut entries = Vec::new();
    let mut current_host: Option<String> = None;
    let mut current_props: HashMap<String, String> = HashMap::new();

    for line in content.lines() {
        let line = line.trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // Parse key-value pairs
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        let key = parts[0].to_lowercase();
        let value = parts[1..].join(" ");

        match key.as_str() {
            "host" => {
                // Save previous host if exists
                if let Some(host) = current_host.take() {
                    if let Some(entry) = build_entry(host, &current_props) {
                        entries.push(entry);
                    }
                    current_props.clear();
                }
                current_host = Some(value);
            }
            "hostname" => {
                current_props.insert("hostname".to_string(), value);
            }
            "user" => {
                current_props.insert("user".to_string(), value);
            }
            "port" => {
                current_props.insert("port".to_string(), value);
            }
            "identityfile" => {
                // Take first identity file only for MVP
                current_props.entry("identityfile".to_string())
                    .or_insert(value);
            }
            "serveraliveinterval" => {
                current_props.insert("serveraliveinterval".to_string(), value);
            }
            _ => {
                // Ignore other directives for MVP
            }
        }
    }

    // Save last host
    if let Some(host) = current_host {
        if let Some(entry) = build_entry(host, &current_props) {
            entries.push(entry);
        }
    }

    Ok(entries)
}

/// Build SshConfigEntry from parsed properties
fn build_entry(host: String, props: &HashMap<String, String>) -> Option<SshConfigEntry> {
    // Skip wildcard hosts for MVP
    if host.contains('*') || host.contains('?') {
        return None;
    }

    Some(SshConfigEntry {
        host: host.clone(),
        hostname: props.get("hostname").cloned(),
        user: props.get("user").cloned(),
        port: props
            .get("port")
            .and_then(|p| p.parse::<u16>().ok()),
        identity_file: props.get("identityfile").cloned(),
        server_alive_interval: props
            .get("serveraliveinterval")
            .and_then(|s| s.parse::<u32>().ok()),
    })
}

/// Expand ~ to home directory
fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return path.replacen("~", &home.to_string_lossy(), 1);
        }
    }
    path.to_string()
}

/// Get default SSH config path
pub fn get_default_ssh_config_path() -> String {
    if let Some(home) = std::env::var_os("HOME") {
        format!("{}/.ssh/config", home.to_string_lossy())
    } else {
        "~/.ssh/config".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_host() {
        let config = r#"
Host myserver
    HostName 192.168.1.100
    User admin
    Port 2222
"#;

        let path = "/tmp/test_ssh_config";
        fs::write(path, config).unwrap();

        let entries = parse_ssh_config(path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "myserver");
        assert_eq!(entries[0].hostname, Some("192.168.1.100".to_string()));
        assert_eq!(entries[0].user, Some("admin".to_string()));
        assert_eq!(entries[0].port, Some(2222));

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn test_parse_with_identity_file() {
        let config = r#"
Host production
    HostName prod.example.com
    User deploy
    IdentityFile ~/.ssh/prod_key
"#;

        let path = "/tmp/test_ssh_config2";
        fs::write(path, config).unwrap();

        let entries = parse_ssh_config(path).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].identity_file.is_some());

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn test_skip_wildcards() {
        let config = r#"
Host production-*
    User deploy

Host myserver
    HostName 192.168.1.100
"#;

        let path = "/tmp/test_ssh_config3";
        fs::write(path, config).unwrap();

        let entries = parse_ssh_config(path).unwrap();
        // Should skip production-* but include myserver
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "myserver");

        fs::remove_file(path).unwrap();
    }
}
