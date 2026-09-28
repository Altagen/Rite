//! Persistent roster of local vault files (ADR 0014 multi-vault). The desktop shell
//! remembers the set of `.db` vaults the user has so the hub can list them and open any
//! one in a window. Stored as JSON in the data dir, separate from any vault (a vault
//! can't list itself — chicken-and-egg), and tolerant of a missing/corrupt file (treated
//! as empty; a bad roster never strands the user out of their vaults).
//!
//! Pure bookkeeping over a file path, so it is fully unit-tested without a display.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VaultEntry {
    pub path: PathBuf,
    pub label: String,
    /// Optional device-local icon (ADR 0014): an emoji ("🚀") or a `data:` image URI. Absent ⇒
    /// the default lock glyph. Kept in the roster so it's per-device, not synced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug)]
pub struct VaultRoster {
    file: PathBuf,
    entries: Vec<VaultEntry>,
}

impl VaultRoster {
    /// Load the roster from `file`; a missing or unreadable/corrupt file yields an empty one.
    pub fn load(file: impl Into<PathBuf>) -> Self {
        let file = file.into();
        let entries = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<VaultEntry>>(&s).ok())
            .unwrap_or_default();
        Self { file, entries }
    }

    pub fn entries(&self) -> &[VaultEntry] {
        &self.entries
    }

    /// Add a vault, or update its label if the path is already known (idempotent on path).
    /// Returns whether anything changed; persists on change.
    pub fn add(&mut self, path: impl AsRef<Path>, label: &str) -> std::io::Result<bool> {
        let path = normalize(path.as_ref());
        if let Some(e) = self.entries.iter_mut().find(|e| e.path == path) {
            if e.label == label {
                return Ok(false);
            }
            e.label = label.to_string();
        } else {
            self.entries.push(VaultEntry {
                path,
                label: label.to_string(),
                icon: None,
            });
        }
        self.save()?;
        Ok(true)
    }

    /// Set (or clear, with `None`) a vault's device-local icon. Returns whether it existed.
    pub fn set_icon(
        &mut self,
        path: impl AsRef<Path>,
        icon: Option<String>,
    ) -> std::io::Result<bool> {
        let path = normalize(path.as_ref());
        let Some(e) = self.entries.iter_mut().find(|e| e.path == path) else {
            return Ok(false);
        };
        e.icon = icon;
        self.save()?;
        Ok(true)
    }

    /// Rename a known vault. Returns whether it existed; persists on change.
    pub fn rename(&mut self, path: impl AsRef<Path>, label: &str) -> std::io::Result<bool> {
        let path = normalize(path.as_ref());
        let Some(e) = self.entries.iter_mut().find(|e| e.path == path) else {
            return Ok(false);
        };
        e.label = label.to_string();
        self.save()?;
        Ok(true)
    }

    /// Forget a vault (does NOT delete the `.db` file — that's a separate "reset").
    pub fn remove(&mut self, path: impl AsRef<Path>) -> std::io::Result<bool> {
        let path = normalize(path.as_ref());
        let before = self.entries.len();
        self.entries.retain(|e| e.path != path);
        if self.entries.len() == before {
            return Ok(false);
        }
        self.save()?;
        Ok(true)
    }

    pub fn contains(&self, path: impl AsRef<Path>) -> bool {
        let path = normalize(path.as_ref());
        self.entries.iter().any(|e| e.path == path)
    }

    fn save(&self) -> std::io::Result<()> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&self.entries)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(&self.file, json)
    }
}

/// Canonicalize when the file exists (so two spellings of one vault collapse), else use
/// the path as given — mirrors `ContextKey::local` so roster and context keys agree.
fn normalize(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A unique, non-existent roster-file path under the temp dir (no tempfile dep).
    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("rite-roster-{}", uuid::Uuid::new_v4().simple()))
    }

    #[test]
    fn missing_file_is_empty() {
        let r = VaultRoster::load(scratch());
        assert!(r.entries().is_empty());
    }

    #[test]
    fn add_persists_and_reloads() {
        let dir = scratch();
        let file = dir.join("vaults.json");
        let a = dir.join("work.db");
        {
            let mut r = VaultRoster::load(&file);
            assert!(r.add(&a, "Work").unwrap());
            assert!(r.contains(&a));
            assert!(!r.add(&a, "Work").unwrap()); // idempotent on (path,label)
        }
        // A fresh load sees the persisted entry.
        let r = VaultRoster::load(&file);
        assert_eq!(r.entries().len(), 1);
        assert_eq!(r.entries()[0].label, "Work");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn add_same_path_updates_label() {
        let file = scratch();
        let mut r = VaultRoster::load(&file);
        r.add("/v/a.db", "Old").unwrap();
        assert!(r.add("/v/a.db", "New").unwrap());
        assert_eq!(r.entries().len(), 1);
        assert_eq!(r.entries()[0].label, "New");
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn rename_and_remove() {
        let file = scratch();
        let mut r = VaultRoster::load(&file);
        r.add("/v/a.db", "A").unwrap();
        assert!(r.rename("/v/a.db", "AA").unwrap());
        assert_eq!(r.entries()[0].label, "AA");
        assert!(!r.rename("/v/missing.db", "X").unwrap());
        assert!(r.remove("/v/a.db").unwrap());
        assert!(r.entries().is_empty());
        assert!(!r.remove("/v/a.db").unwrap());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn corrupt_file_loads_empty() {
        let file = scratch();
        std::fs::write(&file, "not json at all").unwrap();
        let r = VaultRoster::load(&file);
        assert!(r.entries().is_empty());
        std::fs::remove_file(&file).ok();
    }
}
