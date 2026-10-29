use crate::{
    permission::{context_digest, Decision, Policy},
    protocol::{ContextBundle, Message},
    tools::{ToolError, Tools},
};
use serde::Deserialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub label: String,
    pub path: String,
}

pub(crate) struct ReadSource {
    source: Source,
    trigger: String,
}

/// Only successful, durably settled file reads activate nested instructions.
/// Keep the observation Session-owned; Tools is shared by a whole Location.
pub(crate) async fn read_sources(
    tools: &Tools,
    previous: &[serde_json::Value],
    paths: &[String],
    cancel: CancellationToken,
) -> Result<Vec<ReadSource>, ToolError> {
    const LIMIT: usize = 64;
    if std::env::var("MIAO_DISABLE_PROJECT_CONFIG")
        .is_ok_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
    {
        return Ok(Vec::new());
    }
    let names = if [
        "MIAO_DISABLE_CLAUDE_CODE_PROMPT",
        "MIAO_DISABLE_CLAUDE_CODE",
    ]
    .into_iter()
    .any(|name| {
        std::env::var(name).is_ok_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
    }) {
        vec!["AGENTS.md", "CONTEXT.md"]
    } else {
        vec!["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]
    };
    let root = std::path::Path::new(tools.location());
    let mut found = std::collections::BTreeMap::new();
    for value in previous {
        let (Some(path), Some(trigger)) = (value["path"].as_str(), value["read_path"].as_str())
        else {
            continue;
        };
        let parsed = std::path::Path::new(path);
        if value["type"] == "read_instruction"
            && value["location"] == tools.location()
            && source_path(path)
            && !parsed.is_absolute()
            && parsed
                .parent()
                .is_some_and(|parent| !parent.as_os_str().is_empty())
            && parsed
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| names.contains(&name))
            && found.len() < LIMIT
        {
            found.insert(path.to_owned(), trigger.to_owned());
        }
    }
    for path in paths {
        if cancel.is_cancelled() {
            return Err(ToolError::Interrupted);
        }
        // The prepared reader already recorded a canonical workspace-relative
        // path. Its original file may be gone when a receipt is replayed.
        let relative = std::path::Path::new(path);
        if !source_path(path) || relative.is_absolute() {
            continue;
        }
        for directory in relative.ancestors().skip(1) {
            if cancel.is_cancelled() {
                return Err(ToolError::Interrupted);
            }
            if directory.as_os_str().is_empty() || found.len() >= LIMIT {
                break;
            }
            for name in &names {
                let candidate = directory.join(name);
                if tokio::fs::symlink_metadata(root.join(&candidate))
                    .await
                    .is_err()
                {
                    continue;
                }
                let candidate = candidate.to_string_lossy().replace('\\', "/");
                // The matching instruction itself is already visible in its
                // read result; discovering its ancestors remains useful.
                if std::path::Path::new(&candidate) != relative {
                    found.entry(candidate).or_insert_with(|| path.clone());
                }
                break;
            }
        }
    }
    let mut sources = found.into_iter().collect::<Vec<_>>();
    sources.sort_by(|left, right| {
        left.0
            .matches('/')
            .count()
            .cmp(&right.0.matches('/').count())
            .then_with(|| left.0.cmp(&right.0))
    });
    Ok(sources
        .into_iter()
        .map(|(path, trigger)| ReadSource {
            source: Source {
                label: format!(
                    "nested-{}",
                    &crate::permission::digest(path.as_bytes())[..16]
                ),
                path,
            },
            trigger,
        })
        .collect())
}

/// A host-selected skill directory: workspace-relative paths stay contained;
/// absolute paths require a read-only directory reference. `*.md` at its root
/// and nested `SKILL.md` files are discovered under directory and file policy.
/// The body is read on demand, so it never inflates the prompt.
#[derive(Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SkillDirectory {
    pub path: String,
}

/// A host-authorized read-only reference: a directory or file outside the
/// model-writable workspace whose location is listed in the system context and
/// whose files may be read. It never becomes writable.
#[derive(Clone, Deserialize, PartialEq)]
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

/// A skill body resolved on demand by `load_skill`. Only files inside a
/// host-selected skill directory are read, and the body keeps the same bounds
/// as discovery.
pub(crate) struct LoadedSkill {
    pub name: String,
    pub directory: String,
    pub content: String,
    pub files: Vec<String>,
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

fn strip_frontmatter(text: &str) -> &str {
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return text;
    };
    let mut offset = text.len() - rest.len();
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        if line.trim_end() == "---" {
            return text[offset..].trim_start_matches(['\r', '\n']);
        }
    }
    text
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

fn collect_files(dir: &std::path::Path, depth: u8, out: &mut Vec<std::path::PathBuf>) {
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
        if file_type.is_dir() {
            collect_files(&path, depth + 1, out);
        } else if file_type.is_file() {
            out.push(path);
        }
    }
}

/// Resolve one skill by name from the host-selected directories. A skill whose
/// body exceeds the discovery bound is skipped, matching the listing.
pub(crate) fn find_skill(tools: &Tools, name: &str) -> Option<LoadedSkill> {
    for directory in tools.skill_directories().iter() {
        let path = std::path::Path::new(&directory.path);
        let root = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::path::Path::new(tools.location()).join(path)
        };
        let mut files = Vec::new();
        collect_skills(&root, 0, &mut files);
        files.sort();
        for file in files {
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            if text.len() > 65536 {
                continue;
            }
            let (declared, _) = parse_frontmatter(&text);
            let resolved = declared
                .filter(|declared| !declared.is_empty())
                .or_else(|| {
                    if file
                        .file_name()
                        .is_some_and(|name| name == std::ffi::OsStr::new("SKILL.md"))
                    {
                        file.parent()?
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                    } else {
                        file.file_stem()
                            .map(|name| name.to_string_lossy().into_owned())
                    }
                })?;
            if resolved != name || resolved.len() > 64 {
                continue;
            }
            let directory = file
                .parent()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            let mut entries = Vec::new();
            if file
                .file_name()
                .is_some_and(|name| name == std::ffi::OsStr::new("SKILL.md"))
            {
                collect_files(std::path::Path::new(&directory), 0, &mut entries);
                entries.retain(|entry| entry != &file);
                entries.sort();
                entries.truncate(10);
            }
            return Some(LoadedSkill {
                name: resolved,
                content: strip_frontmatter(&text).to_owned(),
                directory: directory.clone(),
                files: entries
                    .iter()
                    .map(|entry| {
                        let path = entry
                            .strip_prefix(&directory)
                            .map(|path| path.to_string_lossy().into_owned())
                            .unwrap_or_else(|_| entry.to_string_lossy().into_owned());
                        path.replace('\\', "/").trim_start_matches('/').to_owned()
                    })
                    .collect(),
            });
        }
    }
    None
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
    for directory in tools.skill_directories().iter() {
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
        let decision = policy
            .assess_input(
                prepared.name(),
                prepared.resource(),
                prepared.access(),
                Some(prepared.input()),
            )
            .0;
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
            if policy
                .assess_input(
                    prepared.name(),
                    prepared.resource(),
                    prepared.access(),
                    Some(prepared.input()),
                )
                .0
                != Decision::Allow
            {
                continue;
            }
            let data = match tools
                .execute_prepared(prepared, policy, cancel.child_token(), None)
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
    assemble_for_agent(tools, policy, cancel, None, &[]).await
}

pub(crate) async fn assemble_for_agent(
    tools: &Tools,
    policy: &Policy,
    cancel: CancellationToken,
    agent: Option<&crate::session_agent::AgentManifest>,
    reads: &[ReadSource],
) -> Result<ContextBundle, ToolError> {
    if cancel.is_cancelled() {
        return Err(ToolError::Interrupted);
    }
    let names = tools
        .definitions()
        .iter()
        .filter(|tool| {
            agent.is_none_or(|agent| agent.permits(&tool.name)) && policy.tool_visible(&tool.name)
        })
        .map(|t| t.name.clone())
        .collect::<Vec<_>>()
        .join(", ");
    let mut system=format!("You are miao, a coding assistant. Complete the user's task using available capabilities. Respond in the user's language. Preserve unrelated user changes. Respect permission and tool errors. Use read_file fingerprints for conditional edits. Do not automatically repeat operations with unknown side effects. For multi-step tasks, send a short user-facing update as normal assistant text before starting tools. During work, share concrete findings, decisions, blockers, and the next step in the user's language after a few tool batches; do not leave the user watching a long sequence of commands. Put these updates in text alongside tool calls, not only in reasoning or tool arguments: reasoning may be hidden. Summarize what the evidence establishes without exposing private reasoning or narrating every routine command. A progress update is not a final answer: continue the authorized work. Finish with the result and verification. Available tools: {names}.");
    let mut sources = Vec::new();
    let root = Source {
        label: "AGENTS.md".into(),
        path: "AGENTS.md".into(),
    };
    // Host global/ancestor instructions precede this workspace's instructions;
    // additional workspace-relative sources retain their configured order. One
    // snapshot for the whole section keeps the two halves consistent.
    let configured = tools.context_sources();
    for source in configured
        .iter()
        .filter(|source| std::path::Path::new(&source.path).is_absolute())
        .chain(tools.workspace_instructions().then_some(&root))
        .chain(
            configured
                .iter()
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
                let data=tools.execute_prepared(prepared,policy,cancel.child_token(),None).await?;
                let text=data["text"].as_str().ok_or(ToolError::InvalidFile)?;
                let block=format!("\n\n<project-instructions source=\"{}\">\n{}\n</project-instructions>",source.label,text);
                // Budget-aware assembly: an instructions block that would blow
                // the context budget is skipped (recorded for the client) so a
                // huge repo cannot fail the whole session at startup.
                if system.len()+block.len()>65536{
                    sources.push(json!({"label":source.label,"path":source.path,"resource":resource,"status":"skipped","reason":"context_budget"}));
                    continue;
                }
                system.push_str(&block);
                sources.push(json!({"label":source.label,"path":source.path,"resource":resource,"status":"loaded","sha256":data["sha256"]}));
            },
            Err(ToolError::Io(error)) if error.kind()==std::io::ErrorKind::NotFound=>sources.push(json!({"label":source.label,"path":source.path,"status":"missing"})),
            Err(ToolError::OutsideWorkspace|ToolError::ProtectedResource)=>sources.push(json!({"label":source.label,"path":source.path,"status":"skipped","reason":"outside_context_authority"})),
            Err(error)=>return Err(error),
        }
    }
    // The builtin-skill and listing sections are advisory; when the budget is
    // exhausted they are omitted instead of failing the session. Their sources
    // stay registered so read_file still reaches them.
    let media_line="\n\nBuilt-in skill: media-observe — use load_skill with name media-observe when inspecting video/audio. Follow its timestamped frame/contact-sheet workflow using bash and read_image. Load any project skill below by name with load_skill.";
    if system.len() + media_line.len() <= 65536 {
        system.push_str(media_line);
    }
    sources.push(json!({"type":"builtin_skill","name":"media-observe","path":"@builtin/skill/media-observe","status":"registered","sha256":crate::permission::digest(MEDIA_OBSERVE.as_bytes())}));
    let skills = discover_skills(tools, policy, cancel.child_token(), &mut sources).await?;
    if !skills.is_empty() {
        let mut section = String::from(
            "\n\n<available-skills>\nSkill bodies are not included; call load_skill with the skill name when one applies.\n",
        );
        for skill in &skills {
            section.push_str(&format!(
                "- {}: {} ({})\n",
                skill.name, skill.description, skill.path
            ));
        }
        section.push_str("</available-skills>");
        if system.len() + section.len() <= 65536 {
            system.push_str(&section);
        }
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
        for reference in references.iter() {
            section.push_str(&format!(
                "- {}: {}\n",
                reference.description, reference.path
            ));
        }
        section.push_str("</available-references>");
        if system.len() + section.len() <= 65536 {
            system.push_str(&section);
        }
        for reference in references.iter() {
            sources.push(json!({"type":"reference","path":reference.path,"status":"authorized"}));
        }
    }
    append_read_sources(tools, policy, cancel, reads, &mut system, &mut sources).await?;
    let fingerprint = context_digest(&system, &sources).map_err(|_| ToolError::InvalidInput)?;
    Ok(ContextBundle {
        system,
        fingerprint,
        sources,
    })
}

/// Request-only guidance based on committed history, so restart and resume do
/// not reset the silence count. Reasoning is not a user-facing progress report.
pub(crate) fn progress_reminder(history: &[Message]) -> Option<&'static str> {
    let silent = history
        .iter()
        .rev()
        .take_while(|message| {
            let blocks = message.content.as_array().into_iter().flatten();
            match message.role.as_str() {
                "assistant" => !blocks.clone().any(|block| {
                    block["type"] == "text"
                        && block["text"]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty())
                }),
                "user" => !blocks.clone().any(|block| block["type"] != "tool_result"),
                _ => true,
            }
        })
        .filter(|message| {
            message.role == "assistant"
                && message
                    .content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|block| block["type"] == "tool_use")
        })
        .take(3)
        .count();
    (silent == 3).then_some(
        "<system-reminder>\nSeveral tool batches have completed without a user-facing update. In your next response, include a brief normal-text update in the user's language describing what you have actually learned and what you will check or change next. Use the tool results as evidence; say if the investigation is still inconclusive. Do not expose private reasoning, repeat command logs, or claim unverified success. Continue the task and call tools as needed; this reminder does not ask you to stop or give a final answer.\n</system-reminder>",
    )
}

async fn append_read_sources(
    tools: &Tools,
    policy: &Policy,
    cancel: CancellationToken,
    reads: &[ReadSource],
    system: &mut String,
    sources: &mut Vec<serde_json::Value>,
) -> Result<(), ToolError> {
    if reads.is_empty() {
        return Ok(());
    }
    let mut bytes = serde_json::to_vec(sources)
        .map_err(|_| ToolError::InvalidInput)?
        .len();
    let mut omitted = 0;
    for read in reads {
        if cancel.is_cancelled() {
            return Err(ToolError::Interrupted);
        }
        let source = &read.source;
        let mut entry = json!({"type":"read_instruction","label":source.label,"path":source.path,"location":tools.location(),"read_path":read.trigger,"status":"skipped"});
        let prepared = tools
            .prepare("read_file", json!({"path":source.path}))
            .await;
        let text = match prepared {
            Ok(prepared)
                if !prepared
                    .resolved_path()
                    .starts_with(std::path::Path::new(tools.location())) =>
            {
                entry["reason"] = json!("outside_context_authority");
                None
            }
            Ok(prepared) => {
                let resource = prepared.resource().to_owned();
                if sources
                    .iter()
                    .any(|source| source["status"] == "loaded" && source["resource"] == resource)
                {
                    continue;
                }
                entry["resource"] = json!(resource);
                let direct =
                    policy.evaluate("read_file", &source.path, crate::permission::Access::Read);
                let resolved =
                    policy.evaluate(prepared.name(), prepared.resource(), prepared.access());
                if direct != Decision::Allow || resolved != Decision::Allow {
                    entry["reason"] =
                        json!(if direct == Decision::Deny || resolved == Decision::Deny {
                            "policy_deny"
                        } else {
                            "policy_ask"
                        });
                    None
                } else {
                    match tools
                        .execute_prepared(prepared, policy, cancel.child_token(), None)
                        .await
                    {
                        Ok(data) => {
                            entry["status"] = json!("loaded");
                            entry["sha256"] = data["sha256"].clone();
                            data["text"].as_str().map(str::to_owned)
                        }
                        Err(ToolError::Interrupted) => return Err(ToolError::Interrupted),
                        Err(_) => {
                            entry["reason"] = json!("read_failed");
                            None
                        }
                    }
                }
            }
            Err(ToolError::OutsideWorkspace | ToolError::ProtectedResource) => {
                entry["reason"] = json!("outside_context_authority");
                None
            }
            Err(_) => {
                entry["reason"] = json!("read_failed");
                None
            }
        };
        let path = source
            .path
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let block = text.map(|text| {
            format!(
                "\n\n<project-instructions source=\"{}\" path=\"{}\">\nThese instructions apply within this file's directory; deeper instruction files take precedence.\n{}\n</project-instructions>",
                source.label, path, text
            )
        });
        let block = block.filter(|block| {
            if system.len() + block.len() <= 65536 {
                return true;
            }
            entry["status"] = json!("skipped");
            entry["reason"] = json!("context_budget");
            false
        });
        let size = serde_json::to_vec(&entry)
            .map_err(|_| ToolError::InvalidInput)?
            .len()
            + 1;
        // Reserve room for a receipt instead of overflowing Store's durable
        // source budget when a deep project contributes long file names.
        if bytes + size + 128 > 65536 {
            omitted += 1;
            continue;
        }
        if let Some(block) = block {
            system.push_str(&block);
        }
        bytes += size;
        sources.push(entry);
    }
    if omitted > 0 {
        let receipt =
            json!({"type":"read_instruction_limit","reason":"source_budget","omitted":omitted});
        if bytes
            + serde_json::to_vec(&receipt)
                .map_err(|_| ToolError::InvalidInput)?
                .len()
            < 65536
        {
            sources.push(receipt);
        }
    }
    Ok(())
}
