# Product-owned native host configuration

The product forwards native host configuration through the same client used by
native Session owners. Global `engine.mcp_config` and `engine.lsp_config` paths
resolve relative to the global configuration directory. Environment overrides
`MIAO_ENGINE_MCP_CONFIG` and `MIAO_ENGINE_LSP_CONFIG` resolve from the product's
working directory and take precedence.

```json
{
  "engine": {
    "model": "your-model",
    "mcp_config": "native-mcp.json",
    "lsp_config": "native-lsp.json"
  }
}
```

Explicit native MCP manifests contain an array of `{ "name", "argv", "env" }`
records. Native LSP manifests additionally describe supported file extensions.
Both files must be outside the model-writable workspace; native startup checks
that boundary.

Global `mcp.servers` local entries can also attach automatically when the
operator's native policy explicitly has `mode: "workspace"` and
`allow_mcp: true`. Disabled servers are skipped. Supported shared fields are
`type: "local"`, `command`, `environment`, and `disabled`. Enabled remote
transports, `cwd`, `call_meta`, and custom timeout settings currently return an
unsupported-configuration error, preserving their meaning rather than silently
omitting them.

```json
{
  "mcp": {
    "servers": {
      "example": {
        "type": "local",
        "command": ["node", "/path/to/server.js"],
        "environment": { "EXAMPLE_MODE": "local" }
      }
    }
  }
}
```

Only the global documents feed this mapping; project documents cannot choose
native host programs. Each owner materializes a private `0600` manifest outside
the workspace, retains it for its child lifetime and removes it on exit or
startup failure. An explicit MCP manifest overrides shared settings. Attachment
does not grant individual tool calls: the native policy's tool decisions still
apply. Configuration is captured at owner startup; restart the owner after
changing it.
