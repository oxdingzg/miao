//! A new database hands free pages back instead of growing without bound.
//!
//! DATA-03's storage spec (migration plan, step 1) asks new databases to enable
//! `auto_vacuum = INCREMENTAL`; the operator command `miao db vacuum` stays for
//! the databases that were created before it.
use miao_engine::store::Store;

#[tokio::test]
async fn a_new_database_enables_incremental_vacuum() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    let store = Store::open(&path).await.unwrap();
    store.initialize("s", "session", "/tmp").await.unwrap();
    drop(store);

    // The setting lives in the database header, so a plain connection can read
    // it back: 2 is INCREMENTAL, 1 would be FULL, 0 OFF.
    let connection = rusqlite::Connection::open(&path).unwrap();
    let mode: i64 = connection
        .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, 2, "a new database has to be incremental-vacuum");
}

#[tokio::test]
async fn an_existing_database_keeps_its_own_setting() {
    // Nothing rewrites the setting of a database that already exists: changing
    // it needs a VACUUM, which is the operator's call.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine.db");
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch("PRAGMA auto_vacuum=NONE; CREATE TABLE keep(value TEXT);")
            .unwrap();
    }
    let store = Store::open(&path).await;
    // A database with tables but no engine schema is refused, which is what
    // protects it from being silently rewritten.
    assert!(store.is_err());
    let connection = rusqlite::Connection::open(&path).unwrap();
    let mode: i64 = connection
        .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, 0, "an existing setting is left alone");
}
