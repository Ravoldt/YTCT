# Third-party notices

## Cline

Parts of the provider preset catalog, endpoint defaults, and the preset-driven
connection flow in this extension are adapted from **Cline**:

- Project: https://github.com/cline/cline
- Copyright: Cline Bot Inc. and contributors
- License: Apache License, Version 2.0

A copy of the Apache License, Version 2.0 is included in
[LICENSE-CLINE.txt](LICENSE-CLINE.txt).

### Changes made for YouTube Comment Toolkit

- The provider list was trimmed to browser-side OpenAI-compatible and local
  providers relevant to this extension.
- Provider metadata was adapted into `llm-config.mjs`; requests, model
  discovery, key storage, and the connection UI were rewritten for Chrome
  Manifest V3 and this extension's existing side panel.
- The Ollama path uses this extension's existing loopback bridge instead of a
  Node.js client.
- Host access is handled with Chrome static/optional host permissions rather
  than unrestricted extension-host networking.

No Cline application code or assets are bundled verbatim in this extension.
The adaptation is limited to provider metadata and the general flow of
selecting a preset, entering a key, discovering models, and testing a
connection.
