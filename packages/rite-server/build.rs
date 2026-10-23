//! What this build knows about itself.
//!
//! The version comes from Cargo. The commit and the build date cannot: a release image is
//! built from a tree with no `.git` in it (`.containerignore` excludes it, deliberately —
//! the repository is not part of what ships), so asking git at compile time answers
//! nothing exactly where the answer matters most.
//!
//! So both are read from the environment first and discovered second: a release passes
//! `RITE_COMMIT` as a build argument, a local `cargo build` falls back to asking git, and
//! a build with neither says `unknown` rather than inventing something.
//!
//! The BUILD TIME is not computed here. A build script runs only when one of its declared
//! inputs changes, so a stamp written here outlives the binary it describes: copying a new
//! frontend into `web/` recompiles this crate and relinks the binary without re-running
//! this script, and the System panel then names yesterday for a binary built minutes ago.
//! It happened. So this only passes `RITE_BUILT_AT` through for a release that wants a
//! fixed value, and an empty one means "ask the executable" at runtime.

use std::process::Command;

fn main() {
    // Only re-run when the inputs change, not on every build of every crate.
    println!("cargo:rerun-if-env-changed=RITE_COMMIT");
    println!("cargo:rerun-if-env-changed=RITE_BUILT_AT");
    println!("cargo:rerun-if-changed=build.rs");
    // …and when the checkout moves: `HEAD` for a branch switch, the ref it names for a
    // new commit on the same branch. Without these the commit is stamped once and then
    // reported for every later build, which is the same lie as the date was.
    watch_git_head();

    let commit = std::env::var("RITE_COMMIT")
        .ok()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .or_else(git_commit)
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=RITE_COMMIT={commit}");

    // Empty unless a release pinned one: the server reads its own file's time instead.
    let built = std::env::var("RITE_BUILT_AT")
        .map(|d| d.trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=RITE_BUILT_AT={built}");
}

/// Tell cargo to re-run this script when the checked-out commit changes.
///
/// `.git` is absent in a release image (`.containerignore` excludes it), and a missing
/// path in `rerun-if-changed` is not an error — it just never triggers, which is correct
/// there: that build is stamped by its build argument.
fn watch_git_head() {
    let git = std::path::Path::new("../../.git");
    let head = git.join("HEAD");
    println!("cargo:rerun-if-changed={}", head.display());
    // `HEAD` holds `ref: refs/heads/<branch>`; the branch file is what a commit moves.
    if let Ok(contents) = std::fs::read_to_string(&head)
        && let Some(reference) = contents.strip_prefix("ref: ")
    {
        println!(
            "cargo:rerun-if-changed={}",
            git.join(reference.trim()).display()
        );
    }
    // A commit can also be recorded in `packed-refs` rather than as a loose file.
    println!(
        "cargo:rerun-if-changed={}",
        git.join("packed-refs").display()
    );
}

fn git_commit() -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if sha.is_empty() {
        return None;
    }
    // A tree with uncommitted changes is not the commit it names, and a bug report that
    // says so saves the first round of questions.
    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .is_some_and(|o| !o.stdout.is_empty());
    Some(if dirty { format!("{sha}-dirty") } else { sha })
}
