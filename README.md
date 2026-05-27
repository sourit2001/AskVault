# AskVault

AskVault is a desktop-only Obsidian plugin that lets you ask questions about the current note or the entire vault through your locally installed OpenAI Codex CLI.

## 给用户的安装和使用说明

AskVault 目前仅支持桌面版 Obsidian。每位用户需要使用自己的 Codex 登录状态，插件不会附带或共享作者的账号。

### 安装插件

1. 安装桌面版 Obsidian，并打开自己的知识库。
2. 在电脑的终端中执行：

   ```bash
   npm install -g @openai/codex
   codex login
   ```

   按照浏览器中的提示完成登录。

3. 在 Obsidian 中进入 **设置 > 第三方插件 > 浏览**，搜索 **AskVault**，点击 **安装** 和 **启用**。
4. 点击左侧工具栏中的 AskVault 图标，或在命令面板中搜索 **Open read-only vault chat**。

AskVault 已在 Obsidian 第三方插件目录中提供，用户不需要下载压缩包或复制插件文件。

已经安装过 AskVault 的用户，请在第三方插件列表中检查更新并升级到 `0.1.2` 或更高版本。`0.1.2` 修复了从另一台电脑复制配置后无法连接的问题。

### 开始使用

1. 打开一篇 Markdown 笔记，保持检索范围为 **当前笔记**，输入问题并发送。
2. 如需跨多篇笔记查询，将检索范围切换为 **整个知识库**。
3. 需要保留回答时，点击面板顶部的 **保存**，对话会保存在知识库的 `Codex 对话/` 文件夹。

通常不需要修改设置中的 **Codex executable** 或 **Node executable**，两项保持为空即可。插件会在每台电脑上自动查找已经安装的 Codex。

### 无法连接时

1. 在终端运行 `codex --version`，确认能输出版本号；建议使用 `0.133.0` 或更新版本。
2. 在终端运行 `codex login`，重新完成登录后回到 Obsidian 点击 **重连**。
3. 只有在自动查找失败时，才需要在 AskVault 设置中填写本机的 Codex 路径。
4. 使用网络代理的用户，可在 AskVault 设置的 **HTTP Proxy** 中填写自己的代理地址。

## Features

- Ask about the active note without repeatedly sending the full note on follow-up questions.
- Switch to whole-vault questions when you need cross-note synthesis.
- Configure the Codex model and reasoning effort in AskVault settings so the sidebar stays focused on questions.
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

AskVault automatically locates `codex` from common npm installation locations and `PATH`, preferring a user-level npm installation over a potentially stale system copy. For a normal installation, leave both **Codex executable** and **Node executable** empty.

Set the default model and reasoning effort under **Settings > Community plugins > AskVault**. These options apply to questions sent from the sidebar and are intentionally hidden from the composer.

If a copied vault contains an absolute executable path from another computer, AskVault ignores that missing path and attempts automatic detection on the current computer. Clear the old path in settings after a successful connection.

If automatic detection cannot find `codex`, set an absolute executable path in AskVault settings. If that executable is a JavaScript entry point, also set `Node executable` to the absolute Node path.

If multiple Codex installations exist, run `codex --version` and configure an absolute path to a recent installation. An older CLI may not implement the app-server protocol AskVault uses.

## Privacy And Permissions

AskVault starts a local Codex CLI subprocess and sends selected note context or requests to search vault files to that process. Codex may transmit relevant context to OpenAI according to your Codex configuration and account terms.

- `Current note` mode sends the open Markdown note on the first question, then reuses it for follow-up questions until the note changes.
- `Whole vault` mode allows Codex to search relevant Markdown files in the vault.
- The session is read-only and does not approve file edits or shell actions.
- Conversations are temporary unless you select `保存`; saved conversations become Markdown files in your vault.

Codex may initialize configured MCP servers or plugins on startup. Non-fatal background warnings are hidden from the chat panel when the core connection succeeds.

## Manual Installation

Manual installation is intended only as a fallback. Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/ask-vault/
```

Then reload Obsidian and enable **AskVault** under Community plugins.

## Sharing With Other Users

AskVault is listed in the official Obsidian Community Plugins directory. Publish a GitHub release for each new version; use BRAT only for testing an unreleased version. Do not distribute `data.json` from an installed vault plugin directory: it contains computer-specific paths, proxy settings, and model preferences.

Each user only needs to:

1. Install and log in to Codex CLI with `npm install -g @openai/codex` and `codex login`.
2. Install AskVault from Community Plugins.
3. Leave the executable fields empty; set a proxy only if their own network requires it.

For maintainers testing an unreleased build through BRAT, add:

```text
https://github.com/sourit2001/AskVault
```

## License

MIT
