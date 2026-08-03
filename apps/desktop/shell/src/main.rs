//! rite-desktop — the native desktop shell (wry), multi-window (ADR 0014 phase 4).
//!
//! One process, one window per *context*: each window runs its own rite-server on
//! a random loopback port with a per-window bearer token (ADR 0009), and shows a
//! `wry` webview pointing at it. The server's active context lives in RAM per
//! instance (ADR 0012), so different windows can hold different contexts while
//! sharing the one SQLite vault (WAL). The in-process [`ContextRegistry`] enforces
//! one-window-per-context: opening a context that's already open focuses its
//! window instead of spawning a duplicate (no concurrent same-context state).
//!
//! The webview asks the shell to open a context by posting an IPC message
//! (`{type:'open-context', ...}`); the shell routes it through the registry on the
//! event-loop thread. Only one desktop process may run per user (fslock); startup
//! failures surface as a native dialog rather than a silent panic.

use anyhow::{Context, Result};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Window, WindowBuilder, WindowId};
use uuid::Uuid;
use wry::{WebView, WebViewBuilder};

use std::path::{Path, PathBuf};

mod context_registry;
mod vault_roster;
use context_registry::{ContextKey, ContextRegistry, OpenOutcome};

const DEFAULT_SIZE: (f64, f64) = (1200.0, 800.0);
const MIN_SIZE: (f64, f64) = (800.0, 600.0);

/// A request from a webview (or the launch) to open a context in a window.
struct OpenRequest {
    /// Identity for one-window-per-context dedup.
    key: ContextKey,
    /// The local vault this window's server opens (ADR 0014 multi-vault). A local
    /// context uses its chosen `.db`; a server context uses the default vault (the
    /// mux keeps its roster/settings there).
    db_path: PathBuf,
    /// The `window.__RITE_CONTEXT__` payload injected into the target window so its
    /// frontend knows which context to activate (`{"kind":"local"}` or a server).
    inject: String,
}

/// Custom event loop message: created off the event-loop thread (an IPC handler)
/// and handled on it (where windows may be built and the roster mutated).
enum UserEvent {
    OpenContext(OpenRequest),
    Vault(VaultCommand),
}

/// A live window: its server's loopback port, plus the `wry` webview and `tao`
/// window kept alive for the window's lifetime (dropping them closes it). The
/// webview is also used to push roster updates back into the hub (ADR 0014).
struct WindowState {
    webview: WebView,
    window: Window,
    #[allow(dead_code)]
    port: u16,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt().init();

    // Single instance: two *processes* would fight over the one SQLite vault. Hold
    // the lock for the whole process lifetime (multi-window lives inside it).
    let _lock = match acquire_instance_lock() {
        Ok(Some(lock)) => Some(lock),
        Ok(None) => {
            show_error(
                "Rite is already running",
                "Another Rite window is already open. Please use it instead.",
            );
            return Ok(());
        }
        Err(e) => {
            // Fail open: a lock-system error shouldn't strand the user.
            tracing::warn!("[rite-desktop] instance lock unavailable ({e}); proceeding");
            None
        }
    };

    // Set the Wayland app-id / X11 WM_CLASS on the event loop (WM grouping +
    // .desktop icon matching), and enable custom user events (IPC → open window).
    let event_loop = {
        let mut builder = EventLoopBuilder::<UserEvent>::with_user_event();
        #[cfg(target_os = "linux")]
        {
            use tao::platform::unix::EventLoopBuilderExtUnix;
            // Must be a valid GApplication id (reverse-DNS, at least one dot).
            builder.with_app_id("io.github.altagen.rite");
        }
        builder.build()
    };
    let proxy = event_loop.create_proxy();

    let mut registry = ContextRegistry::<WindowId>::new();
    let mut windows: std::collections::HashMap<WindowId, WindowState> = std::collections::HashMap::new();

    // Multi-vault roster (ADR 0014): remember the local vaults so the hub can list them.
    // Ensure the default vault is always present, then hand the snapshot to each window as
    // `window.__RITE_VAULTS__` (the hub reads it; management IPC lands in a follow-up).
    let mut roster = vault_roster::VaultRoster::load(roster_path());
    if !roster.contains(db_path()) {
        if let Err(e) = roster.add(db_path(), "Local vault") {
            tracing::warn!("[rite-desktop] could not seed the vault roster: {e}");
        }
    }
    let mut vaults_json = serde_json::to_string(roster.entries()).unwrap_or_else(|_| "[]".to_string());

    // The launch window shows the context hub (ADR 0014). Its server is the local
    // one, so it's registered as the local context — picking "local vault" in the
    // hub proceeds in this window; picking a server opens another window.
    let launch = OpenRequest {
        key: ContextKey::local(db_path()),
        db_path: db_path(),
        inject: r#"{"kind":"hub"}"#.to_string(),
    };
    if let Err(e) = open_window(&event_loop, &proxy, &mut windows, &mut registry, launch, &vaults_json) {
        show_error(
            "Rite failed to start",
            &format!("Could not open the vault or start the local server.\n\n{e:#}"),
        );
        return Err(e);
    }

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id: closed,
                ..
            } => {
                // Drop the window (and its webview); its server thread is torn down
                // in a later increment. The last window to close ends the process.
                windows.remove(&closed);
                registry.remove_window(&closed);
                if registry.is_empty() {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::UserEvent(UserEvent::OpenContext(req)) => {
                match registry.open(&req.key) {
                    // Already open → focus that window rather than duplicate it.
                    OpenOutcome::AlreadyOpen(id) => {
                        if let Some(w) = windows.get(&id) {
                            w.window.set_focus();
                        }
                    }
                    OpenOutcome::New => {
                        if let Err(e) = open_window(target, &proxy, &mut windows, &mut registry, req, &vaults_json) {
                            show_error(
                                "Could not open that context",
                                &format!("Rite couldn't open a window for this context.\n\n{e:#}"),
                            );
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::Vault(cmd)) => {
                if apply_vault_command(cmd, &mut roster, &proxy) {
                    // The roster changed: refresh every open window's hub (ADR 0014).
                    vaults_json =
                        serde_json::to_string(roster.entries()).unwrap_or_else(|_| "[]".to_string());
                    broadcast_vaults(&windows, &vaults_json);
                }
            }
            _ => {}
        }
    });
}

/// Start a server, build a window + webview for `req`, and register it. On success
/// the window is inserted into `windows` and its key into `registry` (so a failed
/// build leaves both untouched). The webview posts `open-context` IPC messages
/// back through `proxy`.
fn open_window(
    target: &EventLoopWindowTarget<UserEvent>,
    proxy: &EventLoopProxy<UserEvent>,
    windows: &mut std::collections::HashMap<WindowId, WindowState>,
    registry: &mut ContextRegistry<WindowId>,
    req: OpenRequest,
    vaults_json: &str,
) -> Result<()> {
    // Per-window token guarding this window's loopback server (ADR 0009). RAM only.
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let port = start_server(token.clone(), &req.db_path)?;
    let url = format!("http://127.0.0.1:{port}/");
    tracing::info!("[rite-desktop] window serving on {url}");

    let window = WindowBuilder::new()
        .with_title("Rite")
        .with_window_icon(load_icon())
        .with_inner_size(LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1))
        .with_min_inner_size(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1))
        .build(target)?;
    let window_id = window.id();

    // Inject the loopback token + the target context, then wire the IPC handler
    // that lets the frontend ask the shell to open another context in a window.
    let init = format!(
        "window.__RITE_TOKEN__ = '{token}'; window.__RITE_CONTEXT__ = {inject}; \
         window.__RITE_VAULTS__ = {vaults_json};",
        inject = req.inject,
    );
    let ipc_proxy = proxy.clone();
    let webview_builder = WebViewBuilder::new()
        .with_url(&url)
        .with_initialization_script(&init)
        .with_ipc_handler(move |request| handle_ipc(&ipc_proxy, request.into_body()));

    // On Linux, wry is GTK-based: it must be built into the window's GTK vbox, not
    // from a raw window handle. Other platforms use the window handle directly.
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window
            .default_vbox()
            .expect("tao provides a default GTK vbox on Linux");
        webview_builder.build_gtk(vbox)?
    };
    #[cfg(not(target_os = "linux"))]
    let webview = webview_builder.build(&window)?;

    registry.register(req.key, window_id);
    windows.insert(window_id, WindowState { webview, window, port });
    Ok(())
}

/// Parse an IPC message from a webview and route it. `open-context` opens/focuses a window;
/// `vault-*` messages manage the multi-vault roster. Malformed or unknown messages are logged
/// and ignored (a webview must never crash the shell).
fn handle_ipc(proxy: &EventLoopProxy<UserEvent>, body: String) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(&body) else {
        tracing::warn!("[rite-desktop] ignoring non-JSON IPC message");
        return;
    };
    if let Some(req) = parse_open_request(&msg, &db_path()) {
        if proxy.send_event(UserEvent::OpenContext(req)).is_err() {
            tracing::warn!("[rite-desktop] event loop gone; dropping open-context");
        }
        return;
    }
    if let Some(cmd) = plan_vault_command(&msg) {
        if proxy.send_event(UserEvent::Vault(cmd)).is_err() {
            tracing::warn!("[rite-desktop] event loop gone; dropping vault command");
        }
    }
}

/// A multi-vault management command (ADR 0014), decoded from an IPC message. Pure decision layer,
/// unit-tested; the shell executes it (native dialogs / roster edits) as thin glue.
#[derive(Debug, PartialEq)]
enum VaultCommand {
    /// Create a new vault. `path`/`label` absent ⇒ the shell shows a save dialog; present ⇒ use
    /// them directly (a test hook that bypasses the native picker so new/open stay automatable).
    New {
        label: Option<String>,
        path: Option<PathBuf>,
    },
    /// Open an existing `.db`. `path` absent ⇒ the shell shows an open dialog; present ⇒ use it.
    OpenFile { path: Option<PathBuf> },
    /// Relabel a known vault in the roster.
    Rename { path: PathBuf, label: String },
    /// Forget a vault from the roster (does NOT delete the file).
    Forget { path: PathBuf },
    /// Wipe a vault — erase its master password + all connections (irreversible). Reuses the
    /// existing reset flow; the frontend confirms before sending.
    Reset { path: PathBuf },
    /// Lock a vault in-session (clears its key from RAM; re-requires the master password).
    Lock { path: PathBuf },
}

/// Decode a `vault-*` management message, or `None` if it isn't one (or is malformed).
fn plan_vault_command(msg: &serde_json::Value) -> Option<VaultCommand> {
    let str_field = |k: &str| {
        msg.get(k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    match msg.get("type").and_then(|t| t.as_str())? {
        "vault-new" => Some(VaultCommand::New {
            label: str_field("label").map(String::from),
            path: str_field("path").map(PathBuf::from),
        }),
        "vault-open-file" => Some(VaultCommand::OpenFile {
            path: str_field("path").map(PathBuf::from),
        }),
        "vault-rename" => Some(VaultCommand::Rename {
            path: PathBuf::from(str_field("path")?),
            label: str_field("label")?.to_string(),
        }),
        "vault-forget" => Some(VaultCommand::Forget {
            path: PathBuf::from(str_field("path")?),
        }),
        "vault-reset" => Some(VaultCommand::Reset {
            path: PathBuf::from(str_field("path")?),
        }),
        "vault-lock" => Some(VaultCommand::Lock {
            path: PathBuf::from(str_field("path")?),
        }),
        _ => None,
    }
}

/// Parse an `open-context` IPC message into an [`OpenRequest`], or `None` if it isn't one
/// we act on. Pure (no event loop / no I/O) so it is unit-tested without a display.
///
/// - `local` with a `path` opens that vault (ADR 0014 multi-vault); without one, the default.
/// - `server` needs a `url`; the id/url/label pass through to the target window.
fn parse_open_request(msg: &serde_json::Value, default_db: &Path) -> Option<OpenRequest> {
    if msg.get("type").and_then(|t| t.as_str()) != Some("open-context") {
        return None;
    }
    match msg.get("kind").and_then(|k| k.as_str()) {
        Some("local") => {
            let path = msg
                .get("path")
                .and_then(|p| p.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| default_db.to_path_buf());
            Some(OpenRequest {
                key: ContextKey::local(&path),
                inject: serde_json::json!({ "kind": "local", "path": path.to_string_lossy() })
                    .to_string(),
                db_path: path,
            })
        }
        Some("server") => {
            let url = msg.get("url").and_then(|u| u.as_str())?;
            Some(OpenRequest {
                key: ContextKey::server(url),
                // Pass the roster id/url/label straight through for the target frontend to
                // activate; a server window keeps the mux's default local vault.
                inject: serde_json::json!({
                    "kind": "server",
                    "id": msg.get("id").and_then(|v| v.as_str()),
                    "url": url,
                    "label": msg.get("label").and_then(|v| v.as_str()),
                })
                .to_string(),
                db_path: default_db.to_path_buf(),
            })
        }
        other => {
            tracing::warn!("[rite-desktop] open-context with unknown kind {other:?}");
            None
        }
    }
}

/// Execute a vault-management command on the event-loop thread (ADR 0014). Returns whether the
/// roster changed, so the caller refreshes open hubs. New/OpenFile add to the roster and ask the
/// loop to open the vault in a window (via an OpenContext event); rename/forget mutate the roster
/// in place. Reset/Lock are Phase C — logged for now. `rfd` dialogs run here (GTK main thread);
/// the optional path on New/OpenFile is a test hook that bypasses the picker.
fn apply_vault_command(
    cmd: VaultCommand,
    roster: &mut vault_roster::VaultRoster,
    proxy: &EventLoopProxy<UserEvent>,
) -> bool {
    match cmd {
        VaultCommand::Rename { path, label } => roster.rename(&path, &label).unwrap_or(false),
        VaultCommand::Forget { path } => roster.remove(&path).unwrap_or(false),
        VaultCommand::New { label, path } => {
            let Some(p) = path.or_else(|| {
                rfd::FileDialog::new()
                    .set_title("Create a new Rite vault")
                    .set_file_name("vault.db")
                    .save_file()
            }) else {
                return false; // the user cancelled the dialog
            };
            let label = label.unwrap_or_else(|| vault_label_for(&p));
            let added = roster.add(&p, &label).unwrap_or(false);
            open_local_vault(&p, proxy);
            added
        }
        VaultCommand::OpenFile { path } => {
            let Some(p) = path.or_else(|| {
                rfd::FileDialog::new()
                    .set_title("Open a Rite vault")
                    .add_filter("Rite vault", &["db"])
                    .pick_file()
            }) else {
                return false;
            };
            let added = roster.add(&p, &vault_label_for(&p)).unwrap_or(false);
            open_local_vault(&p, proxy);
            added
        }
        VaultCommand::Reset { path } | VaultCommand::Lock { path } => {
            tracing::info!(
                "[rite-desktop] vault command for {} — Phase C executor pending",
                path.display()
            );
            false
        }
    }
}

/// Ask the event loop to open (or focus) a local-vault window at `path`.
fn open_local_vault(path: &Path, proxy: &EventLoopProxy<UserEvent>) {
    let req = OpenRequest {
        key: ContextKey::local(path),
        db_path: path.to_path_buf(),
        inject: serde_json::json!({ "kind": "local", "path": path.to_string_lossy() }).to_string(),
    };
    if proxy.send_event(UserEvent::OpenContext(req)).is_err() {
        tracing::warn!("[rite-desktop] event loop gone; couldn't open the vault window");
    }
}

/// A default human label for a vault path (the file stem, e.g. `beta.db` → "beta").
fn vault_label_for(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Vault".to_string())
}

/// Push the current roster into every open window's hub: update `window.__RITE_VAULTS__` and
/// fire `rite-vaults-changed` so the hub re-renders live (no reload).
fn broadcast_vaults(
    windows: &std::collections::HashMap<WindowId, WindowState>,
    vaults_json: &str,
) {
    let js = format!(
        "window.__RITE_VAULTS__ = {vaults_json}; \
         window.dispatchEvent(new Event('rite-vaults-changed'));"
    );
    for w in windows.values() {
        if let Err(e) = w.webview.evaluate_script(&js) {
            tracing::warn!("[rite-desktop] couldn't refresh a hub: {e}");
        }
    }
}

/// Start rite-server in a background thread (its own tokio runtime; the tao event
/// loop must own the main thread) and block until it binds, returning the port.
/// Startup errors are reported instead of panicking.
fn start_server(token: String, db_path: &Path) -> Result<u16> {
    let db_path = db_path.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel::<Result<u16, String>>();
    let tx_bound = tx.clone();
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                let _ = tx.send(Err(format!("tokio runtime: {e}")));
                return;
            }
        };
        rt.block_on(async move {
            let result = async {
                if let Some(parent) = db_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let state = rite_server::ServerState::new(&db_path)
                    .await
                    .context("open vault")?
                    .with_token(token);
                rite_server::serve(state, "127.0.0.1:0", move |port| {
                    let _ = tx_bound.send(Ok(port));
                })
                .await
                .context("serve")?;
                Ok::<(), anyhow::Error>(())
            }
            .await;
            if let Err(e) = result {
                let _ = tx.send(Err(format!("{e:#}")));
            }
        });
    });

    match rx.recv() {
        Ok(Ok(port)) => Ok(port),
        Ok(Err(msg)) => Err(anyhow::anyhow!(msg)),
        Err(_) => Err(anyhow::anyhow!("server thread exited before binding")),
    }
}

/// Acquire the single-instance lock. `Ok(Some)` = acquired, `Ok(None)` = another
/// instance holds it, `Err` = the lock system itself failed.
fn acquire_instance_lock() -> Result<Option<fslock::LockFile>> {
    let path = data_dir().join("rite.lock");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut lock = fslock::LockFile::open(&path)?;
    if lock.try_lock_with_pid()? {
        Ok(Some(lock))
    } else {
        Ok(None)
    }
}

/// Show a native error dialog (and log it). Best-effort.
fn show_error(title: &str, description: &str) {
    tracing::error!("[rite-desktop] {title}: {description}");
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(title)
        .set_description(description)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

/// The window icon, decoded from the bundled PNG. Best-effort: on Wayland the
/// taskbar icon comes from a `.desktop` file matched by app-id, so this mainly
/// affects X11 and the window itself.
fn load_icon() -> Option<tao::window::Icon> {
    let bytes = include_bytes!("../../../../assets/rite-icon-flat.png");
    let img = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (w, h) = img.dimensions();
    tao::window::Icon::from_rgba(img.into_raw(), w, h).ok()
}

fn data_dir() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("rite")
}

fn db_path() -> std::path::PathBuf {
    data_dir().join("vault.db")
}

/// Where the multi-vault roster is persisted (ADR 0014). Next to the vaults, not inside one.
fn roster_path() -> std::path::PathBuf {
    data_dir().join("vaults.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn default() -> PathBuf {
        PathBuf::from("/data/vault.db")
    }

    #[test]
    fn ignores_non_open_context() {
        assert!(parse_open_request(&json!({ "type": "other" }), &default()).is_none());
        assert!(parse_open_request(&json!({ "kind": "local" }), &default()).is_none());
    }

    #[test]
    fn local_without_path_uses_the_default_vault() {
        let req = parse_open_request(&json!({ "type": "open-context", "kind": "local" }), &default()).unwrap();
        assert_eq!(req.db_path, default());
        assert_eq!(req.key, ContextKey::local(default()));
    }

    #[test]
    fn local_with_path_opens_that_vault() {
        let req = parse_open_request(
            &json!({ "type": "open-context", "kind": "local", "path": "/vaults/work.db" }),
            &default(),
        )
        .unwrap();
        assert_eq!(req.db_path, PathBuf::from("/vaults/work.db"));
        assert_eq!(req.key, ContextKey::local("/vaults/work.db"));
        assert!(req.inject.contains("/vaults/work.db"));
    }

    #[test]
    fn blank_path_falls_back_to_default() {
        let req = parse_open_request(
            &json!({ "type": "open-context", "kind": "local", "path": "   " }),
            &default(),
        )
        .unwrap();
        assert_eq!(req.db_path, default());
    }

    #[test]
    fn server_needs_a_url_and_keeps_the_default_vault() {
        assert!(parse_open_request(&json!({ "type": "open-context", "kind": "server" }), &default()).is_none());
        let req = parse_open_request(
            &json!({ "type": "open-context", "kind": "server", "url": "https://rite.example.com", "label": "Team" }),
            &default(),
        )
        .unwrap();
        assert_eq!(req.key, ContextKey::server("https://rite.example.com"));
        assert_eq!(req.db_path, default()); // server window still uses the mux's local vault
    }

    #[test]
    fn unknown_kind_is_ignored() {
        assert!(parse_open_request(&json!({ "type": "open-context", "kind": "wat" }), &default()).is_none());
    }

    #[test]
    fn vault_command_new_and_open_file() {
        // Bare new/open → no path/label ⇒ the shell will show the native dialog.
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-new" })),
            Some(VaultCommand::New { label: None, path: None })
        );
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-open-file" })),
            Some(VaultCommand::OpenFile { path: None })
        );
    }

    #[test]
    fn vault_command_new_open_accept_a_path_hook() {
        // The test/automation hook: a path (and label) bypass the native picker.
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-new", "label": "Beta", "path": "/v/beta.db" })),
            Some(VaultCommand::New { label: Some("Beta".into()), path: Some(PathBuf::from("/v/beta.db")) })
        );
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-open-file", "path": "/v/x.db" })),
            Some(VaultCommand::OpenFile { path: Some(PathBuf::from("/v/x.db")) })
        );
    }

    #[test]
    fn vault_command_reset_and_lock_need_path() {
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-reset", "path": "/v/a.db" })),
            Some(VaultCommand::Reset { path: PathBuf::from("/v/a.db") })
        );
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-lock", "path": "/v/a.db" })),
            Some(VaultCommand::Lock { path: PathBuf::from("/v/a.db") })
        );
        assert!(plan_vault_command(&json!({ "type": "vault-reset" })).is_none());
        assert!(plan_vault_command(&json!({ "type": "vault-lock" })).is_none());
    }

    #[test]
    fn vault_command_rename_needs_path_and_label() {
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-rename", "path": "/v/a.db", "label": "Work" })),
            Some(VaultCommand::Rename { path: PathBuf::from("/v/a.db"), label: "Work".into() })
        );
        // Missing/blank fields → not a valid command.
        assert!(plan_vault_command(&json!({ "type": "vault-rename", "path": "/v/a.db" })).is_none());
        assert!(plan_vault_command(&json!({ "type": "vault-rename", "path": "/v/a.db", "label": "  " })).is_none());
    }

    #[test]
    fn vault_command_forget_needs_path() {
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-forget", "path": "/v/a.db" })),
            Some(VaultCommand::Forget { path: PathBuf::from("/v/a.db") })
        );
        assert!(plan_vault_command(&json!({ "type": "vault-forget" })).is_none());
    }

    #[test]
    fn non_vault_messages_are_not_commands() {
        assert!(plan_vault_command(&json!({ "type": "open-context", "kind": "local" })).is_none());
        assert!(plan_vault_command(&json!({ "type": "whatever" })).is_none());
    }
}
