# YouTube Comment Toolkit

A Chrome side panel for reading, searching, exporting, and asking questions about YouTube comments on videos and community posts.

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
7. Click the comments icon, or the pinned toolbar button on a supported page, to open the side panel. On a watch page the layout switches to theater mode while the panel is open. Comments collect in the background once the page settles, and replies start collapsed.

A fresh install does not ask for host permissions: the YouTube and LLM hosts declared in `manifest.json` are granted when the unpacked extension loads. Only a custom LLM endpoint needs an extra network-access grant (see **Use the side panel**).

### If the comments icon or panel does not appear

- Confirm the page is a video or community post. Shorts, channel pages, playlists, and the home feed are not supported.
- Reload the YouTube tab after installing, reloading, or updating the extension.
- Scroll down so YouTube loads the comments. Videos and posts with comments turned off may not show a comments header, so the in-page buttons may not appear. The pinned toolbar button still opens the panel on a supported page.
- If the side panel says **Open a YouTube video or post**, the current tab is not a supported page or has not reloaded yet.
- If `chrome://extensions` refuses to load the folder, update Chrome from `chrome://settings/help`; the manifest requires Chrome 142 or newer.

## Use the side panel

- Comments collect in the background once the YouTube page settles. Replies start collapsed. **Settings** controls how many replies each click shows, or lets you show all replies at once.
- **Timestamped only** sorts threads by timestamp, cuts each comment to its first four lines, and keeps the replies under a timestamped top-level comment even when those replies have no timestamp. Comments whose first timestamps fall within the **stack window** (default 3 seconds) are shown as a stack: the most-liked comment is on top and up to three cards peek out behind it. Use the arrow to the left of the avatar to expand a stack. The matching comment stays highlighted for the configured duration; a duration of `0` keeps it highlighted until the next timestamp.
- Following the video is off when the panel opens. Checking **Timestamped only** turns it on, and scrolling the comment list stops it. **Sync to video time** resumes following manually.
- **Settings → Text scale** scales both the comments and the Ask section.
- Opening the side panel switches the watch page to theater mode so comments use the wider layout; closing the panel restores the previous state. Theater mode is left alone if it was already on.
- On community posts, a full-screen button appears at the bottom right of each image. Click it to open a borderless viewer: click the image to zoom to 1:1, drag or scroll to pan, and press `Esc` or the close button to leave.
- **Settings → LLM** connects a model through a provider preset. Cloud presets cover OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Cerebras, SambaNova, Nebius, Perplexity, Moonshot, and Z.AI. Local presets cover Ollama, Open WebUI, llama.cpp, and LM Studio. There is also a custom OpenAI-compatible option.
  - Picking a preset fills its endpoint and default model and shows the provider’s key signup link. **Load models** queries the provider and offers the real model IDs; **Test** checks the key, endpoint, and model and reports the provider’s actual error if something is wrong.
  - Known API hosts are declared in the manifest, so they need no permission prompt. For a custom endpoint, saving the profile shows a **Grant network access** action; it opens a one-time permission page in a normal extension tab, because Chrome does not show a usable host-permission prompt inside a side panel. The page grants access to that exact origin only and never contains an API key.
  - The display name and key belong to each saved profile, so switching models switches the **Ask …** label and its masked key. API keys are stored only in this extension’s local background storage, never sent to YouTube pages, and are shown masked; **Reveal** and **Copy** require an explicit click. For cloud models, optional USD-per-million-token prices drive the cost estimate under Ask.
- The assistant heading and button use the configured name (**Ask Gemma** by default). The model loads on the first question. Returning to Search or closing the last panel using it releases a model loaded by the extension. Each tab keeps its own chat for the current page visit. Drag the top edge of the Ask section to resize it.

## Updating the extension

Unpacked extensions do not update themselves. Replace the files in the `extension` folder, open `chrome://extensions`, and click the reload icon on the extension’s card. Reload any open YouTube tabs afterwards. If Chrome reports that the extension needs new permissions, approve them.

## Coming from the YouTube Comment Exporter userscript

- Disable the userscript in your userscript manager. Otherwise both tools add controls to YouTube pages and collect comments independently.
- The extension keeps its own cache and does not read the userscript’s storage. To reuse an export downloaded with the userscript, open the matching video or post, then choose **Settings → Open Markdown or JSON export**.

## API key handling

- Keys live in `chrome.storage.local` under a background-only record. They are never written to `chrome.storage.sync`, `localStorage`, the page, an export, or the host-permission page. Extension storage is set to trusted contexts, so YouTube content scripts cannot read it (the background rejects their configuration messages too).
- Profiles keep only `hasKey` and the last four characters for display. Revealing or copying a key is an explicit action; the revealed value is hidden after 30 seconds and when Settings closes.
- Known provider hosts are packaged with the extension. A custom endpoint gets a one-time host grant from a normal extension tab; the side panel never calls `chrome.permissions.request`, which can hang without showing a prompt.
- Threat model: this protects keys from YouTube pages and from accidental sync. It does not protect against someone who can read this Chrome profile’s extension storage or debug the extension. Use a strong OS account and provider-side spending limits, and revoke keys you no longer need.

## Third-party attribution

Provider presets and the preset-driven connection flow are adapted from
[Cline](https://github.com/cline/cline), Copyright Cline Bot Inc. and
contributors, licensed under the Apache License, Version 2.0. The full license
is in [LICENSE-CLINE.txt](LICENSE-CLINE.txt); details and the list of changes
are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The implementation here
is rewritten for Chrome Manifest V3 and this extension’s side panel.

