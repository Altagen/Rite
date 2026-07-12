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
    let window = WindowBuilder::new().with_title("Rite").build(&event_loop)?;

    let init = format!("window.__RITE_TOKEN__ = '{token}';");
    let _webview = WebViewBuilder::new()
        .with_url(&url)
        .with_initialization_script(&init)
        .build(&window)?;

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

fn db_path() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("rite")
        .join("vault.db")
}
