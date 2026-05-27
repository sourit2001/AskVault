const { FileSystemAdapter, ItemView, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const VIEW_TYPE = "ask-vault-view";
const EXPORT_FOLDER = "Codex 对话";
const DEFAULT_CODEX_PATH = "";
const DEFAULT_NODE_PATH = "";
const CODEX_COMMAND = "codex";
const SYSTEM_PROMPT = [
  "You answer questions about the Obsidian vault that is your current working directory.",
  "Follow the scope specified in each question: when it says current note only, use only the supplied note text; when it says whole vault, read Markdown notes as needed.",
  "When answering from notes, cite relevant note filenames.",
  "This is a read-only knowledge-question session. Do not modify files or run commands that require approval.",
].join(" ");

class CodexVaultChatPlugin extends Plugin {
  settings = { codexPath: DEFAULT_CODEX_PATH, nodePath: DEFAULT_NODE_PATH, model: "", effort: "", proxy: "" };
  vaultPath = "";

  async onload() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("AskVault requires a desktop local vault.");
      return;
    }
    this.vaultPath = adapter.getBasePath();
    this.settings = Object.assign(this.settings, (await this.loadData()) || {});
    this.registerView(VIEW_TYPE, (leaf) => new CodexVaultChatView(leaf, this));
    this.addRibbonIcon("bot-message-square", "打开 AskVault", () => this.openPanel());
    this.addCommand({
      id: "open-panel",
      name: "Open read-only vault chat",
      callback: () => this.openPanel(),
    });
    this.addSettingTab(new CodexVaultChatSettings(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async openPanel() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async loadAvailableModels() {
    const client = this.createClient({
      onNotification: () => {},
      onLog: () => {},
      onExit: () => {},
    });
    try {
      await client.connect();
      const result = await client.request("model/list", { includeHidden: false, limit: 100 });
      return (result.data || []).filter((model) => !model.hidden);
    } finally {
      client.stop();
    }
  }

  createClient(handlers) {
    return new CodexAppServerClient(
      this.settings.codexPath,
      this.settings.nodePath,
      this.vaultPath,
      this.settings.proxy,
      handlers
    );
  }
}

class CodexVaultChatView extends ItemView {
  plugin;
  client = null;
  threadId = null;
  activeTurnId = null;
  outputEl = null;
  statusEl = null;
  composerEl = null;
  sendButton = null;
  pendingAssistantEl = null;
  scopeEl = null;
  contextEl = null;
  contextKey = null;
  messages = [];
  usedContexts = new Set();
  connectionLogs = [];

  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "AskVault";
  }

  getIcon() {
    return "bot-message-square";
  }

  async onOpen() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("ask-vault");

    const header = root.createDiv({ cls: "ask-vault__header" });
    header.createEl("h2", { text: "AskVault" });
    const headerActions = header.createDiv({ cls: "ask-vault__header-actions" });
    const save = headerActions.createEl("button", {
      cls: "clickable-icon",
      text: "保存",
      attr: { "aria-label": "将当前对话保存为笔记" },
    });
    save.addEventListener("click", () => this.saveConversation());
    const reconnect = headerActions.createEl("button", {
      cls: "clickable-icon",
      text: "重连",
      attr: { "aria-label": "重新连接 Codex" },
    });
    reconnect.addEventListener("click", () => this.reconnect());

    this.statusEl = root.createDiv({ cls: "ask-vault__status" });
    this.outputEl = root.createDiv({ cls: "ask-vault__messages" });
    this.addSystemMessage("只读模式：当前笔记正文仅在首次提问或内容变化后发送；连续追问会复用上下文以减少消耗。");

    const composer = root.createDiv({ cls: "ask-vault__composer" });
    const scopeControls = composer.createDiv({ cls: "ask-vault__controls" });
    scopeControls.createEl("label", { text: "检索范围" });
    this.scopeEl = scopeControls.createEl("select");
    this.scopeEl.createEl("option", { text: "当前笔记", attr: { value: "current-note" } });
    this.scopeEl.createEl("option", { text: "整个知识库", attr: { value: "vault" } });
    this.scopeEl.value = "current-note";
    this.scopeEl.addEventListener("change", () => {
      this.contextKey = null;
      this.refreshContextLabel();
    });
    this.contextEl = composer.createDiv({ cls: "ask-vault__context" });
    this.refreshContextLabel();
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshContextLabel()));
    this.composerEl = composer.createEl("textarea", {
      attr: {
        rows: "4",
        placeholder: "例如：请总结这一页的核心观点，并指出我可以继续追问的问题。",
      },
    });
    this.composerEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.sendQuestion();
      }
    });
    this.sendButton = composer.createEl("button", {
      cls: "mod-cta",
      text: "发送给 Codex",
    });
    this.sendButton.addEventListener("click", () => this.sendQuestion());
    composer.createEl("small", { text: "Cmd/Ctrl + Enter 发送" });

    await this.connect();
  }

  async onClose() {
    this.client?.stop();
    this.client = null;
  }

  async reconnect() {
    this.client?.stop();
    this.client = null;
    this.threadId = null;
    this.activeTurnId = null;
    this.contextKey = null;
    await this.connect();
  }

  async connect() {
    this.setStatus("正在连接 Codex...");
    this.setBusy(true);
    this.client = this.plugin.createClient({
      onNotification: (message) => this.handleNotification(message),
      onLog: (message) => {
        this.connectionLogs.push(message);
        const lower = message.toLowerCase();
        if (lower.includes("error") || lower.includes("limit") || lower.includes("quota") || lower.includes("warning") || lower.includes("fail")) {
          this.addSystemMessage(`[Codex CLI] ${message}`);
        }
      },
      onExit: (message) => {
        this.setStatus("连接已断开");
        this.setBusy(false);
        this.activeTurnId = null;
        this.pendingAssistantEl = null;
        this.addSystemMessage(message);
      },
    });

    try {
      this.connectionLogs = [];
      await this.client.connect();
      this.setStatus(`已连接：${this.client.launch.description}`);
      if (this.client.launch.fallbackMessage) {
        this.addSystemMessage(this.client.launch.fallbackMessage);
      }
    } catch (error) {
      this.setStatus("连接失败");
      this.addSystemMessage(formatError(error));
      if (this.client.launch) {
        this.addSystemMessage(`尝试的启动方式：${this.client.launch.description}。可在 AskVault 设置中留空路径以启用自动查找。`);
      }
      for (const message of this.connectionLogs) {
        this.addSystemMessage(`[Codex] ${message}`);
      }
      this.client.stop();
      this.client = null;
    } finally {
      this.setBusy(false);
    }
  }

  async sendQuestion() {
    const text = this.composerEl.value.trim();
    if (!text || this.activeTurnId) {
      return;
    }
    if (!this.client) {
      await this.connect();
    }
    if (!this.client) {
      return;
    }

    let prompt;
    let contextKey;
    let includesDocument;
    let contextDescription;
    let sourcePath;
    try {
      ({ prompt, contextKey, includesDocument, contextDescription, sourcePath } = await this.buildScopedPrompt(text));
    } catch (error) {
      new Notice(formatError(error));
      return;
    }

    if (this.contextKey !== contextKey) {
      this.threadId = null;
      this.contextKey = contextKey;
      this.addSystemMessage(`已切换上下文：${this.contextLabel()}`);
    }

    this.usedContexts.add(sourcePath ? `[[${sourcePath.replace(/\.md$/, "")}]]` : contextDescription);
    this.messages.push({ role: "user", text });
    this.addMessage("user", text);
    this.composerEl.value = "";
    this.messages.push({ role: "assistant", text: "" });
    this.pendingAssistantEl = this.addMessage("assistant", "");
    this.setBusy(true);
    this.setStatus(includesDocument ? "Codex 正在读取笔记并回答..." : "Codex 正在继续回答...");

    try {
      if (!this.threadId) {
        const result = await this.client.request("thread/start", {
          cwd: this.plugin.vaultPath,
          serviceName: "ask-vault",
          developerInstructions: SYSTEM_PROMPT,
          ephemeral: true,
          sandbox: "read-only",
          approvalPolicy: "never",
          environments: [],
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        });
        this.threadId = result.thread.id;
      }
      const result = await this.client.request("turn/start", {
        threadId: this.threadId,
        cwd: this.plugin.vaultPath,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        ...(this.plugin.settings.model ? { model: this.plugin.settings.model } : {}),
        ...(this.plugin.settings.effort ? { effort: this.plugin.settings.effort } : {}),
      });
      this.activeTurnId = result.turn.id;
    } catch (error) {
      this.pendingAssistantEl.setText(formatError(error));
      this.pendingAssistantEl.addClass("is-error");
      this.messages[this.messages.length - 1].text = formatError(error);
      this.pendingAssistantEl = null;
      this.activeTurnId = null;
      this.setBusy(false);
      this.setStatus("发送失败");
    }
  }

  async buildScopedPrompt(question) {
    if (this.scopeEl.value === "vault") {
      return {
        contextKey: "vault",
        includesDocument: false,
        contextDescription: "整个知识库",
        sourcePath: null,
        prompt: [
          "回答范围：整个 Obsidian 知识库。",
          "请按需检索当前 vault 内相关 Markdown 笔记，回答时注明引用的文件名。",
          "",
          `用户问题：${question}`,
        ].join("\n"),
      };
    }

    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      throw new Error("当前没有打开 Markdown 笔记。请先打开一篇笔记，或将检索范围切换为“整个知识库”。");
    }
    const contextKey = `note:${file.path}:${file.stat.mtime}:${file.stat.size}`;
    if (this.threadId && this.contextKey === contextKey) {
      return {
        contextKey,
        includesDocument: false,
        contextDescription: `当前笔记：${file.basename}`,
        sourcePath: file.path,
        prompt: [
          "回答范围：仅限先前已提供的当前笔记。",
          "继续基于本会话中已经提供的当前笔记内容回答。不要搜索、读取或引用 vault 中其他文件，除非用户明确要求扩大范围。",
          `当前笔记文件名：${file.path}`,
          "",
          `用户追问：${question}`,
        ].join("\n"),
      };
    }

    const content = await this.app.vault.cachedRead(file);
    return {
      contextKey,
      includesDocument: true,
      contextDescription: `当前笔记：${file.basename}`,
      sourcePath: file.path,
      prompt: [
        "回答范围：仅限当前笔记。",
        "只使用下方提供的当前笔记内容回答。不要搜索、读取或引用 vault 中其他文件，除非用户明确要求扩大范围。",
        `当前笔记文件名：${file.path}`,
        "",
        "----- 当前笔记内容开始 -----",
        content,
        "----- 当前笔记内容结束 -----",
        "",
        `用户问题：${question}`,
      ].join("\n"),
    };
  }

  contextLabel() {
    if (this.scopeEl?.value === "vault") {
      return "整个知识库";
    }
    const file = this.app.workspace.getActiveFile();
    return file && file.extension === "md" ? `当前笔记：${file.basename}` : "当前笔记：未打开笔记";
  }

  refreshContextLabel() {
    if (this.contextEl) {
      this.contextEl.setText(this.contextLabel());
    }
  }

  async saveConversation() {
    const messages = this.messages.filter((message) => message.text.trim());
    if (!messages.length) {
      new Notice("当前没有可保存的对话。");
      return;
    }

    if (!this.app.vault.getAbstractFileByPath(EXPORT_FOLDER)) {
      await this.app.vault.createFolder(EXPORT_FOLDER);
    }

    const now = new Date();
    const contexts = Array.from(this.usedContexts);
    const linkedContext = contexts.length === 1 && contexts[0].startsWith("[[") ? contexts[0] : null;
    const subject = linkedContext ? linkedContext.slice(2, -2).split("/").pop() : "知识问答";
    const date = formatLocalDate(now);
    const filePath = this.availableExportPath(sanitizeFilename(`${date} ${subject} Codex 对话`));
    const content = [
      "---",
      'type: "ask-vault-chat"',
      `created: "${now.toISOString()}"`,
      'scope: "saved-conversation"',
      "---",
      "",
      `# ${subject} - Codex 对话`,
      "",
      `- 日期：${date}`,
      "- 使用上下文：",
      ...contexts.map((context) => `  - ${context}`),
      "",
      "## 对话",
      "",
      ...messages.flatMap((message) => [
        `### ${message.role === "user" ? "我" : "Codex"}`,
        "",
        message.text.trim(),
        "",
      ]),
    ].join("\n");

    const file = await this.app.vault.create(filePath, content);
    new Notice(`对话已保存到 ${file.path}`);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  availableExportPath(baseName) {
    let suffix = 0;
    let path;
    do {
      path = `${EXPORT_FOLDER}/${baseName}${suffix ? ` ${suffix}` : ""}.md`;
      suffix += 1;
    } while (this.app.vault.getAbstractFileByPath(path));
    return path;
  }

  handleNotification(message) {
    const params = message.params || {};
    if (message.method === "item/agentMessage/delta") {
      const turnId = params.turnId || params.item?.turnId;
      if (turnId && this.activeTurnId && turnId !== this.activeTurnId) {
        return;
      }
      if (this.pendingAssistantEl) {
        this.pendingAssistantEl.appendText(params.delta || "");
        this.messages[this.messages.length - 1].text += params.delta || "";
        this.scrollToBottom();
      }
      return;
    }
    if (message.method === "item/completed") {
      const item = params.item || {};
      if (item.type === "agentMessage") {
        const fullText = extractTextFromItem(item);
        if (fullText && this.pendingAssistantEl) {
          this.pendingAssistantEl.setText(fullText);
          this.messages[this.messages.length - 1].text = fullText;
          this.scrollToBottom();
        }
      }
      return;
    }
    if (message.method === "item/reasoning/summaryTextDelta") {
      this.setStatus("Codex 正在分析相关笔记...");
      return;
    }
    if (message.method === "turn/completed") {
      const completedTurnId = params.turn?.id;
      if (completedTurnId && this.activeTurnId && completedTurnId !== this.activeTurnId) {
        return;
      }
      const turnStatus = params.turn?.status;
      const turnError = params.turn?.error;
      if (this.pendingAssistantEl && !(this.pendingAssistantEl.textContent || "").trim()) {
        if (turnStatus === "failed" && turnError) {
          const errMsg = `Codex 运行失败: ${turnError.message || JSON.stringify(turnError)}`;
          this.pendingAssistantEl.setText(errMsg);
          this.pendingAssistantEl.addClass("is-error");
          this.messages[this.messages.length - 1].text = errMsg;
        } else {
          this.pendingAssistantEl.setText("Codex 已完成，但没有返回可显示的文本。");
          this.messages[this.messages.length - 1].text = "Codex 已完成，但没有返回可显示的文本。";
        }
      }
      this.pendingAssistantEl = null;
      this.activeTurnId = null;
      this.setBusy(false);
      this.setStatus("已连接，等待提问");
    }
  }

  setStatus(text) {
    this.statusEl?.setText(text);
  }

  setBusy(busy) {
    if (this.sendButton) {
      this.sendButton.disabled = busy;
    }
  }

  addSystemMessage(text) {
    const el = this.outputEl.createDiv({ cls: "ask-vault__system", text });
    this.scrollToBottom();
    return el;
  }

  addMessage(role, text) {
    const card = this.outputEl.createDiv({
      cls: `ask-vault__message ask-vault__message--${role}`,
    });
    card.createDiv({
      cls: "ask-vault__role",
      text: role === "user" ? "你" : "Codex",
    });
    const body = card.createDiv({ cls: "ask-vault__body", text });
    this.scrollToBottom();
    return body;
  }

  scrollToBottom() {
    if (this.outputEl) {
      this.outputEl.scrollTop = this.outputEl.scrollHeight;
    }
  }
}

class CodexAppServerClient {
  constructor(codexPath, nodePath, cwd, proxy, handlers) {
    this.codexPath = codexPath;
    this.nodePath = nodePath;
    this.cwd = cwd;
    this.proxy = proxy;
    this.handlers = handlers;
    this.process = null;
    this.reader = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    this.launch = resolveCodexLaunch(this.codexPath, this.nodePath);
    const command = this.launch.command;
    const args = this.launch.args;
    const env = { ...process.env };
    if (this.proxy) {
      env.HTTP_PROXY = this.proxy;
      env.HTTPS_PROXY = this.proxy;
      env.ALL_PROXY = this.proxy;
    }
    this.process = spawn(command, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: env,
    });
    this.process.stderr.on("data", (data) => {
      const text = data.toString("utf8").trim();
      if (text) {
        this.handlers.onLog(text);
      }
    });
    this.process.once("error", (error) => this.rejectAll(error));
    this.process.once("exit", (code, signal) => {
      this.rejectAll(new Error(`Codex 已退出: ${code ?? signal ?? "unknown"}`));
      this.handlers.onExit(`Codex 已退出: ${code ?? signal ?? "unknown"}`);
    });
    this.reader = readline.createInterface({ input: this.process.stdout });
    this.reader.on("line", (line) => this.handleLine(line));

    const initialized = await this.request("initialize", {
      clientInfo: {
        name: "ask_vault",
        title: "AskVault",
        version: "0.1.3",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ method: "initialized" });
    return initialized;
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时: ${method}`));
      }, 120000);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.send({ id, method, params });
    });
  }

  send(message) {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error("Codex app-server 未运行。");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handlers.onLog(`无法解析 app-server 输出: ${line}`);
      this.rejectAll(
        new Error("Codex executable did not start a compatible app-server. Install a recent Codex CLI or set its absolute path in AskVault settings.")
      );
      return;
    }
    if (message.id !== undefined && message.method) {
      this.send({
        id: message.id,
        error: { code: -32601, message: "AskVault does not handle approval requests." },
      });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      window.clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      this.handlers.onNotification(message);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  stop() {
    this.reader?.close();
    this.reader = null;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
  }
}

class CodexVaultChatSettings extends PluginSettingTab {
  availableModels = [];
  loadSequence = 0;

  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "AskVault 设置" });
    new Setting(this.containerEl)
      .setName("Codex executable")
      .setDesc("留空（推荐）时自动查找本机 Codex CLI。仅在自动检测失败时填写完整路径。")
      .addText((text) => {
        text.setPlaceholder("自动检测").setValue(this.plugin.settings.codexPath).onChange(async (value) => {
          this.plugin.settings.codexPath = value.trim() || DEFAULT_CODEX_PATH;
          await this.plugin.saveSettings();
        });
      });
    new Setting(this.containerEl)
      .setName("Node executable")
      .setDesc("通常保持为空。仅当上方手动指定的是 codex.js 文件时，填写 Node 可执行文件路径。")
      .addText((text) => {
        text.setPlaceholder("通常无需设置").setValue(this.plugin.settings.nodePath).onChange(async (value) => {
          this.plugin.settings.nodePath = value.trim() || DEFAULT_NODE_PATH;
          await this.plugin.saveSettings();
        });
      });
    let modelDropdown;
    let effortDropdown;
    new Setting(this.containerEl)
      .setName("默认模型")
      .setDesc("AskVault 提问时使用的 Codex 模型。模型列表由本地 Codex 提供。")
      .addDropdown((dropdown) => {
        modelDropdown = dropdown;
        this.populateModelOptions(dropdown);
        dropdown.onChange(async (value) => {
          this.plugin.settings.model = value;
          this.plugin.settings.effort = "";
          await this.plugin.saveSettings();
          this.populateEffortOptions(effortDropdown);
        });
      })
      .addButton((button) => {
        button.setButtonText("刷新模型").onClick(() => {
          this.refreshModels(modelDropdown, effortDropdown);
        });
      });
    new Setting(this.containerEl)
      .setName("默认思考深度")
      .setDesc("AskVault 提问时使用的推理强度。可选项随模型变化。")
      .addDropdown((dropdown) => {
        effortDropdown = dropdown;
        this.populateEffortOptions(dropdown);
        dropdown.onChange(async (value) => {
          this.plugin.settings.effort = value;
          await this.plugin.saveSettings();
        });
      });
    this.refreshModels(modelDropdown, effortDropdown);
    new Setting(this.containerEl)
      .setName("HTTP Proxy")
      .setDesc("可选代理地址，例如 http://127.0.0.1:7890。此配置因电脑和网络而异，不应随插件分发。")
      .addText((text) => {
        text.setValue(this.plugin.settings.proxy || "").onChange(async (value) => {
          this.plugin.settings.proxy = value.trim();
          await this.plugin.saveSettings();
        });
      });
  }

  hide() {
    this.loadSequence += 1;
    super.hide();
  }

  async refreshModels(modelDropdown, effortDropdown) {
    const sequence = ++this.loadSequence;
    try {
      const availableModels = await this.plugin.loadAvailableModels();
      if (sequence !== this.loadSequence) {
        return;
      }
      this.availableModels = availableModels;
      this.populateModelOptions(modelDropdown);
      this.populateEffortOptions(effortDropdown);
    } catch (error) {
      if (sequence === this.loadSequence) {
        new Notice(`无法读取 Codex 模型列表：${formatError(error)}`);
      }
    }
  }

  populateModelOptions(dropdown) {
    if (!dropdown) {
      return;
    }
    const savedModel = this.plugin.settings.model || "";
    dropdown.selectEl.empty();
    dropdown.addOption("", "Codex 默认");
    for (const model of this.availableModels) {
      const value = model.model || model.id;
      if (value) {
        dropdown.addOption(value, value);
      }
    }
    if (savedModel && !this.availableModels.some((model) => (model.model || model.id) === savedModel)) {
      dropdown.addOption(savedModel, `${savedModel} (已保存)`);
    }
    dropdown.setValue(savedModel);
  }

  populateEffortOptions(dropdown) {
    if (!dropdown) {
      return;
    }
    const selectedModel = this.plugin.settings.model
      ? this.availableModels.find((model) => (model.model || model.id) === this.plugin.settings.model)
      : this.availableModels.find((model) => model.isDefault);
    const supported = selectedModel?.supportedReasoningEfforts
      ?.map((entry) => entry.reasoningEffort)
      .filter(Boolean) || ["low", "medium", "high", "xhigh"];
    const savedEffort = this.plugin.settings.effort || "";
    dropdown.selectEl.empty();
    dropdown.addOption("", "Codex 默认");
    for (const effort of supported) {
      dropdown.addOption(effort, effort);
    }
    if (savedEffort && !supported.includes(savedEffort)) {
      this.plugin.settings.effort = "";
      void this.plugin.saveSettings();
    }
    dropdown.setValue(this.plugin.settings.effort || "");
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatLocalDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim();
}

function resolveCodexLaunch(codexPath, nodePath) {
  const configuredCodex = (codexPath || "").trim();
  const configuredNode = (nodePath || "").trim();
  const shouldAutoDetect = !configuredCodex || configuredCodex === CODEX_COMMAND;

  if (!shouldAutoDetect && commandExists(configuredCodex) && (!configuredNode || commandExists(configuredNode))) {
    return createCodexLaunch(configuredCodex, configuredNode, configuredNode ? `${configuredNode} ${configuredCodex}` : configuredCodex, "");
  }

  const detected = detectCodexExecutable() || CODEX_COMMAND;
  const fallbackMessage = shouldAutoDetect
    ? ""
    : `保存的 Codex/Node 路径在本机不可用，已自动改用 ${detected}。请在设置中清空旧路径以保存可移植配置。`;
  return createCodexLaunch(detected, "", `${detected}（自动检测）`, fallbackMessage);
}

function createCodexLaunch(codexPath, nodePath, description, fallbackMessage) {
  if (nodePath) {
    return {
      command: nodePath,
      args: [codexPath, "app-server"],
      description,
      fallbackMessage,
    };
  }
  if (process.platform === "win32" && /\.cmd$/i.test(codexPath)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${codexPath}" app-server`],
      description,
      fallbackMessage,
    };
  }
  return {
    command: codexPath,
    args: ["app-server"],
    description,
    fallbackMessage,
  };
}

function detectCodexExecutable() {
  const executableName = process.platform === "win32" ? "codex.cmd" : CODEX_COMMAND;
  const home = os.homedir();
  const userInstallCandidates = process.platform === "win32"
    ? [path.join(process.env.APPDATA || "", "npm", "codex.cmd")]
    : [
        path.join(home, ".npm-global", "bin", CODEX_COMMAND),
        path.join(home, ".local", "bin", CODEX_COMMAND),
        path.join(home, ".volta", "bin", CODEX_COMMAND),
        path.join(home, ".bun", "bin", CODEX_COMMAND),
      ];
  const desktopAppCandidates = process.platform === "darwin"
    ? ["/Applications/Codex.app/Contents/Resources/codex"]
    : [];
  const systemInstallCandidates = process.platform === "win32" ? [] : ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
  const preferredInstall = userInstallCandidates.find((candidate) => candidate && commandExists(candidate));
  const desktopInstall = desktopAppCandidates.find((candidate) => commandExists(candidate));
  const systemInstall = systemInstallCandidates.find((candidate) => commandExists(candidate));
  return preferredInstall || desktopInstall || findCommandOnPath(executableName) || systemInstall || "";
}

function findCommandOnPath(command) {
  const pathValue = process.env.PATH || "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (commandExists(candidate)) {
      return candidate;
    }
  }
  return "";
}

function commandExists(command) {
  if (!path.isAbsolute(command) && !command.includes("/") && !command.includes("\\")) {
    return Boolean(findCommandOnPath(command));
  }
  try {
    fs.accessSync(command, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function extractTextFromItem(item) {
  if (!item) return "";
  if (typeof item.content === "string") {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    return item.content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block.text === "string") return block.text;
        if (block && typeof block.string === "string") return block.string;
        return "";
      })
      .join("");
  }
  return "";
}

module.exports = CodexVaultChatPlugin;
