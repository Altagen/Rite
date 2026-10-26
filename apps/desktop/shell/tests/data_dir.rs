//! Where the state lives, pinned to exact paths.
//!
//! The vault, the device preferences and the vault roster all hang off one directory, and
//! the rule that resolves it comes from `dirs`. A version of that crate which changed the
//! rule would not fail to build and would not log: a launched Rite would simply open a
//! fresh, empty vault beside the real one, and a backup script would copy the wrong
//! directory. So the path is asserted as a literal here, through the binary, with the
//! environment it reads under test control.
//!
//! Through the binary on purpose. `dirs::data_dir()` reads process environment, and a unit
//! test that set it would race every other test in the process — and an assertion written
//! as `data_dir() == dirs::data_dir().join("rite")` would agree with any rule the crate
//! adopted, which is the one thing it must not do.

#![cfg(target_os = "linux")]

use std::process::Command;

/// `rite --print-data-dir` under a named environment, as one trimmed line.
fn print_data_dir(xdg: Option<&str>, home: &str) -> String {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_rite"));
    cmd.arg("--print-data-dir").env("HOME", home);
    match xdg {
        Some(value) => cmd.env("XDG_DATA_HOME", value),
        None => cmd.env_remove("XDG_DATA_HOME"),
    };
    let out = cmd.output().expect("could not run the binary");
    assert!(out.status.success(), "--print-data-dir failed: {out:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

#[test]
fn xdg_data_home_is_honoured_exactly() {
    // A directory that does not exist: printing the path must not require it, or a packager
    // could not ask where to put the files before putting them there.
    assert_eq!(
        print_data_dir(Some("/pinned/xdg-data"), "/pinned/home"),
        "/pinned/xdg-data/rite"
    );
}

#[test]
fn without_xdg_data_home_it_is_the_dot_local_default() {
    // The default every installed Rite actually runs on. `INSTALL.md` prints this path and
    // `e2e/serve.sh` wipes it, so a change here breaks the documentation and the harness in
    // the same stroke.
    assert_eq!(
        print_data_dir(None, "/pinned/home"),
        "/pinned/home/.local/share/rite"
    );
}

#[test]
fn an_empty_xdg_data_home_falls_back_rather_than_rooting_at_slash() {
    // XDG says a relative or empty value is ignored. Honouring an empty one would resolve
    // to `/rite`, which is unwritable and would read as a permissions bug, not a path bug.
    assert_eq!(
        print_data_dir(Some(""), "/pinned/home"),
        "/pinned/home/.local/share/rite"
    );
}
