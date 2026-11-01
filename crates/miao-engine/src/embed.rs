//! In-process transport adapter.
//!
//! The stdio adapter and this module carry the same frames: a request is
//! `{"id": <n>, "method": <name>, "params": <value>}` and a reply is
//! `{"id": <n>, "result": <value>}` or `{"id": <n>, "error": <error>}`.
//! [`Command`] is already tagged `method`/`params`, so a caller that would
//! otherwise write to a pipe can decode the frame and dispatch it into
//! [`crate::host::Host`] directly — no child process and no protocol drift,
//! because both adapters decode the identical vocabulary.
//!
//! Cancellation, permission and event semantics stay with `Host`; this module
//! only owns the framing so a mistake here cannot change engine behaviour.

use crate::protocol::{Command, Error};
use serde_json::{json, Value};

/// Decode one request frame into the engine's command vocabulary.
///
/// `id` is transport bookkeeping and is dropped before decoding: the command
/// vocabulary has no id field, and keeping it would make the two adapters
/// disagree about what a well-formed request is.
pub fn decode(frame: &Value) -> Result<Command, Error> {
    let method = frame
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid("request frame has no method".into()))?;
    // `params` must be omitted, not defaulted: a unit variant such as
    // `Command::Sessions` rejects `"params": {}` with a type error, while the
    // stdio adapter sends no `params` key at all for the same call.
    let mut request = serde_json::Map::new();
    request.insert("method".into(), Value::String(method.to_string()));
    if let Some(params) = frame.get("params") {
        request.insert("params".into(), params.clone());
    }
    serde_json::from_value(Value::Object(request))
        .map_err(|error| Error::Invalid(format!("unsupported request {method}: {error}")))
}

/// Build the reply frame the transport delivers for one request.
pub fn reply(id: Value, outcome: Result<Value, Error>) -> Value {
    match outcome {
        Ok(value) => json!({ "id": id, "result": value }),
        Err(error) => json!({
            "id": id,
            "error": { "code": error.code(), "message": error.to_string() }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{decode, reply};
    use crate::protocol::{Command, Error};
    use serde_json::json;

    #[test]
    fn decodes_the_frame_the_tui_writes() {
        let frame = json!({"id": 7, "method": "initialize",
                           "params": {"session_id": "ses_a", "title": "t"}});
        match decode(&frame).expect("decodes") {
            Command::Initialize { session_id, title } => {
                assert_eq!(session_id, "ses_a");
                assert_eq!(title, "t");
            }
            _ => panic!("decoded something other than Initialize"),
        }
    }

    #[test]
    fn rejects_a_frame_without_a_method() {
        assert!(decode(&json!({"id": 1})).is_err());
    }

    #[test]
    fn a_unit_command_decodes_without_params() {
        let command = decode(&json!({"id": 9, "method": "sessions"})).expect("decodes");
        assert!(matches!(command, Command::Sessions));
    }

    #[test]
    fn rejects_an_unknown_method() {
        assert!(decode(&json!({"method": "no_such_command", "params": {}})).is_err());
    }

    #[test]
    fn error_replies_carry_an_error_key() {
        let frame = reply(json!(3), Err(Error::Invalid("bad request".into())));
        assert_eq!(frame["id"], json!(3));
        assert!(frame.get("error").is_some());
        assert!(frame.get("result").is_none());
    }

    #[test]
    fn success_replies_carry_a_result_key() {
        let frame = reply(json!(4), Ok(json!({"ok": true})));
        assert_eq!(frame["result"], json!({"ok": true}));
        assert!(frame.get("error").is_none());
    }
}
