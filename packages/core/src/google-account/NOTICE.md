# Google-account compatibility references

The endpoint conventions and request
schema behavior are adapted from the MIT-licensed community implementation:

- https://github.com/NoeFabris/opencode-antigravity-auth
- Reviewed revision: `f212f7eb01aa904b5985895cf93f6d3074c5bc6d`
- Copyright (c) 2025 Jens; full notice retained in `LICENSE.reference`.

Additional protocol research, not vendored runtime dependencies:
https://github.com/cortexkit/antigravity-auth at
`d17ca2e88fe033f54f745faf31f6b815a75c32e1` (MIT).

This compatibility integration is independently implemented for miao. It is
not an official Google client. It does not use Gemini website cookies, API
keys, the retired personal Gemini CLI entitlement, or an external agent loop.
Google-account model access depends on the backend's current account eligibility.
OAuth application credentials are provided by the deployment through environment variables; no third-party client secret is embedded or committed. They are distinct from user access/refresh tokens and from Gemini API keys.

Tool-history restoration follows Google's documented thought-signature rules:
https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
Live tool calls retain their exact signatures, scoped to the credential/model
and tool-call ID. Reconstructed history uses the documented sentinel only
when the original live signature is unavailable.
