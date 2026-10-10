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

/// A project skill directory: `*.md` at its root and any nested `SKILL.md` are
/// discovered, and each skill's name/description is listed in the system context.
/// The body is read on demand, so it never inflates the prompt.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillDirectory {
    pub path: String,
}

pub(crate) fn validate_skills(directories: &[SkillDirectory]) -> Result<(), ToolError> {
    if directories.len() > 16 {
        return Err(ToolError::InvalidInput);
    }
    let mut seen = std::collections::BTreeSet::new();
    for directory in directories {
        if directory.path.is_empty()
            || directory.path.len() > 2048
            || std::path::Path::new(&directory.path).is_absolute()
            || directory
                .path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || directory.path.contains(['\0', '\\'])
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

fn discover_skills(root: &std::path::Path, directories: &[SkillDirectory]) -> Vec<Skill> {
    let mut skills = Vec::new();
    for directory in directories {
        let mut files = Vec::new();
        collect_skills(&root.join(&directory.path), 0, &mut files);
        for file in files {
            if skills.len() >= 64 {
                break;
            }
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            if text.len() > 65536 {
                continue;
            }
            let (name, description) = parse_frontmatter(&text);
            let parent = file
                .parent()
                .and_then(|parent| parent.file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let name = name.filter(|name| !name.is_empty()).unwrap_or_else(|| {
                if file.ends_with("SKILL.md") {
                    parent
                } else {
                    file.file_stem()
                        .map(|stem| stem.to_string_lossy().into_owned())
                        .unwrap_or_default()
                }
            });
            if name.is_empty() || name.len() > 64 {
                continue;
            }
            let description = description.unwrap_or_default();
            if description.len() > 512 {
                continue;
            }
            let path = file
                .strip_prefix(root)
                .map(|path| path.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| file.to_string_lossy().replace('\\', "/"));
            skills.push(Skill {
                name,
                description,
                path,
            });
        }
    }
    skills
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
    let skills = discover_skills(
        std::path::Path::new(tools.location()),
        tools.skill_directories(),
    );
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
    let fingerprint = context_digest(&system, &sources).map_err(|_| ToolError::InvalidInput)?;
    Ok(ContextBundle {
        system,
        fingerprint,
        sources,
    })
}
