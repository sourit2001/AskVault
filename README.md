# AskVault

AskVault is a desktop-only Obsidian plugin that lets you ask questions about the current note or the entire vault through your locally installed OpenAI Codex CLI.

## Features

- Ask about the active note without repeatedly sending the full note on follow-up questions.
- Switch to whole-vault questions when you need cross-note synthesis.
- Choose the Codex model and reasoning effort for each question workflow.
- Keep Codex access read-only: the chat session starts with a read-only sandbox and no approvals.
- Save useful conversations as Markdown notes under `Codex 对话/`.
- Use your existing ChatGPT-authenticated Codex CLI session instead of configuring an API key in Obsidian.

## Requirements

- Obsidian desktop `1.7.0` or later.
- A locally installed Codex CLI that supports `codex app-server` (`0.133.0` is tested).
- A Codex login configured from a terminal with `codex login`.

AskVault uses the Codex usage included in your ChatGPT plan when your CLI is logged in through ChatGPT. It does not configure or store an OpenAI API key.

## Setup

1. Install and authenticate Codex CLI:

   ```bash
   npm install -g @openai/codex
   codex login
   ```

2. Enable AskVault in Obsidian.
3. Open the AskVault sidebar using the ribbon icon or command palette.

AskVault starts `codex app-server` from the `Codex executable` setting. The default is `codex`.

If Obsidian cannot find `codex` because it does not inherit your terminal `PATH`, set an absolute executable path in AskVault settings. If that executable is a JavaScript entry point, also set `Node executable` to the absolute Node path.

If multiple Codex installations exist, run `codex --version` and configure an absolute path to a recent installation. An older CLI may not implement the app-server protocol AskVault uses.

## Privacy And Permissions

AskVault starts a local Codex CLI subprocess and sends selected note context or requests to search vault files to that process. Codex may transmit relevant context to OpenAI according to your Codex configuration and account terms.

- `Current note` mode sends the open Markdown note on the first question, then reuses it for follow-up questions until the note changes.
- `Whole vault` mode allows Codex to search relevant Markdown files in the vault.
- The session is read-only and does not approve file edits or shell actions.
- Conversations are temporary unless you select `保存`; saved conversations become Markdown files in your vault.

Codex may initialize configured MCP servers or plugins on startup. Non-fatal background warnings are hidden from the chat panel when the core connection succeeds.

## Manual Installation

Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/ask-vault/
```

Then reload Obsidian and enable **AskVault** under Community plugins.

## License

MIT
