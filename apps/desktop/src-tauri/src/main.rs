// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

mod auth;
mod commands;
mod connection;
mod connections_manager;
mod db;
mod known_hosts;
mod local_terminal;
mod ssh_config;
mod state;
mod terminal;
mod theme;

use state::AppState;

fn main() {
    // Apply WebKit workarounds for Linux to fix GBM buffer issues
    // This is a known issue with webkit2gtk on Linux, especially with NVIDIA GPUs
    // See: https://github.com/tauri-apps/tauri/issues/13493
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        // Use X11 backend if available, which has better compatibility
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    // Initialize logging
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::DEBUG)
        .finish();
    tracing::subscriber::set_global_default(subscriber)
        .expect("Failed to set tracing subscriber");

    info!("Starting RITE (Rust & TypeScript Interface for Terminal Environment)");

    // Initialize application state (async)
    let app_state = tokio::runtime::Runtime::new()
        .expect("Failed to create tokio runtime")
        .block_on(async {
            AppState::new()
                .await
                .expect("Failed to initialize application state")
        });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::health_check,
            commands::validate_password,
            commands::is_first_run,
            commands::is_locked,
            commands::setup_master_password,
            commands::unlock,
            commands::lock,
            commands::reset_database,
            commands::create_connection,
            commands::get_all_connections,
            commands::get_connection,
            commands::update_connection,
            commands::delete_connection,
            commands::parse_ssh_config,
            commands::import_ssh_config_entries,
            commands::get_default_ssh_config_path,
            commands::get_connections_by_folder,
            commands::count_saved_connections,
            commands::connect_terminal,
            commands::connect_local_terminal,
            commands::get_installed_shells,
            commands::quick_ssh_connect,
            commands::send_terminal_input,
            commands::resize_terminal,
            commands::disconnect_terminal,
            commands::list_terminal_sessions,
            commands::get_setting,
            commands::set_setting,
            commands::get_all_settings,
            theme::load_theme,
            theme::list_themes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
