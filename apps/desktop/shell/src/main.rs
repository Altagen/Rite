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

mod context_registry;
use context_registry::{ContextKey, ContextRegistry, OpenOutcome};

const DEFAULT_SIZE: (f64, f64) = (1200.0, 800.0);
const MIN_SIZE: (f64, f64) = (800.0, 600.0);

/// A request from a webview (or the launch) to open a context in a window.
struct OpenRequest {
    /// Identity for one-window-per-context dedup.
    key: ContextKey,
    /// The `window.__RITE_CONTEXT__` payload injected into the target window so its
    /// frontend knows which context to activate (`{"kind":"local"}` or a server).
    inject: String,
}

/// Custom event loop message: created off the event-loop thread (an IPC handler)
/// and handled on it (where windows may be built).
enum UserEvent {
    OpenContext(OpenRequest),
}

/// A live window: its server's loopback port, plus the `wry` webview and `tao`
/// window kept alive for the window's lifetime (dropping them closes it).
struct WindowState {
    _webview: WebView,
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

    // The launch window shows the context hub (ADR 0014). Its server is the local
    // one, so it's registered as the local context — picking "local vault" in the
    // hub proceeds in this window; picking a server opens another window.
    let launch = OpenRequest {
        key: ContextKey::local(db_path()),
        inject: r#"{"kind":"hub"}"#.to_string(),
    };
    if let Err(e) = open_window(&event_loop, &proxy, &mut windows, &mut registry, launch) {
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
                        if let Err(e) = open_window(target, &proxy, &mut windows, &mut registry, req) {
                            show_error(
                                "Could not open that context",
                                &format!("Rite couldn't open a window for this context.\n\n{e:#}"),
                            );
                        }
                    }
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
) -> Result<()> {
    // Per-window token guarding this window's loopback server (ADR 0009). RAM only.
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let port = start_server(token.clone())?;
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
        "window.__RITE_TOKEN__ = '{token}'; window.__RITE_CONTEXT__ = {inject};",
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
    windows.insert(window_id, WindowState { _webview: webview, window, port });
    Ok(())
}

/// Parse an IPC message from a webview and, if it is an `open-context` request,
/// forward it to the event loop. Malformed messages are logged and ignored (a
/// webview must never crash the shell).
fn handle_ipc(proxy: &EventLoopProxy<UserEvent>, body: String) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(&body) else {
        tracing::warn!("[rite-desktop] ignoring non-JSON IPC message");
        return;
    };
    if msg.get("type").and_then(|t| t.as_str()) != Some("open-context") {
        return;
    }
    let req = match msg.get("kind").and_then(|k| k.as_str()) {
        Some("local") => OpenRequest {
            key: ContextKey::local(db_path()),
            inject: r#"{"kind":"local"}"#.to_string(),
        },
        Some("server") => {
            let Some(url) = msg.get("url").and_then(|u| u.as_str()) else {
                tracing::warn!("[rite-desktop] open-context server without url");
                return;
            };
            OpenRequest {
                key: ContextKey::server(url),
                // Pass the roster id/url/label straight through for the target
                // frontend to activate (the server context it should land in).
                inject: serde_json::json!({
                    "kind": "server",
                    "id": msg.get("id").and_then(|v| v.as_str()),
                    "url": url,
                    "label": msg.get("label").and_then(|v| v.as_str()),
                })
                .to_string(),
            }
        }
        other => {
            tracing::warn!("[rite-desktop] open-context with unknown kind {other:?}");
            return;
        }
    };
    if proxy.send_event(UserEvent::OpenContext(req)).is_err() {
        tracing::warn!("[rite-desktop] event loop gone; dropping open-context");
    }
}

/// Start rite-server in a background thread (its own tokio runtime; the tao event
/// loop must own the main thread) and block until it binds, returning the port.
/// Startup errors are reported instead of panicking.
fn start_server(token: String) -> Result<u16> {
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
                let db_path = db_path();
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
