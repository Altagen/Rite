//! rite-desktop — the native desktop shell (wry).
//!
//! Runs rite-server in-process on a random loopback port with a per-launch
//! bearer token (ADR 0009), then opens a `wry` webview pointing at it and
//! injects the token so the embedded frontend can authenticate. The token stays
//! in RAM; nothing but the loopback is exposed.
//!
//! Only one instance may run per user (they share one SQLite vault); a second
//! launch is refused with a dialog. Startup failures surface as a native dialog
//! rather than a silent stderr panic.

use anyhow::{Context, Result};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::ControlFlow;
#[cfg(not(target_os = "linux"))]
use tao::event_loop::EventLoop;
use tao::window::WindowBuilder;
use uuid::Uuid;
use wry::WebViewBuilder;

const DEFAULT_SIZE: (f64, f64) = (1200.0, 800.0);
const MIN_SIZE: (f64, f64) = (800.0, 600.0);

fn main() -> Result<()> {
    tracing_subscriber::fmt().init();

    // Single instance: two clients would fight over the one SQLite vault. Hold
    // the lock for the whole process lifetime.
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

    // Per-launch token guarding the loopback server (ADR 0009). RAM only.
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());

    let port = match start_server(token.clone()) {
        Ok(port) => port,
        Err(e) => {
            show_error(
                "Rite failed to start",
                &format!("Could not open the vault or start the local server.\n\n{e:#}"),
            );
            return Err(e);
        }
    };

    let url = format!("http://127.0.0.1:{port}/");
    tracing::info!("[rite-desktop] serving on {url}");

    // Set the Wayland app-id / X11 WM_CLASS on the event loop (WM grouping +
    // future .desktop icon matching).
    #[cfg(target_os = "linux")]
    let event_loop = {
        use tao::event_loop::EventLoopBuilder;
        use tao::platform::unix::EventLoopBuilderExtUnix;
        let mut builder = EventLoopBuilder::new();
        builder.with_app_id("rite");
        builder.build()
    };
    #[cfg(not(target_os = "linux"))]
    let event_loop = EventLoop::new();

    let window = WindowBuilder::new()
        .with_title("Rite")
        .with_window_icon(load_icon())
        .with_inner_size(LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1))
        .with_min_inner_size(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1))
        .build(&event_loop)?;

    let init = format!("window.__RITE_TOKEN__ = '{token}';");
    let webview_builder = WebViewBuilder::new()
        .with_url(&url)
        .with_initialization_script(&init);

    // On Linux, wry is GTK-based: it must be built into the window's GTK vbox,
    // not from a raw window handle (Wayland handles aren't supported by the
    // generic `build`). Other platforms use the window handle directly.
    #[cfg(target_os = "linux")]
    let _webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window
            .default_vbox()
            .expect("tao provides a default GTK vbox on Linux");
        webview_builder.build_gtk(vbox)?
    };
    #[cfg(not(target_os = "linux"))]
    let _webview = webview_builder.build(&window)?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}

/// Start rite-server in a background thread (its own tokio runtime; the tao
/// event loop must own the main thread) and block until it binds, returning the
/// port. Startup errors are reported instead of panicking.
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
