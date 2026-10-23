use crate::tools::ToolError;
use base64::Engine;
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

/// Pages read when the caller does not pass `pages`.
pub(crate) const DEFAULT_PAGES: usize = 10;
/// Most pages one call may request.
pub(crate) const MAX_PAGES: usize = 20;
/// Most pages rendered to images in one call.
pub(crate) const MAX_RENDERED_PAGES: usize = 5;
/// A page with fewer non-whitespace characters is treated as having no text
/// layer and is rendered instead.
pub(crate) const MIN_TEXT_CHARS: usize = 16;
const RENDER_DPI: u32 = 120;
const MAX_TEXT_BYTES: usize = 28 * 1024;
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
const INFO_TIMEOUT: Duration = Duration::from_secs(20);
const TEXT_TIMEOUT: Duration = Duration::from_secs(20);
const RENDER_TIMEOUT: Duration = Duration::from_secs(60);

/// Parse a `pages` selection such as `1-3,5` and return the requested pages
/// plus the continuation for pages left over by this call.
pub fn selection(
    input: Option<&str>,
    total: usize,
) -> Result<(Vec<usize>, Option<String>), ToolError> {
    if total == 0 {
        return Err(ToolError::External("PDF has no pages".into()));
    }
    let pages = match input {
        None => (1..=total.min(DEFAULT_PAGES)).collect::<Vec<_>>(),
        Some(input) => parse_ranges(input, total)?,
    };
    if pages.is_empty() || pages.len() > MAX_PAGES {
        return Err(ToolError::InvalidInput);
    }
    let next = if input.is_none() && total > pages.len() {
        let start = pages.len() + 1;
        let end = (start + DEFAULT_PAGES - 1).min(total);
        Some(format!("{start}-{end}"))
    } else {
        None
    };
    Ok((pages, next))
}

fn parse_ranges(input: &str, total: usize) -> Result<Vec<usize>, ToolError> {
    let mut pages = Vec::new();
    for part in input.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(ToolError::InvalidInput);
        }
        let (start, end) = match part.split_once('-') {
            Some((start, end)) => (start.trim(), end.trim()),
            None => (part, part),
        };
        let start: usize = start.parse().map_err(|_| ToolError::InvalidInput)?;
        let end: usize = end.parse().map_err(|_| ToolError::InvalidInput)?;
        if start == 0 || start > end || end > total {
            return Err(ToolError::InvalidInput);
        }
        pages.extend(start..=end);
        if pages.len() > MAX_PAGES {
            return Err(ToolError::InvalidInput);
        }
    }
    pages.dedup();
    Ok(pages)
}

pub async fn read(resource: &str, path: &Path, pages: Option<&str>) -> Result<Value, ToolError> {
    let total = page_count(path).await?;
    let (selected, next) = selection(pages, total)?;
    let mut content = String::new();
    let mut rendered = Vec::new();
    let mut rendered_pages = 0usize;
    let mut truncated = false;
    let mut images = Vec::new();

    for page in &selected {
        let text = page_text(path, *page).await?;
        let usable = text
            .chars()
            .filter(|character| !character.is_whitespace())
            .count();
        if usable >= MIN_TEXT_CHARS {
            if content.len() + text.len() > MAX_TEXT_BYTES {
                truncated = true;
                continue;
            }
            content.push_str(&format!("--- page {page} ---\n{}\n", text.trim_end()));
            continue;
        }
        if rendered_pages >= MAX_RENDERED_PAGES {
            truncated = true;
            continue;
        }
        rendered_pages += 1;
        match render_page(path, *page).await {
            Ok(image) => {
                rendered.push(*page);
                images.push(image);
            }
            Err(ToolError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(dependency());
            }
            Err(error) => return Err(error),
        }
    }

    if !rendered.is_empty() {
        content.push_str(&format!(
            "\nRendered page images for pages without a usable text layer: {}.\n",
            rendered
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if content.is_empty() && images.is_empty() {
        content.push_str("The selected pages have no text layer and could not be rendered.\n");
    }
    if let Some(next) = &next {
        content.push_str(&format!(
            "\nRemaining pages: {next}. Pass pages to read them.\n"
        ));
    }

    Ok(json!({
        "type":"pdf-pages",
        "path":resource,
        "content":content,
        "total_pages":total,
        "pages":selected,
        "images":images,
        "truncated":truncated || next.is_some(),
        "next":next,
    }))
}

fn dependency() -> ToolError {
    ToolError::External(
        [
            "Reading PDF files requires poppler (pdfinfo, pdftotext, pdftoppm), but the command was not found on PATH.",
            "Install it, then retry:",
            "- macOS: brew install poppler",
            "- Debian/Ubuntu: sudo apt install poppler-utils",
            "- Fedora/RHEL: sudo dnf install poppler-utils",
            "- Windows: scoop install poppler (or choco install poppler), and make sure its bin directory is on PATH",
        ]
        .join("\n"),
    )
}

async fn page_count(path: &Path) -> Result<usize, ToolError> {
    let output = run("pdfinfo", &[path.as_os_str()], INFO_TIMEOUT).await?;
    let text = String::from_utf8_lossy(&output);
    text.lines()
        .find_map(|line| line.strip_prefix("Pages:"))
        .and_then(|value| value.trim().parse().ok())
        .ok_or_else(|| {
            ToolError::External("Unable to read PDF: pdfinfo did not report a page count".into())
        })
}

async fn page_text(path: &Path, page: usize) -> Result<String, ToolError> {
    let page = page.to_string();
    let output = run(
        "pdftotext",
        &[
            std::ffi::OsStr::new("-f"),
            std::ffi::OsStr::new(&page),
            std::ffi::OsStr::new("-l"),
            std::ffi::OsStr::new(&page),
            std::ffi::OsStr::new("-layout"),
            path.as_os_str(),
            std::ffi::OsStr::new("-"),
        ],
        TEXT_TIMEOUT,
    )
    .await?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

async fn render_page(path: &Path, page: usize) -> Result<Value, ToolError> {
    let directory = tempfile::tempdir().map_err(|error| ToolError::Io(error))?;
    let prefix = directory.path().join(format!("page-{page}"));
    let start = page.to_string();
    let dpi = RENDER_DPI.to_string();
    run(
        "pdftoppm",
        &[
            std::ffi::OsStr::new("-f"),
            std::ffi::OsStr::new(&start),
            std::ffi::OsStr::new("-l"),
            std::ffi::OsStr::new(&start),
            std::ffi::OsStr::new("-r"),
            std::ffi::OsStr::new(&dpi),
            std::ffi::OsStr::new("-png"),
            std::ffi::OsStr::new("-singlefile"),
            path.as_os_str(),
            prefix.as_os_str(),
        ],
        RENDER_TIMEOUT,
    )
    .await?;
    let file = prefix.with_extension("png");
    let metadata = tokio::fs::metadata(&file).await?;
    if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
        return Err(ToolError::External(
            "rendered PDF page image must be at most 4 MiB".into(),
        ));
    }
    let bytes = tokio::fs::read(&file).await?;
    Ok(json!({
        "mime":"image/png",
        "data":base64::engine::general_purpose::STANDARD.encode(bytes),
        "metadata":{"page":page},
    }))
}

async fn run(
    program: &str,
    args: &[&std::ffi::OsStr],
    timeout: Duration,
) -> Result<Vec<u8>, ToolError> {
    let mut command = tokio::process::Command::new(program);
    command.args(args).stdin(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| ToolError::External(format!("{program} timed out")))?
        .map_err(|error| ToolError::Io(error))?;
    if !output.status.success() {
        return Err(ToolError::External(format!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}
