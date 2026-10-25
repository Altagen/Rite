/**
 * Known Hosts Module
 *
 * Manages SSH server host key verification for MITM protection.
 *
 * Trust belongs to a MEMBER, not to an instance (ADR 0021, addendum). Every function here
 * is scoped to an owner, and the tables are keyed `UNIQUE(user_id, host, port)`. Before
 * that, a shared server had one set of known hosts for everyone and `host-key/accept` was
 * not an admin route — so any member could promote a pending key and every other member
 * then connected to that host without ever being asked. A member who accepted a
 * man-in-the-middle key silenced the changed-key refusal for the whole instance.
 *
 * The owner is [`LOCAL_OWNER`] for a local vault, which has exactly one person, and the
 * member's id on a shared server. Member ids are uuids, so none can collide with it.
 */
use anyhow::Result;
use russh::keys::{HashAlg, PublicKey};
use serde::Serialize;
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// The owner a local vault records its host keys under.
///
/// A local vault is one person (ADR 0018), so it needs no account to name them — but the
/// column cannot be empty, because SQLite treats NULLs as distinct inside a UNIQUE index
/// and an absent owner would let the same host be recorded twice over. This literal is
/// also the migration's default, which is what keeps a desktop's existing hosts trusted
/// across the upgrade.
pub const LOCAL_OWNER: &str = "local";

/// Result of host key verification
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status")]
pub enum HostKeyVerificationResult {
    /// Host is known and key matches
    #[serde(rename = "accepted")]
    Accepted,
    /// Host is unknown (first connection)
    #[serde(rename = "unknown")]
    Unknown {
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
    },
    /// Host is known but key has changed (potential MITM attack)
    #[serde(rename = "changed")]
    Changed {
        host: String,
        port: u16,
        key_type: String,
        old_fingerprint: String,
        new_fingerprint: String,
    },
}

/// One trusted host, as a listing shows it.
///
/// The raw key bytes are deliberately absent: what a person verifies out-of-band is the
/// fingerprint, and nothing in a UI has any use for the key itself.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    /// Unix seconds, when this key was first trusted.
    pub added_at: i64,
    /// Unix seconds, when a connection last matched it.
    pub last_seen_at: i64,
}

/// Get current Unix timestamp in seconds
fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Calculate SHA256 fingerprint of a public key
fn calculate_fingerprint(public_key: &PublicKey) -> String {
    public_key.fingerprint(HashAlg::Sha256).to_string()
}

/// Get the key type string from a PublicKey
fn get_key_type(public_key: &PublicKey) -> String {
    public_key.algorithm().to_string()
}

/// Verify a server's host key, as `owner` knows it.
///
/// A host trusted by someone else is `Unknown` here, which is the whole point: a
/// fingerprint read out-of-band by one person is not evidence for anyone else.
pub async fn verify_host_key(
    db: &SqlitePool,
    owner: &str,
    host: &str,
    port: u16,
    server_public_key: &PublicKey,
) -> Result<HostKeyVerificationResult> {
    tracing::info!("[known_hosts] Verifying host key for {}:{}", host, port);

    let fingerprint = calculate_fingerprint(server_public_key);
    let key_type = get_key_type(server_public_key);

    // Check if this owner already knows the host
    let existing = sqlx::query_as::<_, (String, String, Vec<u8>)>(
        "SELECT id, fingerprint, public_key_data FROM known_hosts
         WHERE user_id = ? AND host = ? AND port = ?",
    )
    .bind(owner)
    .bind(host)
    .bind(port as i64)
    .fetch_optional(db)
    .await?;

    match existing {
        Some((id, old_fingerprint, _old_key_data)) => {
            // Host is known, check if key matches
            if fingerprint == old_fingerprint {
                // Key matches, update last_seen_at
                tracing::info!("[known_hosts] Host key verified successfully");
                update_last_seen(db, &id).await?;
                Ok(HostKeyVerificationResult::Accepted)
            } else {
                // Key has changed - potential MITM attack!
                tracing::warn!("[known_hosts] HOST KEY CHANGED for {}:{}", host, port);
                tracing::warn!("[known_hosts] Old fingerprint: {}", old_fingerprint);
                tracing::warn!("[known_hosts] New fingerprint: {}", fingerprint);
                Ok(HostKeyVerificationResult::Changed {
                    host: host.to_string(),
                    port,
                    key_type,
                    old_fingerprint,
                    new_fingerprint: fingerprint,
                })
            }
        }
        None => {
            // Host is unknown to this owner (first connection)
            tracing::info!("[known_hosts] Unknown host {}:{}", host, port);
            Ok(HostKeyVerificationResult::Unknown {
                host: host.to_string(),
                port,
                key_type,
                fingerprint,
            })
        }
    }
}

/// Add or update a host key for `owner` (after that owner confirmed it).
pub async fn add_host_key(
    db: &SqlitePool,
    owner: &str,
    host: &str,
    port: u16,
    server_public_key: &PublicKey,
) -> Result<()> {
    tracing::info!(
        "[known_hosts] Adding/updating host key for {}:{}",
        host,
        port
    );

    let fingerprint = calculate_fingerprint(server_public_key);
    let key_type = get_key_type(server_public_key);
    let public_key_data = server_public_key.to_bytes()?;
    let now = current_timestamp();

    // An upsert on this owner's row, and only this owner's — another member's row for the
    // same host is not ours to touch. One statement rather than DELETE-then-INSERT, which
    // two concurrent connections to one host raced each other through (see
    // `store_pending_host_key`). `added_at` is deliberately left alone on conflict: it is
    // when this owner first trusted the host, and re-seeing the same key is not a new
    // decision.
    sqlx::query(
        "INSERT INTO known_hosts (id, user_id, host, port, key_type, fingerprint, public_key_data, added_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, host, port) DO UPDATE SET
           key_type = excluded.key_type,
           fingerprint = excluded.fingerprint,
           public_key_data = excluded.public_key_data,
           last_seen_at = excluded.last_seen_at"
    )
    .bind(Uuid::new_v4().to_string())
    .bind(owner)
    .bind(host)
    .bind(port as i64)
    .bind(key_type)
    .bind(fingerprint)
    .bind(&public_key_data)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;

    tracing::info!("[known_hosts] Host key added successfully");
    Ok(())
}

/// Store a host key offered by an unknown host, pending `owner`'s confirmation
/// (strict mode). Overwrites any previous pending key of theirs for the same host:port.
pub async fn store_pending_host_key(
    db: &SqlitePool,
    owner: &str,
    host: &str,
    port: u16,
    server_public_key: &PublicKey,
) -> Result<()> {
    let fingerprint = calculate_fingerprint(server_public_key);
    let key_type = get_key_type(server_public_key);
    let public_key_data = server_public_key.to_bytes()?;
    let now = current_timestamp();

    // One statement, not a DELETE followed by an INSERT. Two connection attempts to the
    // same unknown host run concurrently — a double-click does it, and so does
    // auto-reconnect — and on a pool they take different connections: both deleted
    // nothing, both inserted, and the second lost the race with
    // `UNIQUE constraint failed: pending_host_keys`. The visible cost was the one that
    // matters: the offered key was not stored, so strict mode refused the connection AND
    // had nothing for the accept dialog to show. An upsert cannot race itself.
    sqlx::query(
        "INSERT INTO pending_host_keys (user_id, host, port, key_type, fingerprint, public_key_data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, host, port) DO UPDATE SET
           key_type = excluded.key_type,
           fingerprint = excluded.fingerprint,
           public_key_data = excluded.public_key_data,
           created_at = excluded.created_at",
    )
    .bind(owner)
    .bind(host)
    .bind(port as i64)
    .bind(key_type)
    .bind(fingerprint)
    .bind(&public_key_data)
    .bind(now)
    .execute(db)
    .await?;

    tracing::info!(
        "[known_hosts] Stored pending host key for {}:{}",
        host,
        port
    );
    Ok(())
}

/// Promote `owner`'s pending host key to a trusted known host (they accepted it).
/// Returns `true` if a pending key of theirs existed for this host:port.
pub async fn accept_pending_host_key(
    db: &SqlitePool,
    owner: &str,
    host: &str,
    port: u16,
) -> Result<bool> {
    let pending = sqlx::query_as::<_, (String, String, Vec<u8>)>(
        "SELECT key_type, fingerprint, public_key_data FROM pending_host_keys
         WHERE user_id = ? AND host = ? AND port = ?",
    )
    .bind(owner)
    .bind(host)
    .bind(port as i64)
    .fetch_optional(db)
    .await?;

    let Some((key_type, fingerprint, public_key_data)) = pending else {
        return Ok(false);
    };
    let now = current_timestamp();

    sqlx::query(
        "INSERT INTO known_hosts (id, user_id, host, port, key_type, fingerprint, public_key_data, added_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, host, port) DO UPDATE SET
           key_type = excluded.key_type,
           fingerprint = excluded.fingerprint,
           public_key_data = excluded.public_key_data,
           last_seen_at = excluded.last_seen_at",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(owner)
    .bind(host)
    .bind(port as i64)
    .bind(key_type)
    .bind(fingerprint)
    .bind(&public_key_data)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;

    sqlx::query("DELETE FROM pending_host_keys WHERE user_id = ? AND host = ? AND port = ?")
        .bind(owner)
        .bind(host)
        .bind(port as i64)
        .execute(db)
        .await?;

    tracing::info!("[known_hosts] Accepted host key for {}:{}", host, port);
    Ok(true)
}

/// Drop `owner`'s pending host key (they rejected it).
pub async fn reject_pending_host_key(
    db: &SqlitePool,
    owner: &str,
    host: &str,
    port: u16,
) -> Result<()> {
    sqlx::query("DELETE FROM pending_host_keys WHERE user_id = ? AND host = ? AND port = ?")
        .bind(owner)
        .bind(host)
        .bind(port as i64)
        .execute(db)
        .await?;
    tracing::info!(
        "[known_hosts] Rejected pending host key for {}:{}",
        host,
        port
    );
    Ok(())
}

/// Every host `owner` trusts, most recently used first.
///
/// Nothing listed what was trusted before this, which is what made a legitimately rotated
/// host key a dead end: the changed-key refusal offers no accept (ADR 0021 §3), and the
/// only way through was Quick SSH, which force-accepts before verification runs (§5).
/// Forgetting the old key turns a rotation back into a first contact.
pub async fn list_host_keys(db: &SqlitePool, owner: &str) -> Result<Vec<KnownHost>> {
    let rows = sqlx::query_as::<_, (String, String, i64, String, String, i64, i64)>(
        "SELECT id, host, port, key_type, fingerprint, added_at, last_seen_at
         FROM known_hosts WHERE user_id = ?
         ORDER BY last_seen_at DESC, host ASC",
    )
    .bind(owner)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(id, host, port, key_type, fingerprint, added_at, last_seen_at)| KnownHost {
                id,
                host,
                port: port as u16,
                key_type,
                fingerprint,
                added_at,
                last_seen_at,
            },
        )
        .collect())
}

/// Forget one of `owner`'s trusted hosts. Returns `true` if they had one to forget.
///
/// Scoped to the owner, so forgetting is as private as trusting: a member cannot make
/// another member's host unknown.
pub async fn forget_host_key(db: &SqlitePool, owner: &str, host: &str, port: u16) -> Result<bool> {
    let done = sqlx::query("DELETE FROM known_hosts WHERE user_id = ? AND host = ? AND port = ?")
        .bind(owner)
        .bind(host)
        .bind(port as i64)
        .execute(db)
        .await?;
    // A pending key for the same host is dropped with it: leaving one behind would make
    // the next connection answer with a key the person just decided to stop trusting.
    sqlx::query("DELETE FROM pending_host_keys WHERE user_id = ? AND host = ? AND port = ?")
        .bind(owner)
        .bind(host)
        .bind(port as i64)
        .execute(db)
        .await?;
    let forgotten = done.rows_affected() > 0;
    if forgotten {
        tracing::info!("[known_hosts] Forgot host key for {}:{}", host, port);
    }
    Ok(forgotten)
}

/// Update last_seen_at timestamp for a known host
async fn update_last_seen(db: &SqlitePool, id: &str) -> Result<()> {
    let now = current_timestamp();
    sqlx::query("UPDATE known_hosts SET last_seen_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use tempfile::TempDir;

    /// Two members of one instance, and the literal a local vault uses.
    const ALICE: &str = "11111111-1111-4111-8111-111111111111";
    const BOB: &str = "22222222-2222-4222-8222-222222222222";

    async fn db() -> (Database, TempDir) {
        let dir = TempDir::new().unwrap();
        let db = Database::new(&dir.path().join("test.db")).await.unwrap();
        (db, dir)
    }

    fn a_key() -> PublicKey {
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
            .unwrap()
            .public_key()
            .clone()
    }

    #[tokio::test]
    async fn a_member_id_can_never_be_the_local_owner() {
        // The whole separation rests on this: a shared server passes member ids and a
        // local vault passes the literal, into the same column. Member ids are uuids, so
        // the two namespaces cannot meet — and if that ever changed, one member would
        // inherit every local row.
        assert_eq!(LOCAL_OWNER, "local");
        assert!(uuid::Uuid::parse_str(LOCAL_OWNER).is_err());
        for id in [ALICE, BOB] {
            assert!(uuid::Uuid::parse_str(id).is_ok(), "{id} is not a uuid");
            assert_ne!(id, LOCAL_OWNER);
        }
    }

    #[tokio::test]
    async fn one_member_trusting_a_host_does_not_trust_it_for_another() {
        let (db, _dir) = db().await;
        let key = a_key();

        add_host_key(db.pool(), ALICE, "web-01", 22, &key)
            .await
            .unwrap();

        // The defect this whole change exists for: before the owner column, Bob's first
        // connection to web-01 was Accepted on the strength of Alice's decision alone,
        // and he was never asked.
        assert!(matches!(
            verify_host_key(db.pool(), ALICE, "web-01", 22, &key)
                .await
                .unwrap(),
            HostKeyVerificationResult::Accepted
        ));
        assert!(matches!(
            verify_host_key(db.pool(), BOB, "web-01", 22, &key)
                .await
                .unwrap(),
            HostKeyVerificationResult::Unknown { .. }
        ));
    }

    #[tokio::test]
    async fn accepting_a_pending_key_promotes_only_the_accepter() {
        let (db, _dir) = db().await;
        let key = a_key();

        // Both meet the unknown host and both have it held as pending.
        store_pending_host_key(db.pool(), ALICE, "web-01", 22, &key)
            .await
            .unwrap();
        store_pending_host_key(db.pool(), BOB, "web-01", 22, &key)
            .await
            .unwrap();

        assert!(
            accept_pending_host_key(db.pool(), ALICE, "web-01", 22)
                .await
                .unwrap()
        );

        assert!(matches!(
            verify_host_key(db.pool(), ALICE, "web-01", 22, &key)
                .await
                .unwrap(),
            HostKeyVerificationResult::Accepted
        ));
        // Bob's pending key is still pending: `host-key/accept` is not an admin route, so
        // before this one member's click answered for everyone.
        assert!(matches!(
            verify_host_key(db.pool(), BOB, "web-01", 22, &key)
                .await
                .unwrap(),
            HostKeyVerificationResult::Unknown { .. }
        ));
        assert!(
            accept_pending_host_key(db.pool(), BOB, "web-01", 22)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn rejecting_drops_only_your_own_pending_key() {
        let (db, _dir) = db().await;
        let key = a_key();
        store_pending_host_key(db.pool(), ALICE, "web-01", 22, &key)
            .await
            .unwrap();
        store_pending_host_key(db.pool(), BOB, "web-01", 22, &key)
            .await
            .unwrap();

        reject_pending_host_key(db.pool(), ALICE, "web-01", 22)
            .await
            .unwrap();

        // Alice has nothing left to accept; Bob still does.
        assert!(
            !accept_pending_host_key(db.pool(), ALICE, "web-01", 22)
                .await
                .unwrap()
        );
        assert!(
            accept_pending_host_key(db.pool(), BOB, "web-01", 22)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn a_listing_shows_your_hosts_and_nobody_elses() {
        let (db, _dir) = db().await;
        add_host_key(db.pool(), ALICE, "web-01", 22, &a_key())
            .await
            .unwrap();
        add_host_key(db.pool(), ALICE, "db-01", 2222, &a_key())
            .await
            .unwrap();
        add_host_key(db.pool(), BOB, "secret-01", 22, &a_key())
            .await
            .unwrap();

        let mine = list_host_keys(db.pool(), ALICE).await.unwrap();
        let mut names: Vec<_> = mine.iter().map(|h| h.host.as_str()).collect();
        names.sort();
        assert_eq!(names, ["db-01", "web-01"]);
        // The port is carried, not assumed: a host on 2222 is a different host.
        assert_eq!(
            mine.iter().find(|h| h.host == "db-01").map(|h| h.port),
            Some(2222)
        );
        // And a listing never leaks another member's hosts, which is a privacy matter as
        // much as a trust one: it says where somebody connects.
        assert!(!names.contains(&"secret-01"));
        assert_eq!(
            list_host_keys(db.pool(), LOCAL_OWNER).await.unwrap().len(),
            0
        );
    }

    #[tokio::test]
    async fn a_listing_carries_the_fingerprint_a_person_verifies() {
        let (db, _dir) = db().await;
        let key = a_key();
        add_host_key(db.pool(), ALICE, "web-01", 22, &key)
            .await
            .unwrap();

        let listed = list_host_keys(db.pool(), ALICE).await.unwrap();
        assert_eq!(listed.len(), 1);
        // Pinned to the key's own fingerprint rather than to "not empty": a listing that
        // showed the wrong one would be worse than showing none, because out-of-band
        // verification is the only thing a fingerprint is for.
        assert_eq!(listed[0].fingerprint, calculate_fingerprint(&key));
        assert_eq!(listed[0].key_type, get_key_type(&key));
        assert!(listed[0].added_at > 0 && listed[0].last_seen_at > 0);
    }

    #[tokio::test]
    async fn forgetting_a_host_makes_it_unknown_again_to_you_alone() {
        let (db, _dir) = db().await;
        let key = a_key();
        add_host_key(db.pool(), ALICE, "web-01", 22, &key)
            .await
            .unwrap();
        add_host_key(db.pool(), BOB, "web-01", 22, &key)
            .await
            .unwrap();

        assert!(
            forget_host_key(db.pool(), ALICE, "web-01", 22)
                .await
                .unwrap()
        );

        // What this buys: a rotated host key had no clean path, because a changed key is
        // refused in every mode (ADR 0021 §3). Forgetting turns it back into a first
        // contact — for the person who forgot, and nobody else.
        assert!(matches!(
            verify_host_key(db.pool(), ALICE, "web-01", 22, &key)
                .await
                .unwrap(),
            HostKeyVerificationResult::Unknown { .. }
        ));
        assert!(matches!(
            verify_host_key(db.pool(), BOB, "web-01", 22, &key)
                .await
                .unwrap(),
            HostKeyVerificationResult::Accepted
        ));
    }

    #[tokio::test]
    async fn forgetting_a_host_you_never_trusted_says_so() {
        let (db, _dir) = db().await;
        add_host_key(db.pool(), BOB, "web-01", 22, &a_key())
            .await
            .unwrap();
        // Not an error, but not a deletion either — which is what lets a UI tell "gone"
        // from "was never yours".
        assert!(
            !forget_host_key(db.pool(), ALICE, "web-01", 22)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn forgetting_also_drops_the_pending_key_for_that_host() {
        let (db, _dir) = db().await;
        let old = a_key();
        let rotated = a_key();
        add_host_key(db.pool(), ALICE, "web-01", 22, &old)
            .await
            .unwrap();
        store_pending_host_key(db.pool(), ALICE, "web-01", 22, &rotated)
            .await
            .unwrap();

        assert!(
            forget_host_key(db.pool(), ALICE, "web-01", 22)
                .await
                .unwrap()
        );
        // Leaving the pending row behind would let the next accept restore a key the
        // person had just decided to stop trusting.
        assert!(
            !accept_pending_host_key(db.pool(), ALICE, "web-01", 22)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn a_changed_key_is_still_changed_for_the_owner_who_trusted_it() {
        let (db, _dir) = db().await;
        let first = a_key();
        let rotated = a_key();
        add_host_key(db.pool(), ALICE, "web-01", 22, &first)
            .await
            .unwrap();

        // ADR 0021 §3 survives the scoping: for Alice this is a changed key, and the
        // fingerprints it reports are the two real ones.
        match verify_host_key(db.pool(), ALICE, "web-01", 22, &rotated)
            .await
            .unwrap()
        {
            HostKeyVerificationResult::Changed {
                old_fingerprint,
                new_fingerprint,
                ..
            } => {
                assert_eq!(old_fingerprint, calculate_fingerprint(&first));
                assert_eq!(new_fingerprint, calculate_fingerprint(&rotated));
            }
            other => panic!("expected Changed, got {other:?}"),
        }
        // To Bob, who trusted nothing, the same host is simply unknown.
        assert!(matches!(
            verify_host_key(db.pool(), BOB, "web-01", 22, &rotated)
                .await
                .unwrap(),
            HostKeyVerificationResult::Unknown { .. }
        ));
    }

    #[tokio::test]
    async fn two_members_can_trust_the_same_host_at_once() {
        let (db, _dir) = db().await;
        let key = a_key();
        // The unique index moved from (host, port) to (user_id, host, port). Without that
        // the second insert would collide and one member would lose their row.
        add_host_key(db.pool(), ALICE, "web-01", 22, &key)
            .await
            .unwrap();
        add_host_key(db.pool(), BOB, "web-01", 22, &key)
            .await
            .unwrap();
        add_host_key(db.pool(), LOCAL_OWNER, "web-01", 22, &key)
            .await
            .unwrap();

        for owner in [ALICE, BOB, LOCAL_OWNER] {
            assert!(
                matches!(
                    verify_host_key(db.pool(), owner, "web-01", 22, &key)
                        .await
                        .unwrap(),
                    HostKeyVerificationResult::Accepted
                ),
                "{owner} lost their row"
            );
        }
    }

    #[tokio::test]
    async fn concurrent_attempts_on_one_unknown_host_do_not_collide() {
        let (db, _dir) = db().await;
        let key = a_key();
        let pool = db.pool().clone();

        // Two connections to the same unknown host, at once. A double-click does this, and
        // so does auto-reconnect. The old DELETE-then-INSERT took two pool connections:
        // both deleted nothing, both inserted, and the loser came back with
        // `UNIQUE constraint failed: pending_host_keys`. The cost was not the log line —
        // it was that the offered key went unstored, so strict mode refused the connection
        // and left the accept dialog with nothing to show.
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let pool = pool.clone();
            let key = key.clone();
            tasks.push(tokio::spawn(async move {
                store_pending_host_key(&pool, ALICE, "web-01", 22, &key).await
            }));
        }
        for t in tasks {
            t.await
                .unwrap()
                .expect("a concurrent attempt must not fail");
        }

        // And exactly one pending key survives, which is what the dialog accepts.
        assert!(
            accept_pending_host_key(db.pool(), ALICE, "web-01", 22)
                .await
                .unwrap()
        );
        assert!(
            !accept_pending_host_key(db.pool(), ALICE, "web-01", 22)
                .await
                .unwrap(),
            "only one row was ever stored"
        );
    }

    #[tokio::test]
    async fn concurrent_adds_of_one_host_do_not_collide() {
        let (db, _dir) = db().await;
        let key = a_key();
        let pool = db.pool().clone();

        // The same race on the accepted side: `warn` and `accept` modes call this one.
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let pool = pool.clone();
            let key = key.clone();
            tasks.push(tokio::spawn(async move {
                add_host_key(&pool, ALICE, "web-01", 22, &key).await
            }));
        }
        for t in tasks {
            t.await.unwrap().expect("a concurrent add must not fail");
        }
        assert_eq!(list_host_keys(db.pool(), ALICE).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn seeing_a_known_host_again_keeps_when_it_was_first_trusted() {
        let (db, _dir) = db().await;
        let key = a_key();
        add_host_key(db.pool(), ALICE, "web-01", 22, &key)
            .await
            .unwrap();

        // Backdated on purpose. Reading the timestamp the first call wrote and comparing
        // it to the second's proves nothing: both land in the same second, so the
        // assertion held whether or not the upsert overwrote the column — found by
        // mutation, which stayed green with `added_at = excluded.added_at` in the SQL.
        const LONG_AGO: i64 = 1_000_000;
        sqlx::query("UPDATE known_hosts SET added_at = ? WHERE user_id = ? AND host = ?")
            .bind(LONG_AGO)
            .bind(ALICE)
            .bind("web-01")
            .execute(db.pool())
            .await
            .unwrap();
        let first = list_host_keys(db.pool(), ALICE).await.unwrap()[0].clone();
        assert_eq!(first.added_at, LONG_AGO);

        // Re-seeing the SAME key is not a new decision, so `added_at` is left alone: it
        // answers "since when have I trusted this", which a listing shows and which an
        // upsert that overwrote it would quietly reset on every connection.
        add_host_key(db.pool(), ALICE, "web-01", 22, &key)
            .await
            .unwrap();
        let again = list_host_keys(db.pool(), ALICE).await.unwrap()[0].clone();
        assert_eq!(again.added_at, LONG_AGO, "first trusted stays put");
        assert_eq!(
            again.id, first.id,
            "and it is the same row, not a replacement"
        );
        // While last_seen_at does move: that is the column that answers "and recently?".
        assert!(again.last_seen_at > LONG_AGO, "last seen moves forward");
    }

    #[tokio::test]
    async fn re_adding_a_host_replaces_only_your_own_row() {
        let (db, _dir) = db().await;
        let first = a_key();
        let second = a_key();
        add_host_key(db.pool(), ALICE, "web-01", 22, &first)
            .await
            .unwrap();
        add_host_key(db.pool(), BOB, "web-01", 22, &first)
            .await
            .unwrap();

        add_host_key(db.pool(), ALICE, "web-01", 22, &second)
            .await
            .unwrap();

        assert_eq!(list_host_keys(db.pool(), ALICE).await.unwrap().len(), 1);
        assert_eq!(
            list_host_keys(db.pool(), ALICE).await.unwrap()[0].fingerprint,
            calculate_fingerprint(&second)
        );
        // Bob's row still holds the key he accepted, not the one Alice replaced it with.
        assert_eq!(
            list_host_keys(db.pool(), BOB).await.unwrap()[0].fingerprint,
            calculate_fingerprint(&first)
        );
    }
}
