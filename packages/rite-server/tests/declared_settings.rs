//! A declared setting reaching the crate that opens the connection (ADR 0020 addendum).
//!
//! Its own test binary, and one test in it, on purpose. Both settings are process-wide —
//! they bound a connect and govern host-key verification inside `rite-core`, where no
//! request is in the frame to resolve anything — and every `ServerState` built pushes them.
//! In the library's own test binary, a dozen tests build a state concurrently, so an
//! assertion on either value raced whichever state was constructed last: the first version
//! of this test failed one run in three with `left: 20s, right: 45s`, which reads as a bug
//! in the pushing and is a bug in the testing.
//!
//! Here nothing else constructs a state, so what is asserted is what this test put there.

use rite_core::terminal::{connect_timeout, host_key_mode};
use rite_server::ServerState;
use rite_server::config::InstanceConfig;
use std::time::Duration;

#[tokio::test]
async fn a_configured_instance_pushes_its_settings_into_rite_core() {
    let dir = tempfile::tempdir().unwrap();
    let toml = dir.path().join("rite.toml");
    std::fs::write(
        &toml,
        "ssh_connect_timeout = 45\nhost_key_verification_mode = \"strict\"\n",
    )
    .unwrap();

    // Set before the state is built, because `ServerState::new` is where the production
    // path loads the configuration — the desktop shell and the server binary both go
    // through it. Safe here in a way it is not in the library's test binary: this process
    // runs one test, so nothing else is reading the environment while it changes.
    unsafe { std::env::set_var("RITE_CONFIG", &toml) };
    let state = ServerState::new(&dir.path().join("vault.db"))
        .await
        .unwrap();

    assert_eq!(
        connect_timeout(),
        Duration::from_secs(45),
        "the declared bound has to reach the crate that opens the connection"
    );
    // The row an administrator left behind, which the declaration outranks. Before this,
    // `rite-core` read that row directly and the declared mode governed only what
    // `/api/server/mode` reported: the console showed `strict` and unknown hosts were
    // still accepted.
    assert_eq!(host_key_mode(Some("accept".to_string())), "strict");

    // A configuration that declares neither puts both back — the shipped bound, and the
    // row answering again. Removing a key from the file restores what the console had
    // (ADR 0020 §6), and a value that outlived its declaration would quietly break that.
    let _state = state.with_config(InstanceConfig::load_from(None, &[]).unwrap());
    assert_eq!(connect_timeout(), Duration::from_secs(20));
    assert_eq!(host_key_mode(Some("accept".to_string())), "accept");
    assert_eq!(
        host_key_mode(None),
        "strict",
        "an empty table is still strict"
    );
}
