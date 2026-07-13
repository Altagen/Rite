//! rite-desktop — the native desktop shell (wry).
//!
//! Runs rite-server in-process on a random loopback port with a per-launch
//! bearer token (ADR 0009), then opens a `wry` webview pointing at it and
//! injects the token so the embedded frontend can authenticate. The token stays
//! in RAM; nothing but the loopback is exposed.

use anyhow::Result;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use uuid::Uuid;
use wry::WebViewBuilder;

fn main() -> Result<()> {
    tracing_subscriber::fmt().init();

    // Per-launch token guarding the loopback server (ADR 0009). RAM only.
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());

    // rite-server runs in a background thread with its own tokio runtime; the
    // tao event loop must own the main thread.
    let (port_tx, port_rx) = std::sync::mpsc::channel();
    let server_token = token.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async move {
            let db_path = db_path();
            if let Some(parent) = db_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let state = rite_server::ServerState::new(&db_path)
                .await
                .expect("open vault")
                .with_token(server_token);
            rite_server::serve(state, "127.0.0.1:0", move |port| {
                port_tx.send(port).expect("report bound port");
            })
            .await
            .expect("serve");
        });
    });

    let port = port_rx.recv()?;
    let url = format!("http://127.0.0.1:{port}/");
    tracing::info!("[rite-desktop] serving on {url}");

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Rite")
        .with_window_icon(load_icon())
        .build(&event_loop)?;

    let init = format!("window.__RITE_TOKEN__ = '{token}';");
    let builder = WebViewBuilder::new()
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
        builder.build_gtk(vbox)?
    };
    #[cfg(not(target_os = "linux"))]
    let _webview = builder.build(&window)?;

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

/// The window icon, decoded from the bundled PNG. Best-effort: on Wayland the
/// taskbar icon comes from a `.desktop` file matched by app-id, so this mainly
/// affects X11 and the window itself.
fn load_icon() -> Option<tao::window::Icon> {
    let bytes = include_bytes!("../../../../assets/rite-icon-flat.png");
    let img = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (w, h) = img.dimensions();
    tao::window::Icon::from_rgba(img.into_raw(), w, h).ok()
}

fn db_path() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("rite")
        .join("vault.db")
}
