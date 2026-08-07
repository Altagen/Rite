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
use tokio::sync::oneshot;

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

/// Custom event loop message: created off the event-loop thread (an IPC handler
/// or a file-dialog thread) and handled on it (where windows may be built and the
/// roster mutated).
enum UserEvent {
    /// Open a context in a NEW window (or focus it if already open) — the explicit
    /// "open in new window" action.
    OpenContext(OpenRequest),
    /// Switch the posting window IN PLACE to another context (ADR 0014): its server is
    /// torn down (locking the previous vault) and the same window reloads onto the new
    /// one. The default action when picking a vault/server in the hub or pill.
    SwitchContext { window: WindowId, req: OpenRequest },
    /// Force a rebuild of the posting window onto its *current* context (fresh server + webview,
    /// so `__RITE_VAULTS__` is regenerated). Used after a vault reset, where a plain page reload
    /// would re-inject the stale roster snapshot frozen at window-creation time.
    ReloadContext { window: WindowId },
    /// A vault-management command (roster edit / native dialog), tagged with the window
    /// that posted it so New/Open can switch *that* window to the vault.
    Vault { window: WindowId, cmd: VaultCommand },
    /// A native file dialog resolved on its own thread (see [`spawn_file_dialog`]).
    VaultPicked(VaultPick),
}

/// Which native file chooser to raise on the dialog thread. New/Open carry the window that
/// requested them so the resolved pick can switch it in place.
enum DialogKind {
    /// "Save as" for a brand-new vault file. Carries the chosen name (label), if any, so it
    /// survives the picker.
    New {
        window: WindowId,
        label: Option<String>,
    },
    /// "Open" an existing vault file.
    Open(WindowId),
    /// Pick an image to use as `vault`'s icon.
    Image(PathBuf),
}

/// The outcome of a resolved [`DialogKind`], handed back to the event loop so the roster
/// mutation + window switch happen on the owning thread (never off it).
enum VaultPick {
    /// A brand-new vault at `path`, to open in `window` — NOT yet registered (the frontend
    /// registers it via `vault-ready` once its master password is set, register-after-password).
    /// `label` is the chosen name, if the user typed one (else derived from the filename).
    New {
        window: WindowId,
        path: PathBuf,
        label: Option<String>,
    },
    /// An existing vault file at `path`, to register and open in `window`.
    Open {
        window: WindowId,
        path: PathBuf,
    },
    Image {
        vault: PathBuf,
        file: PathBuf,
    },
}

/// A live window: its server's loopback port, plus the `wry` webview and `tao`
/// window kept alive for the window's lifetime (dropping them closes it). The
/// webview is also used to push roster updates back into the hub (ADR 0014).
struct WindowState {
    webview: WebView,
    window: Window,
    #[allow(dead_code)]
    port: u16,
    /// Dropping this stops the window's server (graceful shutdown), so the dropped
    /// `ServerState` zeroizes its vault key — the vault **locks**. Held for the window's
    /// lifetime; dropped on window close or replaced on an in-place context switch.
    #[allow(dead_code)]
    shutdown: oneshot::Sender<()>,
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
            // Must be a valid GApplication id (reverse-DNS, at least one dot). Overridable via
            // RITE_APP_ID so a second instance on the same machine (multi-client testing) can use a
            // distinct id — two GTK apps sharing one GApplication id collide (crash in the webview).
            let app_id = std::env::var("RITE_APP_ID")
                .ok()
                .filter(|v| v.contains('.') && !v.trim().is_empty())
                .unwrap_or_else(|| "io.github.altagen.rite".to_string());
            builder.with_app_id(app_id);
        }
        builder.build()
    };
    let proxy = event_loop.create_proxy();

    let mut registry = ContextRegistry::<WindowId>::new();
    let mut windows: std::collections::HashMap<WindowId, WindowState> =
        std::collections::HashMap::new();

    // Multi-vault roster (ADR 0014): the local vaults the hub lists. The default vault is NOT
    // pre-seeded — like any other vault it only joins the roster once its master password is set
    // (register-after-password), so a fresh install shows "create a vault", not a phantom "unlock".
    let mut roster = vault_roster::VaultRoster::load(roster_path());
    let mut vaults_json =
        serde_json::to_string(roster.entries()).unwrap_or_else(|_| "[]".to_string());

    // The launch window shows the context hub (ADR 0014, base-first). Its server opens the default
    // local vault; carry that path so the frontend knows which roster entry is "this window". When
    // the default isn't registered yet (fresh install), carry a `pendingLabel` so setting its
    // master password registers it (register-after-password), exactly like a user-created vault.
    let launch_inject = if roster.contains(db_path()) {
        serde_json::json!({ "kind": "hub", "path": db_path().to_string_lossy() })
    } else {
        serde_json::json!({ "kind": "hub", "path": db_path().to_string_lossy(), "pendingLabel": "Local vault" })
    };
    let launch = OpenRequest {
        key: ContextKey::local(db_path()),
        db_path: db_path(),
        inject: launch_inject.to_string(),
    };
    if let Err(e) = open_window(
        &event_loop,
        &proxy,
        &mut windows,
        &mut registry,
        launch,
        &vaults_json,
    ) {
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
                // Drop the window: its webview closes and its `shutdown` sender drops,
                // gracefully stopping the window's server (which locks its vault). The
                // last window to close ends the process.
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
            Event::UserEvent(UserEvent::SwitchContext { window, req }) => {
                switch_context(&proxy, &mut windows, &mut registry, window, req, &vaults_json);
            }
            Event::UserEvent(UserEvent::ReloadContext { window }) => {
                // Return the window to the BASE workspace on the default vault, base-first (kind:hub)
                // — no forced password after a reset/abandon; "no vault" is fine, and the user can
                // create one when they want. The rebuild regenerates `__RITE_VAULTS__` (the reset/
                // abandoned vault is gone). If the default is already open in ANOTHER window, focus
                // that and close this one rather than duplicating the context.
                let base_key = ContextKey::local(db_path());
                match registry.open(&base_key) {
                    OpenOutcome::AlreadyOpen(other) if other != window => {
                        if let Some(w) = windows.get(&other) {
                            w.window.set_focus();
                        }
                        windows.remove(&window);
                        registry.remove_window(&window);
                        if registry.is_empty() {
                            *control_flow = ControlFlow::Exit;
                        }
                    }
                    _ => {
                        let inject =
                            serde_json::json!({ "kind": "hub", "path": db_path().to_string_lossy() })
                                .to_string();
                        let req = OpenRequest { key: base_key, inject, db_path: db_path() };
                        rebuild_window(&proxy, &mut windows, &mut registry, window, req, &vaults_json);
                    }
                }
            }
            Event::UserEvent(UserEvent::Vault { window, cmd }) => {
                if apply_vault_command(window, cmd, &mut roster, &proxy) {
                    // The roster changed: refresh every open window's hub (ADR 0014).
                    vaults_json =
                        serde_json::to_string(roster.entries()).unwrap_or_else(|_| "[]".to_string());
                    broadcast_vaults(&windows, &vaults_json);
                }
            }
            Event::UserEvent(UserEvent::VaultPicked(pick)) => match pick {
                // A new vault: rebuild its window onto it, carrying `pendingLabel` so the frontend
                // registers it after setup (register-after-password). No roster change yet.
                VaultPick::New { window, path, label } => {
                    let key = ContextKey::local(&path);
                    let is_default = key == ContextKey::local(db_path());
                    // Use the name the user typed; else the default's canonical name, else the filename.
                    let label = label
                        .map(|l| l.trim().to_string())
                        .filter(|l| !l.is_empty())
                        .unwrap_or_else(|| {
                            if is_default {
                                "Local vault".to_string()
                            } else {
                                vault_label_for(&path)
                            }
                        });
                    let inject = serde_json::json!({
                        "kind": "local",
                        "path": path.to_string_lossy(),
                        "pendingLabel": label,
                        "isDefault": is_default,
                    })
                    .to_string();
                    let req = OpenRequest { key: key.clone(), inject, db_path: path };
                    // Focus the window that already holds this vault — unless that's THIS window
                    // (creating at the default path it's already on): then force a rebuild so the
                    // setup screen shows even though the context didn't change.
                    match registry.open(&key) {
                        OpenOutcome::AlreadyOpen(other) if other != window => {
                            if let Some(w) = windows.get(&other) {
                                w.window.set_focus();
                            }
                        }
                        _ => rebuild_window(&proxy, &mut windows, &mut registry, window, req, &vaults_json),
                    }
                }
                // An existing vault: register it now, then switch its window onto it.
                VaultPick::Open { window, path } => {
                    let added = roster.add(&path, &vault_label_for(&path)).unwrap_or(false);
                    let inject = serde_json::json!({ "kind": "local", "path": path.to_string_lossy() })
                        .to_string();
                    let req = OpenRequest { key: ContextKey::local(&path), inject, db_path: path };
                    switch_context(&proxy, &mut windows, &mut registry, window, req, &vaults_json);
                    if added {
                        vaults_json = serde_json::to_string(roster.entries())
                            .unwrap_or_else(|_| "[]".to_string());
                        broadcast_vaults(&windows, &vaults_json);
                    }
                }
                VaultPick::Image { vault, file } => {
                    let changed = match encode_icon_data_uri(&file) {
                        Some(uri) => roster.set_icon(&vault, Some(uri)).unwrap_or(false),
                        None => {
                            show_error(
                                "Couldn't use that image",
                                "Rite couldn't read or convert the selected image.",
                            );
                            false
                        }
                    };
                    if changed {
                        vaults_json = serde_json::to_string(roster.entries())
                            .unwrap_or_else(|_| "[]".to_string());
                        broadcast_vaults(&windows, &vaults_json);
                    }
                }
            },
            _ => {}
        }
    });
}

/// Start a server, build a NEW window + webview for `req`, and register it. On success
/// the window is inserted into `windows` and its key into `registry` (so a failed
/// build leaves both untouched).
fn open_window(
    target: &EventLoopWindowTarget<UserEvent>,
    proxy: &EventLoopProxy<UserEvent>,
    windows: &mut std::collections::HashMap<WindowId, WindowState>,
    registry: &mut ContextRegistry<WindowId>,
    req: OpenRequest,
    vaults_json: &str,
) -> Result<()> {
    let window = WindowBuilder::new()
        .with_title("Rite")
        .with_window_icon(load_icon())
        .with_inner_size(LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1))
        .with_min_inner_size(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1))
        .build(target)?;
    let window_id = window.id();
    let (webview, port, shutdown) = build_context_view(&window, &req, proxy, vaults_json)?;
    registry.register(req.key, window_id);
    windows.insert(
        window_id,
        WindowState {
            webview,
            window,
            port,
            shutdown,
        },
    );
    Ok(())
}

/// Start `req`'s server and build a webview for it into the (already-created) `window`.
/// Used both to populate a fresh window ([`open_window`]) and to reload an existing one
/// onto a new context ([`switch_context`]). Returns the webview, the server's port, and a
/// shutdown handle whose drop stops that server (locking its vault). The webview posts
/// `open-context` / `switch-context` / `vault-*` IPC messages back through `proxy`.
fn build_context_view(
    window: &Window,
    req: &OpenRequest,
    proxy: &EventLoopProxy<UserEvent>,
    vaults_json: &str,
) -> Result<(WebView, u16, oneshot::Sender<()>)> {
    // Per-window token guarding this window's loopback server (ADR 0009). RAM only.
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let (port, shutdown) = start_server(token.clone(), &req.db_path)?;
    let url = format!("http://127.0.0.1:{port}/");
    tracing::info!("[rite-desktop] window serving on {url}");
    let window_id = window.id();

    // Inject the loopback token + the target context, then wire the IPC handler (tagged with
    // this window's id, so `switch-context` reloads the window that posted it). Also inject a
    // suggested path for the create-vault dialog so it can show where a new vault would be written.
    let suggested = serde_json::Value::from(suggested_vault_path().to_string_lossy().into_owned());
    let init = format!(
        "window.__RITE_TOKEN__ = '{token}'; window.__RITE_CONTEXT__ = {inject}; \
         window.__RITE_VAULTS__ = {vaults_json}; window.__RITE_SUGGESTED_VAULT_PATH__ = {suggested};{test_hook}",
        inject = req.inject,
        test_hook = test_ipc_hook(),
    );
    let ipc_proxy = proxy.clone();
    let webview_builder = WebViewBuilder::new()
        .with_url(&url)
        .with_initialization_script(&init)
        .with_ipc_handler(move |request| handle_ipc(&ipc_proxy, window_id, request.into_body()));

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
    let webview = webview_builder.build(window)?;

    Ok((webview, port, shutdown))
}

/// Switch `window_id` IN PLACE to `req`'s context (ADR 0014 §multi-window): the default
/// action when the user picks another vault/server. One-window-per-context still holds —
/// if the target is already open in a *different* window we focus that instead. Otherwise
/// we drop this window's old webview + shutdown handle (stopping its server → **locking the
/// previous vault**) and rebuild its webview onto the new context, reusing the same window.
fn switch_context(
    proxy: &EventLoopProxy<UserEvent>,
    windows: &mut std::collections::HashMap<WindowId, WindowState>,
    registry: &mut ContextRegistry<WindowId>,
    window_id: WindowId,
    req: OpenRequest,
    vaults_json: &str,
) {
    // Already this window's context → nothing to switch (avoid a pointless relock+reload).
    if registry.context_of(&window_id) == Some(&req.key) {
        return;
    }
    // Open in another window → focus it, leave this one as-is (never two on one context).
    if let OpenOutcome::AlreadyOpen(other) = registry.open(&req.key) {
        if let Some(w) = windows.get(&other) {
            w.window.set_focus();
        }
        return;
    }
    rebuild_window(proxy, windows, registry, window_id, req, vaults_json);
}

/// Tear down `window_id`'s current server + webview (stopping the server → **locking its vault**)
/// and rebuild it onto `req` in the same OS window, updating the registry to `req.key`. Shared by
/// the in-place switch and by a forced reload (reset); the caller enforces any one-per-context rule
/// and same-context guard first. A `build_context_view` failure surfaces an error and drops the
/// window rather than stranding a blank frame.
fn rebuild_window(
    proxy: &EventLoopProxy<UserEvent>,
    windows: &mut std::collections::HashMap<WindowId, WindowState>,
    registry: &mut ContextRegistry<WindowId>,
    window_id: WindowId,
    req: OpenRequest,
    vaults_json: &str,
) {
    let Some(old) = windows.remove(&window_id) else {
        tracing::warn!("[rite-desktop] rebuild for an unknown window; ignoring");
        return;
    };
    // Keep the OS window; drop the old webview + shutdown handle now so the previous
    // server stops and its vault locks before (or alongside) the new one comes up.
    let WindowState {
        window,
        webview,
        shutdown,
        ..
    } = old;
    drop(webview);
    drop(shutdown);
    match build_context_view(&window, &req, proxy, vaults_json) {
        Ok((webview, port, shutdown)) => {
            registry.remove_window(&window_id);
            registry.register(req.key, window_id);
            windows.insert(
                window_id,
                WindowState {
                    webview,
                    window,
                    port,
                    shutdown,
                },
            );
        }
        Err(e) => {
            registry.remove_window(&window_id);
            show_error(
                "Could not open that context",
                &format!("Rite couldn't open that vault or server.\n\n{e:#}"),
            );
        }
    }
}

/// Parse an IPC message from `window`'s webview and route it. `open-context` opens/focuses a
/// separate window; `switch-context` reloads *this* window onto another context; `vault-*`
/// messages manage the multi-vault roster. Malformed or unknown messages are logged and ignored
/// (a webview must never crash the shell).
fn handle_ipc(proxy: &EventLoopProxy<UserEvent>, window: WindowId, body: String) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(&body) else {
        tracing::warn!("[rite-desktop] ignoring non-JSON IPC message");
        return;
    };
    let send = |event| {
        if proxy.send_event(event).is_err() {
            tracing::warn!("[rite-desktop] event loop gone; dropping IPC event");
        }
    };
    match msg.get("type").and_then(|t| t.as_str()) {
        Some("open-context") => {
            if let Some(req) = context_request_from(&msg, &db_path()) {
                send(UserEvent::OpenContext(req));
            }
        }
        Some("switch-context") => {
            if let Some(req) = context_request_from(&msg, &db_path()) {
                send(UserEvent::SwitchContext { window, req });
            }
        }
        Some("reload-context") => send(UserEvent::ReloadContext { window }),
        _ => {
            if let Some(cmd) = plan_vault_command(&msg) {
                send(UserEvent::Vault { window, cmd });
            }
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
    /// Forget a vault AND permanently delete its `.db` file (+ WAL/SHM sidecars). Irreversible;
    /// the frontend confirms first. Mirrors the mock's "Also delete the file permanently" opt-in.
    Delete { path: PathBuf },
    /// Register a freshly-created vault in the roster — sent by the frontend once its master
    /// password is set, so a not-yet-configured vault never appears (register-after-password).
    Ready { path: PathBuf, label: String },
    /// Wipe a vault — erase its master password + all connections (irreversible). Reuses the
    /// existing reset flow; the frontend confirms before sending.
    Reset { path: PathBuf },
    /// Lock a vault in-session (clears its key from RAM; re-requires the master password).
    Lock { path: PathBuf },
    /// Set (or clear, when `icon` is None) a vault's icon to an emoji chosen in the hub.
    SetIcon { path: PathBuf, icon: Option<String> },
    /// Set a vault's icon to a device-local image — the shell shows an open dialog, then stores a
    /// small `data:` URI in the roster.
    SetImage { path: PathBuf },
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
        "vault-delete" => Some(VaultCommand::Delete {
            path: PathBuf::from(str_field("path")?),
        }),
        "vault-ready" => Some(VaultCommand::Ready {
            path: PathBuf::from(str_field("path")?),
            label: str_field("label")?.to_string(),
        }),
        "vault-reset" => Some(VaultCommand::Reset {
            path: PathBuf::from(str_field("path")?),
        }),
        "vault-lock" => Some(VaultCommand::Lock {
            path: PathBuf::from(str_field("path")?),
        }),
        // `icon` present ⇒ set that emoji; absent ⇒ clear back to the default glyph.
        "vault-set-icon" => Some(VaultCommand::SetIcon {
            path: PathBuf::from(str_field("path")?),
            icon: str_field("icon").map(String::from),
        }),
        "vault-set-image" => Some(VaultCommand::SetImage {
            path: PathBuf::from(str_field("path")?),
        }),
        _ => None,
    }
}

/// Build an [`OpenRequest`] from a context message's `kind`/fields (no `type` check). Shared by
/// `open-context` (new window) and `switch-context` (reload this window). Pure (no event loop /
/// no I/O) so it is unit-tested without a display.
///
/// - `local` with a `path` opens that vault (ADR 0014 multi-vault); without one, the default. An
///   optional `pendingLabel` (a not-yet-registered new vault) is carried through so the frontend
///   can register it after the master password is set (Part 3).
/// - `server` needs a `url`; the id/url/label pass through to the target window.
fn context_request_from(msg: &serde_json::Value, default_db: &Path) -> Option<OpenRequest> {
    match msg.get("kind").and_then(|k| k.as_str()) {
        Some("local") => {
            let path = msg
                .get("path")
                .and_then(|p| p.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| default_db.to_path_buf());
            let mut inject = serde_json::json!({ "kind": "local", "path": path.to_string_lossy() });
            if let Some(label) = msg
                .get("pendingLabel")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
            {
                inject["pendingLabel"] = serde_json::Value::from(label);
            }
            Some(OpenRequest {
                key: ContextKey::local(&path),
                inject: inject.to_string(),
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

/// Execute a vault-management command on the event-loop thread (ADR 0014), for the window that
/// posted it. Returns whether the roster changed, so the caller refreshes open hubs. New/OpenFile
/// raise a native chooser off this thread ([`spawn_file_dialog`]) and finish in the `VaultPicked`
/// handler, which switches `window` onto the vault; rename/forget/delete/ready/set-icon mutate the
/// roster in place. Reset/Lock are Phase C. An optional path on New/OpenFile is a test hook that
/// bypasses the picker — it resolves by posting the equivalent `VaultPicked` for the same window.
fn apply_vault_command(
    window: WindowId,
    cmd: VaultCommand,
    roster: &mut vault_roster::VaultRoster,
    proxy: &EventLoopProxy<UserEvent>,
) -> bool {
    match cmd {
        VaultCommand::Rename { path, label } => roster.rename(&path, &label).unwrap_or(false),
        VaultCommand::Forget { path } => roster.remove(&path).unwrap_or(false),
        VaultCommand::Delete { path } => {
            let forgotten = roster.remove(&path).unwrap_or(false);
            delete_vault_file(&path);
            // The roster changed whenever the entry was there; even if it wasn't, the file
            // deletion is worth a rebroadcast so every hub drops any stale view of it.
            forgotten
        }
        VaultCommand::Ready { path, label } => roster.add(&path, &label).unwrap_or(false),
        // A path here is the test hook (bypasses the picker) → post the pick directly for this
        // window; otherwise raise the native chooser and finish in the `VaultPicked` handler.
        VaultCommand::New { label, path } => {
            match path {
                Some(path) => {
                    let _ = proxy.send_event(UserEvent::VaultPicked(VaultPick::New {
                        window,
                        path,
                        label,
                    }));
                }
                None => spawn_file_dialog(proxy.clone(), DialogKind::New { window, label }),
            }
            false
        }
        VaultCommand::OpenFile { path } => {
            match path {
                Some(path) => {
                    let _ =
                        proxy.send_event(UserEvent::VaultPicked(VaultPick::Open { window, path }));
                }
                None => spawn_file_dialog(proxy.clone(), DialogKind::Open(window)),
            }
            false
        }
        VaultCommand::SetIcon { path, icon } => roster.set_icon(&path, icon).unwrap_or(false),
        VaultCommand::SetImage { path } => {
            spawn_file_dialog(proxy.clone(), DialogKind::Image(path));
            false
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

/// Raise a native file chooser without ever re-entering the shell's own GTK/glib event
/// loop: the blocking `rfd::FileDialog` nests a GTK main loop (which corrupts the running
/// webview and crashes), so instead we drive `AsyncFileDialog` — whose gtk3 backend runs
/// the chooser on its own isolated loop — from a throwaway thread, and hand the result back
/// to the event loop as a [`UserEvent::VaultPicked`]. A cancelled dialog sends nothing.
fn spawn_file_dialog(proxy: EventLoopProxy<UserEvent>, kind: DialogKind) {
    std::thread::spawn(move || {
        // A single-thread runtime just to await rfd's dialog future — no reactor needed,
        // the gtk3 async backend feeds the result over a channel from its own loop.
        let rt = match tokio::runtime::Builder::new_current_thread().build() {
            Ok(rt) => rt,
            Err(e) => {
                tracing::warn!("[rite-desktop] couldn't start the file-dialog runtime: {e}");
                return;
            }
        };
        let picked = rt.block_on(async {
            match kind {
                DialogKind::New { window, label } => rfd::AsyncFileDialog::new()
                    .set_title("Create a new Rite vault")
                    // Propose Rite's default location + filename so the user sees where it will be
                    // written and can change it — the same flow whether it's the first vault or another.
                    .set_directory(db_path().parent().unwrap_or_else(|| Path::new(".")))
                    .set_file_name("vault.db")
                    .save_file()
                    .await
                    .map(|f| VaultPick::New {
                        window,
                        path: f.path().to_path_buf(),
                        label,
                    }),
                DialogKind::Open(window) => rfd::AsyncFileDialog::new()
                    .set_title("Open a Rite vault")
                    .add_filter("Rite vault", &["db"])
                    .pick_file()
                    .await
                    .map(|f| VaultPick::Open {
                        window,
                        path: f.path().to_path_buf(),
                    }),
                DialogKind::Image(vault) => rfd::AsyncFileDialog::new()
                    .set_title("Choose a vault icon")
                    .add_filter("Image", &["png", "jpg", "jpeg", "gif", "webp"])
                    .pick_file()
                    .await
                    .map(|f| VaultPick::Image {
                        vault,
                        file: f.path().to_path_buf(),
                    }),
            }
        });
        if let Some(pick) = picked {
            // The event loop is gone only during shutdown; nothing to do then.
            let _ = proxy.send_event(UserEvent::VaultPicked(pick));
        }
    });
}

/// Load a device-local image, downscale it to a small square, and return a `data:image/png`
/// base64 URI — kept small so the roster stays lightweight. `None` on a read/decode failure.
fn encode_icon_data_uri(path: &Path) -> Option<String> {
    use base64::Engine;
    let img = image::open(path).ok()?;
    let small = img.resize(64, 64, image::imageops::FilterType::Lanczos3);
    let mut png = std::io::Cursor::new(Vec::new());
    small.write_to(&mut png, image::ImageFormat::Png).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    Some(format!("data:image/png;base64,{b64}"))
}

/// Permanently delete a vault's database file and its SQLite sidecars (WAL/SHM/journal).
/// Best-effort and graceful (owner bar): a missing file or permission error is logged, never
/// fatal — the user already confirmed, and the roster removal stands regardless. If the vault
/// is still open in another window, unlinking is safe on Linux (that server keeps its fd until
/// the window closes); the data is gone once nothing holds it.
fn delete_vault_file(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let target = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            PathBuf::from(name)
        };
        match std::fs::remove_file(&target) {
            Ok(()) => tracing::info!("[rite-desktop] deleted vault file {}", target.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("[rite-desktop] couldn't delete {} ({e})", target.display()),
        }
    }
}

/// A default human label for a vault path (the file stem, e.g. `beta.db` → "beta").
fn vault_label_for(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Vault".to_string())
}

/// Where a *new* vault would be written by default, shown in the create dialog so the user sees
/// the location without opening a picker. The default base path when it isn't registered yet
/// (reusing its auto-created empty file is fine); otherwise the first free `vault(N).db` that is
/// neither registered nor already on disk, so we never silently clobber an existing vault.
fn suggested_vault_path() -> PathBuf {
    let roster = vault_roster::VaultRoster::load(roster_path());
    if !roster.contains(db_path()) {
        return db_path();
    }
    let dir = db_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    for i in 1..1000 {
        let candidate = dir.join(format!("vault({i}).db"));
        if !roster.contains(&candidate) && !candidate.exists() {
            return candidate;
        }
    }
    dir.join("vault.db")
}

/// Test hook (host smoke, ADR 0014): when `RITE_TEST_IPC` holds an IPC message, the first window
/// posts it via `window.ipc` shortly after load — driving the full IPC→executor loop headlessly
/// (the webview has no webdriver). No-op unless the env var is set; fires exactly once.
fn test_ipc_hook() -> String {
    use std::sync::atomic::{AtomicBool, Ordering};
    static FIRED: AtomicBool = AtomicBool::new(false);
    if FIRED.swap(true, Ordering::SeqCst) {
        return String::new();
    }
    match std::env::var("RITE_TEST_IPC") {
        Ok(cmd) if !cmd.is_empty() => format!(
            " setTimeout(function(){{ try {{ window.ipc.postMessage({}); }} catch (e) {{}} }}, 500);",
            serde_json::to_string(&cmd).unwrap_or_else(|_| "\"\"".to_string())
        ),
        _ => String::new(),
    }
}

/// Push the current roster into every open window's hub: update `window.__RITE_VAULTS__` and
/// fire `rite-vaults-changed` so the hub re-renders live (no reload).
fn broadcast_vaults(windows: &std::collections::HashMap<WindowId, WindowState>, vaults_json: &str) {
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

/// Start rite-server in a background thread (its own tokio runtime; the tao event loop
/// must own the main thread) and block until it binds, returning the port and a shutdown
/// handle. Dropping (or firing) the handle stops the server gracefully — the dropped
/// `ServerState` zeroizes the vault key, i.e. the vault locks. Errors are reported, not panics.
fn start_server(token: String, db_path: &Path) -> Result<(u16, oneshot::Sender<()>)> {
    let db_path = db_path.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel::<Result<u16, String>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
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
                rite_server::serve_with_shutdown(
                    state,
                    "127.0.0.1:0",
                    move |port| {
                        let _ = tx_bound.send(Ok(port));
                    },
                    // Resolves when the handle is fired OR simply dropped (window closed/switched).
                    async move {
                        let _ = shutdown_rx.await;
                    },
                )
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
        Ok(Ok(port)) => Ok((port, shutdown_tx)),
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
    fn context_request_needs_a_known_kind() {
        // Type dispatch (open vs switch) lives in `handle_ipc`; the builder is kind-driven.
        assert!(context_request_from(&json!({ "type": "other" }), &default()).is_none());
        assert!(context_request_from(&json!({ "nope": 1 }), &default()).is_none());
        // A bare local kind (no type) builds the default-vault request.
        assert!(context_request_from(&json!({ "kind": "local" }), &default()).is_some());
    }

    #[test]
    fn local_carries_pending_label_when_present() {
        let req = context_request_from(
            &json!({ "kind": "local", "path": "/v/new.db", "pendingLabel": "Client Beta" }),
            &default(),
        )
        .unwrap();
        assert!(req.inject.contains("pendingLabel"));
        assert!(req.inject.contains("Client Beta"));
    }

    #[test]
    fn local_without_path_uses_the_default_vault() {
        let req = context_request_from(
            &json!({ "type": "open-context", "kind": "local" }),
            &default(),
        )
        .unwrap();
        assert_eq!(req.db_path, default());
        assert_eq!(req.key, ContextKey::local(default()));
    }

    #[test]
    fn local_with_path_opens_that_vault() {
        let req = context_request_from(
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
        let req = context_request_from(
            &json!({ "type": "open-context", "kind": "local", "path": "   " }),
            &default(),
        )
        .unwrap();
        assert_eq!(req.db_path, default());
    }

    #[test]
    fn server_needs_a_url_and_keeps_the_default_vault() {
        assert!(
            context_request_from(
                &json!({ "type": "open-context", "kind": "server" }),
                &default()
            )
            .is_none()
        );
        let req = context_request_from(
            &json!({ "type": "open-context", "kind": "server", "url": "https://rite.example.com", "label": "Team" }),
            &default(),
        )
        .unwrap();
        assert_eq!(req.key, ContextKey::server("https://rite.example.com"));
        assert_eq!(req.db_path, default()); // server window still uses the mux's local vault
    }

    #[test]
    fn unknown_kind_is_ignored() {
        assert!(
            context_request_from(
                &json!({ "type": "open-context", "kind": "wat" }),
                &default()
            )
            .is_none()
        );
    }

    #[test]
    fn vault_command_new_and_open_file() {
        // Bare new/open → no path/label ⇒ the shell will show the native dialog.
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-new" })),
            Some(VaultCommand::New {
                label: None,
                path: None
            })
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
            plan_vault_command(
                &json!({ "type": "vault-new", "label": "Beta", "path": "/v/beta.db" })
            ),
            Some(VaultCommand::New {
                label: Some("Beta".into()),
                path: Some(PathBuf::from("/v/beta.db"))
            })
        );
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-open-file", "path": "/v/x.db" })),
            Some(VaultCommand::OpenFile {
                path: Some(PathBuf::from("/v/x.db"))
            })
        );
    }

    #[test]
    fn vault_command_reset_and_lock_need_path() {
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-reset", "path": "/v/a.db" })),
            Some(VaultCommand::Reset {
                path: PathBuf::from("/v/a.db")
            })
        );
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-lock", "path": "/v/a.db" })),
            Some(VaultCommand::Lock {
                path: PathBuf::from("/v/a.db")
            })
        );
        assert!(plan_vault_command(&json!({ "type": "vault-reset" })).is_none());
        assert!(plan_vault_command(&json!({ "type": "vault-lock" })).is_none());
    }

    #[test]
    fn vault_command_rename_needs_path_and_label() {
        assert_eq!(
            plan_vault_command(
                &json!({ "type": "vault-rename", "path": "/v/a.db", "label": "Work" })
            ),
            Some(VaultCommand::Rename {
                path: PathBuf::from("/v/a.db"),
                label: "Work".into()
            })
        );
        // Missing/blank fields → not a valid command.
        assert!(
            plan_vault_command(&json!({ "type": "vault-rename", "path": "/v/a.db" })).is_none()
        );
        assert!(
            plan_vault_command(
                &json!({ "type": "vault-rename", "path": "/v/a.db", "label": "  " })
            )
            .is_none()
        );
    }

    #[test]
    fn vault_command_forget_needs_path() {
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-forget", "path": "/v/a.db" })),
            Some(VaultCommand::Forget {
                path: PathBuf::from("/v/a.db")
            })
        );
        assert!(plan_vault_command(&json!({ "type": "vault-forget" })).is_none());
    }

    #[test]
    fn vault_command_delete_needs_path() {
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-delete", "path": "/v/a.db" })),
            Some(VaultCommand::Delete {
                path: PathBuf::from("/v/a.db")
            })
        );
        assert!(plan_vault_command(&json!({ "type": "vault-delete" })).is_none());
    }

    #[test]
    fn vault_command_ready_needs_path_and_label() {
        assert_eq!(
            plan_vault_command(
                &json!({ "type": "vault-ready", "path": "/v/a.db", "label": "Beta" })
            ),
            Some(VaultCommand::Ready {
                path: PathBuf::from("/v/a.db"),
                label: "Beta".into()
            })
        );
        // Missing either field ⇒ not a command (never register a half-specified vault).
        assert!(plan_vault_command(&json!({ "type": "vault-ready", "path": "/v/a.db" })).is_none());
        assert!(plan_vault_command(&json!({ "type": "vault-ready", "label": "Beta" })).is_none());
    }

    #[test]
    fn vault_command_set_icon_and_image() {
        assert_eq!(
            plan_vault_command(
                &json!({ "type": "vault-set-icon", "path": "/v/a.db", "icon": "🚀" })
            ),
            Some(VaultCommand::SetIcon {
                path: PathBuf::from("/v/a.db"),
                icon: Some("🚀".into())
            })
        );
        // No icon ⇒ clear.
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-set-icon", "path": "/v/a.db" })),
            Some(VaultCommand::SetIcon {
                path: PathBuf::from("/v/a.db"),
                icon: None
            })
        );
        assert_eq!(
            plan_vault_command(&json!({ "type": "vault-set-image", "path": "/v/a.db" })),
            Some(VaultCommand::SetImage {
                path: PathBuf::from("/v/a.db")
            })
        );
    }

    #[test]
    fn non_vault_messages_are_not_commands() {
        assert!(plan_vault_command(&json!({ "type": "open-context", "kind": "local" })).is_none());
        assert!(plan_vault_command(&json!({ "type": "whatever" })).is_none());
    }
}
