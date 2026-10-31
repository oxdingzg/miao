//! V1 config document migration for the S5 unified read model.
//!
//! Ported from `packages/core/src/v1/config` (migrate.ts plus the provider
//! options lowerers): the engine and the TypeScript product must decode the
//! same document set into the same normalized V2 value, pinned by the shared
//! golden samples in `tests/fixtures/config-golden`. The port works on JSON
//! values the way the TypeScript suite works on its decoded documents: a
//! V1-shaped document is detected by its key set, migrated to the V2 shape,
//! and documents the V2 schema does not know are filtered to the schema's
//! top-level field set exactly like the product's typed decode.

use serde_json::{json, Map, Value};

/// V1-only top-level keys, from `packages/core/src/v1/config/migrate.ts`.
const V1_KEYS: &[&str] = &[
    "logLevel",
    "server",
    "command",
    "reference",
    "snapshot",
    "plugin",
    "autoshare",
    "disabled_providers",
    "enabled_providers",
    "small_model",
    "mode",
    "agent",
    "provider",
    "permission",
    "tools",
    "attachment",
    "layout",
];

/// The V2 `Config.Info` top-level field set from `packages/schema/src/config.ts`.
/// The product's typed decode drops unknown keys, so the normalized surface
/// does too.
const V2_KEYS: &[&str] = &[
    "$schema",
    "shell",
    "model",
    "engine",
    "default_agent",
    "autoupdate",
    "share",
    "enterprise",
    "username",
    "permissions",
    "disabled_tools",
    "accounts",
    "agents",
    "snapshots",
    "watcher",
    "formatter",
    "linter",
    "tools",
    "lsp",
    "attachments",
    "tool_output",
    "hooks",
    "mcp",
    "compaction",
    "cache",
    "loop",
    "cost",
    "sandbox",
    "skills",
    "commands",
    "instructions",
    "references",
    "plugins",
    "experimental",
    "providers",
];

/// A document carrying any V1 key, or a keyed `mcp` map, is V1 and migrates.
pub fn is_v1(input: &Value) -> bool {
    let Some(map) = input.as_object() else {
        return false;
    };
    map.keys().any(|key| V1_KEYS.contains(&key.as_str())) || is_v1_mcp(map.get("mcp"))
}

/// Both shapes have `mcp`: V2 nests servers under `servers`. A document whose
/// only V1 field is keyed MCP servers would otherwise decode as V2 and lose
/// them.
fn is_v1_mcp(mcp: Option<&Value>) -> bool {
    let Some(map) = mcp.and_then(Value::as_object) else {
        return false;
    };
    map.keys().any(|key| key != "servers" && key != "timeout")
}

/// Drop top-level keys the V2 `Info` schema does not know. The product's typed
/// decode ignores excess properties, so they are absent from the normalized
/// surface on the TypeScript side as well.
pub fn normalize(input: &Value) -> Value {
    let Some(map) = input.as_object() else {
        return input.clone();
    };
    let mut out = Map::new();
    for (key, value) in map {
        if V2_KEYS.contains(&key.as_str()) {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

/// Migrate one V1 document to the V2 shape. Value-level port of
/// `ConfigMigrateV1.migrate`; fields absent from the input stay absent from
/// the output.
pub fn migrate(input: &Value) -> Value {
    let map = input.as_object().cloned().unwrap_or_default();
    let mut out = Map::new();
    for key in [
        "$schema",
        "shell",
        "model",
        "default_agent",
        "autoupdate",
        "enterprise",
        "username",
        "watcher",
        "formatter",
        "lsp",
        "tool_output",
        "sandbox",
        "instructions",
    ] {
        if let Some(value) = map.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    if let Some(share) = map
        .get("share")
        .cloned()
        .or_else(|| matches!(map.get("autoshare"), Some(Value::Bool(true))).then(|| json!("auto")))
    {
        out.insert("share".into(), share);
    }
    if let Some(rules) = permissions(map.get("permission"), map.get("tools")) {
        out.insert("permissions".into(), rules);
    }
    if let Some(agents) = agents(&map) {
        out.insert("agents".into(), agents);
    }
    for (from, to) in [("snapshot", "snapshots"), ("attachment", "attachments")] {
        if let Some(value) = map.get(from) {
            out.insert(to.to_string(), value.clone());
        }
    }
    if let Some(mcp) = mcp_section(&map) {
        out.insert("mcp".into(), mcp);
    }
    if let Some(compaction) = map
        .get("compaction")
        .and_then(|value| compaction(Some(value)))
    {
        out.insert("compaction".into(), compaction);
    }
    if let Some(skills) = skills(&map) {
        out.insert("skills".into(), skills);
    }
    if let Some(commands) = map.get("command") {
        out.insert("commands".into(), commands.clone());
    }
    if let Some(references) = map.get("references").or_else(|| map.get("reference")) {
        out.insert("references".into(), references.clone());
    }
    if let Some(plugins) = plugins(&map) {
        out.insert("plugins".into(), plugins);
    }
    if let Some(experimental) = experimental(&map) {
        out.insert("experimental".into(), experimental);
    }
    if let Some(providers) = providers(map.get("provider"), map.get("disabled_providers")) {
        out.insert("providers".into(), providers);
    }
    Value::Object(out)
}

fn permissions(permission: Option<&Value>, tools: Option<&Value>) -> Option<Value> {
    let mut rules = Vec::new();
    if let Some(Value::Object(tools)) = tools {
        for (action, enabled) in tools {
            let effect = if is_truthy(enabled) { "allow" } else { "deny" };
            rules.push(
                json!({ "action": normalize_action(action), "resource": "*", "effect": effect }),
            );
        }
    }
    if let Some(Value::Object(permission)) = permission {
        for (action, rule) in permission {
            if is_null(rule) {
                continue;
            }
            if let Some(effect) = rule.as_str() {
                rules.push(json!({ "action": action, "resource": "*", "effect": effect }));
                continue;
            }
            if let Value::Object(entries) = rule {
                for (resource, effect) in entries {
                    rules.push(json!({ "action": action, "resource": resource, "effect": effect }));
                }
            }
        }
    }
    if rules.is_empty() {
        None
    } else {
        Some(Value::Array(rules))
    }
}

fn normalize_action(action: &str) -> &str {
    if action == "write" || action == "patch" {
        "edit"
    } else {
        action
    }
}

fn agents(map: &Map<String, Value>) -> Option<Value> {
    let mut entries = Vec::new();
    if let Some(Value::Object(agent)) = map.get("agent") {
        for (name, value) in agent {
            if !is_null(value) {
                entries.push((name.clone(), migrate_agent(value)));
            }
        }
    }
    if let Some(Value::Object(mode)) = map.get("mode") {
        for (name, value) in mode {
            if let Value::Object(object) = value {
                let mut with_mode = object.clone();
                with_mode.insert("mode".into(), Value::String("primary".into()));
                entries.push((name.clone(), migrate_agent(&Value::Object(with_mode))));
            }
        }
    }
    if entries.is_empty() {
        return None;
    }
    let mut out = Map::new();
    for (name, agent) in entries {
        out.insert(name, agent);
    }
    Some(Value::Object(out))
}

fn migrate_agent(info: &Value) -> Value {
    let map = info.as_object().cloned().unwrap_or_default();
    let mut body = map
        .get("options")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(temperature) = map.get("temperature") {
        body.insert("temperature".into(), temperature.clone());
    }
    if let Some(top_p) = map.get("top_p") {
        body.insert("top_p".into(), top_p.clone());
    }
    let mut out = Map::new();
    for (to, from) in [
        ("model", "model"),
        ("variant", "variant"),
        ("system", "prompt"),
        ("description", "description"),
        ("mode", "mode"),
        ("hidden", "hidden"),
        ("color", "color"),
        ("steps", "steps"),
        ("budget", "budget"),
        ("disabled", "disable"),
    ] {
        if let Some(value) = map.get(from) {
            out.insert(to.to_string(), value.clone());
        }
    }
    if !body.is_empty() {
        out.insert("request".into(), json!({ "body": Value::Object(body) }));
    }
    if let Some(rules) = permissions(map.get("permission"), None) {
        out.insert("permissions".into(), rules);
    }
    Value::Object(out)
}

fn mcp_section(map: &Map<String, Value>) -> Option<Value> {
    let mut servers = Map::new();
    if let Some(Value::Object(mcp)) = map.get("mcp") {
        for (name, server) in mcp {
            if server.get("type").is_some() {
                servers.insert(name.clone(), migrate_mcp(server));
            }
        }
    }
    let timeout = map
        .get("experimental")
        .and_then(|experimental| experimental.get("mcp_timeout"));
    if timeout.is_none() && servers.is_empty() {
        return None;
    }
    let mut out = Map::new();
    if let Some(timeout) = timeout {
        out.insert("timeout".into(), json!({ "request": timeout }));
    }
    out.insert("servers".into(), Value::Object(servers));
    Some(Value::Object(out))
}

fn migrate_mcp(server: &Value) -> Value {
    let map = server.as_object().cloned().unwrap_or_default();
    let disabled = map
        .get("enabled")
        .map(|enabled| Value::Bool(!enabled.as_bool().unwrap_or(false)));
    let is_local = map.get("type").and_then(Value::as_str) == Some("local");
    let mut out = Map::new();
    let passthrough = if is_local {
        ["type", "command", "cwd", "environment"].as_slice()
    } else {
        ["type", "url", "headers"].as_slice()
    };
    for &key in passthrough {
        if let Some(value) = map.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    if !is_local {
        if let Some(Value::Object(oauth)) = map.get("oauth") {
            let mut migrated_oauth = Map::new();
            for (to, from) in [
                ("client_id", "clientId"),
                ("client_secret", "clientSecret"),
                ("scope", "scope"),
                ("callback_port", "callbackPort"),
                ("redirect_uri", "redirectUri"),
            ] {
                if let Some(value) = oauth.get(from) {
                    migrated_oauth.insert(to.to_string(), value.clone());
                }
            }
            out.insert("oauth".into(), Value::Object(migrated_oauth));
        }
    }
    if let Some(disabled) = disabled {
        out.insert("disabled".into(), disabled);
    }
    if let Some(timeout) = map.get("timeout") {
        out.insert("timeout".into(), json!({ "request": timeout }));
    }
    Value::Object(out)
}

fn compaction(value: Option<&Value>) -> Option<Value> {
    let map = value?.as_object()?;
    let mut out = Map::new();
    if let Some(auto) = map.get("auto") {
        out.insert("auto".into(), auto.clone());
    }
    if let Some(prune) = map.get("prune") {
        out.insert("prune".into(), prune.clone());
    }
    let mut keep = Map::new();
    if let Some(tokens) = map.get("preserve_recent_tokens") {
        keep.insert("tokens".into(), tokens.clone());
    }
    if !keep.is_empty() {
        out.insert("keep".into(), Value::Object(keep));
    }
    if let Some(buffer) = map.get("reserved") {
        out.insert("buffer".into(), buffer.clone());
    }
    Some(Value::Object(out))
}

fn skills(map: &Map<String, Value>) -> Option<Value> {
    let object = map.get("skills")?.as_object()?;
    let mut all = Vec::new();
    if let Some(Value::Array(paths)) = object.get("paths") {
        all.extend(paths.clone());
    }
    if let Some(Value::Array(urls)) = object.get("urls") {
        all.extend(urls.clone());
    }
    Some(Value::Array(all))
}

fn plugins(map: &Map<String, Value>) -> Option<Value> {
    let Value::Array(list) = map.get("plugin")? else {
        return None;
    };
    let mut out = Vec::new();
    for entry in list {
        match entry {
            Value::String(name) => out.push(Value::String(name.clone())),
            Value::Array(pair) => out.push(json!({
                "package": pair.first().cloned().unwrap_or(Value::Null),
                "options": pair.get(1).cloned().unwrap_or(Value::Null),
            })),
            _ => {}
        }
    }
    Some(Value::Array(out))
}

fn experimental(map: &Map<String, Value>) -> Option<Value> {
    let experimental = map.get("experimental")?.as_object()?;
    let policies = experimental.get("policies");
    let disable_paste_summary = experimental.get("disable_paste_summary");
    if policies.is_none() && disable_paste_summary.is_none() {
        return None;
    }
    let mut out = Map::new();
    if let Some(policies) = policies {
        out.insert("policies".into(), policies.clone());
    }
    if let Some(disable_paste_summary) = disable_paste_summary {
        out.insert(
            "disable_paste_summary".into(),
            disable_paste_summary.clone(),
        );
    }
    Some(Value::Object(out))
}

fn providers(provider: Option<&Value>, disabled: Option<&Value>) -> Option<Value> {
    let has_disabled =
        disabled.is_some_and(|value| value.as_array().is_some_and(|list| !list.is_empty()));
    let migrated = match provider.and_then(Value::as_object) {
        Some(map) if !map.is_empty() => {
            let mut migrated = Map::new();
            for (name, entry) in map {
                migrated.insert(name.clone(), migrate_provider(entry));
            }
            migrated
        }
        _ if has_disabled => Map::new(),
        _ => return None,
    };
    let mut out = migrated;
    if let Some(Value::Array(names)) = disabled {
        for name in names {
            if let Some(name) = name.as_str() {
                let entry = out.get(name).cloned().unwrap_or_else(|| json!({}));
                let Value::Object(mut object) = entry else {
                    continue;
                };
                object.insert("disabled".into(), Value::Bool(true));
                out.insert(name.to_string(), Value::Object(object));
            }
        }
    }
    Some(Value::Object(out))
}

fn migrate_provider(info: &Value) -> Value {
    let map = info.as_object().cloned().unwrap_or_default();
    let npm = map.get("npm").and_then(Value::as_str);
    let options = map.get("options").cloned().unwrap_or_else(|| json!({}));
    let lowered = lowerer_provider(npm, options.as_object().unwrap_or(&Map::new()));
    let url = map.get("api").cloned().or_else(|| lowered.url.clone());
    let mut out = Map::new();
    if let Some(name) = map.get("name") {
        out.insert("name".into(), name.clone());
    }
    if let Some(env) = map.get("env") {
        out.insert("env".into(), env.clone());
    }
    if let Some(npm) = npm {
        let mut api = Map::new();
        api.insert("type".into(), Value::String("aisdk".into()));
        api.insert("package".into(), Value::String(npm.to_string()));
        if let Some(url) = url {
            api.insert("url".into(), url);
        }
        api.insert(
            "settings".into(),
            lowered.settings.clone().unwrap_or_else(|| json!({})),
        );
        out.insert("api".into(), Value::Object(api));
    }
    if map.get("options").is_some() {
        let mut request = Map::new();
        if let Some(headers) = lowered.headers {
            request.insert("headers".into(), headers);
        }
        if let Some(body) = lowered.body {
            request.insert("body".into(), body);
        }
        out.insert("request".into(), Value::Object(request));
    }
    if let Some(Value::Object(models)) = map.get("models") {
        let mut migrated_models = Map::new();
        for (name, model) in models {
            migrated_models.insert(name.clone(), migrate_model(model, npm));
        }
        out.insert("models".into(), Value::Object(migrated_models));
    }
    Value::Object(out)
}

fn migrate_model(info: &Value, package_name: Option<&str>) -> Value {
    let map = info.as_object().cloned().unwrap_or_default();
    let provider_npm = map
        .get("provider")
        .and_then(|provider| provider.get("npm"))
        .and_then(Value::as_str);
    let package_id = provider_npm.or(package_name);
    let mut out = Map::new();
    if let Some(family) = map.get("family") {
        out.insert("family".into(), family.clone());
    }
    if let Some(name) = map.get("name") {
        out.insert("name".into(), name.clone());
    }
    if let Some(npm) = provider_npm {
        let mut api = Map::new();
        if let Some(id) = map.get("id") {
            api.insert("id".into(), id.clone());
        }
        api.insert("type".into(), Value::String("aisdk".into()));
        api.insert("package".into(), Value::String(npm.to_string()));
        if let Some(url) = map.get("provider").and_then(|provider| provider.get("api")) {
            api.insert("url".into(), url.clone());
        }
        api.insert("settings".into(), json!({}));
        out.insert("api".into(), Value::Object(api));
    } else if let Some(id) = map.get("id") {
        out.insert("api".into(), json!({ "id": id }));
    }
    let tool_call = map.get("tool_call");
    let modalities = map.get("modalities");
    let has_capabilities = tool_call.is_some()
        || modalities
            .and_then(|modalities| modalities.get("input"))
            .is_some()
        || modalities
            .and_then(|modalities| modalities.get("output"))
            .is_some();
    if has_capabilities {
        out.insert(
            "capabilities".into(),
            json!({
                "tools": tool_call.cloned().unwrap_or(Value::Bool(false)),
                "input": modalities.and_then(|modalities| modalities.get("input")).cloned().unwrap_or_else(|| json!([])),
                "output": modalities.and_then(|modalities| modalities.get("output")).cloned().unwrap_or_else(|| json!([])),
            }),
        );
    }
    let lowered_request = map
        .get("options")
        .filter(|options| !is_null(options))
        .map(|options| lowerer_request(package_id, options));
    let headers = map.get("headers");
    if headers.is_some() || lowered_request.is_some() {
        let mut request = Map::new();
        if let Some(headers) = headers {
            request.insert("headers".into(), headers.clone());
        }
        if let Some(body) = lowered_request {
            request.insert("body".into(), body);
        }
        out.insert("request".into(), Value::Object(request));
    }
    if let Some(Value::Object(variants)) = map.get("variants") {
        let migrated_variants: Vec<Value> = variants
            .iter()
            .map(|(id, options)| json!({ "id": id, "body": lowerer_request(package_id, options) }))
            .collect();
        out.insert("variants".into(), Value::Array(migrated_variants));
    }
    if let Some(cost) = map.get("cost").and_then(Value::as_object) {
        let mut costs = Vec::new();
        costs.push(json!({
            "input": cost.get("input").cloned().unwrap_or(Value::Null),
            "output": cost.get("output").cloned().unwrap_or(Value::Null),
            "cache": {
                "read": cost.get("cache_read").cloned().unwrap_or(Value::Null),
                "write": cost.get("cache_write").cloned().unwrap_or(Value::Null),
            },
        }));
        if let Some(over_200k) = cost.get("context_over_200k") {
            costs.push(json!({
                "tier": { "type": "context", "size": 200_000 },
                "input": over_200k.get("input").cloned().unwrap_or(Value::Null),
                "output": over_200k.get("output").cloned().unwrap_or(Value::Null),
                "cache": {
                    "read": over_200k.get("cache_read").cloned().unwrap_or(Value::Null),
                    "write": over_200k.get("cache_write").cloned().unwrap_or(Value::Null),
                },
            }));
        }
        out.insert("cost".into(), Value::Array(costs));
    }
    if map.get("status").and_then(Value::as_str) == Some("deprecated") {
        out.insert("disabled".into(), Value::Bool(true));
    }
    if let Some(limit) = map.get("limit").and_then(Value::as_object) {
        let mut migrated_limit = Map::new();
        if let Some(context) = limit.get("context") {
            migrated_limit.insert("context".into(), int(context));
        }
        if let Some(input) = limit.get("input") {
            migrated_limit.insert("input".into(), int(input));
        }
        if let Some(output) = limit.get("output") {
            migrated_limit.insert("output".into(), int(output));
        }
        out.insert("limit".into(), Value::Object(migrated_limit));
    }
    Value::Object(out)
}

fn int(value: &Value) -> Value {
    let Some(number) = value.as_f64() else {
        return value.clone();
    };
    let clamped = number
        .trunc()
        .clamp(-9_007_199_254_740_992.0, 9_007_199_254_740_992.0);
    json!(clamped as i64)
}

struct ProviderResult {
    url: Option<Value>,
    headers: Option<Value>,
    body: Option<Value>,
    settings: Option<Value>,
}

fn lowerer_provider(package: Option<&str>, options: &Map<String, Value>) -> ProviderResult {
    match package {
        Some("@ai-sdk/openai") => {
            let mut headers = Map::new();
            if let Some(key) = bearer(options.get("apiKey")) {
                headers.insert("Authorization".into(), Value::String(key));
            }
            if let Some(organization) = string(options.get("organization")) {
                headers.insert("OpenAI-Organization".into(), Value::String(organization));
            }
            if let Some(project) = string(options.get("project")) {
                headers.insert("OpenAI-Project".into(), Value::String(project));
            }
            if let Some(Value::Object(extra)) = options.get("headers") {
                for (key, value) in extra {
                    if let Some(text) = value.as_str() {
                        headers.insert(key.clone(), Value::String(text.to_string()));
                    }
                }
            }
            ProviderResult {
                url: string(options.get("baseURL")).map(Value::String),
                headers: compact_strings(headers),
                body: body_value(options.get("body")),
                settings: Some(omit(
                    options,
                    &[
                        "apiKey",
                        "baseURL",
                        "organization",
                        "project",
                        "headers",
                        "body",
                    ],
                )),
            }
        }
        Some("@ai-sdk/anthropic") | Some("@ai-sdk/google-vertex/anthropic") => {
            let mut headers = Map::new();
            if let Some(key) = string(options.get("apiKey")) {
                headers.insert("x-api-key".into(), Value::String(key));
            }
            if let Some(token) = string(options.get("authToken")) {
                headers.insert(
                    "Authorization".into(),
                    Value::String(format!("Bearer {token}")),
                );
            }
            if let Some(Value::Object(extra)) = options.get("headers") {
                for (key, value) in extra {
                    if let Some(text) = value.as_str() {
                        headers.insert(key.clone(), Value::String(text.to_string()));
                    }
                }
            }
            ProviderResult {
                url: string(options.get("baseURL")).map(Value::String),
                headers: compact_strings(headers),
                body: body_value(options.get("body")),
                settings: Some(omit(
                    options,
                    &["apiKey", "authToken", "baseURL", "headers", "body"],
                )),
            }
        }
        Some("@ai-sdk/google") | Some("@ai-sdk/google-vertex") => {
            let mut headers = Map::new();
            if let Some(key) = string(options.get("apiKey")) {
                headers.insert("x-goog-api-key".into(), Value::String(key));
            }
            if let Some(Value::Object(extra)) = options.get("headers") {
                for (key, value) in extra {
                    if let Some(text) = value.as_str() {
                        headers.insert(key.clone(), Value::String(text.to_string()));
                    }
                }
            }
            ProviderResult {
                url: string(options.get("baseURL")).map(Value::String),
                headers: compact_strings(headers),
                body: body_value(options.get("body")),
                settings: Some(omit(options, &["apiKey", "baseURL", "headers", "body"])),
            }
        }
        Some("@ai-sdk/azure") => {
            let mut headers = Map::new();
            if let Some(key) = string(options.get("apiKey")) {
                headers.insert("api-key".into(), Value::String(key));
            }
            if let Some(Value::Object(extra)) = options.get("headers") {
                for (key, value) in extra {
                    if let Some(text) = value.as_str() {
                        headers.insert(key.clone(), Value::String(text.to_string()));
                    }
                }
            }
            ProviderResult {
                url: string(options.get("baseURL")).map(Value::String),
                headers: compact_strings(headers),
                body: body_value(options.get("body")),
                settings: Some(omit(options, &["apiKey", "baseURL", "headers", "body"])),
            }
        }
        Some("@ai-sdk/amazon-bedrock") => ProviderResult {
            url: None,
            headers: headers_value(options.get("headers")),
            body: body_value(options.get("body")),
            settings: Some(omit(options, &["headers", "body"])),
        },
        package if is_openai_compatible(package) => ProviderResult {
            url: string(options.get("baseURL")).map(Value::String),
            headers: headers_value(options.get("headers")),
            body: body_value(options.get("body")),
            settings: Some(omit(options, &["headers", "body", "baseURL"])),
        },
        _ => ProviderResult {
            url: None,
            headers: None,
            body: Some(Value::Object(options.clone())),
            settings: None,
        },
    }
}

fn is_openai_compatible(package: Option<&str>) -> bool {
    matches!(
        package,
        Some("@ai-sdk/openai-compatible")
            | Some("@ai-sdk/cerebras")
            | Some("@ai-sdk/deepinfra")
            | Some("@ai-sdk/groq")
            | Some("@ai-sdk/mistral")
            | Some("@ai-sdk/togetherai")
            | Some("@ai-sdk/xai")
            | Some("@openrouter/ai-sdk-provider")
            | Some("venice-ai-sdk-provider")
    )
}

fn lowerer_request(package: Option<&str>, options: &Value) -> Value {
    match package {
        Some("@ai-sdk/openai") => {
            let mut result = snake(options);
            if let Some(object) = result.as_object_mut() {
                let effort = options.get("reasoningEffort").cloned();
                let summary = options.get("reasoningSummary").cloned();
                if effort.is_some() || summary.is_some() {
                    let mut reasoning = object
                        .get("reasoning")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(effort) = effort {
                        reasoning.insert("effort".into(), effort);
                    }
                    if let Some(summary) = summary {
                        reasoning.insert("summary".into(), summary);
                    }
                    object.insert("reasoning".into(), Value::Object(reasoning));
                    object.remove("reasoning_effort");
                    object.remove("reasoning_summary");
                }
                if let Some(verbosity) = options.get("textVerbosity").cloned() {
                    let mut text = object
                        .get("text")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    text.insert("verbosity".into(), verbosity);
                    object.insert("text".into(), Value::Object(text));
                    object.remove("text_verbosity");
                }
            }
            result
        }
        Some("@ai-sdk/anthropic") | Some("@ai-sdk/google-vertex/anthropic") => {
            let mut result = snake(options);
            if let Some(object) = result.as_object_mut() {
                let effort = options.get("effort").cloned();
                let task_budget = options.get("taskBudget").cloned();
                if effort.is_some() || task_budget.is_some() {
                    let mut output_config = Map::new();
                    if let Some(effort) = effort {
                        output_config.insert("effort".into(), effort);
                    }
                    if let Some(task_budget) = task_budget {
                        output_config.insert("task_budget".into(), task_budget);
                    }
                    object.insert("output_config".into(), Value::Object(output_config));
                    object.remove("effort");
                    object.remove("task_budget");
                }
                if let Some(Value::Object(metadata)) = options.get("metadata") {
                    if let Some(user_id) = metadata.get("userId") {
                        let mut migrated_metadata = object
                            .get("metadata")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        migrated_metadata.insert("user_id".into(), user_id.clone());
                        object.insert("metadata".into(), Value::Object(migrated_metadata));
                    }
                }
            }
            result
        }
        Some("@ai-sdk/google") | Some("@ai-sdk/google-vertex") => {
            let picked = [
                "thinkingConfig",
                "responseModalities",
                "mediaResolution",
                "imageConfig",
            ];
            let mut generation_config = Map::new();
            let mut result = Map::new();
            if let Some(object) = options.as_object() {
                for (key, value) in object {
                    if !picked.contains(&key.as_str()) {
                        result.insert(key.clone(), value.clone());
                    }
                }
            }
            for key in picked {
                if let Some(value) = options.get(key) {
                    generation_config.insert(key.to_string(), value.clone());
                }
            }
            if !generation_config.is_empty() {
                result.insert("generationConfig".into(), Value::Object(generation_config));
            }
            Value::Object(result)
        }
        Some("@ai-sdk/amazon-bedrock") => json!({ "additionalModelRequestFields": options }),
        package if is_openai_compatible(package) => {
            let mut result = options.as_object().cloned().unwrap_or_default();
            if let Some(effort) = options.get("reasoningEffort") {
                result.insert("reasoning_effort".into(), effort.clone());
                result.remove("reasoningEffort");
            }
            Value::Object(result)
        }
        _ => options.clone(),
    }
}

fn is_null(value: &Value) -> bool {
    matches!(value, Value::Null)
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(list) => !list.is_empty(),
        Value::Object(object) => !object.is_empty(),
    }
}

fn string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn bearer(value: Option<&Value>) -> Option<String> {
    string(value).map(|text| format!("Bearer {text}"))
}

fn headers_value(input: Option<&Value>) -> Option<Value> {
    let map = input?.as_object()?;
    let mut out = Map::new();
    for (key, value) in map {
        if let Some(text) = value.as_str() {
            out.insert(key.clone(), Value::String(text.to_string()));
        }
    }
    Some(Value::Object(out))
}

fn body_value(input: Option<&Value>) -> Option<Value> {
    input
        .and_then(Value::as_object)
        .map(|map| Value::Object(map.clone()))
}

fn compact_strings(map: Map<String, Value>) -> Option<Value> {
    if map.is_empty() {
        None
    } else {
        Some(Value::Object(map))
    }
}

fn omit(options: &Map<String, Value>, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for (key, value) in options {
        if !keys.contains(&key.as_str()) {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

fn snake(options: &Value) -> Value {
    match options {
        Value::Array(list) => Value::Array(list.iter().map(snake).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, value) in map {
                out.insert(snake_key(key), snake(value));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn snake_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for character in key.chars() {
        if character.is_ascii_uppercase() {
            out.push('_');
            out.push(character.to_ascii_lowercase());
        } else {
            out.push(character);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_v1_document_is_detected_by_its_keys() {
        assert!(is_v1(&json!({ "snapshot": false })));
        assert!(is_v1(&json!({ "snapshot": false, "agents": {} })));
        assert!(is_v1(&json!({ "provider": {} })));
        assert!(!is_v1(
            &json!({ "shell": "/bin/zsh", "model": "anthropic/claude" })
        ));
        assert!(!is_v1(&json!({ "references": {} })));
    }

    #[test]
    fn keyed_mcp_maps_make_a_document_v1() {
        assert!(is_v1(
            &json!({ "mcp": { "github": { "type": "remote", "url": "https://example.com/mcp" } } })
        ));
        assert!(!is_v1(
            &json!({ "mcp": { "servers": {}, "timeout": { "request": 1000 } } })
        ));
    }

    #[test]
    fn v1_tools_and_permission_become_permission_rules() {
        let migrated = migrate(&json!({
            "tools": { "bash": true, "write": false },
            "permission": { "edit": "ask" }
        }));
        assert_eq!(
            migrated["permissions"],
            json!([
                { "action": "bash", "resource": "*", "effect": "allow" },
                { "action": "edit", "resource": "*", "effect": "deny" },
                { "action": "edit", "resource": "*", "effect": "ask" }
            ])
        );
    }

    #[test]
    fn v1_compaction_maps_onto_the_v2_shape() {
        let migrated = migrate(&json!({
            "compaction": { "auto": true, "preserve_recent_tokens": 4000, "reserved": 20000 }
        }));
        assert_eq!(
            migrated["compaction"],
            json!({ "auto": true, "keep": { "tokens": 4000 }, "buffer": 20000 })
        );
    }

    #[test]
    fn v1_providers_migrate_through_the_package_lowerer() {
        let migrated = migrate(&json!({
            "provider": { "openai": { "name": "OpenAI", "npm": "@ai-sdk/openai", "options": { "apiKey": "sk" } } },
            "disabled_providers": ["openai"]
        }));
        let provider = &migrated["providers"]["openai"];
        assert_eq!(provider["disabled"], json!(true));
        assert_eq!(provider["api"]["type"], "aisdk");
        assert_eq!(provider["api"]["package"], "@ai-sdk/openai");
        assert_eq!(provider["api"]["settings"], json!({}));
        // `models: info.models && ...` keeps the key absent when the V1
        // provider declared no models.
        assert!(provider.get("models").is_none());
    }

    #[test]
    fn unknown_v2_keys_are_absent_from_the_normalized_surface() {
        let normalized = normalize(&json!({ "model": "anthropic/claude", "mystery": true }));
        assert_eq!(normalized, json!({ "model": "anthropic/claude" }));
    }

    #[test]
    fn autoshare_becomes_auto_share_when_no_share_is_set() {
        assert_eq!(
            migrate(&json!({ "autoshare": true }))["share"],
            json!("auto")
        );
        assert_eq!(
            migrate(&json!({ "autoshare": true, "share": "manual" }))["share"],
            json!("manual")
        );
    }
}
