use crate::{protocol::Error, store::Store};
use serde_json::{json, Value};
use std::path::Path;

/// A batch catalog read never constructs an execution runtime or adopts work.
pub async fn read(
    path: impl AsRef<Path>,
    sessions: &[String],
    usage: bool,
) -> Result<Vec<Value>, Error> {
    if sessions.len() > 200 || sessions.iter().any(|id| id.is_empty() || id.len() > 256) {
        return Err(Error::Invalid(
            "catalog requires at most 200 bounded Session ids".into(),
        ));
    }
    let store = Store::open_reader(path).await?;
    let mut entries = Vec::with_capacity(sessions.len());
    for session in sessions {
        let entry = async {
            // A Session this storage never held carries no facts and no error:
            // the reader's absence is the answer, and a listing skips it.
            let Some(snapshot) = store.catalog_info(session).await? else {
                return Ok::<_, Error>(json!({"session_id":session}));
            };
            let (report, usage_error) = if usage {
                match store.usage_report(session).await {
                    Ok(report) => (report, None),
                    Err(error) => (Value::Null, Some(error.to_string())),
                }
            } else { (Value::Null, None) };
            Ok::<_, Error>(json!({"session_id":session,"snapshot":snapshot,"usage":report,"usage_error":usage_error}))
        }
        .await;
        entries.push(match entry {
            Ok(value) => value,
            Err(error) => json!({"session_id":session,"error":error.to_string()}),
        });
    }
    store.close().await?;
    Ok(entries)
}
