/// Theme management system
///
/// Supports loading themes from:
/// 1. User config directory (~/.config/rite/themes/)
/// 2. Embedded default themes (fallback)

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tracing::{debug, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub metadata: ThemeMetadata,
    pub colors: ThemeColors,
    pub terminal: TerminalConfig,
    pub ui: UiConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeMetadata {
    pub name: String,
    pub author: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeColors {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub selection: String,

    // ANSI colors
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,

    // Bright ANSI colors
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConfig {
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiConfig {
    pub accent: String,
    pub border: String,
    pub hover: String,
}

/// Get the default embedded theme
fn get_default_theme() -> Theme {
    Theme {
        metadata: ThemeMetadata {
            name: "RITE Default".to_string(),
            author: Some("RITE Team".to_string()),
            version: Some("1.0.0".to_string()),
        },
        colors: ThemeColors {
            background: "#1e1e2e".to_string(),
            foreground: "#cdd6f4".to_string(),
            cursor: "#f5e0dc".to_string(),
            selection: "#585b70".to_string(),
            black: "#45475a".to_string(),
            red: "#f38ba8".to_string(),
            green: "#a6e3a1".to_string(),
            yellow: "#f9e2af".to_string(),
            blue: "#89b4fa".to_string(),
            magenta: "#f5c2e7".to_string(),
            cyan: "#94e2d5".to_string(),
            white: "#bac2de".to_string(),
            bright_black: "#585b70".to_string(),
            bright_red: "#f38ba8".to_string(),
            bright_green: "#a6e3a1".to_string(),
            bright_yellow: "#f9e2af".to_string(),
            bright_blue: "#89b4fa".to_string(),
            bright_magenta: "#f5c2e7".to_string(),
            bright_cyan: "#94e2d5".to_string(),
            bright_white: "#a6adc8".to_string(),
        },
        terminal: TerminalConfig {
            font_family: "JetBrains Mono".to_string(),
            font_size: 14,
            line_height: 1.2,
        },
        ui: UiConfig {
            accent: "#89b4fa".to_string(),
            border: "#313244".to_string(),
            hover: "#585b70".to_string(),
        },
    }
}

/// Get user themes directory
fn get_user_themes_dir() -> Option<PathBuf> {
    let config_dir = dirs::config_dir()?;
    Some(config_dir.join("rite").join("themes"))
}

/// Load a theme by name
#[tauri::command]
pub fn load_theme(name: String) -> Result<Theme, String> {
    debug!("Loading theme: {}", name);

    // Try to load from user directory
    if let Some(themes_dir) = get_user_themes_dir() {
        let theme_path = themes_dir.join(format!("{}.toml", name));
        if theme_path.exists() {
            match fs::read_to_string(&theme_path) {
                Ok(content) => match toml::from_str::<Theme>(&content) {
                    Ok(theme) => {
                        debug!("Loaded user theme: {}", name);
                        return Ok(theme);
                    }
                    Err(e) => {
                        warn!("Failed to parse theme {}: {}", name, e);
                    }
                },
                Err(e) => {
                    warn!("Failed to read theme file {}: {}", theme_path.display(), e);
                }
            }
        }
    }

    // Fallback to default
    if name == "default" || name == "RITE Default" {
        debug!("Loading default embedded theme");
        return Ok(get_default_theme());
    }

    Err(format!("Theme '{}' not found", name))
}

/// List available themes
#[tauri::command]
pub fn list_themes() -> Vec<String> {
    let mut themes = vec!["default".to_string()];

    if let Some(themes_dir) = get_user_themes_dir() {
        if themes_dir.exists() {
            if let Ok(entries) = fs::read_dir(&themes_dir) {
                for entry in entries.flatten() {
                    if let Some(ext) = entry.path().extension() {
                        if ext == "toml" {
                            if let Some(name) = entry.path().file_stem() {
                                themes.push(name.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    themes
}
