const { FileSystemAdapter, ItemView, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const { spawn } = require("child_process");
const readline = require("readline");

const VIEW_TYPE = "ask-vault-view";
const EXPORT_FOLDER = "Codex 对话";
const DEFAULT_CODEX_PATH = "codex";
const DEFAULT_NODE_PATH = "";
const SYSTEM_PROMPT = [
  "You answer questions about the Obsidian vault that is your current working directory.",
  "Follow the scope specified in each question: when it says current note only, use only the supplied note text; when it says whole vault, read Markdown notes as needed.",
  "When answering from notes, cite relevant note filenames.",
  "This is a read-only knowledge-question session. Do not modify files or run commands that require approval.",
].join(" ");

class CodexVaultChatPlugin extends Plugin {
  settings = { codexPath: DEFAULT_CODEX_PATH, nodePath: DEFAULT_NODE_PATH, model: "", effort: "" };
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
  modelEl = null;
  effortEl = null;
  contextEl = null;
  contextKey = null;
  messages = [];
  usedContexts = new Set();
  connectionLogs = [];
  availableModels = [];

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
    const modelControls = composer.createDiv({ cls: "ask-vault__controls" });
    modelControls.createEl("label", { text: "模型" });
    this.modelEl = modelControls.createEl("select");
    this.modelEl.createEl("option", { text: "Codex 默认", attr: { value: "" } });
    this.modelEl.value = this.plugin.settings.model || "";
    this.modelEl.addEventListener("change", async () => {
      this.plugin.settings.model = this.modelEl.value;
      this.plugin.settings.effort = "";
      await this.plugin.saveSettings();
      this.populateEffortOptions();
    });
    const effortControls = composer.createDiv({ cls: "ask-vault__controls" });
    effortControls.createEl("label", { text: "思考深度" });
    this.effortEl = effortControls.createEl("select");
    this.populateEffortOptions();
    this.effortEl.addEventListener("change", async () => {
      this.plugin.settings.effort = this.effortEl.value;
      await this.plugin.saveSettings();
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
    this.client = new CodexAppServerClient(
      this.plugin.settings.codexPath,
      this.plugin.settings.nodePath,
      this.plugin.vaultPath,
      {
        onNotification: (message) => this.handleNotification(message),
        onLog: (message) => this.connectionLogs.push(message),
        onExit: (message) => {
          this.setStatus("连接已断开");
          this.setBusy(false);
          this.addSystemMessage(message);
        },
      }
    );

    try {
      this.connectionLogs = [];
      await this.client.connect();
      await this.loadModels();
      this.setStatus("已连接，当前 vault 可用于问答");
    } catch (error) {
      this.setStatus("连接失败");
      this.addSystemMessage(formatError(error));
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

  async loadModels() {
    try {
      const result = await this.client.request("model/list", { includeHidden: false, limit: 100 });
      this.availableModels = (result.data || []).filter((model) => !model.hidden);
    } catch (error) {
      this.availableModels = [];
    }
    this.populateModelOptions();
    this.populateEffortOptions();
  }

  populateModelOptions() {
    if (!this.modelEl) {
      return;
    }
    const savedModel = this.plugin.settings.model || "";
    this.modelEl.empty();
    this.modelEl.createEl("option", { text: "Codex 默认", attr: { value: "" } });
    for (const model of this.availableModels) {
      const value = model.model || model.id;
      if (value) {
        this.modelEl.createEl("option", { text: value, attr: { value } });
      }
    }
    if (savedModel && !this.availableModels.some((model) => (model.model || model.id) === savedModel)) {
      this.modelEl.createEl("option", { text: `${savedModel} (已保存)`, attr: { value: savedModel } });
    }
    this.modelEl.value = savedModel;
  }

  populateEffortOptions() {
    if (!this.effortEl) {
      return;
    }
    const selectedModel = this.plugin.settings.model
      ? this.availableModels.find((model) => (model.model || model.id) === this.plugin.settings.model)
      : this.availableModels.find((model) => model.isDefault);
    const supported = selectedModel?.supportedReasoningEfforts
      ?.map((entry) => entry.reasoningEffort)
      .filter(Boolean) || ["low", "medium", "high", "xhigh"];
    const savedEffort = this.plugin.settings.effort || "";
    this.effortEl.empty();
    this.effortEl.createEl("option", { text: "Codex 默认", attr: { value: "" } });
    for (const effort of supported) {
      this.effortEl.createEl("option", { text: effort, attr: { value: effort } });
    }
    if (savedEffort && !supported.includes(savedEffort)) {
      this.plugin.settings.effort = "";
    }
    this.effortEl.value = this.plugin.settings.effort || "";
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
      if (this.activeTurnId && params.turnId !== this.activeTurnId) {
        return;
      }
      if (this.pendingAssistantEl) {
        this.pendingAssistantEl.appendText(params.delta || "");
        this.messages[this.messages.length - 1].text += params.delta || "";
        this.scrollToBottom();
      }
      return;
    }
    if (message.method === "item/reasoning/summaryTextDelta") {
      this.setStatus("Codex 正在分析相关笔记...");
      return;
    }
    if (message.method === "turn/completed" && params.turn?.id === this.activeTurnId) {
      if (this.pendingAssistantEl && !(this.pendingAssistantEl.textContent || "").trim()) {
        this.pendingAssistantEl.setText("Codex 已完成，但没有返回可显示的文本。");
        this.messages[this.messages.length - 1].text = "Codex 已完成，但没有返回可显示的文本。";
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
  constructor(codexPath, nodePath, cwd, handlers) {
    this.codexPath = codexPath;
    this.nodePath = nodePath;
    this.cwd = cwd;
    this.handlers = handlers;
    this.process = null;
    this.reader = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    const command = this.nodePath || this.codexPath;
    const args = this.nodePath ? [this.codexPath, "app-server"] : ["app-server"];
    this.process = spawn(command, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
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
        version: "0.1.0",
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
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Codex executable")
      .setDesc("用于启动 `codex app-server` 的完整路径。")
      .addText((text) => {
        text.setValue(this.plugin.settings.codexPath).onChange(async (value) => {
          this.plugin.settings.codexPath = value.trim() || DEFAULT_CODEX_PATH;
          await this.plugin.saveSettings();
        });
      });
    new Setting(this.containerEl)
      .setName("Node executable")
      .setDesc("Optional Node path when Codex executable points to a JavaScript file after a GUI PATH issue.")
      .addText((text) => {
        text.setValue(this.plugin.settings.nodePath).onChange(async (value) => {
          this.plugin.settings.nodePath = value.trim() || DEFAULT_NODE_PATH;
          await this.plugin.saveSettings();
        });
      });
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

module.exports = CodexVaultChatPlugin;
