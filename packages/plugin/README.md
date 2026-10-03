# @miao/plugin

Plugin interfaces for miao, maintained in this repository.

- `@miao/plugin`: server hooks and plugin context.
- `@miao/plugin/tool`: custom tool definitions.
- `@miao/plugin/tui`: terminal UI plugins and slots.
- `@miao/plugin/v2/effect`: Effect-based V2 plugin interfaces.
- `@miao/plugin/v2/promise`: Promise-based V2 plugin interfaces.

```ts
import { tool } from "@miao/plugin"

export default tool({
  description: "Return the current project directory",
  args: {},
  async execute(_args, context) {
    return context.directory
  },
})
```

## Migrating existing plugins

Replace imports from `@opencode-ai/plugin` with `@miao/plugin`, keeping the same subpath. Update the dependency in the plugin's package manifest and reinstall dependencies. This rename preserves the hook and tool interfaces; it does not change how plugins are registered.

Existing third-party plugins can retain their own dependencies on the upstream packages. The host continues loading those plugins through the existing compatibility interfaces. New miao plugins should use `@miao/plugin`.

Restart miao after changing project plugins or custom tools so the new definitions are loaded.

See the [miao guide](https://mtty.dev/docs/miao/guide/) and [LICENSE](../../LICENSE).
