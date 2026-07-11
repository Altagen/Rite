//! rite-core — the UI-agnostic core of Rite.
//!
//! Holds the backend logic shared by every delivery shell: the encrypted vault
//! (auth + connections + SQLite), SSH host-key verification, and SSH-config
//! parsing. No UI and no Tauri here — the Tauri app (and, later, rite-server)
//! depend on this crate and provide the transport/UI on top.

pub mod auth;
pub mod connection;
pub mod connections_manager;
pub mod db;
pub mod known_hosts;
pub mod ssh_config;
