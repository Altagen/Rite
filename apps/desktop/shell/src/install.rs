//! Desktop integration — `rite --install` and `rite --uninstall` (ADR 0030).
//!
//! A release ships one binary. Copying it onto `PATH` makes it runnable from a shell and
//! nothing more: no launcher entry, so the only way to start Rite is a terminal, and the
//! window dies with that terminal. This module writes the four paths that fix it.
//!
//! **Why the icon cannot be solved inside the window.** The shell already embeds its icon
//! and passes it to `with_window_icon`, which X11 honours and Wayland ignores: a
//! compositor does not take an icon from the surface. It matches the surface's app-id
//! against the BASENAME of a `.desktop` file, reads that file's `Icon=` key, and resolves
//! the name through the icon theme. So the entry's filename is not cosmetic — it is the
//! join key, and `e2e/install-entry-check.mjs` holds it equal to [`APP_ID`] because a
//! mismatch loses the icon with no error anywhere.
//!
//! Nothing here assumes a tool is installed: the icon sizes are resized in-process (the
//! `image` crate is already linked to decode the same PNG for the window), and the two
//! freedesktop cache helpers are called only if they exist.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// The Wayland app-id, the X11 `WM_CLASS`, the `.desktop` basename and the icon name — one
/// string in four places, which is the only reason they cannot drift apart.
pub const APP_ID: &str = "io.github.altagen.rite";

/// The name the binary is installed under, and what `Exec=` runs.
pub const BIN_NAME: &str = "rite";

/// Written into the hicolor theme, largest first so a chooser that stops at the first hit
/// lands on a usable size. 512 is the ceiling: the master is 1024 and nothing asks for it.
const ICON_SIZES: [u32; 8] = [512, 256, 128, 64, 48, 32, 24, 16];

/// The same master the window icon is decoded from, so one file cannot update without the
/// other.
const ICON_MASTER: &[u8] = include_bytes!("../../../../assets/rite-icon-flat.png");

/// Where the four paths live. Held as a struct so the tests can put them under a temporary
/// root instead of the home directory of whoever runs them.
pub struct Layout {
    /// `~/.local/bin` — or `$XDG_BIN_HOME`.
    pub bin_dir: PathBuf,
    /// `~/.local/share` — or `$XDG_DATA_HOME`.
    pub data_dir: PathBuf,
    /// Whether a desktop reads these directories at all.
    ///
    /// False under `--prefix`, and the bench is what found it: the two cache helpers
    /// *create* `applications/mimeinfo.cache` and `icons/hicolor/icon-theme.cache`, so a
    /// prefix came back with two files the uninstall did not remove — and a package built
    /// with `--prefix $pkgdir/usr` would have shipped them. Deleting them is not the fix:
    /// in a real `~/.local/share` they are shared with every other application. Not
    /// building them is, because nothing reads a cache under a prefix of our own.
    pub refresh_caches: bool,
}

impl Layout {
    /// The real locations, XDG variables honoured.
    pub fn user() -> Result<Self> {
        Ok(Self {
            bin_dir: dirs::executable_dir()
                .context("could not resolve the user executable directory (~/.local/bin)")?,
            data_dir: dirs::data_dir()
                .context("could not resolve the user data directory (~/.local/share)")?,
            refresh_caches: true,
        })
    }

    /// Everything under one directory, FHS-style: `DIR/bin` and `DIR/share`.
    ///
    /// What `--prefix` resolves to. `/usr/local` is then the system install and
    /// `$pkgdir/usr` is what a distribution package builds with — but a prefix outside
    /// `$XDG_DATA_HOME` and `XDG_DATA_DIRS` is invisible to a launcher, so this serves
    /// packaging and testing rather than "install Rite anywhere and it works"
    /// (ADR 0030 §2).
    pub fn prefixed(root: &Path) -> Self {
        Self {
            bin_dir: root.join("bin"),
            data_dir: root.join("share"),
            refresh_caches: false,
        }
    }

    pub fn binary(&self) -> PathBuf {
        self.bin_dir.join(BIN_NAME)
    }

    pub fn desktop_entry(&self) -> PathBuf {
        self.data_dir
            .join("applications")
            .join(format!("{APP_ID}.desktop"))
    }

    pub fn icon(&self, size: u32) -> PathBuf {
        self.data_dir
            .join("icons/hicolor")
            .join(format!("{size}x{size}"))
            .join("apps")
            .join(format!("{APP_ID}.png"))
    }
}

/// The entry's contents, for an already-placed binary.
///
/// `StartupWMClass` is the X11 half of what the basename does on Wayland: it lets a window
/// manager match the window to this entry. `Terminal=false` is the line that stops a
/// desktop from opening a terminal to host the process — the symptom this module exists for.
pub fn entry_text(exec: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Version=1.5\n\
         Name=Rite\n\
         GenericName=Terminal\n\
         Comment=Terminal and SSH client with an encrypted vault\n\
         Exec={exec}\n\
         Icon={APP_ID}\n\
         Terminal=false\n\
         Categories=System;TerminalEmulator;\n\
         Keywords=terminal;shell;ssh;console;\n\
         StartupNotify=true\n\
         StartupWMClass={APP_ID}\n",
        exec = exec.display()
    )
}

/// One icon, at one size, as PNG bytes.
///
/// The resize happens here and not in an installer because the master is embedded and
/// resizing it outside would assume ImageMagick — and a shipped default assumes no tool.
/// `rite --print-icon 48` is this function, written to stdout.
pub fn icon_png(size: u32) -> Result<Vec<u8>> {
    let master =
        image::load_from_memory(ICON_MASTER).context("the embedded icon is not an image")?;
    let mut out = std::io::Cursor::new(Vec::new());
    master
        .resize(size, size, image::imageops::FilterType::Lanczos3)
        .write_to(&mut out, image::ImageFormat::Png)
        .with_context(|| format!("could not encode the {size}x{size} icon"))?;
    Ok(out.into_inner())
}

/// The sizes an installer should place, largest first.
pub fn icon_sizes() -> &'static [u32] {
    &ICON_SIZES
}

/// What an install or an uninstall did, so the caller prints it rather than this module.
pub struct Report {
    pub lines: Vec<String>,
    /// Set when the binary directory is not on `PATH`: the one line to add, never added here.
    pub path_hint: Option<String>,
}

/// Write the four paths. Idempotent: running it twice leaves the same result.
pub fn install(layout: &Layout, source: &Path) -> Result<Report> {
    let mut lines = Vec::new();
    let target = layout.binary();

    std::fs::create_dir_all(&layout.bin_dir)
        .with_context(|| format!("could not create {}", layout.bin_dir.display()))?;

    // Copying a file onto itself truncates it, which would destroy the binary being run.
    // `rite --install` from an already-installed copy is the ordinary second run.
    if same_file(source, &target) {
        lines.push(format!("kept       {}", target.display()));
    } else {
        std::fs::copy(source, &target)
            .with_context(|| format!("could not copy the binary to {}", target.display()))?;
        set_executable(&target)?;
        lines.push(format!("installed  {}", target.display()));
    }

    let entry = layout.desktop_entry();
    let dir = entry.parent().expect("the entry path has a parent");
    std::fs::create_dir_all(dir).with_context(|| format!("could not create {}", dir.display()))?;
    std::fs::write(&entry, entry_text(&target))
        .with_context(|| format!("could not write {}", entry.display()))?;
    lines.push(format!("installed  {}", entry.display()));

    // Through the emitter, so the bytes a script places and the bytes `--install` writes
    // cannot differ.
    for size in ICON_SIZES {
        let path = layout.icon(size);
        let dir = path.parent().expect("the icon path has a parent");
        std::fs::create_dir_all(dir)
            .with_context(|| format!("could not create {}", dir.display()))?;
        std::fs::write(&path, icon_png(size)?)
            .with_context(|| format!("could not write {}", path.display()))?;
    }
    lines.push(format!(
        "installed  {} icons under {}",
        ICON_SIZES.len(),
        layout.data_dir.join("icons/hicolor").display()
    ));

    if layout.refresh_caches {
        refresh_caches(&layout.data_dir, &mut lines);
    }

    Ok(Report {
        lines,
        path_hint: path_hint(&layout.bin_dir),
    })
}

/// Remove exactly what [`install`] wrote. Never the vault: that is a separate, deliberate
/// act, and `INSTALL.md` says where it lives.
pub fn uninstall(layout: &Layout) -> Result<Report> {
    let mut lines = Vec::new();
    let mut removed_icons = 0;

    for (path, label) in [
        (layout.binary(), "binary"),
        (layout.desktop_entry(), "entry"),
    ] {
        match std::fs::remove_file(&path) {
            Ok(()) => lines.push(format!("removed    {}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                lines.push(format!("absent     {} ({label})", path.display()))
            }
            Err(e) => {
                return Err(e).with_context(|| format!("could not remove {}", path.display()));
            }
        }
    }

    // Every size, or the ones left behind keep resolving after the application is gone.
    for size in ICON_SIZES {
        let path = layout.icon(size);
        match std::fs::remove_file(&path) {
            Ok(()) => removed_icons += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(e).with_context(|| format!("could not remove {}", path.display()));
            }
        }
    }
    lines.push(format!("removed    {removed_icons} icons"));

    if layout.refresh_caches {
        refresh_caches(&layout.data_dir, &mut lines);
    }

    Ok(Report {
        lines,
        path_hint: None,
    })
}

/// Where the client keeps state, named by `--uninstall` so that removing the application
/// and removing the data stay two separate acts (`INSTALL.md` documents both).
pub fn state_note() -> String {
    let data = dirs::data_dir().map(|d| d.join("rite"));
    let config = dirs::config_dir().map(|d| d.join("rite"));
    match (data, config) {
        (Some(d), Some(c)) => format!("{} and {}", d.display(), c.display()),
        (Some(d), None) | (None, Some(d)) => d.display().to_string(),
        (None, None) => "the user data and configuration directories".to_string(),
    }
}

/// The freedesktop caches, if the tools are there. Neither is required: the specifications
/// mandate no cache, and an entry written without them is found on the next session. A
/// default that fails on a machine without a packaging helper is not a default.
fn refresh_caches(data_dir: &Path, lines: &mut Vec<String>) {
    let jobs: [(&str, Vec<PathBuf>); 2] = [
        (
            "update-desktop-database",
            vec![data_dir.join("applications")],
        ),
        (
            "gtk-update-icon-cache",
            vec![
                PathBuf::from("--quiet"),
                PathBuf::from("--ignore-theme-index"),
                data_dir.join("icons/hicolor"),
            ],
        ),
    ];
    for (tool, args) in jobs {
        let ran = std::process::Command::new(tool)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if let Ok(status) = ran {
            if status.success() {
                lines.push(format!("refreshed  {tool}"));
            }
        }
    }
}

/// The line to add when the binary directory is not on `PATH`. Printed, never written: a
/// shell rc is a file the user owns.
fn path_hint(bin_dir: &Path) -> Option<String> {
    let on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|e| e == bin_dir))
        .unwrap_or(false);
    (!on_path).then(|| format!("export PATH=\"{}:$PATH\"", bin_dir.display()))
}

/// True when both paths are the same file on disk, so a copy would truncate it. Compares
/// metadata rather than text: `~/.local/bin/rite` may be reached by a symlink or a `..`.
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        match (a.canonicalize(), b.canonicalize()) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        }
    }
}

fn set_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("could not make {} executable", path.display()))?;
    }
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of our own, named so a leftover says which test left it.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rite-install-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// The join key Wayland uses. If this ever fails, the icon disappears from the taskbar
    /// and nothing logs a word about it (ADR 0030 §3).
    #[test]
    fn the_entry_filename_is_the_app_id() {
        let layout = Layout::prefixed(Path::new("/tmp/does-not-need-to-exist"));
        let name = layout
            .desktop_entry()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(name, format!("{APP_ID}.desktop"));

        let text = entry_text(Path::new("/home/x/.local/bin/rite"));
        assert!(
            text.contains(&format!("\nIcon={APP_ID}\n")),
            "Icon= must name the app id, which is the icon filename too"
        );
        assert!(
            text.contains(&format!("\nStartupWMClass={APP_ID}\n")),
            "X11 matches on WM_CLASS where Wayland matches on the basename"
        );
    }

    /// `Terminal=false` is the key that stops the desktop hosting Rite in a terminal — the
    /// process that then dies with it.
    #[test]
    fn the_entry_does_not_ask_for_a_terminal() {
        let text = entry_text(Path::new("/home/x/.local/bin/rite"));
        assert!(text.contains("\nTerminal=false\n"));
        assert!(text.starts_with("[Desktop Entry]\n"));
        for key in ["Type=Application", "Name=Rite", "Categories="] {
            assert!(text.contains(key), "the entry needs {key}");
        }
    }

    #[test]
    fn exec_is_the_installed_binary_not_the_source() {
        let root = scratch("exec");
        let layout = Layout::prefixed(&root);
        let source = root.join("unpacked").join("rite");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"#!/bin/true\n").unwrap();

        install(&layout, &source).expect("install");
        let text = std::fs::read_to_string(layout.desktop_entry()).unwrap();
        assert!(
            text.contains(&format!("Exec={}\n", layout.binary().display())),
            "Exec must point at the installed copy, not at the tarball it came from"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn install_writes_four_paths_and_uninstall_takes_them_back() {
        let root = scratch("roundtrip");
        let layout = Layout::prefixed(&root);
        let source = root.join("unpacked").join("rite");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"#!/bin/true\n").unwrap();

        install(&layout, &source).expect("install");
        assert!(layout.binary().is_file(), "the binary");
        assert!(layout.desktop_entry().is_file(), "the entry");
        for size in ICON_SIZES {
            assert!(layout.icon(size).is_file(), "icon {size}");
        }

        // Twice must be the same as once: a second run is how an update lands.
        install(&layout, &source).expect("install again");
        assert!(layout.binary().is_file());

        uninstall(&layout).expect("uninstall");
        assert!(!layout.binary().exists(), "the binary stays removed");
        assert!(!layout.desktop_entry().exists(), "the entry stays removed");
        for size in ICON_SIZES {
            assert!(
                !layout.icon(size).exists(),
                "icon {size} outlived the uninstall"
            );
        }
        std::fs::remove_dir_all(&root).ok();
    }

    /// The icons are real images at the size their directory claims — a theme that finds a
    /// 512 where it asked for 16 scales it badly, and the entry looks broken.
    #[test]
    fn each_icon_is_its_declared_size() {
        let root = scratch("sizes");
        let layout = Layout::prefixed(&root);
        let source = root.join("rite");
        std::fs::write(&source, b"#!/bin/true\n").unwrap();

        install(&layout, &source).expect("install");
        for size in ICON_SIZES {
            let img = image::open(layout.icon(size)).expect("a readable png");
            assert_eq!((img.width(), img.height()), (size, size), "icon {size}");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    /// Installing from the installed copy must not truncate it, which a plain
    /// `fs::copy(x, x)` does.
    #[test]
    fn installing_over_itself_keeps_the_binary() {
        let root = scratch("self");
        let layout = Layout::prefixed(&root);
        std::fs::create_dir_all(&layout.bin_dir).unwrap();
        std::fs::write(layout.binary(), b"#!/bin/true\n").unwrap();

        install(&layout, &layout.binary()).expect("install");
        assert_eq!(
            std::fs::read(layout.binary()).unwrap(),
            b"#!/bin/true\n",
            "the running binary was truncated by a copy onto itself"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// `--prefix DIR` puts the four paths under DIR, and nowhere near a home directory.
    /// This is what lets the bench (`e2e/install-smoke.sh`) run against the real binary
    /// without touching an existing installation.
    #[test]
    fn a_prefix_holds_every_path_under_itself() {
        let root = Path::new("/opt/rite-trial");
        let layout = Layout::prefixed(root);

        for path in [
            layout.binary(),
            layout.desktop_entry(),
            layout.icon(48),
            layout.icon(512),
        ] {
            assert!(
                path.starts_with(root),
                "{} escaped the prefix",
                path.display()
            );
        }
        // FHS, so `--prefix /usr/local` is the system install without a second code path.
        assert_eq!(layout.binary(), root.join("bin/rite"));
        assert_eq!(
            layout.desktop_entry(),
            root.join(format!("share/applications/{APP_ID}.desktop"))
        );
        assert_eq!(
            layout.icon(48),
            root.join(format!("share/icons/hicolor/48x48/apps/{APP_ID}.png"))
        );
    }

    /// Two prefixes never collide, which is the property the bench relies on to leave an
    /// existing installation alone.
    #[test]
    fn two_prefixes_share_no_path() {
        let a = Layout::prefixed(Path::new("/opt/a"));
        let b = Layout::prefixed(Path::new("/opt/b"));
        assert_ne!(a.binary(), b.binary());
        assert_ne!(a.desktop_entry(), b.desktop_entry());
        assert_ne!(a.icon(256), b.icon(256));
    }

    /// The vault is not this command's business.
    #[test]
    fn uninstall_leaves_data_alone() {
        let root = scratch("data");
        let layout = Layout::prefixed(&root);
        let source = root.join("rite");
        std::fs::write(&source, b"#!/bin/true\n").unwrap();
        install(&layout, &source).expect("install");

        // Where the client actually keeps state, under the same data root.
        let vault = layout.data_dir.join("rite").join("vault.db");
        std::fs::create_dir_all(vault.parent().unwrap()).unwrap();
        std::fs::write(&vault, b"not a real vault").unwrap();

        uninstall(&layout).expect("uninstall");
        assert!(vault.is_file(), "uninstall removed the vault");
        std::fs::remove_dir_all(&root).ok();
    }
}
