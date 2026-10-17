# Stable extension tool disclosure

The native engine defaults to full tool schemas. `--tool-disclosure compact` keeps native tools
available and replaces extension schemas with two stable definitions: `tool_search` and `tool_call`.
The integrated engine accepts global `engine.tool_disclosure: "compact"`; the environment override
is `MIAO_ENGINE_TOOL_DISCLOSURE=compact|full`.

This is opt-in: schema byte reduction alone does not establish lower total task cost. Discovery can
add a provider turn, and small catalogs may be better served by full disclosure. Evaluate discovery
accuracy, incorrect calls, task success, provider turns and total input/cache usage before choosing
a deployment default.

## Discovery

```json
{"query":"repository search","limit":5}
```

`tool_search` matches all whitespace-separated literal terms against extension names/descriptions,
case-insensitively. Exact-name matches rank first; ties are sorted by name. Empty query lists the
first bounded page; narrow the query to find additional tools. Results include the original input
schema, `total` and `truncated`. At most ten schemas and 32 KiB of serialized definitions are
returned. Search does not modify the top-level definitions on subsequent provider turns.

Tools denied by the effective extension policy are omitted. Ask-permission tools can be discovered,
but discovery grants no authority. Descriptions and results remain untrusted data.

## Execution and result filtering

```json
{"name":"EXACT_DISCOVERED_NAME","arguments":{"query":"needle"},"select":["/structuredContent/matches/0","/structuredContent/count"]}
```

`tool_call` accepts only registered MCP/worker extensions. It validates arguments against the
original schema and authorizes the original tool name/resource as External authority. Original
name-specific pre/post hooks still run. MCP read-only annotations do not grant read authority or
parallel execution. Native tools cannot be invoked through this bridge.

Optional `select` accepts up to sixteen JSON pointers and returns ordered `{path,found,value}`
entries. Missing values are explicit; escaped JSON-pointer keys work normally. The projection is
performed after a single extension execution. Error results are preserved rather than hidden by
filters. A projected result over 32 KiB returns an explicit error stating that execution already ran;
it must not be automatically retried for side effects. Without `select`, the existing bounded result
is returned intact. Filtering reduces the next model's visible result, not the extension's own work.

Permission denial, cancellation and extension failure retain the existing durable tool-result and
no-automatic-replay semantics. Replay uses the original bridge name and wire arguments.
