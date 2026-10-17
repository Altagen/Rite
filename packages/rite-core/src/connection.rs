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
use rite_crypto::{EncryptedData, decrypt, encrypt};

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

    // Inherent method kept (not a FromStr impl) to avoid touching call sites
    // during the rite-core extraction; converting to FromStr is a future cleanup.
    #[allow(clippy::should_implement_trait)]
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
///
/// `Debug` is hand-written below: this enum holds the only plaintext secrets Rite ever
/// has, and a derived `Debug` would print them the first time anyone adds a log line.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    PublicKey {
        /// The browser sends `keyPath`; `rename_all` on an enum renames variants,
        /// not their fields, so this has to be spelled out. `alias` keeps any
        /// credentials already stored under the snake_case spelling readable.
        #[serde(rename = "keyPath", alias = "key_path")]
        key_path: String,
        /// Omitted when absent, as the browser does — `passphrase?: string` simply
        /// disappears from JSON.stringify, so skipping it keeps a record written on
        /// either side byte-identical rather than merely equivalent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        passphrase: Option<String>,
    },
    /// A private key carried in the record itself, rather than named on disk (ADR 0024).
    ///
    /// `key_path` above is read by whichever process opens SSH. On a desktop that is the
    /// person's own machine and a path is the better answer — the key stays on their disk.
    /// On a shared server it is the server's container, where a browser cannot put a file
    /// and anything an administrator puts is one credential for every account that can
    /// read the path. So the web UI carries the key instead.
    ///
    /// This lives inside the encrypted credentials like every other variant
    /// (`encrypt_credentials` serialises the whole enum), so ADR 0011 holds by
    /// construction: there is no plaintext column it could land in by accident.
    VaultKey {
        /// The private key's text, exactly as the file held it — still encrypted by its
        /// own passphrase if it had one.
        key: String,
        /// Omitted when absent, like the variant above: a passphrase the member chose not
        /// to store is asked for at connect time and never written here.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        passphrase: Option<String>,
    },
    /// Authenticate via a running SSH agent (`SSH_AUTH_SOCK`). The private key
    /// never leaves the agent — this is also the only way to use hardware keys
    /// (FIDO/PIV). Nothing secret is stored by Rite.
    Agent {
        /// SHA256 fingerprint of a specific agent identity to offer; `None`
        /// offers every identity the agent holds, like `ssh`.
        identity: Option<String>,
        /// Request agent forwarding so the remote host can reuse the agent.
        #[serde(default)]
        forward: bool,
    },
}

impl AuthMethod {
    /// The name the clients know this method by.
    ///
    /// One function, because three places computed it by hand — `to_info` here,
    /// `vault_conn::auth_type` and `LocalMachine::from_stored` — and a fourth variant had
    /// to be added to each of them. Now a new variant is one edit the compiler points at.
    pub fn type_str(&self) -> &'static str {
        match self {
            AuthMethod::Password { .. } => "password",
            AuthMethod::PublicKey { .. } => "publicKey",
            AuthMethod::VaultKey { .. } => "vaultKey",
            AuthMethod::Agent { .. } => "agent",
        }
    }
}

/// Says which method, and the shape of what it holds — never the bytes.
///
/// Hand-written because the derived version printed the password, the passphrase and (with
/// `VaultKey`) a whole private key. Nothing logs an `AuthMethod` today, but that is a fact
/// about the current call sites and not about the type: a `debug!("{auth:?}")` added in a
/// year would have put a key in the server's log, which is the one place ADR 0011 promises
/// a secret never reaches. A path is kept — it names a file, it is not its contents.
impl std::fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthMethod::Password { .. } => f.write_str("Password(<redacted>)"),
            AuthMethod::PublicKey {
                key_path,
                passphrase,
            } => write!(
                f,
                "PublicKey {{ key_path: {key_path:?}, passphrase: {} }}",
                if passphrase.is_some() { "<redacted>" } else { "none" }
            ),
            AuthMethod::VaultKey { key, passphrase } => write!(
                f,
                "VaultKey {{ key: <redacted {} bytes>, passphrase: {} }}",
                key.len(),
                if passphrase.is_some() { "<redacted>" } else { "none" }
            ),
            AuthMethod::Agent { identity, forward } => write!(
                f,
                "Agent {{ identity: {identity:?}, forward: {forward} }}"
            ),
        }
    }
}

/// Connection metadata (not encrypted)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionMetadata {
    pub color: Option<String>,
    pub icon: Option<String>,
    pub folder: Option<String>,
    pub notes: Option<String>,
}

fn default_forward_type() -> String {
    "local".to_string()
}

/// A saved port-forward config on a connection. Started/stopped at runtime by the
/// session manager; persisted as JSON (non-secret metadata). MVP = "local".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardConfig {
    /// Forward kind — "local" for the MVP ("remote"/"dynamic" reserved for later).
    #[serde(default = "default_forward_type")]
    pub forward_type: String,
    /// Local bind host; `None` ⇒ 127.0.0.1.
    #[serde(default)]
    pub bind_host: Option<String>,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
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
    pub preconnect: Option<String>,              // pre-connect hook: local command, NULL = none
    pub jump: Option<String>, // jump host: id of another connection, NULL = direct
    pub forwards: Vec<PortForwardConfig>, // saved port forwards (JSON-persisted)
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
    pub preconnect: Option<String>,              // pre-connect hook: local command, NULL = none
    pub jump: Option<String>, // jump host: id of another connection, NULL = direct
    #[serde(default)]
    pub forwards: Vec<PortForwardConfig>, // saved port forwards
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
    pub preconnect: Option<String>,              // pre-connect hook: local command
    pub jump: Option<String>,                    // jump host: id of another connection
    #[serde(default)]
    pub forwards: Option<Vec<PortForwardConfig>>, // saved port forwards
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
    pub preconnect: Option<Option<String>>,              // Nested Option to allow clearing
    pub jump: Option<Option<String>>,                    // Nested Option to allow clearing
    #[serde(default)]
    pub forwards: Option<Vec<PortForwardConfig>>, // Some ⇒ replace the whole list
    /// Drop the stored key passphrase, keeping everything else about the key (ADR 0024 §4).
    ///
    /// Needed because a client editing a machine does not hold its secrets: it cannot send
    /// an `auth_method` with the passphrase removed, since it never had the key. Without
    /// it, unticking "remember this passphrase" changed nothing — the update omitted
    /// `auth_method`, so the stored one was kept, passphrase included.
    ///
    /// Honoured where this struct is actually applied: `vault_conn::merge_update` (a
    /// desktop editing a machine on a server) and `local_collections::patch_machine` (its
    /// own vault). `Connection::update` below does not read it, because no route has
    /// called `ConnectionsManager` since ADR 0018 moved local vaults into collections —
    /// handling it there would be code no test could reach.
    #[serde(default)]
    pub forget_passphrase: bool,
}

impl AuthMethod {
    /// Whether a key passphrase is kept with this method.
    ///
    /// Not a secret — it is the difference between "this key has no passphrase" and "it
    /// has one and Rite holds it", which the form has to show or its checkbox lies.
    pub fn has_stored_passphrase(&self) -> bool {
        match self {
            AuthMethod::PublicKey { passphrase, .. } | AuthMethod::VaultKey { passphrase, .. } => {
                passphrase.is_some()
            }
            _ => false,
        }
    }

    /// The same method with no passphrase kept.
    pub fn without_passphrase(self) -> Self {
        match self {
            AuthMethod::PublicKey { key_path, .. } => AuthMethod::PublicKey {
                key_path,
                passphrase: None,
            },
            AuthMethod::VaultKey { key, .. } => AuthMethod::VaultKey {
                key,
                passphrase: None,
            },
            other => other,
        }
    }
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
            preconnect: input.preconnect.filter(|s| !s.trim().is_empty()),
            jump: input.jump.filter(|s| !s.trim().is_empty()),
            forwards: input.forwards.unwrap_or_default(),
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
        let auth_type = self.auth_method.type_str().to_string();

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
            preconnect: self.preconnect.clone(),
            jump: self.jump.clone(),
            forwards: self.forwards.clone(),
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
        if let Some(preconnect) = input.preconnect {
            self.preconnect = preconnect.filter(|s| !s.trim().is_empty());
        }
        if let Some(jump) = input.jump {
            self.jump = jump.filter(|s| !s.trim().is_empty());
        }
        if let Some(forwards) = input.forwards {
            self.forwards = forwards;
        }

        self.updated_at = Utc::now().timestamp_millis();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-KEY-BYTES-DO-NOT-LEAK\n";

    fn vault_key_connection() -> Connection {
        Connection::new(CreateConnectionInput {
            name: "scaleway".into(),
            protocol: "ssh".into(),
            hostname: "10.0.0.9".into(),
            port: 22,
            username: "root".into(),
            auth_method: AuthMethod::VaultKey {
                key: MARKER.into(),
                passphrase: Some("PASSPHRASE-DO-NOT-LEAK".into()),
            },
            color: None,
            icon: None,
            folder: None,
            notes: None,
            ssh_keep_alive_override: None,
            ssh_keep_alive_interval: None,
            preconnect: None,
            jump: None,
            forwards: None,
        })
        .expect("a connection")
    }

    /// The point of ADR 0024 §1: a carried key is inside the encrypted credentials, so it
    /// inherits ADR 0011 rather than relying on anyone remembering to encrypt it.
    ///
    /// Asserted on the ciphertext, not on the shape of the code: searching the bytes for
    /// the key is the only form of this claim that a future refactor cannot quietly break.
    #[test]
    fn a_carried_key_is_only_ever_in_the_ciphertext() {
        let conn = vault_key_connection();
        let master = MasterKey::derive("test-password", b"0123456789abcdef").expect("key");
        let (ciphertext, nonce) = conn.encrypt_credentials(&master).expect("encrypted");

        let needle = MARKER.as_bytes();
        assert!(
            !ciphertext.windows(needle.len()).any(|w| w == needle),
            "the key's bytes appear in what is stored"
        );
        let pass = b"PASSPHRASE-DO-NOT-LEAK";
        assert!(
            !ciphertext.windows(pass.len()).any(|w| w == pass),
            "the passphrase's bytes appear in what is stored"
        );

        // …and it is genuinely there, so the assertions above are not passing on an empty
        // blob: the round trip returns exactly what went in.
        match Connection::decrypt_credentials(&ciphertext, &nonce, &master).expect("decrypted") {
            AuthMethod::VaultKey { key, passphrase } => {
                assert_eq!(key, MARKER);
                assert_eq!(passphrase.as_deref(), Some("PASSPHRASE-DO-NOT-LEAK"));
            }
            other => panic!("round-tripped into {other:?}"),
        }
    }

    /// What the client is told about a stored key: which method, never the key.
    #[test]
    fn the_info_a_client_gets_names_the_method_and_nothing_secret() {
        let info = vault_key_connection().to_info();
        assert_eq!(info.auth_type, "vaultKey");
        let rendered = format!("{info:?}");
        assert!(!rendered.contains("SECRET-KEY-BYTES"), "info carries the key: {rendered}");
        assert!(!rendered.contains("PASSPHRASE-DO-NOT-LEAK"), "info carries the passphrase");
    }

    /// `Debug` is the leak that has not happened yet: nothing logs an `AuthMethod` today,
    /// which is a fact about today's call sites and not about the type.
    #[test]
    fn debug_prints_the_method_and_never_the_secret() {
        let key = AuthMethod::VaultKey {
            key: MARKER.into(),
            passphrase: Some("PASSPHRASE-DO-NOT-LEAK".into()),
        };
        let rendered = format!("{key:?}");
        assert!(rendered.starts_with("VaultKey"), "it still says which method: {rendered}");
        assert!(!rendered.contains("SECRET-KEY-BYTES"), "the key is printed: {rendered}");
        assert!(!rendered.contains("PASSPHRASE-DO-NOT-LEAK"), "the passphrase is printed");

        let password = AuthMethod::Password { password: "PASSPHRASE-DO-NOT-LEAK".into() };
        assert!(!format!("{password:?}").contains("PASSPHRASE-DO-NOT-LEAK"));

        // A path names a file; it is not its contents, and losing it from a log would cost
        // the one thing these lines are read for.
        let on_disk = AuthMethod::PublicKey {
            key_path: "/home/me/.ssh/id_ed25519".into(),
            passphrase: Some("PASSPHRASE-DO-NOT-LEAK".into()),
        };
        let rendered = format!("{on_disk:?}");
        assert!(rendered.contains("/home/me/.ssh/id_ed25519"), "the path is kept: {rendered}");
        assert!(!rendered.contains("PASSPHRASE-DO-NOT-LEAK"), "the passphrase is printed");
    }
}
