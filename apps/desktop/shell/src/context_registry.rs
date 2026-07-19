//! In-process registry of open contexts (ADR 0014 phase 4, Option C).
//!
//! One desktop process may show several windows, but **never two on the same
//! context** — two windows on the same local vault would mean concurrent SQLite
//! access, and two on the same server would mean duplicate sessions. The registry
//! maps a normalized [`ContextKey`] to the window showing it, so "open a context"
//! either focuses the window that already has it or reports that a new window
//! must be created.
//!
//! It is pure bookkeeping, generic over the window id, so it is fully unit-tested
//! without a display; the shell instantiates it with `tao::window::WindowId`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// What a window is showing. Two windows may never share one key.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum ContextKey {
    /// The local offline vault at this DB path (native only).
    Local(PathBuf),
    /// A remote server, keyed by its normalized origin (see [`ContextKey::server`]).
    Server(String),
}

impl ContextKey {
    /// The local vault at `db_path`. Canonicalized when the file exists so that
    /// two spellings of the same path (`./x` vs an absolute path, a symlink) map
    /// to one key; falls back to the path as-given before the vault is created.
    pub fn local(db_path: impl AsRef<Path>) -> Self {
        let p = db_path.as_ref();
        ContextKey::Local(std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()))
    }

    /// A remote server keyed by origin. Normalizes so trivially different
    /// spellings of the same endpoint collapse to one key: trims surrounding
    /// whitespace, lowercases the scheme+host, and drops any trailing slashes and
    /// empty path (`HTTPS://Rite.Example.com/` → `https://rite.example.com`). A
    /// string with no `scheme://` is lowercased and trimmed as-is.
    pub fn server(url: &str) -> Self {
        let trimmed = url.trim();
        let key = match trimmed.split_once("://") {
            Some((scheme, rest)) => {
                // Split host[:port] from the path; normalize the authority only.
                let (authority, _path) = rest.split_once('/').unwrap_or((rest, ""));
                format!("{}://{}", scheme.to_ascii_lowercase(), authority.to_ascii_lowercase())
            }
            None => trimmed.trim_end_matches('/').to_ascii_lowercase(),
        };
        ContextKey::Server(key)
    }
}

/// The result of asking the registry to open a context.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenOutcome<Id> {
    /// Not open yet — the caller should create a window, then [`register`] it.
    ///
    /// [`register`]: ContextRegistry::register
    New,
    /// Already open in this window — the caller should focus it, not open another.
    AlreadyOpen(Id),
}

/// Tracks which context each window is showing, one window per context.
pub struct ContextRegistry<Id> {
    open: HashMap<ContextKey, Id>,
}

impl<Id> Default for ContextRegistry<Id> {
    fn default() -> Self {
        Self { open: HashMap::new() }
    }
}

impl<Id: Clone + PartialEq> ContextRegistry<Id> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decide how to open `key`: focus the existing window, or signal that a new
    /// one is needed. Does **not** mutate — on [`OpenOutcome::New`] the caller
    /// creates the window and calls [`register`] with its id (so a failed window
    /// creation leaves the registry clean).
    ///
    /// [`register`]: ContextRegistry::register
    pub fn open(&self, key: &ContextKey) -> OpenOutcome<Id> {
        match self.open.get(key) {
            Some(id) => OpenOutcome::AlreadyOpen(id.clone()),
            None => OpenOutcome::New,
        }
    }

    /// Record that `key` is now shown in window `id`. Overwrites any stale entry
    /// for the key (there can only be one window per context).
    pub fn register(&mut self, key: ContextKey, id: Id) {
        self.open.insert(key, id);
    }

    /// Forget a window (on close), whatever context it held. Safe to call for an
    /// id that was never registered.
    pub fn remove_window(&mut self, id: &Id) {
        self.open.retain(|_, v| v != id);
    }

    /// The context `id` currently holds, if any. (Focus/hub bookkeeping, phase 4b.)
    #[allow(dead_code)]
    pub fn context_of(&self, id: &Id) -> Option<&ContextKey> {
        self.open.iter().find_map(|(k, v)| (v == id).then_some(k))
    }

    /// No windows are open — the caller may exit the process.
    pub fn is_empty(&self) -> bool {
        self.open.is_empty()
    }

    /// How many contexts (windows) are open. (Hub state, phase 4b.)
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.open.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_key_normalizes_scheme_host_and_trailing_slash() {
        assert_eq!(ContextKey::server("https://rite.example.com"), ContextKey::server("HTTPS://Rite.Example.com/"));
        assert_eq!(ContextKey::server("https://rite.example.com"), ContextKey::server("  https://rite.example.com//  "));
        // The port is part of the origin: different ports are different contexts.
        assert_ne!(ContextKey::server("https://x.com:1"), ContextKey::server("https://x.com:2"));
        // A path does not distinguish an origin (the server is the same endpoint).
        assert_eq!(ContextKey::server("https://x.com/a"), ContextKey::server("https://x.com/b"));
    }

    #[test]
    fn open_reports_new_then_focus_after_register() {
        let mut reg: ContextRegistry<u64> = ContextRegistry::new();
        let key = ContextKey::server("https://a.example");
        assert_eq!(reg.open(&key), OpenOutcome::New);
        // `open` alone does not mutate.
        assert!(reg.is_empty());

        reg.register(key.clone(), 1);
        assert_eq!(reg.open(&key), OpenOutcome::AlreadyOpen(1));
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn distinct_contexts_get_distinct_windows() {
        let mut reg: ContextRegistry<u64> = ContextRegistry::new();
        reg.register(ContextKey::server("https://a.example"), 1);
        reg.register(ContextKey::Local(PathBuf::from("/data/vault.db")), 2);
        assert_eq!(reg.len(), 2);
        assert_eq!(reg.open(&ContextKey::server("https://a.example")), OpenOutcome::AlreadyOpen(1));
        assert_eq!(reg.open(&ContextKey::Local(PathBuf::from("/data/vault.db"))), OpenOutcome::AlreadyOpen(2));
    }

    #[test]
    fn removing_a_window_frees_its_context() {
        let mut reg: ContextRegistry<u64> = ContextRegistry::new();
        let key = ContextKey::server("https://a.example");
        reg.register(key.clone(), 7);
        assert_eq!(reg.context_of(&7), Some(&key));

        reg.remove_window(&7);
        assert!(reg.is_empty());
        // The freed context can be opened afresh (e.g. reopened in a new window).
        assert_eq!(reg.open(&key), OpenOutcome::New);
        // Removing an unknown id is a no-op.
        reg.remove_window(&999);
    }

    #[test]
    fn reregistering_a_key_moves_it_to_the_new_window() {
        let mut reg: ContextRegistry<u64> = ContextRegistry::new();
        let key = ContextKey::Local(PathBuf::from("/data/vault.db"));
        reg.register(key.clone(), 1);
        reg.register(key.clone(), 2); // same context, new window id
        assert_eq!(reg.len(), 1);
        assert_eq!(reg.open(&key), OpenOutcome::AlreadyOpen(2));
        assert_eq!(reg.context_of(&1), None);
    }
}
