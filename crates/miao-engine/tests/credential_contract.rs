//! The engine reads the product's credential table read-only through the
//! spawn contract (--credential-db/--credential-id/--credential-integration).
//! This test pins the columns and row shape that read depends on, so a
//! product-side schema migration that would break the engine surfaces here
//! instead of at provider turn time.

use miao_engine::credential::{Kind, Source};
use miao_engine::credential::Error;
use std::path::PathBuf;

fn product_database() -> PathBuf {
    // Columns and nullability mirror packages/core/src/credential/sql.ts.
    let path = std::env::temp_dir().join(format!(
        "miao-credential-contract-{}-{}.db",
        std::process::id(),
        CredentialContractGuard.next_id()
    ));
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE credential (
               id TEXT PRIMARY KEY,
               integration_id TEXT,
               label TEXT NOT NULL,
               value TEXT NOT NULL,
               connector_id TEXT,
               method_id TEXT,
               active INTEGER,
               time_created INTEGER NOT NULL,
               time_updated INTEGER NOT NULL
             );",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
             VALUES ('cred_key', 'anthropic', 'Fixture', '{\"type\":\"key\",\"key\":\"sk-fixture\"}', 1, 1, 1)",
            [],
        )
        .unwrap();
    path
}

struct CredentialContractGuard;

impl CredentialContractGuard {
    fn next_id(&self) -> u32 {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(1);
        COUNTER.fetch_add(1, Ordering::Relaxed)
    }
}

#[tokio::test]
async fn the_product_credential_row_resolves_as_a_key() {
    let path = product_database();
    let source = Source::Database {
        path,
        id: "cred_key".into(),
        integration: "anthropic".into(),
    };
    let loaded = source.load().await.unwrap();
    assert_eq!(loaded.kind(), Kind::Key);
}

#[tokio::test]
async fn a_different_integration_refuses_the_row() {
    let path = product_database();
    let source = Source::Database {
        path,
        id: "cred_key".into(),
        integration: "openai".into(),
    };
    assert!(matches!(source.load().await, Err(Error::Integration)));
}

#[tokio::test]
async fn a_missing_row_reports_missing() {
    let path = product_database();
    let source = Source::Database {
        path,
        id: "cred_absent".into(),
        integration: "anthropic".into(),
    };
    assert!(matches!(source.load().await, Err(Error::Missing)));
}
