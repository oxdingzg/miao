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

/// A host-selected skill directory: workspace-relative paths stay contained;
/// absolute paths require a read-only directory reference. `*.md` at its root
/// and nested `SKILL.md` files are discovered under directory and file policy.
/// The body is read on demand, so it never inflates the prompt.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillDirectory {
    pub path: String,
}

/// A host-authorized read-only reference: a directory or file outside the
/// model-writable workspace whose location is listed in the system context and
/// whose files may be read. It never becomes writable.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub path: String,
    pub description: String,
}

pub(crate) fn validate_references(references: &[Reference]) -> Result<(), ToolError> {
    if references.len() > 16 {
        return Err(ToolError::InvalidInput);
    }
    for reference in references {
        if reference.path.is_empty()
            || reference.path.len() > 2048
            || reference.path.contains('\0')
            || reference.description.trim().is_empty()
            || reference.description.len() > 256
        {
            return Err(ToolError::InvalidInput);
        }
    }
    Ok(())
}

pub(crate) fn validate_skills(directories: &[SkillDirectory]) -> Result<(), ToolError> {
    if directories.len() > 16 {
        return Err(ToolError::InvalidInput);
    }
    let mut seen = std::collections::BTreeSet::new();
    for directory in directories {
        if directory.path.is_empty()
            || directory.path.len() > 2048
            || directory
                .path
                .split('/')
                .any(|part| part == "." || part == "..")
            || (!std::path::Path::new(&directory.path).is_absolute()
                && directory.path.split('/').any(str::is_empty))
            || directory.path.contains('\0')
            || (!std::path::Path::new(&directory.path).is_absolute()
                && directory.path.contains('\\'))
            || !seen.insert(&directory.path)
        {
            return Err(ToolError::InvalidInput);
        }
    }
    Ok(())
}

struct Skill {
    name: String,
    description: String,
    path: String,
}

fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("name:") {
            name = Some(value.trim().trim_matches(['"', '\'']).to_owned());
        } else if let Some(value) = trimmed.strip_prefix("description:") {
            description = Some(value.trim().trim_matches(['"', '\'']).to_owned());
        }
    }
    (name, description)
}

/// Collect skill files: `*.md` directly in the directory, and any `SKILL.md` in
/// its subtree. Symlinks are skipped and depth is bounded.
fn collect_skills(dir: &std::path::Path, depth: u8, out: &mut Vec<std::path::PathBuf>) {
    if depth > 4 || out.len() >= 64 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= 64 {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy().into_owned();
        if file_type.is_dir() {
            collect_skills(&path, depth + 1, out);
        } else if file_type.is_file()
            && ((depth == 0 && file_name.ends_with(".md")) || file_name == "SKILL.md")
        {
            out.push(path);
        }
    }
}

pub(crate) const MEDIA_OBSERVE: &str =
    include_str!("../../../packages/core/src/plugin/skill/media-observe.md");

async fn discover_skills(
    tools: &Tools,
    policy: &Policy,
    cancel: CancellationToken,
    sources: &mut Vec<serde_json::Value>,
) -> Result<Vec<Skill>, ToolError> {
    let root = std::path::Path::new(tools.location());
    let mut skills = Vec::new();
    for directory in tools.skill_directories() {
        if cancel.is_cancelled() {
            return Err(ToolError::Interrupted);
        }
        // Authorize enumeration before inspecting any filenames or frontmatter.
        // The tool resolver requires an explicit reference for external roots.
        let prepared = match tools
            .prepare(
                "glob",
                json!({"path":directory.path,"pattern":"**/SKILL.md"}),
            )
            .await
        {
            Ok(prepared) => prepared,
            Err(ToolError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(ToolError::OutsideWorkspace | ToolError::ProtectedResource) => {
                sources.push(json!({"type":"skill_directory","path":directory.path,"status":"skipped","reason":"outside_context_authority"}));
                continue;
            }
            Err(error) => return Err(error),
        };
        let decision = policy.evaluate(prepared.name(), prepared.resource(), prepared.access());
        if decision != Decision::Allow {
            sources.push(json!({"type":"skill_directory","path":directory.path,"status":"skipped","reason":if decision==Decision::Ask{"policy_ask"}else{"policy_deny"}}));
            continue;
        }
        let mut files = Vec::new();
        collect_skills(prepared.resolved_path(), 0, &mut files);
        files.sort();
        for file in files {
            if skills.len() >= 64 {
                break;
            }
            let path = file.to_string_lossy().into_owned();
            let prepared = match tools.prepare("read_file", json!({"path":path})).await {
                Ok(prepared) => prepared,
                Err(ToolError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                    continue
                }
                Err(ToolError::OutsideWorkspace | ToolError::ProtectedResource) => continue,
                Err(error) => return Err(error),
            };
            if policy.evaluate(prepared.name(), prepared.resource(), prepared.access())
                != Decision::Allow
            {
                continue;
            }
            let data = match tools
                .execute_prepared(prepared, policy, cancel.child_token())
                .await
            {
                Ok(data) => data,
                Err(ToolError::InvalidFile) => continue,
                Err(error) => return Err(error),
            };
            let Some(text) = data["text"].as_str() else {
                continue;
            };
            if text.len() > 65536 || data["truncated"] == true {
                continue;
            }
            let (name, description) = parse_frontmatter(text);
            let name = name.filter(|name| !name.is_empty()).unwrap_or_else(|| {
                if file.ends_with("SKILL.md") {
                    return file
                        .parent()
                        .and_then(|parent| parent.file_name())
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                }
                file.file_stem()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
            let description = description.unwrap_or_default();
            if name.is_empty() || name.len() > 64 || description.len() > 512 {
                continue;
            }
            // Keep Windows absolute/verbatim prefixes intact for later read_file calls.
            let path = file
                .strip_prefix(root)
                .map(|path| path.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| file.to_string_lossy().into_owned());
            skills.push(Skill {
                name,
                description,
                path,
            });
        }
    }
    Ok(skills)
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
            || !source_path(&source.path)
            || !paths.insert(&source.path)
            || !labels.insert(&source.label)
        {
            return Err(ToolError::InvalidInput);
        }
    }
    Ok(())
}

fn source_path(path: &str) -> bool {
    if path.contains('\0') {
        return false;
    }
    let parsed = std::path::Path::new(path);
    if parsed.is_absolute() {
        // Absolute names grant nothing by themselves: ordinary prepare/read
        // still requires a host-authorized read-only reference for this file.
        return parsed.file_name().is_some()
            && !parsed.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            });
    }
    !path.contains('\\')
        && !path
            .split('/')
            .any(|part| part == ".." || part.is_empty() || part == ".")
}

/// Location-owned workspace producers. Additional sources are explicit host
/// selections; their content still uses the ordinary scoped read capability.
pub async fn assemble(
    tools: &Tools,
    policy: &Policy,
    cancel: CancellationToken,
) -> Result<ContextBundle, ToolError> {
    assemble_for_agent(tools, policy, cancel, None).await
}

pub(crate) async fn assemble_for_agent(
    tools: &Tools,
    policy: &Policy,
    cancel: CancellationToken,
    agent: Option<&crate::session_agent::AgentManifest>,
) -> Result<ContextBundle, ToolError> {
    if cancel.is_cancelled() {
        return Err(ToolError::Interrupted);
    }
    let names = tools
        .definitions()
        .iter()
        .filter(|tool| agent.is_none_or(|agent| agent.permits(&tool.name)))
        .map(|t| t.name.clone())
        .collect::<Vec<_>>()
        .join(", ");
    let mut system=format!("You are miao, a coding assistant. Complete the user's task using available capabilities. Respond in the user's language. Preserve unrelated user changes. Respect permission and tool errors. Use read_file fingerprints for conditional edits. Do not automatically repeat operations with unknown side effects. Available tools: {names}.");
    let mut sources = Vec::new();
    let root = Source {
        label: "AGENTS.md".into(),
        path: "AGENTS.md".into(),
    };
    // Host global/ancestor instructions precede this workspace's instructions;
    // additional workspace-relative sources retain their configured order.
    for source in tools
        .context_sources()
        .filter(|source| std::path::Path::new(&source.path).is_absolute())
        .chain(tools.workspace_instructions().then_some(&root))
        .chain(
            tools
                .context_sources()
                .filter(|source| !std::path::Path::new(&source.path).is_absolute()),
        )
    {
        if cancel.is_cancelled() {
            return Err(ToolError::Interrupted);
        }
        if !std::path::Path::new(&source.path).is_absolute() {
            let decision =
                policy.evaluate("read_file", &source.path, crate::permission::Access::Read);
            if decision != Decision::Allow {
                sources.push(json!({"label":source.label,"path":source.path,"status":"skipped","reason":if decision==Decision::Ask{"policy_ask"}else{"policy_deny"}}));
                continue;
            }
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
    system.push_str("\n\nBuilt-in skill: media-observe — use load_skill with name media-observe when inspecting video/audio. Follow its timestamped frame/contact-sheet workflow using bash and read_image. Project skills below are loaded using read_file.");
    if system.len() > 65536 {
        return Err(ToolError::ContextBudget);
    }
    sources.push(json!({"type":"builtin_skill","name":"media-observe","path":"@builtin/skill/media-observe","status":"registered","sha256":crate::permission::digest(MEDIA_OBSERVE.as_bytes())}));
    let skills = discover_skills(tools, policy, cancel.child_token(), &mut sources).await?;
    if !skills.is_empty() {
        let mut section = String::from(
            "\n\n<available-skills>\nSkill bodies are not included; read the listed path when a skill applies.\n",
        );
        for skill in &skills {
            section.push_str(&format!(
                "- {}: {} ({})\n",
                skill.name, skill.description, skill.path
            ));
        }
        section.push_str("</available-skills>");
        if system.len() + section.len() > 65536 {
            return Err(ToolError::ContextBudget);
        }
        system.push_str(&section);
        for skill in skills {
            sources.push(
                json!({"type":"skill","name":skill.name,"path":skill.path,"status":"registered"}),
            );
        }
    }
    let references = tools.references();
    if !references.is_empty() {
        let mut section = String::from(
            "\n\n<available-references>\nHost-authorized read-only references outside the workspace. Read a listed file by its absolute path.\n",
        );
        for reference in references {
            section.push_str(&format!(
                "- {}: {}\n",
                reference.description, reference.path
            ));
        }
        section.push_str("</available-references>");
        if system.len() + section.len() > 65536 {
            return Err(ToolError::ContextBudget);
        }
        system.push_str(&section);
        for reference in references {
            sources.push(json!({"type":"reference","path":reference.path,"status":"authorized"}));
        }
    }
    let fingerprint = context_digest(&system, &sources).map_err(|_| ToolError::InvalidInput)?;
    Ok(ContextBundle {
        system,
        fingerprint,
        sources,
    })
}
