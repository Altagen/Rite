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

use std::process::Command;

fn main() {
    // Only re-run when the inputs change, not on every build of every crate.
    println!("cargo:rerun-if-env-changed=RITE_COMMIT");
    println!("cargo:rerun-if-changed=build.rs");

    let commit = std::env::var("RITE_COMMIT")
        .ok()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .or_else(git_commit)
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=RITE_COMMIT={commit}");

    // A date, not a timestamp: this is read by a person in a bug report, and the hour a
    // binary was linked tells them nothing they can act on.
    let built = std::env::var("RITE_BUILT_AT")
        .ok()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(today);
    println!("cargo:rustc-env=RITE_BUILT_AT={built}");
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

/// Today in UTC, as `YYYY-MM-DD`, computed from the epoch so the build needs no date crate.
fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs / 86_400;
    // Civil-from-days (Howard Hinnant's algorithm), shifted to an era starting 0000-03-01.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}
