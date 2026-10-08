use crate::{
    permission::{context_digest, Decision, Policy},
    protocol::ContextBundle,
    tools::{ToolError, Tools},
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

/// The first Location-owned producer loads only workspace AGENTS.md. Ancestor,
/// user, skill and reference producers remain separate additions, not implicit
/// reads of host configuration or ambient private notes.
pub async fn assemble(
    tools: &Tools,
    policy: &Policy,
    cancel: CancellationToken,
) -> Result<ContextBundle, ToolError> {
    if cancel.is_cancelled() {
        return Err(ToolError::Interrupted);
    }
    let names = tools
        .definitions()
        .iter()
        .map(|t| t.name.clone())
        .collect::<Vec<_>>()
        .join(", ");
    let mut system=format!("You are miao, a coding assistant. Complete the user's task using available capabilities. Respond in the user's language. Preserve unrelated user changes. Respect permission and tool errors. Use read_file fingerprints for conditional edits. Do not automatically repeat operations with unknown side effects. Available tools: {names}.");
    let mut sources = Vec::new();
    let source_decision =
        policy.evaluate("read_file", "AGENTS.md", crate::permission::Access::Read);
    if source_decision != Decision::Allow {
        sources.push(json!({"label":"AGENTS.md","status":"skipped","reason":if source_decision==Decision::Ask{"policy_ask"}else{"policy_deny"}}));
        let fingerprint = context_digest(&system, &sources).map_err(|_| ToolError::InvalidInput)?;
        return Ok(ContextBundle {
            system,
            fingerprint,
            sources,
        });
    }
    match tools
        .prepare("read_file", json!({"path":"AGENTS.md"}))
        .await
    {
        Ok(prepared) => {
            let decision = policy.evaluate(prepared.name(), prepared.resource(), prepared.access());
            if decision == Decision::Allow {
                let resource = prepared.resource().to_owned();
                let data = tools.execute_prepared(prepared, policy, cancel).await?;
                let text = data["text"].as_str().ok_or(ToolError::InvalidFile)?;
                system.push_str("\n\n<project-instructions source=\"AGENTS.md\">\n");
                system.push_str(text);
                system.push_str("\n</project-instructions>");
                sources.push(json!({"label":"AGENTS.md","resource":resource,"status":"loaded","sha256":data["sha256"]}));
            } else {
                sources.push(json!({"label":"AGENTS.md","status":"skipped","reason":if decision==Decision::Ask{"policy_ask"}else{"policy_deny"}}));
            }
        }
        Err(ToolError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            sources.push(json!({"label":"AGENTS.md","status":"missing"}))
        }
        Err(ToolError::OutsideWorkspace | ToolError::ProtectedResource) => sources.push(
            json!({"label":"AGENTS.md","status":"skipped","reason":"outside_context_authority"}),
        ),
        Err(error) => return Err(error),
    }
    let fingerprint = context_digest(&system, &sources).map_err(|_| ToolError::InvalidInput)?;
    Ok(ContextBundle {
        system,
        fingerprint,
        sources,
    })
}
