# Providers and models

[简体中文](providers.zh.md)

miao brings its own model layer but not its own model: you connect the
providers you already use, switch models inside a session, and give different
agents different models. It runs locally with no miao or OpenCode account —
credentials go straight to the provider.

## Connect a provider

```bash
miao providers login     # choose a provider, then OAuth or an API key
miao providers list      # what is connected
miao providers logout    # remove stored credentials
```

`miao auth login <provider>` is the same command. `miao providers login`
without a name lists what your build knows and prompts; with a name it goes
straight to that provider (for example `miao auth login commandcode`).
Credentials are written to `auth.json`, which is shared across the
`miao` / `miao-dev` / `miao-preview` entry points, so you log in once.

Some providers offer an OAuth flow (the terminal prints a URL, or opens the
browser, and waits for the callback); others take an API key. A provider that
has a key in the environment is also picked up without `login`.

## List and select models

```bash
miao models                     # every provider/model your build knows
miao models anthropic           # filter to one provider
miao models --verbose           # include metadata such as costs
miao models --refresh           # refresh the catalog from mtty.dev first
```

Inside the TUI, `/model` or `ctrl+x m` switches the model; the last model used
per agent is remembered. A session without a chosen model uses the `model`
setting, written as `<provider>/<model>`:

```jsonc
{
  "$schema": "https://mtty.dev/miao/config.json",
  "model": "anthropic/claude-sonnet-4-5",
}
```

Specialist agents can carry their own model and permissions; see the
[guide](guide.en.md#4-configuration).

## Where the catalog comes from

Model metadata (names, context limits, capabilities, pricing) comes from
miao's own catalog served at `mtty.dev`: the public [models.dev](https://models.dev)
catalog with the provider miao maintains that models.dev does not list —
currently [Command Code](https://commandcode.ai) — merged in when the site
deploys. miao reads only this source; there is no models.dev fallback at
runtime. A snapshot is bundled into the build, so startup works offline.

You can point this at a different source:

| Variable | What it does |
|---|---|
| `MIAO_MODELS_URL` | Fetch the catalog from another URL |
| `MIAO_MODELS_PATH` | Use an exact local catalog file |

[Command Code](https://commandcode.ai) is a subscription provider: connect it
with `miao auth login commandcode` (browser-assisted) or set `CMD_API_KEY`; its
models are discovered from your account when it connects. OpenCode Zen / Go
remain available as optional third-party providers.

## Custom providers

The `providers` record in `miao.jsonc` adds or overrides a provider: its
credentials, wire protocol (`api`), extra request headers or body, model list,
and native-currency cost.

```jsonc
{
  "$schema": "https://mtty.dev/miao/config.json",
  "providers": {
    "my-gateway": {
      "name": "My gateway",
      "env": ["MY_GATEWAY_API_KEY"],
      "currency": "USD",
      "models": {
        "llama-3.3-70b": {
          "name": "Llama 3.3 70B",
          "cost": { "input": 0.2, "output": 0.6 },
          "limit": { "context": 131072 },
        },
      },
    },
  },
}
```

`env` names the environment variables the provider reads its key from;
`disabled` hides a provider and its models even when credentials exist. The
`api` field selects the wire protocol, and the whole file is validated against
`$schema`. After editing, run `miao models` to confirm what the provider now
reports.

## Cost and currency

Each provider turn records usage, time to first token, cache-hit data and an
estimated cost; session totals appear in the sidebar. Costs are estimates from
the model's declared rates — your provider's invoice is authoritative.

Pricing may be declared in the provider's own currency (for example DeepSeek in
CNY). `/currency` in the TUI switches the display currency; entries without a
declared currency use a static conversion to USD.

## Provider policy (experimental)

The `experimental.policies` list can deny use of a provider even when it is
configured and authenticated. Rules are matched in order and the **last match
wins**. The supported action is `provider.use`; `resource` accepts wildcard patterns:

```jsonc
{
  "experimental": {
    "policies": [
      { "effect": "deny",  "action": "provider.use", "resource": "company-*" },
      { "effect": "allow", "action": "provider.use", "resource": "company-eu" },
    ],
  },
}
```

## Troubleshooting

- `miao debug config` shows resolved configuration; `miao debug info` shows installation and plugin information. `miao debug` lists the available subcommands.
- An authentication error names the fix, usually `miao auth login <provider>`;
  re-run `miao providers login` if the stored token expired.
- A provider that shows no models is usually missing credentials or disabled by
  policy; `miao models <provider> --verbose` shows what was resolved.

See the [guide](guide.en.md) for configuration precedence and the
[agent workflow comparison](agent-comparison.en.md) for how the provider layer
evolved.
