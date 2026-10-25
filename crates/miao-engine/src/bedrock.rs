use crate::{
    credential::{Kind, Source},
    protocol::ModelRequest,
    provider::{Identity, Provider, ProviderError, Reply},
};
use async_trait::async_trait;
use aws_sdk_bedrockruntime::{
    config::{Region, Token},
    types, Client,
};
use aws_smithy_runtime_api::client::auth::http::HTTP_BEARER_AUTH_SCHEME_ID;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::{mpsc, OnceCell};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Bedrock {
    endpoint: Option<String>,
    region: String,
    profile: Option<String>,
    bearer: Option<Source>,
    model: String,
    client: Arc<OnceCell<Client>>,
    options: crate::request_options::Options,
    modalities: Vec<String>,
    prompt_cache: bool,
    headers: BTreeMap<String, String>,
}
impl Bedrock {
    pub fn with_chain(
        endpoint: Option<String>,
        model: String,
        region: String,
        profile: Option<String>,
    ) -> Result<Self, ProviderError> {
        if !crate::provider::valid_model(&model)
            || region.is_empty()
            || region.len() > 64
            || !region
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || profile.as_ref().is_some_and(|profile| {
                profile.is_empty() || profile.len() > 256 || profile.chars().any(char::is_control)
            })
        {
            return Err(invalid());
        }
        if let Some(endpoint) = &endpoint {
            let url = reqwest::Url::parse(endpoint).map_err(|_| invalid())?;
            if !matches!(url.scheme(), "https" | "http")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(invalid());
            }
        }
        Ok(Self {
            endpoint,
            region,
            profile,
            bearer: None,
            model,
            client: Arc::new(OnceCell::new()),
            options: Default::default(),
            modalities: vec![],
            prompt_cache: false,
            headers: BTreeMap::new(),
        })
    }
    pub fn with_prompt_cache(mut self, enabled: bool) -> Self {
        self.prompt_cache = enabled;
        self
    }
    pub fn with_bearer_source(
        endpoint: Option<String>,
        model: String,
        region: String,
        source: Source,
    ) -> Result<Self, ProviderError> {
        let mut provider = Self::with_chain(endpoint, model, region, None)?;
        provider.bearer = Some(source);
        Ok(provider)
    }
    /// A trusted caller may supply an SDK client with a scoped credential
    /// provider, e.g. a deterministic transport fixture without global env edits.
    pub fn with_client(mut self, client: Client) -> Self {
        self.client = Arc::new(OnceCell::new_with(Some(client)));
        self
    }
    async fn sdk(&self) -> Result<Client, ProviderError> {
        let client = self
            .client
            .get_or_init(|| async {
                let loader = aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .region(Region::new(self.region.clone()));
                let loader = match &self.profile {
                    Some(profile) => loader.profile_name(profile),
                    None => loader,
                };
                let shared = loader.load().await;
                let mut config = aws_sdk_bedrockruntime::config::Builder::from(&shared)
                    .retry_config(aws_smithy_types::retry::RetryConfig::disabled());
                if let Some(endpoint) = &self.endpoint {
                    config = config.endpoint_url(endpoint);
                }
                Client::from_conf(config.build())
            })
            .await;
        let Some(source) = &self.bearer else {
            return Ok(client.clone());
        };
        let credential = source.load().await?;
        if credential.kind() != Kind::Key {
            return Err(ProviderError::AuthProfile);
        }
        let config = client
            .config()
            .to_builder()
            .bearer_token(Token::new(credential.secret(), None))
            .auth_scheme_preference([HTTP_BEARER_AUTH_SCHEME_ID])
            .build();
        Ok(Client::from_conf(config))
    }
}

#[async_trait]
impl Provider for Bedrock {
    fn identity(&self) -> Option<Identity> {
        Some(Identity {
            protocol: "bedrock-converse".into(),
            model: self.model.clone(),
        })
    }
    fn for_model(&self, model: &str) -> Option<Arc<dyn Provider>> {
        if !crate::provider::valid_model(model) {
            return None;
        }
        let mut selected = self.clone();
        selected.model = model.into();
        Some(Arc::new(selected))
    }
    fn with_input_modalities(
        &self,
        input: Vec<String>,
    ) -> Result<Arc<dyn Provider>, ProviderError> {
        crate::media::validate_modalities(&input)?;
        let mut selected = self.clone();
        selected.modalities = input;
        Ok(Arc::new(selected))
    }
    fn with_route_auth(
        &self,
        auth: &crate::model_routes::Auth,
    ) -> Result<Arc<dyn Provider>, ProviderError> {
        auth.validate()?;
        if !auth.query.is_empty()
            || !matches!(
                (auth.style.as_deref(), self.bearer.is_some()),
                (None, _) | (Some("sigv4"), false) | (Some("bearer"), true)
            )
        {
            return Err(ProviderError::AuthProfile);
        }
        validate_headers(&auth.headers)?;
        let mut selected = self.clone();
        auth.apply_headers(&mut selected.headers);
        Ok(Arc::new(selected))
    }
    fn with_request_options(
        &self,
        options: crate::request_options::Options,
    ) -> Result<Arc<dyn Provider>, ProviderError> {
        options.validate()?;
        validate_headers(&options.headers)?;
        if options.body.keys().any(|key| {
            !matches!(
                key.as_str(),
                "inferenceConfig" | "additionalModelRequestFields"
            )
        }) {
            return Err(invalid());
        }
        inference(options.body.get("inferenceConfig"))?;
        if options
            .body
            .get("additionalModelRequestFields")
            .is_some_and(|value| {
                !value.is_object()
                    || value.as_object().is_some_and(|value| {
                        value.keys().any(|key| {
                            matches!(
                                key.as_str(),
                                "model"
                                    | "messages"
                                    | "system"
                                    | "tools"
                                    | "toolConfig"
                                    | "tool_choice"
                                    | "input"
                            )
                        })
                    })
            })
        {
            return Err(invalid());
        }
        let mut selected = self.clone();
        selected.options = options;
        Ok(Arc::new(selected))
    }
    fn protected_resources(&self) -> Vec<std::path::PathBuf> {
        let mut paths: Vec<_> = self
            .bearer
            .as_ref()
            .and_then(Source::path)
            .map(std::path::Path::to_path_buf)
            .into_iter()
            .collect();
        if self.bearer.is_none() {
            if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
            {
                let directory = std::path::PathBuf::from(home).join(".aws");
                if directory.exists() {
                    paths.push(directory);
                }
            }
            paths.extend(
                [
                    "AWS_CONFIG_FILE",
                    "AWS_SHARED_CREDENTIALS_FILE",
                    "AWS_WEB_IDENTITY_TOKEN_FILE",
                ]
                .into_iter()
                .filter_map(std::env::var_os)
                .map(std::path::PathBuf::from),
            );
        }
        paths
    }
    async fn stream(
        &self,
        request: ModelRequest,
        progress: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if cancel.is_cancelled() {
            return Err(ProviderError::Interrupted);
        }
        let request = crate::media::normalize(request, "bedrock-converse", &self.modalities)?;
        let mut messages = crate::bedrock_input::messages(&request, &self.model)?;
        let mut system = if request.system.is_empty() {
            vec![]
        } else {
            vec![types::SystemContentBlock::Text(request.system.clone())]
        };
        if self.prompt_cache {
            let point = types::CachePointBlock::builder()
                .r#type(types::CachePointType::Default)
                .build()
                .map_err(|_| invalid())?;
            if !system.is_empty() {
                system.push(types::SystemContentBlock::CachePoint(point.clone()));
            }
            if let Some(message) = messages
                .iter_mut()
                .rev()
                .find(|message| message.role().as_str() == "user")
            {
                message.content.push(types::ContentBlock::CachePoint(point));
            }
        }
        let tools = crate::bedrock_input::tools(&request)?;
        let config = inference(self.options.body.get("inferenceConfig"))?;
        let additional = self
            .options
            .body
            .get("additionalModelRequestFields")
            .map(crate::bedrock_input::document);
        let sdk = tokio::select! {_=cancel.cancelled()=>return Err(ProviderError::Interrupted),result=tokio::time::timeout(Duration::from_secs(30),self.sdk())=>result.map_err(|_|ProviderError::Transport)??};
        let mut headers = self.headers.clone();
        for (name, value) in &self.options.headers {
            headers.retain(|key, _| !key.eq_ignore_ascii_case(name));
            headers.insert(name.clone(), value.clone());
        }
        for value in headers
            .values_mut()
            .filter(|value| value.as_str() == "$session")
        {
            *value = crate::cache_affinity::session_key().ok_or_else(invalid)?;
        }
        let headers = Arc::new(headers);
        let mut output = None;
        let mut watchdogs = crate::first_event::Watchdogs::default();
        for attempt in 0..crate::provider::transport_retry_limit() {
            let (deadline, _) = crate::provider::transport_attempt()?;
            watchdogs = crate::first_event::Watchdogs::at(0);
            let first = watchdogs
                .header_deadline()
                .unwrap_or(deadline)
                .min(deadline);
            let operation = sdk
                .converse_stream()
                .model_id(&self.model)
                .set_messages(Some(messages.clone()))
                .set_system((!system.is_empty()).then(|| system.clone()))
                .set_tool_config(tools.clone())
                .set_inference_config(config.clone())
                .set_additional_model_request_fields(additional.clone());
            let headers = headers.clone();
            let operation = operation.customize().mutate_request(move |request| {
                for (name, value) in headers.iter() {
                    request.headers_mut().insert(name.clone(), value.clone());
                }
            });
            let result = tokio::select! {_=cancel.cancelled()=>return Err(ProviderError::Interrupted),result=tokio::time::timeout_at(first,operation.send())=>result.map_err(|_|ProviderError::Transport)};
            let result = match result {
                Ok(Ok(output)) => Ok(output),
                Ok(Err(error)) => Err(error
                    .raw_response()
                    .map(|response| ProviderError::Http(response.status().as_u16()))
                    .unwrap_or(ProviderError::Transport)),
                Err(error) => Err(error),
            };
            match result {
                Ok(response) => {
                    output = Some(response);
                    break;
                }
                Err(error)
                    if error.can_fallback()
                        && attempt + 1 < crate::provider::transport_retry_limit() =>
                {
                    tokio::select! {_=cancel.cancelled()=>return Err(ProviderError::Interrupted),_=tokio::time::sleep(Duration::from_millis(200*(attempt as u64+1)))=>{}}
                }
                Err(error) => return Err(error),
            }
        }
        let mut output = output.ok_or(ProviderError::Transport)?;
        let mut state = crate::bedrock_stream::State::default();
        let mut event = watchdogs.event;
        let byte_idle = watchdogs.byte_idle;
        loop {
            let now = tokio::time::Instant::now();
            let idle = (byte_idle > Duration::ZERO).then(|| now + byte_idle);
            let mut deadline = state
                .deadline()
                .unwrap_or(now + Duration::from_secs(120))
                .min(event.unwrap_or(now + Duration::from_secs(120)));
            if let Some(idle) = idle {
                deadline = deadline.min(idle);
            }
            let received = tokio::select! {_=cancel.cancelled()=>return Err(ProviderError::Interrupted),result=tokio::time::timeout_at(deadline,output.stream.recv())=>match result {Ok(Ok(event))=>event,Ok(Err(_))=>return Err(ProviderError::ResponseTransport),Err(_)=>{if state.deadline().is_some_and(|limit|limit<=tokio::time::Instant::now()){return Err(state.timeout());}return Err(ProviderError::ResponseTransport);}}};
            let Some(received) = received else {
                return state.finish();
            };
            let notices = state.event(received, &self.model)?;
            if !notices.is_empty() {
                event = watchdogs.next_event_deadline();
            }
            for notice in notices {
                let send_deadline = state
                    .deadline()
                    .map(|limit| match idle {
                        Some(idle) => limit.min(idle),
                        None => limit,
                    })
                    .unwrap_or(now + Duration::from_secs(120));
                tokio::select! {_=cancel.cancelled()=>return Err(ProviderError::Interrupted),result=tokio::time::timeout_at(send_deadline,progress.send(json!({"kind":"delta","delta":notice})))=>{result.map_err(|_|ProviderError::Transport)?.map_err(|_|ProviderError::Interrupted)?;}}
            }
        }
    }
}
fn validate_headers(headers: &BTreeMap<String, String>) -> Result<(), ProviderError> {
    if headers.keys().any(|name| {
        matches!(
            name.to_ascii_lowercase().as_str(),
            "x-amz-date"
                | "x-amz-security-token"
                | "x-amz-content-sha256"
                | "amz-sdk-invocation-id"
                | "amz-sdk-request"
        )
    }) {
        return Err(ProviderError::AuthProfile);
    }
    Ok(())
}
fn inference(
    value: Option<&Value>,
) -> Result<Option<types::InferenceConfiguration>, ProviderError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.as_object().ok_or_else(invalid)?;
    if value.keys().any(|key| {
        !matches!(
            key.as_str(),
            "maxTokens" | "temperature" | "topP" | "stopSequences"
        )
    }) {
        return Err(invalid());
    }
    let mut config = types::InferenceConfiguration::builder();
    if let Some(value) = value.get("maxTokens") {
        let value = value
            .as_i64()
            .filter(|value| (1..=1_000_000).contains(value))
            .ok_or_else(invalid)?;
        config = config.max_tokens(value as i32);
    }
    for key in ["temperature", "topP"] {
        if let Some(value) = value.get(key) {
            let value = value
                .as_f64()
                .filter(|value| (0.0..=1.0).contains(value))
                .ok_or_else(invalid)?;
            config = if key == "temperature" {
                config.temperature(value as f32)
            } else {
                config.top_p(value as f32)
            };
        }
    }
    if let Some(value) = value.get("stopSequences") {
        let values = value
            .as_array()
            .filter(|values| values.len() <= 8)
            .ok_or_else(invalid)?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.is_empty() && value.len() <= 1024)
                    .map(str::to_owned)
                    .ok_or_else(invalid)
            })
            .collect::<Result<Vec<_>, _>>()?;
        config = config.set_stop_sequences(Some(values));
    }
    Ok(Some(config.build()))
}
fn invalid() -> ProviderError {
    ProviderError::Stream("invalid host Bedrock configuration".into())
}

pub async fn validate_credential_paths(
    paths: Vec<std::path::PathBuf>,
    workspace: &std::path::Path,
) -> Result<(), ProviderError> {
    let workspace = tokio::fs::canonicalize(workspace)
        .await
        .map_err(|_| crate::credential::Error::Io)?;
    for path in paths {
        if !path.is_absolute()
            || path.starts_with(&workspace)
            || tokio::fs::canonicalize(path)
                .await
                .map_err(|_| crate::credential::Error::Io)?
                .starts_with(&workspace)
        {
            return Err(ProviderError::Stream(
                "AWS credential resources must be outside workspace".into(),
            ));
        }
    }
    Ok(())
}
