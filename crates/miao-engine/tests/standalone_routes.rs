//! The generated routes manifest: a standalone start answers the model
//! picker with every configured provider model that has a transport and an
//! unexpired stored credential.

use rusqlite::Connection;
use std::collections::HashMap;

fn write_config(directory: &std::path::Path) {
    std::fs::create_dir_all(directory).expect("config dir");
    std::fs::write(
        directory.join("miao.json"),
        r#"{
  "model": "prov-a/model-1",
  "providers": {
    "prov-a": {
      "models": {
        "model-1": {
          "name": "Model One",
          "api": {"type": "aisdk", "package": "@ai-sdk/openai-compatible", "url": "https://a.example/v1"},
          "capabilities": {"tools": true, "input": ["text"], "output": ["text"]},
          "limit": {"context": 1000, "output": 500}
        },
        "model-2": {
          "name": "No Tools",
          "api": {"type": "aisdk", "package": "@ai-sdk/openai-compatible", "url": "https://a.example/v1"},
          "capabilities": {"tools": false, "input": ["text"], "output": ["text"]}
        }
      }
    },
    "prov-b": {
      "models": {
        "model-b": {
          "name": "Provider-level api",
          "capabilities": {"tools": true, "input": ["text"], "output": ["text"]}
        }
      },
      "api": {"type": "aisdk", "package": "@ai-sdk/openai-compatible", "url": "https://b.example/v1"}
    },
    "prov-off": {
      "disabled": true,
      "models": {
        "model-off": {
          "name": "Disabled",
          "api": {"type": "aisdk", "package": "@ai-sdk/openai-compatible", "url": "https://x.example/v1"},
          "capabilities": {"tools": true, "input": ["text"], "output": ["text"]}
        }
      }
    },
    "prov-uncredentialed": {
      "models": {
        "model-x": {
          "name": "No credential",
          "api": {"type": "aisdk", "package": "@ai-sdk/openai-compatible", "url": "https://x.example/v1"},
          "capabilities": {"tools": true, "input": ["text"], "output": ["text"]}
        }
      }
    }
  }
}"#,
    )
    .expect("config file");
}

fn write_credentials(path: &std::path::Path) {
    let connection = Connection::open(path).expect("credential db");
    connection
        .execute_batch(
            r#"
            CREATE TABLE credential (
              id text PRIMARY KEY,
              integration_id text,
              label text NOT NULL,
              value text NOT NULL,
              connector_id text,
              method_id text,
              active integer,
              time_created integer NOT NULL,
              time_updated integer NOT NULL
            );
            INSERT INTO credential VALUES ('cred-a', 'prov-a', 'a', '{"type":"key","key":"sk-a"}', NULL, NULL, 1, 1, 1);
            INSERT INTO credential VALUES ('cred-b', 'prov-b', 'b', '{"type":"key","key":"sk-b"}', NULL, NULL, 1, 1, 1);
            "#,
        )
        .expect("credential rows");
}

fn options(config_dir: &std::path::Path) -> HashMap<String, String> {
    HashMap::from([(
        "--config-dir".to_string(),
        config_dir.display().to_string(),
    )])
}

#[tokio::test]
async fn the_manifest_covers_every_credentialed_tool_model() {
    let root = tempfile::tempdir().expect("tempdir");
    write_config(root.path());
    let database = root.path().join("credentials.db");
    write_credentials(&database);

    let path = miao_engine::cli::test_support::config_routes_manifest(
        &options(root.path()),
        Some(&database),
    )
    .await
    .expect("manifest derives")
    .expect("manifest exists");

    let entries: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).expect("manifest bytes")).expect("json");
    let entries = entries.as_array().expect("array");
    let ids: Vec<&str> = entries
        .iter()
        .map(|entry| entry["id"].as_str().expect("id"))
        .collect();
    // prov-a/model-1 (tools), prov-b/model-b (provider-level api). model-2 is
    // uncapable, prov-off is disabled, prov-uncredentialed has no credential.
    assert_eq!(ids, vec!["prov-a/model-1", "prov-b/model-b"]);
    let primary = entries
        .iter()
        .find(|entry| entry["primary"] == serde_json::Value::Bool(true))
        .expect("one primary");
    assert_eq!(primary["id"], "prov-a/model-1");
    assert_eq!(primary["model"], "model-1");
    assert_eq!(primary["endpoint"], "https://a.example/v1/chat/completions");
    assert_eq!(primary["limit"]["context"], 1000);
    assert_eq!(primary["input_modalities"], serde_json::json!(["text"]));
    assert_eq!(primary["account"]["model_key"], "prov-a/model-1");
}

#[tokio::test]
async fn no_configuration_means_no_manifest() {
    let root = tempfile::tempdir().expect("tempdir");
    let database = root.path().join("credentials.db");
    write_credentials(&database);
    let empty = root.path().join("empty");
    std::fs::create_dir_all(&empty).expect("empty dir");
    assert!(
        miao_engine::cli::test_support::config_routes_manifest(
            &options(&empty),
            Some(&database),
        )
        .await
        .expect("derives")
        .is_none()
    );
}
