/**
 * Settings dialog: model & thinking, workspace rules, extensions/MCP, permissions.
 */

let currentSettingsData = null;
let selectedThinkingLevel = "high";
let settingsReturnFocus = null;

/** Display names only; which levels exist and their order come from the server (runtime/thinking.ts). */
const THINKING_LABELS = { off: "关闭", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极限" };

const RULE_PRESETS = {
  Surgical: "\n## 最小改动\n- 只改实现需求所必需的文件与代码行。\n- 不做无关的格式化、重构或清理。\n",
  TestFirst: "\n## 交付前跑测试\n- 交付前运行受影响模块的测试并确认通过。\n- 回复里附上测试命令与结果。\n",
  Security: "\n## 不硬编码凭据\n- 源码与日志里不写任何 API Key 或密钥，使用环境变量。\n- 数据库与命令调用一律参数化。\n",
};

function initSettingsModal() {
  const dialog = $("settings-modal");
  $("btn-open-settings").addEventListener("click", openSettingsModal);
  $("btn-close-settings").addEventListener("click", closeSettingsModal);
  $("btn-cancel-settings").addEventListener("click", closeSettingsModal);
  $("btn-save-settings").addEventListener("click", saveSettings);
  // Clicking the backdrop (the dialog element itself, outside its content) closes it.
  dialog.addEventListener("click", (e) => { if (e.target === dialog) closeSettingsModal(); });
  dialog.addEventListener("close", () => settingsReturnFocus?.focus());

  const tabs = [...document.querySelectorAll(".settings-tab")];
  tabs.forEach(btn => btn.addEventListener("click", () => selectSettingsTab(btn)));
  initRovingTabs(tabs, selectSettingsTab, "vertical");

  $("setting-provider-select").addEventListener("change", () => reflectProvider($("setting-provider-select").value));
}

function selectSettingsTab(btn) {
  document.querySelectorAll(".settings-tab").forEach(b => {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".settings-pane").forEach(c => c.classList.remove("active"));
  $("settings-pane-" + btn.dataset.settingsTab)?.classList.add("active");
}

/** Catalog presets first, then providers that only exist in the user's config. */
function providerChoices(data) {
  const catalog = (data.catalog || []).map(p => ({ id: p.id, label: p.label, apiKeyEnv: p.apiKeyEnv, defaultModel: p.defaultModel, models: p.sampleModels || [], hasKey: p.hasKey }));
  for (const p of data.providers || []) {
    const known = catalog.find(c => c.id === p.name);
    if (known) {
      known.hasKey = known.hasKey || p.hasKey;
      if (p.model && !known.models.includes(p.model)) known.models.unshift(p.model);
    } else {
      catalog.push({ id: p.name, label: p.name + "（配置文件）", apiKeyEnv: p.apiKeyEnv, defaultModel: p.model, models: p.model ? [p.model] : [], hasKey: p.hasKey });
    }
  }
  return catalog;
}

function renderSettingsCatalog(data) {
  const select = $("setting-provider-select");
  select.replaceChildren(...providerChoices(data).map(p => {
    const option = el("option", null, p.label + (p.hasKey ? "" : " · 未配置凭据"));
    option.value = p.id;
    return option;
  }));
  $("setting-thinking-picker").replaceChildren(...(data.thinkingLevels || []).map(level => {
    const b = el("button", "segmented-btn", THINKING_LABELS[level] || level);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.level = level;
    b.addEventListener("click", () => selectThinkingLevel(level));
    return b;
  }));
}

function reflectProvider(providerId) {
  const provider = providerChoices(currentSettingsData || {}).find(p => p.id === providerId);
  $("setting-model-input").placeholder = provider?.defaultModel || "";
  $("setting-model-options").replaceChildren(...(provider?.models || []).map(m => { const o = el("option"); o.value = m; return o; }));
  $("provider-key-env-name").textContent = provider?.apiKeyEnv || "";
  $("provider-key-status").className = "key-badge" + (provider?.hasKey ? "" : " missing");
  $("provider-key-status-text").textContent = provider?.hasKey ? "已找到凭据" : "未找到凭据";
}

function selectThinkingLevel(level) {
  selectedThinkingLevel = level;
  document.querySelectorAll("#setting-thinking-picker .segmented-btn").forEach(b => {
    const on = b.dataset.level === level;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}

async function openSettingsModal() {
  settingsReturnFocus = document.activeElement;
  $("settings-modal").showModal();
  await Promise.all([loadSettings(), loadRules(), loadExtensions()]);
}

function closeSettingsModal() {
  $("settings-modal").close();
}

async function loadSettings() {
  try {
    const data = await api("/api/settings");
    currentSettingsData = data;
    renderSettingsCatalog(data);
    if (data.configPath) $("setting-config-path").textContent = data.configPath;
    const g = data.general || {};
    const select = $("setting-provider-select");
    // A default the catalog does not know is still the user's setting: show it rather than silently picking another.
    if (g.defaultProvider && ![...select.options].some(o => o.value === g.defaultProvider)) {
      const option = el("option", null, g.defaultProvider + "（未配置）");
      option.value = g.defaultProvider;
      select.prepend(option);
    }
    if (g.defaultProvider) select.value = g.defaultProvider;
    $("setting-model-input").value = g.defaultModel || "";
    if (g.maxTurns) $("setting-max-turns").value = g.maxTurns;
    if (g.maxSessionTokens) $("setting-max-tokens").value = g.maxSessionTokens;
    if (g.repeatToolLimit !== undefined) $("setting-repeat-tool-limit").value = g.repeatToolLimit;
    selectThinkingLevel(g.defaultThinkingLevel || "off");
    reflectProvider($("setting-provider-select").value);
  } catch (err) {
    showToast("无法读取设置：" + err.message, "error");
  }
}

async function loadRules(force = false) {
  try {
    const data = await api("/api/rules");
    $("setting-rules-editor").value = data.content || "";
    $("rules-file-indicator").textContent = (data.filename || "AGENTS.md") + (data.exists ? "" : "（尚未创建）");
    if (force) showToast("已重新读取 AGENTS.md", "success");
  } catch (err) {
    showToast("无法读取 AGENTS.md：" + err.message, "error");
  }
}

function itemRow(icon, name, tag, desc) {
  return el("li", "item-row",
    el("span", "item-icon", xioIcon(icon)),
    el("div", "item-main",
      el("div", "item-name", name, tag ? el("span", "item-tag", tag) : null),
      desc ? el("p", "item-desc", desc) : null));
}

async function loadExtensions() {
  try {
    const data = await api("/api/extensions");
    const extensions = data.extensions || [];
    $("plugins-container").replaceChildren(...(extensions.length
      ? extensions.map(ext => itemRow("layers", ext.name, ext.category || null, ext.description))
      : [el("li", "item-empty", "没有装配扩展。")]));
    const servers = data.mcpServers || [];
    $("mcp-container").replaceChildren(...(servers.length
      ? servers.map(s => itemRow("plug", s.name, s.transport, "来源：" + s.source))
      : [el("li", "item-empty", "没有发现 MCP 服务器。可以在工作区 .mcp.json 或配置文件的 [mcp] 段里添加。")]));
  } catch (err) {
    showToast("无法读取扩展列表：" + err.message, "error");
  }
}

function appendRulePreset(type) {
  const editor = $("setting-rules-editor");
  editor.value = (editor.value.trim() + (RULE_PRESETS[type] || "")).trim() + "\n";
}

function readInt(id, fallback) {
  const n = parseInt($(id).value, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function saveSettings() {
  const btnSave = $("btn-save-settings");
  btnSave.textContent = "保存中…";
  btnSave.disabled = true;
  try {
    const providerName = $("setting-provider-select").value;
    const modelName = $("setting-model-input").value.trim();
    const apiKey = $("setting-api-key-input").value.trim();
    await api("/api/settings", {
      method: "POST",
      body: {
        general: {
          defaultProvider: providerName,
          ...(modelName ? { defaultModel: modelName } : {}),
          defaultThinkingLevel: selectedThinkingLevel,
          maxTurns: readInt("setting-max-turns", 24),
          maxSessionTokens: readInt("setting-max-tokens", 48000),
          repeatToolLimit: readInt("setting-repeat-tool-limit", 0),
        },
        provider: { name: providerName, ...(modelName ? { model: modelName } : {}), ...(apiKey ? { apiKey } : {}) },
      },
    });
    await api("/api/rules", { method: "POST", body: { content: $("setting-rules-editor").value } });
    $("setting-api-key-input").value = "";
    showToast("已保存，新会话生效", "success");
    closeSettingsModal();
    fetchStatus();
  } catch (err) {
    showToast("保存失败：" + err.message, "error");
  } finally {
    btnSave.textContent = "保存";
    btnSave.disabled = false;
  }
}
