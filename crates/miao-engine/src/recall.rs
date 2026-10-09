use crate::{protocol::Error, store::Store, tools::ToolError};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub before_message_seq: Option<u64>,
}
fn default_limit() -> usize {
    10
}
impl Query {
    pub fn parse(value: Value) -> Result<Self, ToolError> {
        let query: Self = serde_json::from_value(value).map_err(|_| ToolError::InvalidInput)?;
        if query.query.is_empty()
            || query.query.len() > 512
            || query.query.contains('\0')
            || query.limit == 0
            || query.limit > 20
            || query
                .before_message_seq
                .is_some_and(|seq| seq > i64::MAX as u64)
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(query)
    }
}
impl Store {
    /// Search immutable messages, never a generated compaction summary. A scan
    /// page has an explicit cursor even if its bounded window has no matches.
    pub async fn recall(&self, session: &str, query: Query) -> Result<Value, Error> {
        // Public callers follow the same validation as the model tool boundary.
        let query=Query::parse(json!({"query":query.query,"limit":query.limit,"before_message_seq":query.before_message_seq})).map_err(|_|Error::Invalid("invalid recall query".into()))?;
        let session = session.to_owned();
        self.call(move|conn|{
            let before=query.before_message_seq.unwrap_or(i64::MAX as u64);
            let mut stmt=conn.prepare("SELECT seq,role,CASE WHEN length(CAST(content AS BLOB))<=2097152 THEN content ELSE NULL END FROM engine_message WHERE session_id=?1 AND seq<?2 ORDER BY seq DESC LIMIT 1001")?;
            let mut rows=stmt.query(params![session,before])?;
            let mut matches=Vec::new();let mut skipped=Vec::new();let mut scanned=0;let mut bytes=0;let mut cursor=None;let mut exhausted=true;
            while let Some(row)=rows.next()? {
                let seq:u64=row.get(0)?;
                if scanned>=1000||matches.len()>=query.limit{exhausted=false;break;}
                let content:Option<String>=row.get(2)?;
                let Some(content)=content else{scanned+=1;cursor=Some(seq);skipped.push(seq);continue;};
                if bytes+content.len()>2*1024*1024{exhausted=false;break;}
                scanned+=1;bytes+=content.len();cursor=Some(seq);
                let content:Value=serde_json::from_str(&content)?;
                let text=visible_text(&content);
                if let Some(at)=text.find(&query.query) {
                    // Character boundaries keep previews valid for Chinese and
                    // other multibyte text. Search still examines the full text.
                    let start=text[..at].char_indices().rev().nth(100).map(|(index,_)|index).unwrap_or(0);
                    let end=text[at..].char_indices().nth(400).map(|(index,_)|at+index).unwrap_or(text.len());
                    matches.push(json!({"message_seq":seq,"role":row.get::<_,String>(1)?,"preview":&text[start..end],"preview_truncated":start!=0||end!=text.len()}));
                }
            }
            Ok(json!({"matches":matches,"scanned_messages":scanned,"skipped_oversized_message_seqs":skipped,"exhausted":exhausted,"next_before_message_seq":if exhausted{None}else{cursor}}))
        }).await
    }
}
fn visible_text(content: &Value) -> String {
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    parts
        .iter()
        .filter_map(|part| match part["type"].as_str() {
            Some("text") => part["text"].as_str().map(str::to_owned),
            Some("tool_use") => Some(format!("{} {}", part["name"], part["input"])),
            Some("tool_result") => Some(
                part["content"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| part["content"].to_string()),
            ),
            // Opaque provider continuation is not searchable user-visible text.
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}
