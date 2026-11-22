# Third-party notices

This extension includes or adapts the following third-party software. Full
license texts are kept in [licenses/](licenses/).

## Cline

Parts of the provider preset catalog, endpoint defaults, and the preset-driven
connection flow in this extension are adapted from **Cline**:

- Project: https://github.com/cline/cline
- Copyright: Cline Bot Inc. and contributors
- License: Apache License, Version 2.0 ([licenses/LICENSE-CLINE.txt](licenses/LICENSE-CLINE.txt))

### Changes made for YouTube Comment Toolkit

- The provider list was trimmed to browser-side OpenAI-compatible and local
  providers relevant to this extension.
- Provider metadata was adapted into `llm-config.mjs`; requests, model
  discovery, key storage, and the connection UI were rewritten for Chrome
  Manifest V3 and this extension's side panel.
- The Ollama path uses this extension's loopback bridge instead of a Node.js
  client.
- Host access is handled with Chrome optional host permissions rather than
  unrestricted extension-host networking.

No Cline application code or assets are bundled verbatim in this extension. The
adaptation is limited to provider metadata and the general flow of selecting a
preset, entering a key, discovering models, and testing a connection.

## markdown-it

Markdown rendering in the Ask panel uses a bundled copy of **markdown-it**
(v14.3.3, `vendor/markdown-it.min.js`):

- Project: https://github.com/markdown-it/markdown-it
- Copyright: Vitaly Puzrin, Alex Kocharin
- License: MIT License ([licenses/LICENSE-markdown-it.txt](licenses/LICENSE-markdown-it.txt))
