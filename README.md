# YouTube Comment Toolkit

A Chrome side panel for reading, searching, exporting, and asking questions about YouTube comments on videos and community posts.

## Disclaimer & Terms Notice

This project is an unofficial tool and is not affiliated with, endorsed by, or sponsored by YouTube or Google. It is shared as-is on GitHub for personal/experimental use at your own risk.

Using this extension—especially features that request comments or transcripts, export content/metadata, cache data locally, or send extracted text or images to local or remote LLM endpoints—may conflict with the [YouTube Terms of Service](https://www.youtube.com/t/terms) (including provisions covering copying/transmitting content, automated access, collecting identifying information, and using other users' content outside YouTube features). You are solely responsible for how you use this tool and for complying with applicable terms, laws, and third-party rights. This extension is not intended or configured for Chrome Web Store distribution.

## Requirements

- Google Chrome 142 or newer. Check or update Chrome at `chrome://settings/help`; Chrome will not load the extension on an older version.
- This repository. There is no build step, so install it directly from the `extension` folder.
- No API key is needed to collect, search, or export comments. **Ask** requires an LLM: a local server such as Ollama, or a cloud provider key (**Settings → LLM**).

## First-time installation in Chrome

1. Download or clone this repository and keep the folder where it is. Chrome runs the unpacked extension from that folder, so moving or deleting it later disables the extension.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder inside the repository — the folder containing `manifest.json`, not the repository root.
4. Pin the extension: click the puzzle-piece **Extensions** button in Chrome’s toolbar, then the pin beside **YouTube Comment Toolkit**. This makes the panel button easy to reach.
5. Open a YouTube video (`https://www.youtube.com/watch?v=…`) or community post (`https://www.youtube.com/post/…`). If the tab was already open before installing, reload it so the content scripts load.
6. Scroll to the comments. The extension adds a download icon and a comments icon to the comments header, to the left of **Sort by**. The comments icon opens and closes the panel; the download icon saves an export in the format set under **Settings → General → Download format** (Markdown by default).
7. Click the comments icon or pinned toolbar button to open the side panel, then choose **Collect**. On a watch page the layout switches to theater mode while the panel is open.

The extension needs access to YouTube and its image hosts for comments and playback tools. All LLM endpoints (including local servers such as Ollama) request host access separately when configured.

### If the comments icon or panel does not appear

- Confirm the page is a video or community post. Shorts, channel pages, playlists, and the home feed are not supported.
- Reload the YouTube tab after installing, reloading, or updating the extension.
- Scroll down so YouTube loads the comments. Videos and posts with comments turned off may not show a comments header, so the in-page buttons may not appear. The pinned toolbar button still opens the panel on a supported page.
- If the side panel says **Open a YouTube video or post**, the current tab is not a supported page or has not reloaded yet.
- If `chrome://extensions` refuses to load the folder, update Chrome from `chrome://settings/help`; the manifest requires Chrome 142 or newer.

## Use the side panel

- Choose **Collect** in the panel or use the download icon on YouTube. The collector requests available comments and replies from YouTube using the current page session. Large collections stop at the export size limit and remain available as partial exports. Replies start collapsed. **Settings** controls how many replies each click shows.
- **Timestamped only** sorts threads by timestamp, cuts each comment to its first four lines, and keeps the replies under a timestamped top-level comment even when those replies have no timestamp. Comments whose first timestamps fall within the **stack window** (default 3 seconds) are shown as a stack: the most-liked comment is on top and up to three cards peek out behind it. Use the arrow to the left of the avatar to expand a stack. The matching comment stays highlighted for the configured duration; a duration of `0` keeps it highlighted until the next timestamp.
- Following the video is off when the panel opens. Checking **Timestamped only** turns it on, and scrolling the comment list stops it. **Sync to video time** resumes following manually.
- **Settings → Text scale** scales both the comments and the Ask section.
- Opening the side panel switches the watch page to theater mode so comments use the wider layout; closing the panel restores the previous state. Theater mode is left alone if it was already on.
- On community posts, a full-screen button appears at the bottom right of each image. Click it to open a borderless viewer: click the image to zoom to 1:1, drag or scroll to pan, and press `Esc` or the close button to leave.
- **Settings → LLM** connects a model through a provider preset. Cloud presets cover OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Cerebras, SambaNova, Nebius, Perplexity, Moonshot, and Z.AI. Local presets cover Ollama, Open WebUI, llama.cpp, and LM Studio. There is also a custom OpenAI-compatible option.
  - Picking a preset fills its endpoint and default model and shows the provider’s key signup link. **Load models** queries the provider and offers the real model IDs; **Test** checks the key, endpoint, and model and reports the provider’s actual error if something is wrong.
  - For cloud and other optional endpoints, **Grant network access** opens a Chrome permission prompt in an extension tab. Saving a profile does not call the provider. Click **Load models** or **Test** to make a connection check. HTTPS is required except on loopback.
  - The display name and key belong to each saved profile, so switching models switches the **Ask …** label and its masked key. API keys are stored only in this extension’s local background storage, never sent to YouTube pages, and are shown masked; **Reveal** and **Copy** require an explicit click. For cloud models, optional USD-per-million-token prices drive the cost estimate under Ask.
- The assistant heading and button use the configured name (**Ask LLM** until a model is configured). Before the first question to a destination on a visit, Ask explains which source material and prior turns can be sent. Captions are opt-in. Switching destinations starts a separate chat. Returning to Search or closing the last panel using an extension-loaded Ollama model releases it. Drag the top edge of the Ask section to resize it.
- Persistent export storage is off by default. Enable **Keep copies in Chrome storage** to save exports, or use **Load saved export** to retrieve a matching saved copy. **Clear saved exports** deletes saved copies from this Chrome profile.

## Updating the extension

Unpacked extensions do not update themselves. Replace the files in the `extension` folder, open `chrome://extensions`, and click the reload icon on the extension’s card. Reload any open YouTube tabs afterwards. If Chrome reports that the extension needs new permissions, approve them.

## API key handling

- Keys live in `chrome.storage.local` under a background-only record. They are never written to `chrome.storage.sync`, `localStorage`, the page, an export, or the host-permission page. Extension storage is set to trusted contexts, so YouTube content scripts cannot read it (the background rejects their configuration messages too).
- Profiles keep only `hasKey` and the last four characters for display. Revealing or copying a key is an explicit action; the revealed value is hidden after 30 seconds and when Settings closes.
- A saved key is bound to its provider and base URL. Changing either requires entering a key for the new destination. When upgrading from 4.3.0, re-enter keys for custom or overridden endpoints.
- Threat model: this protects keys from YouTube pages and from accidental sync. It does not protect against someone who can read this Chrome profile’s extension storage or debug the extension. Use a strong OS account and provider-side spending limits, and revoke keys you no longer need.

## Data and privacy

Read the [privacy policy](extension/privacy.html) before installing. Because this extension is intended to be loaded unpacked rather than distributed through the Chrome Web Store, no Chrome Web Store privacy-policy hosting or listing disclosures are maintained.

Collected data, optional export files, optional saved copies in `chrome.storage.local`, and any content or images sent to configured local or remote LLM endpoints are handled according to your local settings and those endpoints' terms/policies.

## License

This repository is licensed under the Apache License, Version 2.0. See [LICENSE.md](LICENSE.md) for the full text.

### Third-party notices & licenses

Full third-party license texts are stored in [`extension/licenses/`](extension/licenses/), with attribution and modification details in [extension/THIRD_PARTY_NOTICES.md](extension/THIRD_PARTY_NOTICES.md):

- **[Cline](https://github.com/cline/cline)** (Apache License 2.0 — [extension/licenses/LICENSE-CLINE.txt](extension/licenses/LICENSE-CLINE.txt)): Provider presets and the preset-driven connection flow are adapted from Cline (Copyright Cline Bot Inc. and contributors) and rewritten for Chrome Manifest V3 and this extension’s side panel.
- **[markdown-it](https://github.com/markdown-it/markdown-it)** v14.3.3 (MIT License — [extension/licenses/LICENSE-markdown-it.txt](extension/licenses/LICENSE-markdown-it.txt)): Bundled in `extension/vendor/markdown-it.min.js` for rendering Markdown answers in the Ask panel (Copyright Vitaly Puzrin, Alex Kocharin).