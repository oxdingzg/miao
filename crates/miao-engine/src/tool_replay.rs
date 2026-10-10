//! Explicit diagnostic capability: replay a native tool settlement without
//! invoking its executor. The provider tape and ordinary engine store remain
//! separate; this is never an automatic crash-recovery path.

use crate::protocol::Error;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::sync::Mutex;

#[derive(Deserialize)]
struct Envelope {
    bundle: Value,
    sha256: String,
}

#[derive(Deserialize)]
struct Interaction {
    lane: String,
    ordinal: usize,
    request: Value,
    frames: Vec<Frame>,
    outcome: String,
}

#[derive(Deserialize)]
struct Frame {
    value: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settlement {
    output: Value,
    is_error: bool,
    #[serde(default)]
    output_json: Option<String>,
}

struct Cursor {
    position: usize,
    owner: Option<String>,
    failed: bool,
}

pub struct ToolReplay {
    calls: Vec<Interaction>,
    cursor: Mutex<Cursor>,
}

impl ToolReplay {
    pub fn load(path: &Path) -> Result<Self, Error> {
        let bytes = std::fs::read(path)?;
        let envelope: Envelope = serde_json::from_slice(&bytes)?;
        if envelope.bundle["format"] != "miao-blackbox" || envelope.bundle["version"] != 1 {
            return Err(Error::Invalid(
                "unsupported native tool replay bundle".into(),
            ));
        }
        let canonical = serde_jcs::to_vec(&envelope.bundle)
            .map_err(|_| Error::Invalid("invalid native tool replay JSON".into()))?;
        if format!("{:x}", Sha256::digest(canonical)) != envelope.sha256 {
            return Err(Error::Invalid(
                "native tool replay integrity check failed".into(),
            ));
        }
        let interactions: Vec<Interaction> =
            serde_json::from_value(envelope.bundle["interactions"].clone())?;
        let calls: Vec<_> = interactions
            .into_iter()
            .filter(|item| item.lane == "native-tool")
            .collect();
        for (index, call) in calls.iter().enumerate() {
            if call.ordinal != index || call.outcome != "complete" || call.frames.len() != 1 {
                return Err(Error::Invalid(
                    "incomplete or unordered native tool replay".into(),
                ));
            }
            let settlement: Settlement = serde_json::from_value(call.frames[0].value.clone())?;
            settlement.materialize()?;
        }
        Ok(Self {
            calls,
            cursor: Mutex::new(Cursor {
                position: 0,
                owner: None,
                failed: false,
            }),
        })
    }

    pub async fn take(
        &self,
        session: &str,
        name: &str,
        input: &Value,
    ) -> Result<(Value, bool), Error> {
        let mut cursor = self.cursor.lock().await;
        if cursor.failed {
            return Err(Error::Invalid("native tool replay is poisoned".into()));
        }
        if cursor.owner.as_ref().is_some_and(|owner| owner != session) {
            cursor.failed = true;
            return Err(Error::Invalid(
                "native tool replay belongs to one Session".into(),
            ));
        }
        cursor.owner.get_or_insert_with(|| session.to_owned());
        let request = json!({"name":name,"input":input});
        let index = cursor.position;
        let Some(call) = self.calls.get(index) else {
            cursor.failed = true;
            return Err(Error::Invalid(format!(
                "unexpected native tool at native-tool[{index}]"
            )));
        };
        if encode(&call.request)? != encode(&request)? {
            cursor.failed = true;
            return Err(Error::Invalid(format!(
                "native tool request mismatch at native-tool[{index}]"
            )));
        }
        let result: Settlement = serde_json::from_value(call.frames[0].value.clone())?;
        let output = result.materialize()?;
        cursor.position += 1;
        Ok(output)
    }

    pub async fn assert_consumed(&self) -> Result<(), Error> {
        let cursor = self.cursor.lock().await;
        if cursor.failed || cursor.position != self.calls.len() {
            return Err(Error::Invalid(
                "native tool replay failed or has unconsumed calls".into(),
            ));
        }
        Ok(())
    }
}

fn encode(value: &Value) -> Result<Vec<u8>, Error> {
    serde_jcs::to_vec(value)
        .map_err(|_| Error::Invalid("invalid native tool canonical JSON".into()))
}

impl Settlement {
    fn materialize(self) -> Result<(Value, bool), Error> {
        let output = if let Some(raw) = self.output_json {
            let decoded: Value = serde_json::from_str(&raw)?;
            if encode(&decoded)? != encode(&self.output)? {
                return Err(Error::Invalid(
                    "native tool result encoding differs from its value".into(),
                ));
            }
            decoded
        } else {
            self.output
        };
        Ok((output, self.is_error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tape(file: &Path, request: Value, outcome: &str) {
        let bundle = json!({"format":"miao-blackbox","version":1,"metadata":{},"trace":[],"interactions":[
            {"lane":"native-tool","ordinal":0,"request":request,"frames":[{"elapsedMs":0.125,"value":{"output":{"written":true},"is_error":false}}],"outcome":outcome}
        ]});
        let sha256 = format!("{:x}", Sha256::digest(serde_jcs::to_vec(&bundle).unwrap()));
        std::fs::write(
            file,
            serde_json::to_vec(&json!({"bundle":bundle,"sha256":sha256})).unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn exact_request_consumption_and_mismatch_poisoning() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("tape.json");
        let input = json!({"path":"marker","text":"once","expected_sha256":null});
        tape(
            &file,
            json!({"name":"write_file","input":input}),
            "complete",
        );
        let replay = ToolReplay::load(&file).unwrap();
        assert!(replay.assert_consumed().await.is_err());
        assert_eq!(
            replay.take("session", "write_file", &input).await.unwrap(),
            (json!({"written":true}), false)
        );
        replay.assert_consumed().await.unwrap();
        assert!(replay.take("session", "write_file", &input).await.is_err());
        let replay = ToolReplay::load(&file).unwrap();
        assert!(replay
            .take("session", "write_file", &json!({"text":"changed"}))
            .await
            .is_err());
        assert!(replay.take("session", "write_file", &input).await.is_err());
    }

    #[test]
    fn raw_output_preserves_native_json_numbers_after_shared_json_normalization() {
        let settlement: Settlement = serde_json::from_value(json!({
            "output":{"count":1},"is_error":false,"output_json":"{\"count\":1.0}"
        }))
        .unwrap();
        let (output, _) = settlement.materialize().unwrap();
        assert_eq!(serde_json::to_string(&output).unwrap(), "{\"count\":1.0}");
        let inconsistent: Settlement = serde_json::from_value(json!({
            "output":{"count":1},"is_error":false,"output_json":"{\"count\":2.0}"
        }))
        .unwrap();
        assert!(inconsistent.materialize().is_err());
    }

    #[test]
    fn corrupt_and_incomplete_bundles_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("tape.json");
        tape(&file, json!({"name":"read_file","input":{}}), "incomplete");
        assert!(ToolReplay::load(&file).is_err());
        tape(&file, json!({"name":"read_file","input":{}}), "complete");
        let mut envelope: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        envelope["bundle"]["metadata"]["modified"] = json!(true);
        std::fs::write(&file, serde_json::to_vec(&envelope).unwrap()).unwrap();
        assert!(ToolReplay::load(&file).is_err());
    }
}
