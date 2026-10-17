//! Cross-platform handoff verification against the actual SQLite guards.
use miao_credential::{store, Error};
use rusqlite::Connection;
use serde_json::json;

#[test]
fn release_preserves_identity_and_refuses_a_different_owner_or_integration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("credentials.db");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE credential(id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT);").unwrap();
    let value = json!({"type":"oauth", "access":"latest-access", "refresh":"latest-refresh", "expires":123456789, "metadata":{"accountID":"account"}, "methodID":"login"});
    connection
        .execute(
            "INSERT INTO credential VALUES('cred_1','openai','Work',?1)",
            [value.to_string()],
        )
        .unwrap();
    store::claim(&path, "cred_1", "openai", "owner").unwrap();
    assert!(connection.execute("DELETE FROM credential", []).is_err());
    assert_eq!(
        store::release(&path, "cred_1", "openai", "other"),
        Err(Error::NotRefreshable)
    );
    assert_eq!(
        store::release(&path, "cred_1", "other", "owner"),
        Err(Error::Integration)
    );
    assert_eq!(
        store::release(&path, "missing", "openai", "owner"),
        Err(Error::Missing)
    );
    assert!(connection
        .execute("UPDATE credential SET label='changed'", [])
        .is_err());
    store::release(&path, "cred_1", "openai", "owner").unwrap();
    store::release(&path, "cred_1", "openai", "owner").unwrap();
    assert_eq!(store::load(&path, "cred_1", "openai").unwrap(), value);
    connection
        .execute("UPDATE credential SET label='Product'", [])
        .unwrap();
    // Re-adoption reinstalls the same guard without changing token identity.
    store::claim(&path, "cred_1", "openai", "owner").unwrap();
    assert!(connection.execute("DELETE FROM credential", []).is_err());
}
