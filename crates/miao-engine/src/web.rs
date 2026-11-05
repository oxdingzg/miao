//! Native, bounded web reads and provider-backed search. The host selects any
//! search credentials; model arguments can never replace the search endpoint.
//!
//! `websearch` has two kinds of backend. A REST provider (Exa, Parallel) answers
//! one request with its own per-result rows. An MCP server answers through its
//! own search tool, with that tool's own arguments and its own output. The two
//! stay distinguishable on purpose: a row count is not recall, so the engine
//! bounds and labels each answer instead of reshaping one backend into the
//! other's vocabulary.
use crate::{
    mcp::Registry,
    permission::{Access, Decision, Policy},
    protocol::ToolDefinition,
    tools::ToolError,
};
use reqwest::{redirect, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

const BODY_LIMIT: usize = 2 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 65536;

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    search: Option<SearchConfig>,
    /// The attached MCP catalogue, which is what an `mcp` search backend calls
    /// through. Without it the configured backend is unusable, and the tool says
    /// so rather than falling back to another backend on its own.
    mcp: Option<Arc<Registry>>,
}

#[derive(Clone, Copy)]
pub enum SearchProvider {
    Exa,
    Parallel,
}

/// Which kind of backend answers `websearch`.
#[derive(Clone)]
enum Backend {
    Rest {
        provider: SearchProvider,
        endpoint: Url,
        key: reqwest::header::HeaderValue,
    },
    /// A search tool on an attached MCP server. The server owns the request and
    /// the response shape, so the tool's own schema is what the model fills in.
    Mcp { tool: String },
}

#[derive(Clone)]
pub struct SearchConfig {
    backend: Backend,
}

impl SearchConfig {
    pub fn new(
        provider: SearchProvider,
        endpoint: Option<&str>,
        key: &str,
    ) -> Result<Self, ToolError> {
        let endpoint = url(endpoint.unwrap_or(match provider {
            SearchProvider::Exa => "https://api.exa.ai/search",
            SearchProvider::Parallel => "https://api.parallel.ai/v1/search",
        }))?;
        if key.is_empty() || key.len() > 8192 || endpoint.query().is_some() {
            return Err(ToolError::InvalidInput);
        }
        let mut key =
            reqwest::header::HeaderValue::from_str(key).map_err(|_| ToolError::InvalidInput)?;
        key.set_sensitive(true);
        Ok(Self {
            backend: Backend::Rest {
                provider,
                endpoint,
                key,
            },
        })
    }

    /// Select a search tool by its catalogue alias. Aliases are bare: a value
    /// with whitespace or control characters cannot name a catalogue entry, so
    /// it is rejected here instead of surfacing later as an unusable backend.
    pub fn mcp(tool: &str) -> Result<Self, ToolError> {
        if tool.is_empty()
            || tool.len() > 128
            || tool.chars().any(char::is_control)
            || tool.contains(char::is_whitespace)
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(Self {
            backend: Backend::Mcp {
                tool: tool.to_owned(),
            },
        })
    }

    pub fn from_env() -> Result<Option<Self>, ToolError> {
        if std::env::var("MIAO_WEB_SEARCH_PROVIDER").ok().as_deref() == Some("mcp") {
            let tool =
                std::env::var("MIAO_WEB_SEARCH_MCP_TOOL").map_err(|_| ToolError::InvalidInput)?;
            return Self::mcp(&tool).map(Some);
        }
        let provider = match std::env::var("MIAO_WEB_SEARCH_PROVIDER").ok().as_deref() {
            Some("exa") => Some(SearchProvider::Exa),
            Some("parallel") => Some(SearchProvider::Parallel),
            Some(_) => return Err(ToolError::InvalidInput),
            None if std::env::var_os("EXA_API_KEY").is_some() => Some(SearchProvider::Exa),
            None if std::env::var_os("PARALLEL_API_KEY").is_some() => {
                Some(SearchProvider::Parallel)
            }
            None => None,
        };
        let Some(provider) = provider else {
            return Ok(None);
        };
        let key = std::env::var(match provider {
            SearchProvider::Exa => "EXA_API_KEY",
            SearchProvider::Parallel => "PARALLEL_API_KEY",
        })
        .map_err(|_| ToolError::InvalidInput)?;
        Self::new(
            provider,
            std::env::var("MIAO_WEB_SEARCH_ENDPOINT").ok().as_deref(),
            &key,
        )
        .map(Some)
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Format {
    Text,
    Html,
    #[default]
    Markdown,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fetch {
    url: String,
    #[serde(default)]
    format: Format,
    #[serde(default = "timeout")]
    timeout: u64,
}
fn timeout() -> u64 {
    30
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SearchType {
    #[default]
    Auto,
    Fast,
    Deep,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Search {
    query: String,
    #[serde(default = "results")]
    num_results: usize,
    #[serde(default, rename = "type")]
    kind: SearchType,
    #[serde(default = "characters")]
    context_max_characters: usize,
}
fn results() -> usize {
    8
}
fn characters() -> usize {
    10000
}

fn url(raw: &str) -> Result<Url, ToolError> {
    let mut parsed = Url::parse(raw).map_err(|_| ToolError::InvalidInput)?;
    if raw.len() > 8192
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(ToolError::InvalidInput);
    }
    parsed.set_fragment(None);
    Ok(parsed)
}
fn resource(url: &Url) -> String {
    format!(
        "@web/{}{}{}",
        url.host_str().unwrap_or_default(),
        url.port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default(),
        url.path()
    )
}
fn fetch(input: Value) -> Result<(Fetch, Url), ToolError> {
    let input: Fetch = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
    if !(1..=120).contains(&input.timeout) {
        return Err(ToolError::InvalidInput);
    }
    let parsed = url(&input.url)?;
    Ok((input, parsed))
}
fn search(input: Value) -> Result<Search, ToolError> {
    let input: Search = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
    if input.query.trim().is_empty()
        || input.query.len() > 8192
        || !(1..=20).contains(&input.num_results)
        || !(1..=50000).contains(&input.context_max_characters)
    {
        return Err(ToolError::InvalidInput);
    }
    Ok(input)
}

impl Client {
    pub fn new(search: Option<SearchConfig>) -> Result<Self, ToolError> {
        let http = reqwest::Client::builder()
            .redirect(redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent("miao-engine web")
            .build()
            .map_err(|_| ToolError::External("web client initialization failed".into()))?;
        Ok(Self {
            http,
            search,
            mcp: None,
        })
    }

    /// Attach the MCP catalogue an `mcp` search backend calls through. The
    /// registry is what resolves the configured alias, so the backend stays
    /// unusable until it is attached rather than quietly answering elsewhere.
    pub fn with_mcp(mut self, registry: Arc<Registry>) -> Self {
        self.mcp = Some(registry);
        self
    }

    pub fn prepare(&self, name: &str, input: Value) -> Result<String, ToolError> {
        match name {
            "webfetch" => Ok(resource(&fetch(input)?.1)),
            "websearch" => self.search_resource(input),
            _ => Err(ToolError::Unsupported),
        }
    }

    /// The resource one `websearch` call is authorized against. A REST backend
    /// is a single endpoint; an MCP backend is the tool that answers, so a rule
    /// can allow one search server without allowing every other one.
    fn search_resource(&self, input: Value) -> Result<String, ToolError> {
        let config = self.search.as_ref().ok_or(ToolError::Unsupported)?;
        match &config.backend {
            Backend::Rest { endpoint, .. } => {
                search(input)?;
                Ok(resource(endpoint))
            }
            Backend::Mcp { tool } => {
                let registry = self.mcp.as_ref().ok_or(ToolError::Unsupported)?;
                registry.validate(tool, &input)?;
                registry.resource(tool).ok_or(ToolError::Unsupported)
            }
        }
    }

    pub(crate) fn descriptor(&self) -> Value {
        json!({"fetch":true,"search":self.search.as_ref().map(|config|match &config.backend {
            Backend::Rest { provider, endpoint, .. } => json!({"provider":match provider {SearchProvider::Exa=>"exa",SearchProvider::Parallel=>"parallel"},"endpoint":endpoint.as_str()}),
            Backend::Mcp { tool } => json!({"provider":"mcp","tool":tool}),
        })})
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let mut definitions=vec![ToolDefinition { name:"webfetch".into(),description:"Fetch an HTTP(S) page as markdown, text, or HTML. At most 2 MiB downloaded and 64 KiB returned. Redirect destinations must independently pass web permission; fetch a refused redirect explicitly to request its permission.".into(),input_schema:json!({"type":"object","properties":{"url":{"type":"string"},"format":{"type":"string","enum":["markdown","text","html"],"default":"markdown"},"timeout":{"type":"integer","minimum":1,"maximum":120,"default":30}},"required":["url"],"additionalProperties":false}) }];
        definitions.extend(self.search_definition());
        definitions
    }

    /// `websearch` advertises whichever argument contract its backend reads: a
    /// REST provider takes `query`/`numResults`, while an MCP backend takes
    /// exactly what its search tool declares. Translating the model's arguments
    /// into the other vocabulary would advertise a contract the answering
    /// backend never reads, so each shape is passed through instead.
    fn search_definition(&self) -> Option<ToolDefinition> {
        let config = self.search.as_ref()?;
        match &config.backend {
            Backend::Rest { .. } => Some(ToolDefinition { name:"websearch".into(),description:"Search the web through the host-configured Exa or Parallel provider. Returns bounded results with source URLs; provider credentials and endpoint are not model arguments.".into(),input_schema:json!({"type":"object","properties":{"query":{"type":"string"},"numResults":{"type":"integer","minimum":1,"maximum":20,"default":8},"type":{"type":"string","enum":["auto","fast","deep"],"default":"auto"},"contextMaxCharacters":{"type":"integer","minimum":1,"maximum":50000,"default":10000}},"required":["query"],"additionalProperties":false}) }),
            Backend::Mcp { tool } => {
                let catalogue = self.mcp.as_ref()?.definitions();
                let definition = catalogue
                    .iter()
                    .find(|definition| &definition.name == tool)?;
                Some(ToolDefinition {
                    name: "websearch".into(),
                    description: format!("Search the web through the MCP server's own search tool `{tool}`. The server owns the request and the result shape, so its schema is the argument contract; the endpoint and any credentials are not model arguments."),
                    input_schema: definition.input_schema.clone(),
                })
            }
        }
    }

    pub async fn execute(
        &self,
        name: &str,
        input: Value,
        policy: &Policy,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let target = self.prepare(name, input.clone())?;
        // The runtime has already obtained any per-call Ask approval for this
        // initial resource. Redirects below require their own explicit Allow.
        if policy.evaluate(name, &target, Access::Web) == Decision::Deny {
            return Err(ToolError::External("web permission is denied".into()));
        }
        tokio::select! {
            _=cancel.cancelled()=>Err(ToolError::Interrupted),
            result=async {
                match name {
                    "webfetch"=>{
                        let (input,url)=fetch(input)?;
                        tokio::time::timeout(Duration::from_secs(input.timeout),self.fetch(input,url,policy)).await.map_err(|_|ToolError::External("web request timed out".into()))?
                    },
                    "websearch"=> match &self.search.as_ref().ok_or(ToolError::Unsupported)?.backend {
                        Backend::Rest { .. } => self.rest_search(search(input)?).await,
                        Backend::Mcp { .. } => self.mcp_search(input, cancel.clone()).await,
                    },
                    _=>Err(ToolError::Unsupported),
                }
            }=>result,
        }
    }

    async fn fetch(
        &self,
        input: Fetch,
        mut target: Url,
        policy: &Policy,
    ) -> Result<Value, ToolError> {
        for _ in 0..=5 {
            let response = self
                .http
                .get(target.clone())
                .send()
                .await
                .map_err(|_| ToolError::External("web request failed".into()))?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| ToolError::External("redirect has no valid Location".into()))?;
                let next = target.join(location).map_err(|_| ToolError::InvalidInput)?;
                let next = url(next.as_str())?;
                if policy.evaluate("webfetch", &resource(&next), Access::Web) != Decision::Allow {
                    return Err(ToolError::External(format!(
                        "redirect requires separate permission: {}",
                        next.as_str()
                    )));
                }
                target = next;
                continue;
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("text/plain")
                .to_owned();
            let response = bounded(response).await?;
            let normalized_type = content_type.to_ascii_lowercase();
            let charset = normalized_type
                .split(';')
                .skip(1)
                .find_map(|part| part.trim().strip_prefix("charset="))
                .map(|name| name.trim_matches(['\'', '"']));
            let encoding = charset
                .and_then(|name| encoding_rs::Encoding::for_label(name.as_bytes()))
                .unwrap_or(encoding_rs::UTF_8);
            let (raw, _, invalid) = encoding.decode(&response);
            if invalid {
                return Err(ToolError::External(
                    "web response is not valid text in its declared encoding".into(),
                ));
            }
            let raw = raw.into_owned();
            let html = normalized_type.contains("text/html")
                || normalized_type.contains("application/xhtml");
            let content = match input.format {
                Format::Html => raw,
                Format::Markdown if html => htmd::convert(&raw)
                    .map_err(|_| ToolError::External("HTML conversion failed".into()))?,
                Format::Text if html => {
                    let document = scraper::Html::parse_document(&raw);
                    document
                        .root_element()
                        .descendants()
                        .filter(|node| {
                            !node.ancestors().any(|parent| {
                                parent.value().as_element().is_some_and(|element| {
                                    matches!(element.name(), "script" | "style" | "head")
                                })
                            })
                        })
                        .filter_map(|node| node.value().as_text().map(|text| text.text.as_ref()))
                        .collect::<Vec<&str>>()
                        .join(" ")
                }
                _ => raw,
            };
            let (content, truncated) = clip(content, OUTPUT_LIMIT);
            return Ok(
                json!({"url":target.as_str(),"content_type":content_type,"content":content,"truncated":truncated}),
            );
        }
        Err(ToolError::External("web redirect limit exceeded".into()))
    }

    async fn rest_search(&self, input: Search) -> Result<Value, ToolError> {
        let config = self.search.as_ref().ok_or(ToolError::Unsupported)?;
        let Backend::Rest {
            provider,
            endpoint,
            key,
        } = &config.backend
        else {
            return Err(ToolError::Unsupported);
        };
        let body = match provider {
            SearchProvider::Exa => {
                json!({"query":input.query,"numResults":input.num_results,"type":match input.kind {SearchType::Auto=>"auto",SearchType::Fast=>"fast",SearchType::Deep=>"deep"},"contents":{"text":{"maxCharacters":input.context_max_characters.div_ceil(input.num_results)}}})
            }
            SearchProvider::Parallel => {
                json!({"objective":input.query,"search_queries":[input.query],"mode":match input.kind {SearchType::Auto=>"basic",SearchType::Fast=>"fast",SearchType::Deep=>"advanced"},"max_chars_total":input.context_max_characters,"advanced_settings":{"max_results":input.num_results}})
            }
        };
        // Search requests never follow redirects, so the key stays on its
        // configured endpoint even when a provider returns a redirect.
        let response = self
            .http
            .post(endpoint.clone())
            .header("x-api-key", key.clone())
            .json(&body)
            .send()
            .await
            .map_err(|_| ToolError::External("web search request failed".into()))?;
        let value: Value = serde_json::from_slice(&bounded(response).await?)
            .map_err(|_| ToolError::External("invalid web search response".into()))?;
        let rows = value["results"]
            .as_array()
            .ok_or_else(|| ToolError::External("web search response has no results".into()))?;
        let mut remaining = OUTPUT_LIMIT.min(input.context_max_characters.saturating_mul(4));
        let mut characters = input.context_max_characters;
        let mut results = Vec::new();
        for row in rows.iter().take(input.num_results) {
            let Some(link) = row["url"].as_str().filter(|link| url(link).is_ok()) else {
                continue;
            };
            let text = match provider {
                SearchProvider::Exa => row["text"].as_str().unwrap_or_default().to_owned(),
                SearchProvider::Parallel => row["excerpts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n\n"),
            };
            let character_truncated = text.chars().count() > characters;
            let text = text.chars().take(characters).collect::<String>();
            let (text, byte_truncated) = clip(text, remaining);
            characters = characters.saturating_sub(text.chars().count());
            remaining = remaining.saturating_sub(text.len());
            results.push(json!({"url":link,"title":row["title"].as_str().unwrap_or_default(),"text":text,"truncated":character_truncated||byte_truncated}));
            if remaining == 0 || characters == 0 {
                break;
            }
        }
        Ok(
            json!({"provider":match provider { SearchProvider::Exa=>"exa",SearchProvider::Parallel=>"parallel" },"results":results}),
        )
    }

    /// Answer through the attached catalogue's own search tool. The server
    /// chooses the request and the result shape, so the engine forwards the
    /// arguments it validated and labels which server and which of its tools
    /// answered. The catalogue already refuses a result over its 64 KiB output
    /// budget rather than returning a partial one, so this answer is bounded by
    /// that budget and carries no truncation flag of its own.
    async fn mcp_search(
        &self,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let registry = self.mcp.as_ref().ok_or(ToolError::Unsupported)?;
        let Some(Backend::Mcp { tool }) = self.search.as_ref().map(|config| &config.backend) else {
            return Err(ToolError::Unsupported);
        };
        let identity = registry.identity(tool).ok_or(ToolError::Unsupported)?;
        let output = registry.call(tool, input, cancel).await?;
        Ok(json!({"backend":"mcp","server":identity.server,"tool":identity.tool,"output":output}))
    }
}

async fn bounded(mut response: reqwest::Response) -> Result<Vec<u8>, ToolError> {
    if !response.status().is_success() {
        return Err(ToolError::External(format!(
            "web server returned HTTP {}",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > BODY_LIMIT as u64)
    {
        return Err(ToolError::External("web response exceeds 2 MiB".into()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ToolError::External("web response interrupted".into()))?
    {
        if body.len() + chunk.len() > BODY_LIMIT {
            return Err(ToolError::External("web response exceeds 2 MiB".into()));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
fn clip(mut text: String, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    (text, true)
}
