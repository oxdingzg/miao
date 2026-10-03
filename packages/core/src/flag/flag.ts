import { Config } from "effect"
import { InstallationChannel } from "../installation/version"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["MIAO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["MIAO_DISABLE_FFF"]
const native = process.env["MIAO_NATIVE"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("MIAO_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  MIAO_AUTO_HEAP_SNAPSHOT: truthy("MIAO_AUTO_HEAP_SNAPSHOT"),
  MIAO_GIT_BASH_PATH: process.env["MIAO_GIT_BASH_PATH"],
  MIAO_CONFIG: process.env["MIAO_CONFIG"],
  MIAO_CONFIG_CONTENT: process.env["MIAO_CONFIG_CONTENT"],
  MIAO_DISABLE_AUTOUPDATE: truthy("MIAO_DISABLE_AUTOUPDATE"),
  MIAO_ALWAYS_NOTIFY_UPDATE: truthy("MIAO_ALWAYS_NOTIFY_UPDATE"),
  MIAO_DISABLE_PRUNE: truthy("MIAO_DISABLE_PRUNE"),
  MIAO_DISABLE_TERMINAL_TITLE: truthy("MIAO_DISABLE_TERMINAL_TITLE"),
  MIAO_SHOW_TTFD: truthy("MIAO_SHOW_TTFD"),
  MIAO_DISABLE_AUTOCOMPACT: truthy("MIAO_DISABLE_AUTOCOMPACT"),
  MIAO_DISABLE_MODELS_FETCH: truthy("MIAO_DISABLE_MODELS_FETCH"),
  MIAO_DISABLE_MOUSE: truthy("MIAO_DISABLE_MOUSE"),
  MIAO_DISABLE_KITTY_KEYBOARD: truthy("MIAO_DISABLE_KITTY_KEYBOARD"),
  MIAO_FAKE_VCS: process.env["MIAO_FAKE_VCS"],
  MIAO_SERVER_PASSWORD: process.env["MIAO_SERVER_PASSWORD"],
  MIAO_SERVER_USERNAME: process.env["MIAO_SERVER_USERNAME"],
  MIAO_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("MIAO_DISABLE_FFF"),
  MIAO_NATIVE: native === undefined ? true : truthy("MIAO_NATIVE"),
  get MIAO_SANDBOX() {
    return truthy("MIAO_SANDBOX")
  },
  get MIAO_SANDBOX_DENY_NETWORK() {
    return truthy("MIAO_SANDBOX_DENY_NETWORK")
  },
  MIAO_PACKAGE_MANAGER_AUTO_UPDATE: truthy("MIAO_PACKAGE_MANAGER_AUTO_UPDATE"),

  // Experimental
  MIAO_EXPERIMENTAL_FILEWATCHER: Config.boolean("MIAO_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  MIAO_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("MIAO_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  MIAO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("MIAO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  MIAO_MODELS_URL: process.env["MIAO_MODELS_URL"],
  MIAO_MODELS_PATH: process.env["MIAO_MODELS_PATH"],
  MIAO_DB: process.env["MIAO_DB"],

  MIAO_WORKSPACE_ID: process.env["MIAO_WORKSPACE_ID"],
  MIAO_EXPERIMENTAL_WORKSPACES: enabledByExperimental("MIAO_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get MIAO_DISABLE_PROJECT_CONFIG() {
    return truthy("MIAO_DISABLE_PROJECT_CONFIG")
  },
  // Skips CLAUDE.md and ~/.claude/CLAUDE.md as instruction sources, matching V1.
  get MIAO_DISABLE_CLAUDE_CODE_PROMPT() {
    return truthy("MIAO_DISABLE_CLAUDE_CODE") || truthy("MIAO_DISABLE_CLAUDE_CODE_PROMPT")
  },
  get MIAO_EXPERIMENTAL_ICON_DISCOVERY() {
    return enabledByExperimental("MIAO_EXPERIMENTAL_ICON_DISCOVERY")
  },
  get MIAO_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("MIAO_EXPERIMENTAL_REFERENCES")
  },
  get MIAO_EXPERIMENTAL_CODE_MODE() {
    return enabledByExperimental("MIAO_EXPERIMENTAL_CODE_MODE")
  },
  get MIAO_EXPERIMENTAL_RESPONSES_WS() {
    // Pooled Responses WebSockets for ChatGPT sign-in; on for source and preview
    // builds until proven, off for releases unless MIAO_EXPERIMENTAL_RESPONSES_WS=1.
    const value = process.env["MIAO_EXPERIMENTAL_RESPONSES_WS"]
    return value === undefined ? InstallationChannel !== "latest" : truthy("MIAO_EXPERIMENTAL_RESPONSES_WS")
  },
  get MIAO_TUI_CONFIG() {
    return process.env["MIAO_TUI_CONFIG"]
  },
  get MIAO_CONFIG_DIR() {
    return process.env["MIAO_CONFIG_DIR"]
  },
  get MIAO_PURE() {
    return truthy("MIAO_PURE")
  },
  get MIAO_PERMISSION() {
    return process.env["MIAO_PERMISSION"]
  },
  get MIAO_PLUGIN_META_FILE() {
    return process.env["MIAO_PLUGIN_META_FILE"]
  },
  get MIAO_CLIENT() {
    return process.env["MIAO_CLIENT"] ?? "cli"
  },
  get MIAO_DISABLE_EMBEDDED_WEB_UI() {
    return truthy("MIAO_DISABLE_EMBEDDED_WEB_UI")
  },
  // Opt-in raw provider-wire recording. `1`/`true` selects the log directory;
  // any other value is the directory to write into. Read at access time so
  // tests and the CLI can arm it after module load.
  get MIAO_LLM_WIRE_ARCHIVE() {
    return process.env["MIAO_LLM_WIRE_ARCHIVE"]
  },
}
