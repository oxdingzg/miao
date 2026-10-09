use crate::{
    permission::{context_digest, Decision, Policy},
    protocol::ContextBundle,
    tools::{ToolError, Tools},
};
use serde::Deserialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub label: String,
    pub path: String,
}

pub(crate) fn validate(sources: &[Source]) -> Result<(), ToolError> {
    if sources.len() > 16 {
        return Err(ToolError::InvalidInput);
    }
    let mut paths = std::collections::BTreeSet::from(["AGENTS.md"]);
    let mut labels = std::collections::BTreeSet::from(["AGENTS.md"]);
    for source in sources {
        if source.label.is_empty()
            || source.label.len() > 64
            || !source
                .label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
            || source.path.is_empty()
            || source.path.len() > 2048
            || std::path::Path::new(&source.path).is_absolute()
            || source
                .path
                .split('/')
                .any(|part| part == ".." || part.is_empty() || part == ".")
            || source.path.contains(['\0', '\\'])
            || !paths.insert(&source.path)
            || !labels.insert(&source.label)
        {
            return Err(ToolError::InvalidInput);
        }
    }
    Ok(())
}

/// Location-owned workspace producers. Additional sources are explicit host
/// selections; their content still uses the ordinary scoped read capability.
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
    let root = Source {
        label: "AGENTS.md".into(),
        path: "AGENTS.md".into(),
    };
    for source in std::iter::once(&root).chain(tools.context_sources()) {
        if cancel.is_cancelled() {
            return Err(ToolError::Interrupted);
        }
        let decision = policy.evaluate("read_file", &source.path, crate::permission::Access::Read);
        if decision != Decision::Allow {
            sources.push(json!({"label":source.label,"path":source.path,"status":"skipped","reason":if decision==Decision::Ask{"policy_ask"}else{"policy_deny"}}));
            continue;
        }
        match tools.prepare("read_file",json!({"path":source.path})).await {
            Ok(prepared)=> {
                let decision=policy.evaluate(prepared.name(),prepared.resource(),prepared.access());
                if decision!=Decision::Allow {
                    sources.push(json!({"label":source.label,"path":source.path,"status":"skipped","reason":if decision==Decision::Ask{"policy_ask"}else{"policy_deny"}}));
                    continue;
                }
                let resource=prepared.resource().to_owned();
                let data=tools.execute_prepared(prepared,policy,cancel.child_token()).await?;
                let text=data["text"].as_str().ok_or(ToolError::InvalidFile)?;
                let block=format!("\n\n<project-instructions source=\"{}\">\n{}\n</project-instructions>",source.label,text);
                if system.len()+block.len()>65536{return Err(ToolError::ContextBudget);}
                system.push_str(&block);
                sources.push(json!({"label":source.label,"path":source.path,"resource":resource,"status":"loaded","sha256":data["sha256"]}));
            },
            Err(ToolError::Io(error)) if error.kind()==std::io::ErrorKind::NotFound=>sources.push(json!({"label":source.label,"path":source.path,"status":"missing"})),
            Err(ToolError::OutsideWorkspace|ToolError::ProtectedResource)=>sources.push(json!({"label":source.label,"path":source.path,"status":"skipped","reason":"outside_context_authority"})),
            Err(error)=>return Err(error),
        }
    }
    let fingerprint = context_digest(&system, &sources).map_err(|_| ToolError::InvalidInput)?;
    Ok(ContextBundle {
        system,
        fingerprint,
        sources,
    })
}
