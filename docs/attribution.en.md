# Project origins and licensing

[简体中文](attribution.zh.md)

## Origins and acknowledgements

miao is an open-source AI agent derived from
[opencode](https://github.com/anomalyco/opencode). A substantial part of the
codebase comes from opencode's MIT-licensed implementation. We thank its authors
and contributors for the terminal coding workflow and engineering foundation.

miao is maintained as a separate project, with its own development direction,
issue tracker and releases. The source relationship does not imply affiliation
with or endorsement by the opencode maintainers. For miao support and releases,
use [oxdingzg/miao](https://github.com/oxdingzg/miao).

## License and redistribution

miao is distributed under the [MIT License](../LICENSE). The license file keeps
both copyright notices:

```text
Copyright (c) 2026 the miao authors
Copyright (c) 2025 opencode
```

MIT permits use, modification and redistribution, including commercial use,
subject to its terms. Copies or substantial portions of the software must
include the copyright notices and permission notice. The warranty disclaimer
remains part of the license. Third-party components retain their own licenses
and notices; the root license does not replace those terms.

## Providers and compatibility

Source attribution is separate from model-provider selection. miao runs locally
without a project account; model access uses your chosen provider's credentials
and terms. OpenCode Zen and Go are optional third-party providers, and their
names, IDs and endpoints identify those services.

Compatibility identifiers, such as the `.opencode/` configuration fallback,
describe supported interfaces. They do not change the project’s maintenance or
licensing relationship. See [providers and models](providers.en.md) and the
[usage guide](guide.en.md) for current behavior.
