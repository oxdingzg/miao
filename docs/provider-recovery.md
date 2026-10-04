# Provider connection and recovery

These fixes shipped in [v0.1.2](https://github.com/oxdingzg/miao/releases/tag/v0.1.2), published on 2026-10-04. Run `miao upgrade`, then restart miao and confirm `miao --version` reports `0.1.2` or later.

## Log in by provider name

```sh
miao auth login opencode
miao auth login opencode-go
```

The positional argument accepts a provider ID/name or an HTTP(S) authentication-provider URL. Provider names open the provider's login flow; URLs fetch `/.well-known/opencode` metadata. Older versions treat all positional values as URLs; use `miao auth login --provider opencode` or the fixed preview build instead.

OpenCode Zen and Go accept API keys created at <https://opencode.ai/auth>. In the TUI, use `/connect` and select the relevant provider and authentication method.

OAuth methods without additional prompts send `inputs: {}`. The service also accepts the older request shape that omits `inputs`.

## Existing credentials

Legacy `auth.json` API keys are adopted into the current credential store. Legacy OAuth logins are adopted using the integration's OAuth method. Do not delete credentials to repair a missing provider list.

Verification of the compiled 0.1.2 preview in an isolated home:

- The connection dialog loaded the built-in provider catalog, including OpenCode Zen, OpenAI, GitHub Copilot, Anthropic, and Google.
- Both positional Zen and Go login commands reached the API-key prompt rather than attempting to fetch a provider name as a URL.
- Synthetic legacy Zen and Go API keys were imported as two `legacy` credentials. The TUI selected an OpenCode Go model instead of displaying `No provider selected`.

These checks validate discovery, command routing, and credential recovery. They do not establish that a real paid account is authorized to use every model.

## Go models requiring Global regions

This upstream error is a workspace setting restriction:

> This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it.

Select **Global** in the relevant OpenCode workspace's **Privacy** settings, then retry the model request. Re-entering the same API key does not change the workspace's region setting. The client preserves the upstream error so the workspace owner can act on it.
