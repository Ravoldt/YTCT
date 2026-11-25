# YouTube Comment Toolkit

A browser side panel for reading, searching, exporting, and asking questions about YouTube comments on videos and community posts.

## Disclaimer & Terms Notice

This project is an unofficial tool and is not affiliated with, endorsed by, or sponsored by YouTube or Google. It is shared as-is on GitHub for personal/experimental use at your own risk.

Using this extension—especially features that request comments or transcripts, export content/metadata, cache data locally, or send extracted text or images to local or remote LLM endpoints—may conflict with the [YouTube Terms of Service](https://www.youtube.com/t/terms) (including provisions covering copying/transmitting content, automated access, collecting identifying information, and using other users' content outside YouTube features). You are solely responsible for how you use this tool and for complying with applicable terms, laws, and third-party rights. This extension is not intended or configured for Chrome Web Store distribution.

## Requirements

- A Chromium-based browser (version 142 or newer, supporting Manifest V3 side panels). Check your browser’s About page; older versions will not load the extension.
- This repository. There is no build step, so install it directly from the `extension` folder.
- No API key is needed to collect, search, or export comments. **Ask** requires an LLM: a local server such as Ollama, or a cloud provider key (**Settings → LLM**).

## First-time installation

1. Download or clone this repository and keep the folder where it is. The browser runs the unpacked extension from that folder, so moving or deleting it later disables the extension.
2. Open your browser’s Extensions page (for example, `chrome://extensions` or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder inside the repository — the folder containing `manifest.json`, not the repository root.
4. Open a YouTube video (`https://www.youtube.com/watch?v=…`) or community post (`https://www.youtube.com/post/…`). If the tab was already open before installing, reload it so the content scripts load.
5. Scroll to the comments. The extension adds a download icon and a comments icon to the comments header, to the left of **Sort by**. The comments icon opens and closes the panel; the download icon saves an export in the format set under **Settings → General → Download format** (Markdown by default).
6. Click the comments icon or pinned toolbar button to open the side panel, then choose **Collect**. On a watch page the layout switches to theater mode while the panel is open.

The extension needs access to YouTube and its image hosts for comments and playback tools. All LLM endpoints (including local servers such as Ollama) request host access separately when configured.

### If the comments icon or panel does not appear

- Confirm the page is a video or community post. Shorts, channel pages, playlists, and the home feed are not supported.
- Reload the YouTube tab after installing, reloading, or updating the extension.
- Scroll down so YouTube loads the comments. Videos and posts with comments turned off may not show a comments header, so the in-page buttons may not appear. The extension can still be opened by clicking the extension icon in the toolbar or from the extensions list.
- If the side panel says **Open a YouTube video or post**, the current tab is not a supported page or has not reloaded yet.
- If your browser refuses to load the folder, update it to Chromium 142 or newer.

## Use the side panel

- Choose **Collect** in the panel to load comments into the side panel (or **Stop** to cancel), and use the download icon injected into YouTube to save an export file to your Downloads folder. Once comments are loaded, the button changes to **Refresh** and performs an incremental refresh (sorting by Newest first, fetching new top-level comments and checking for new replies without scrolling the YouTube page); **Settings → General → Collect fresh comments** still runs a full re-collection. Once per minute while comments are loaded, the panel checks YouTube’s reported comment count and displays `+NNN New Comments` next to **Refresh** when new comments appear. You can also enable **Settings → General → Auto-collect comments after page load** (off by default) to start background collection automatically once a visible video or post finishes loading. Large collections stop at the export size limit and remain available as partial exports. Replies start collapsed; **Replies per click** controls how many replies each click shows (`0` loads all replies at once).
- Use the **All comments / Timestamped comments** icon toggle to switch into timestamped mode (displaying the current video playhead time beside the toggle). Timestamped mode sorts threads by timestamp (then likes for ties), trims comments to their first four lines, and keeps replies under timestamped top-level comments. **Settings → General → Stack nearby timestamped comments** controls whether comments within the **stack window** (default 3 seconds) collapse into a stack (most-liked on top, up to three peeking behind; expand via the arrow to the left of the avatar) or stay unstacked. **Highlight before timestamp** and **Highlight after timestamp** are measured in real seconds independent of video playback speed, and multiple comments can stay highlighted simultaneously on independent timers.
- Following the video is off when the panel opens. Switching to timestamped mode turns it on. **Sync to video time** stays active through expanding replies, clicking Read more, or minor scrolling, and only disengages when you scroll the last highlighted comment completely off-screen.
- **Search & Filters**: Search supports three matching modes — **Exact**, **Fuzzy** (default, typo-tolerant word matching), and opt-in **Semantic** (hybrid exact + fuzzy + local in-browser embeddings via Transformers.js running in a Web Worker with WebGPU/WASM and Reciprocal Rank Fusion relevance scoring) — plus an inline **`.*` Regex** toggle inside the search field (which auto-grows up to 4 lines and shows an unobtrusive validation hint after 3 seconds if a pattern is invalid). Click **Filters** to toggle **Has likes**, **Has replies**, **♥ Creator liked**, **By creator**, **Creator replied**, **Mentions creator**, **Edited**, **Min/Max likes**, **Min/Max replies**, and **Author** (`@handle`), with out-of-bounds diagnostics and user-saved filter presets (never auto-loaded). Configure default search mode, opt-in semantic search (which discloses and downloads a ~23–118 MB quantized model + ONNX WebAssembly runtime once into browser cache while keeping comments local), compute device (Auto WebGPU/CPU or CPU-only WASM), and saved presets under **Settings → Search**.
- **Settings → Text scale** scales comments, the search box, the Ask chat, and the Ask text field. The Ask input grows automatically up to 4 lines and includes a top-right button to expand the input field to the full height of the side panel.
- Opening the side panel switches the watch page to theater mode so comments use the wider layout; closing the panel restores the previous state. Theater mode is left alone if it was already on. Enable **Settings → General → Open side panel with theater mode (T)** to automatically open the side panel when entering theater mode via `T` or the theater button (or on your first click/keypress if theater mode is already active on load).
- On community posts, a full-screen button appears at the bottom right of each image. Click it to open a semi-transparent fullscreen viewer: click outside the image (or press `Esc` / the close button) to close, and use the scroll wheel (or click, or `+`/`-`/`0`) and mouse drag over the image to zoom and pan.
- **Settings → LLM** connects a model through a provider preset. Cloud presets cover OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Cerebras, SambaNova, Nebius, Perplexity, Moonshot, and Z.AI. Local presets cover Ollama, Open WebUI, llama.cpp, and LM Studio. There is also a custom OpenAI-compatible option.
  - Picking a preset fills its endpoint and default model and shows the provider’s key signup link. Local endpoints automatically populate their available models once host access is granted. **Load models** queries the provider and offers the real model IDs; **Test** checks the key, endpoint, and model and reports the provider’s actual error if something is wrong.
  - Context limits and thinking availability/levels are configured in **Settings → LLM**. Cloud API providers set the context limit automatically from the model’s capabilities and populate supported thinking levels from model metadata. Local servers and custom endpoints provide a power-of-two context slider (up to 7 stops capped at the model’s maximum, e.g., `4k` to `256k`) alongside a numeric input for exact custom values.
  - For optional endpoints, **Grant network access** opens a browser permission prompt in an extension tab. Saving a profile does not call the provider. HTTPS is required except on loopback.
  - The display name and key belong to each saved profile, so switching models switches the **Ask …** label and its masked key. API keys are stored only in this extension’s local background storage, never sent to YouTube pages, and are shown masked; **Reveal** and **Copy** require an explicit click. For cloud models, optional USD-per-million-token prices drive the cost estimate under Ask.
- The assistant heading and button use the configured name (**Ask LLM** until a model is configured). Before the first question to a destination on a visit, Ask explains which source material and prior turns can be sent. Captions are opt-in. Switching destinations starts a separate chat. Returning to Search or closing the last panel using an extension-loaded Ollama model releases it. Drag the top edge of the Ask section to resize it.
- Persistent export storage is off by default. Enable **Keep copies in browser storage** to save exports and automatically load a saved copy when revisiting a matching video or post (skipping automatic collection when a saved copy is already available). You can also use **Load saved export** manually, or **Clear saved exports** to delete saved copies from this browser profile.

## Updating the extension

Unpacked extensions do not update themselves. Replace the files in the `extension` folder, open your browser’s Extensions page, and click the reload icon on the extension’s card. Reload any open YouTube tabs afterwards. If the browser reports that the extension needs new permissions, approve them.

## API key handling

- Keys live in `chrome.storage.local` under a background-only record. They are never written to `chrome.storage.sync`, `localStorage`, the page, an export, or the host-permission page. Extension storage is set to trusted contexts, so YouTube content scripts cannot read it (the background rejects their configuration messages too).
- Profiles keep only `hasKey` and the last four characters for display. Revealing or copying a key is an explicit action; the revealed value is hidden after 30 seconds and when Settings closes.
- A saved key is bound to its provider and base URL. Changing either requires entering a key for the new destination. When upgrading from 4.3.0, re-enter keys for custom or overridden endpoints.
- Threat model: this protects keys from YouTube pages and from accidental sync. It does not protect against someone who can read this browser profile’s extension storage or debug the extension. Use a strong OS account and provider-side spending limits, and revoke keys you no longer need.

## Data and privacy

Read the [privacy policy](extension/privacy.html) before installing. Because this extension is intended to be loaded unpacked rather than distributed through the Chrome Web Store, no Chrome Web Store privacy-policy hosting or listing disclosures are maintained.

Collected data, optional export files, optional saved copies in `chrome.storage.local`, and any content or images sent to configured local or remote LLM endpoints are handled according to your local settings and those endpoints' terms/policies.

## License

This repository is licensed under the Apache License, Version 2.0. See [LICENSE.md](LICENSE.md) for the full text.

### Third-party notices & licenses

Full third-party license texts are stored in [`extension/licenses/`](extension/licenses/), with attribution and modification details in [extension/THIRD_PARTY_NOTICES.md](extension/THIRD_PARTY_NOTICES.md):

- **[Cline](https://github.com/cline/cline)** (Apache License 2.0 — [extension/licenses/LICENSE-CLINE.txt](extension/licenses/LICENSE-CLINE.txt)): Provider presets and the preset-driven connection flow are adapted from Cline (Copyright Cline Bot Inc. and contributors) and rewritten for Chrome Manifest V3 and this extension’s side panel.
- **[markdown-it](https://github.com/markdown-it/markdown-it)** v14.3.3 (MIT License — [extension/licenses/LICENSE-markdown-it.txt](extension/licenses/LICENSE-markdown-it.txt)): Bundled in `extension/vendor/markdown-it.min.js` for rendering Markdown answers in the Ask panel (Copyright Vitaly Puzrin, Alex Kocharin).
- **[Transformers.js](https://github.com/huggingface/transformers.js)** v4.3.2 (Apache License 2.0 — [extension/licenses/LICENSE-transformers.txt](extension/licenses/LICENSE-transformers.txt)) & **[ONNX Runtime Web](https://github.com/microsoft/onnxruntime)** (MIT License): Browser bundle and WASM loader vendored in `extension/vendor/transformers/` for opt-in local semantic search (Copyright Hugging Face Inc. and contributors; Microsoft Corporation).