//! rite-core — the UI-agnostic core of Rite.
//!
//! Holds the backend logic shared by every delivery shell: the encrypted vault
//! (auth + connections + SQLite), SSH host-key verification, and SSH-config
//! parsing. No UI here — the shells (rite-server and the wry desktop client)
//! depend on this crate and provide the transport/UI on top.

pub mod auth;
pub mod collection_crypto;
pub mod collection_store;
pub mod connection;
pub mod connections_manager;
pub mod db;
pub mod enrollment;
pub mod events;
pub mod known_hosts;
pub mod library_store;
pub mod local_terminal;
pub mod server_auth;
pub mod ssh_config;
pub mod teams;
pub mod terminal;
pub mod vault_store;
