//! The wire shape of `AuthMethod` must match what the frontend sends.
//!
//! `#[serde(rename_all = "camelCase")]` on an enum renames the *variants*, not the
//! fields inside them, so `key_path` stayed snake_case while every caller in
//! apps/desktop sends `keyPath`. Public-key auth therefore failed to deserialise on
//! every path — saving a connection, Quick SSH, ssh-config import — and no test
//! caught it because they all use password auth.

use rite_core::connection::AuthMethod;

#[test]
fn accepts_exactly_what_the_browser_sends() {
    let browser = r#"{"type":"publicKey","keyPath":"/home/u/.ssh/id_ed25519","passphrase":"s"}"#;
    let parsed: AuthMethod = serde_json::from_str(browser).expect("browser publicKey must parse");
    match parsed {
        AuthMethod::PublicKey {
            key_path,
            passphrase,
        } => {
            assert_eq!(key_path, "/home/u/.ssh/id_ed25519");
            assert_eq!(passphrase.as_deref(), Some("s"));
        }
        other => panic!("wrong variant: {other:?}"),
    }
}

#[test]
fn writes_back_the_same_spelling() {
    let json = serde_json::to_string(&AuthMethod::PublicKey {
        key_path: "/k".into(),
        passphrase: None,
    })
    .unwrap();
    assert!(
        json.contains("\"keyPath\""),
        "must round-trip to the browser: {json}"
    );
    assert!(!json.contains("key_path"));
}

#[test]
fn still_reads_credentials_stored_under_the_old_spelling() {
    let legacy = r#"{"type":"publicKey","key_path":"/k"}"#;
    assert!(serde_json::from_str::<AuthMethod>(legacy).is_ok());
}

#[test]
fn the_other_variants_are_unaffected() {
    for json in [
        r#"{"type":"password","password":"p"}"#,
        r#"{"type":"agent","identity":"fp","forward":true}"#,
        r#"{"type":"agent"}"#,
    ] {
        serde_json::from_str::<AuthMethod>(json).unwrap_or_else(|e| panic!("{json}: {e}"));
    }
}
