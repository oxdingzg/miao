use base64::Engine;
use miao_engine::{
    protocol::{Error, Input, ModelRequest},
    provider::{Identity, Provider, ProviderError, Reply},
    runtime::Runtime,
    session_agent::AgentManifest,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Capture(mpsc::UnboundedSender<ModelRequest>);
#[async_trait::async_trait]
impl Provider for Capture {
    fn identity(&self) -> Option<Identity> {
        Some(identity())
    }
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        self.0.send(request).unwrap();
        Ok(Reply {
            content: json!([{"type":"text","text":"continued"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}
fn identity() -> Identity {
    Identity {
        protocol: "openai-chat".into(),
        model: "fixture".into(),
    }
}
fn agent() -> AgentManifest {
    serde_json::from_value(json!({"name":"build","semantics":"original-agent","instructions":"original agent instructions"})).unwrap()
}
fn source(root: &Path) -> String {
    let bytes = b"snapshot file bytes";
    let file_hash = format!("{:x}", Sha256::digest(bytes));
    let second_hash = format!("{:x}", Sha256::digest(b"second snapshot bytes"));
    json!({"format":"miao.session.transfer.v1","source":{"engine":"ts","storage":root.join("product.db"),"sequence":3},
        "session":{"id":"s","title":"Original title","agent":"build","model":{"id":"fixture"},"location":{"directory":root},"time":{"created":123,"updated":456}},
        "timeline":(0..3).map(|i|json!({"id":format!("msg_original_{i}"),"type":"user","text":format!("original {i}"),"time":{"created":123+i}}))
            .chain([
                json!({"id":"msg_original_assistant","type":"assistant","time":{"created":456,"completed":460},"snapshot":{"start":"a".repeat(40)}}),
                json!({"id":"msg_original_assistant_2","type":"assistant","time":{"created":470,"completed":474},"snapshot":{"start":"b".repeat(40)}}),
            ])
            .collect::<Vec<_>>(),
        "context_ids":["msg_original_0","msg_original_1","msg_original_2"],
        "artifacts":[
            {"hash":file_hash,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)},
            {"hash":second_hash,"base64":base64::engine::general_purpose::STANDARD.encode(b"second snapshot bytes")}],"source_state":{},
        "operational":{"goal":{"objective":"original objective","status":"active","autonomous":false},"todos":[{"task_id":"first","depends_on":null,"content":"Original todo","status":"pending","priority":"high"}]},
        "snapshots":[
            {"id":"b".repeat(40),"files":[
                {"path":"src/main.rs","source_path":"src/main.rs","hash":second_hash,"mode":"100644"},
                {"path":"link","source_path":"link","hash":file_hash,"mode":"120000"}]},
            {"id":"a".repeat(40),"files":[
                {"path":"src/main.rs","source_path":"src/main.rs","hash":file_hash,"mode":"100755"},
                {"path":"gone.txt","source_path":"gone.txt","hash":null}]}]
    }).to_string()
}
fn digest(bundle: &str) -> String {
    format!("{:x}", Sha256::digest(bundle.as_bytes()))
}
fn product(path: &Path, native: &Path, root: &Path, hash: &str) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch("CREATE TABLE session_migration(id TEXT,session_id TEXT,state TEXT,bundle_sha256 TEXT,native_storage TEXT,location TEXT); CREATE TABLE session_engine_placement(session_id TEXT,engine TEXT,native_storage TEXT,location TEXT);").unwrap();
    let location = json!({"directory":root}).to_string();
    conn.execute(
        "INSERT INTO session_migration VALUES('transfer','s','prepared',?1,?2,?3)",
        rusqlite::params![hash, native.to_str().unwrap(), location],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_engine_placement VALUES('s','ts',?1,?2)",
        rusqlite::params![native.to_str().unwrap(), location],
    )
    .unwrap();
}
fn switch(path: &Path) {
    let mut conn = rusqlite::Connection::open(path).unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute("UPDATE session_migration SET state='switched'", [])
        .unwrap();
    tx.execute("UPDATE session_engine_placement SET engine='rust'", [])
        .unwrap();
    tx.commit().unwrap();
}

#[tokio::test]
async fn actual_product_cas_is_required_and_activation_restores_provider_context_and_state() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tokio::fs::canonicalize(tmp.path()).await.unwrap();
    let native = tmp.path().join("engine.db");
    let database = Store::open(&native).await.unwrap();
    let source = source(&workspace);
    let hash = digest(&source);
    database
        .stage_transfer_with_agent(
            "transfer",
            source.clone(),
            &hash,
            identity(),
            None,
            Some(agent()),
        )
        .await
        .unwrap();
    let product_path = tmp.path().join("product.db");
    product(&product_path, &native, &workspace, &hash);
    let (send, mut received) = mpsc::unbounded_channel();
    let runtime = Runtime::new(
        database.clone(),
        Arc::new(Capture(send)),
        Tools::new(&workspace).await.unwrap(),
    )
    .await
    .unwrap();
    assert!(matches!(
        runtime
            .activate_transfer("transfer", &hash, &product_path)
            .await,
        Err(Error::Conflict)
    ));
    assert!(database.migration_active("s").await.unwrap());
    assert!(database.history("s").await.unwrap().is_empty());
    switch(&product_path);
    let activated = runtime
        .activate_transfer("transfer", &hash, &product_path)
        .await
        .unwrap();
    assert_eq!(activated["state"], "active");
    let exported_path = tmp.path().join("exported.json");
    let exported = database
        .export_session_transfer_import("transfer", exported_path.clone())
        .await
        .unwrap();
    assert_eq!(exported["bundle_sha256"], hash);
    assert_eq!(exported["state"], "active");
    assert_eq!(std::fs::read(&exported_path).unwrap(), source.as_bytes());
    assert!(database
        .export_session_transfer_import("missing", tmp.path().join("missing.json"))
        .await
        .is_err());
    {
        let conn = rusqlite::Connection::open(&native).unwrap();
        let (manifest, boundary): (String, String) = conn
            .query_row(
                "SELECT manifest,boundary_message_id FROM engine_transfer_snapshot WHERE snapshot_id=?1",
                ["a".repeat(40)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let manifest: Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(manifest[0]["mode"], "100755");
        assert_eq!(
            manifest[0]["hash"],
            json!(format!("{:x}", Sha256::digest(b"snapshot file bytes")))
        );
        assert_eq!(manifest[1]["hash"], Value::Null);
        assert_eq!(boundary, "msg_original_assistant");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM engine_file_snapshot", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }
    let retained = native
        .with_extension("snapshots")
        .join("s")
        .join(format!("{:x}", Sha256::digest(b"snapshot file bytes")));
    assert_eq!(std::fs::read(&retained).unwrap(), b"snapshot file bytes");
    let order: Vec<(String, Option<i64>)> = {
        let conn = rusqlite::Connection::open(&native).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT snapshot_id,order_index FROM engine_transfer_snapshot ORDER BY order_index",
            )
            .unwrap();
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(order[0], ("a".repeat(40), Some(3)));
    assert_eq!(order[1], ("b".repeat(40), Some(4)));
    let available = database.snapshot_at("s", 1).await.unwrap();
    assert_eq!(available["assembled"], true);
    assert_eq!(available["available"], true);
    let staged = database.revert_stage("s", 1).await.unwrap();
    assert!(staged["created"]
        .as_array()
        .unwrap()
        .iter()
        .any(|path| path == "src/main.rs"));
    assert_eq!(
        std::fs::read(workspace.join("src/main.rs")).unwrap(),
        b"snapshot file bytes"
    );
    assert!(!workspace.join("link").exists());
    database.revert_clear("s").await.unwrap();
    assert!(!workspace.join("src/main.rs").exists());
    let seq = database.latest_seq("s").await.unwrap();
    assert_eq!(
        runtime
            .activate_transfer("transfer", &hash, &product_path)
            .await
            .unwrap(),
        activated
    );
    assert_eq!(database.latest_seq("s").await.unwrap(), seq);
    assert!(!database.migration_active("s").await.unwrap());
    let history = database.history("s").await.unwrap();
    assert_eq!(history.len(), 3);
    assert_eq!(history[0].recorded_at_ms, Some(123));
    assert_eq!(history[2].content[0]["text"], "original 2");
    assert!(database.snapshot("s").await.unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        database.state("s").await.unwrap()["goal"]["value"]["objective"],
        "original objective"
    );
    assert_eq!(
        database.state("s").await.unwrap()["todos"]["value"]["todos"][0]["id"],
        "first"
    );
    assert_eq!(database.agent("s").await.unwrap().unwrap().0.name, "build");
    assert!(database
        .abort_session_transfer_import("transfer")
        .await
        .is_err());
    let input: Input = serde_json::from_value(
        json!({"session_id":"s","input_id":"next","prompt":"continue","delivery":"steer"}),
    )
    .unwrap();
    runtime.admit(input, true).await.unwrap();
    let request = tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(request.system.contains("original agent instructions"));
    for index in 0..3 {
        assert!(request.messages.iter().any(|message| message
            .content
            .to_string()
            .contains(&format!("original {index}"))));
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if database
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "stop")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let boundary: u64 = {
        let conn = rusqlite::Connection::open(&native).unwrap();
        conn.query_row(
            "SELECT MAX(seq) FROM engine_message WHERE session_id='s' AND role='assistant'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    database
        .compact(
            "s",
            "partial",
            boundary,
            "summarized first source message".into(),
        )
        .await
        .unwrap();
    let cut = database.latest_seq("s").await.unwrap();
    let selected = database.transfer_messages("s", 0, true, cut).await.unwrap();
    assert!(selected["messages"].as_array().unwrap().is_empty());
    // Compaction cuts the provider view only; canonical history keeps every
    // imported message regardless of later native appends.
    let full = database
        .transfer_messages("s", 0, false, cut)
        .await
        .unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["id"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    for index in 0..3 {
        assert!(full.contains(&format!("msg_original_{index}")));
    }
    let input: Input = serde_json::from_value(
        json!({"session_id":"s","input_id":"after-cut","prompt":"again","delivery":"steer"}),
    )
    .unwrap();
    runtime.admit(input, true).await.unwrap();
    let request = tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(request.messages.iter().any(|message| message
        .content
        .to_string()
        .contains("summarized first source message")));
    assert!(!request
        .messages
        .iter()
        .any(|message| message.content.to_string().contains("original 1")));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if database
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.kind == "stop")
                .count()
                >= 2
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if database
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "stop")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    {
        let conn = rusqlite::Connection::open(&native).unwrap();
        conn.execute(
            "INSERT INTO engine_message(session_id,seq,role,content,checkpoint,recorded_at_ms) VALUES('s',900,'user','[{\"type\":\"text\",\"text\":\"native turn\"}]',NULL,900)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO engine_message(session_id,seq,role,content,checkpoint,recorded_at_ms) VALUES('s',901,'assistant','[{\"type\":\"text\",\"text\":\"native reply\"}]',NULL,901)",
            [],
        )
        .unwrap();
    }
    let delta_path = tmp.path().join("delta.json");
    let delta = database
        .export_session_transfer_delta("transfer", None, delta_path.clone())
        .await
        .unwrap();
    let baseline: i64 = {
        let conn = rusqlite::Connection::open(&native).unwrap();
        conn.query_row(
            "SELECT COALESCE(MAX(seq),0) FROM engine_transfer_message",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(delta["baseline_seq"], json!(baseline));
    let timeline = delta["timeline"].as_array().unwrap();
    // Everything the native engine produced after the imported baseline is
    // part of the delta, including the earlier fixture runs.
    let expected: i64 = {
        let conn = rusqlite::Connection::open(&native).unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM engine_message WHERE session_id='s' AND seq>?1 AND reverted=0",
            [baseline],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(timeline.len() as i64, expected);
    assert_eq!(timeline[timeline.len() - 2]["id"], "msg_native_900");
    assert_eq!(timeline[timeline.len() - 2]["text"], "native turn");
    assert_eq!(
        timeline[timeline.len() - 1]["content"][0]["text"],
        "native reply"
    );
    // The file holds the payload without the self-referential delta digest;
    // the receipt carries it so the reverse migration can verify the bytes.
    let mut payload = delta.clone();
    if let Some(obj) = payload.as_object_mut() {
        let digest = obj.remove("delta_sha256").expect("delta_sha256 in receipt");
        assert!(digest.as_str().is_some_and(|d| d.len() == 64));
    }
    assert_eq!(
        std::fs::read(&delta_path).unwrap(),
        serde_json::to_vec(&payload).unwrap()
    );
    runtime.shutdown().await;
    drop(runtime);
    database.close().await.unwrap();
    let database = Store::open(&native).await.unwrap();
    assert_eq!(
        database
            .session_transfer_import("transfer")
            .await
            .unwrap()
            .unwrap()
            .state,
        "active"
    );
    let full = database
        .transfer_messages("s", 0, false, u64::MAX)
        .await
        .unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["id"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    for index in 0..3 {
        assert!(full.contains(&format!("msg_original_{index}")));
    }
    database.remove_session("s").await.unwrap();
    {
        let conn = rusqlite::Connection::open(&native).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM engine_transfer_snapshot", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
    }
    assert!(database
        .session_transfer_import("transfer")
        .await
        .unwrap()
        .is_none());
    database.close().await.unwrap();
}

#[tokio::test]
async fn activation_failure_rolls_back_the_gate_and_every_provider_row() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tokio::fs::canonicalize(tmp.path()).await.unwrap();
    let native = tmp.path().join("engine.db");
    let database = Store::open(&native).await.unwrap();
    let source = source(&workspace);
    let hash = digest(&source);
    database
        .stage_transfer_with_agent("transfer", source, &hash, identity(), None, Some(agent()))
        .await
        .unwrap();
    let product_path = tmp.path().join("product.db");
    product(&product_path, &native, &workspace, &hash);
    switch(&product_path);
    {
        let conn = rusqlite::Connection::open(&native).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_import_map BEFORE INSERT ON engine_transfer_message BEGIN SELECT RAISE(ABORT,'injected map failure'); END;").unwrap();
    }
    assert!(database
        .activate_session_transfer("transfer", &hash, &product_path)
        .await
        .is_err());
    assert_eq!(
        database
            .session_transfer_import("transfer")
            .await
            .unwrap()
            .unwrap()
            .state,
        "staged"
    );
    assert!(database.history("s").await.unwrap().is_empty());
    assert!(database.migration_active("s").await.unwrap());
    assert_eq!(database.latest_seq("s").await.unwrap(), 1);
    database.close().await.unwrap();
}

#[tokio::test]
async fn a_session_born_native_exports_its_whole_timeline_without_a_transfer_import() {
    let tmp = tempfile::tempdir().unwrap();
    let native = tmp.path().join("native.db");
    let database = Store::open(&native).await.unwrap();
    {
        let conn = rusqlite::Connection::open(&native).unwrap();
        conn.execute(
            "INSERT INTO engine_session(id,next_seq,mode) VALUES('ses_native',3,'build')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO engine_message(session_id,seq,role,content,checkpoint,recorded_at_ms) VALUES('ses_native',1,'user','[{\"type\":\"text\",\"text\":\"native prompt\"}]',NULL,100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO engine_message(session_id,seq,role,content,checkpoint,recorded_at_ms) VALUES('ses_native',2,'assistant','[{\"type\":\"text\",\"text\":\"native reply\"}]',NULL,200)",
            [],
        )
        .unwrap();
    }
    let delta_path = tmp.path().join("native-back.delta.json");
    let delta = database
        .export_session_transfer_delta("native-ses_native", Some("ses_native"), delta_path.clone())
        .await
        .unwrap();
    assert_eq!(delta["baseline_seq"], json!(0));
    assert_eq!(delta["session_id"], json!("ses_native"));
    let timeline = delta["timeline"].as_array().unwrap();
    assert_eq!(timeline.len(), 2);
    assert_eq!(timeline[0]["type"], json!("user"));
    assert_eq!(timeline[0]["text"], json!("native prompt"));
    assert_eq!(timeline[1]["type"], json!("assistant"));
    // No forward bundle backs this delta: the receipt records the empty
    // input's digest so the receipt's 64-hex contract still holds.
    let empty = format!("{:x}", Sha256::digest([]));
    assert_eq!(delta["bundle_sha256"], json!(empty));
    assert!(delta["delta_sha256"]
        .as_str()
        .is_some_and(|d| d.len() == 64));
    // The file holds the payload without the self-referential digest; the
    // returned receipt carries it so the reverse migration can verify bytes.
    let on_disk = std::fs::read(&delta_path).unwrap();
    let file = serde_json::from_slice::<Value>(&on_disk).unwrap();
    assert!(file["delta_sha256"].is_null());
    assert_eq!(
        format!("{:x}", Sha256::digest(on_disk.as_slice())),
        delta["delta_sha256"].as_str().unwrap()
    );
}

#[tokio::test]
async fn a_delta_export_for_an_unknown_session_still_conflicts() {
    let tmp = tempfile::tempdir().unwrap();
    let native = tmp.path().join("native.db");
    let database = Store::open(&native).await.unwrap();
    let delta_path = tmp.path().join("nope.delta.json");
    let error = database
        .export_session_transfer_delta("native-ses_unknown", Some("ses_unknown"), delta_path)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("input id conflicts"));
}
