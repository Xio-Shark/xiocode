/**
 * Settings dialog: model & thinking, workspace rules, extensions/MCP, permissions.
 */

let currentSettingsData = null;
let selectedThinkingLevel = "high";
let settingsReturnFocus = null;

/** Display names only; which levels exist and their order come from the server (runtime/thinking.ts). */
const thinkingLabel = (level) => (MESSAGES["web.think." + level] === undefined ? level : t("web.think." + level));

const RULE_PRESETS = {
  Surgical: t("web.ruleSurgicalText"),
  TestFirst: t("web.ruleTestsText"),
  Security: t("web.ruleSecretsText"),
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
      catalog.push({ id: p.name, label: t("web.fromConfig", { name: p.name }), apiKeyEnv: p.apiKeyEnv, defaultModel: p.model, models: p.model ? [p.model] : [], hasKey: p.hasKey });
    }
  }
  return catalog;
}

function renderSettingsCatalog(data) {
  const select = $("setting-provider-select");
  select.replaceChildren(...providerChoices(data).map(p => {
    const option = el("option", null, p.label + (p.hasKey ? "" : t("web.noKey")));
    option.value = p.id;
    return option;
  }));
  $("setting-thinking-picker").replaceChildren(...(data.thinkingLevels || []).map(level => {
    const b = el("button", "segmented-btn", thinkingLabel(level));
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
  $("provider-key-status-text").textContent = provider?.hasKey ? t("web.keyFound") : t("web.keyMissing");
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
      const option = el("option", null, t("web.notConfigured", { name: g.defaultProvider }));
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
    showToast(t("web.settingsReadFailed", { error: err.message }), "error");
  }
}

async function loadRules(force = false) {
  try {
    const data = await api("/api/rules");
    $("setting-rules-editor").value = data.content || "";
    $("rules-file-indicator").textContent = (data.filename || "AGENTS.md") + (data.exists ? "" : t("web.notCreated"));
    if (force) showToast(t("web.rulesReloaded"), "success");
  } catch (err) {
    showToast(t("web.rulesReadFailed", { error: err.message }), "error");
  }
}

function itemRow(icon, name, tag, desc, aside) {
  return el("li", "item-row",
    el("span", "item-icon", xioIcon(icon)),
    el("div", "item-main",
      el("div", "item-name", name, tag ? el("span", "item-tag", tag) : null),
      desc ? el("p", "item-desc", desc) : null),
    aside || null);
}

const mcpSourceLabel = (source) => (MESSAGES["web.mcpSource." + source] === undefined ? source : t("web.mcpSource." + source));

function mcpStateBadge(server) {
  const label = {
    ok: t("web.mcpOk", { n: server.tools ?? 0 }),
    connecting: t("web.mcpConnecting"),
    failed: t("web.mcpFailed"),
    idle: t("web.mcpIdle"),
  }[server.state] || server.state;
  return el("span", "mcp-state " + server.state, el("span", "status-dot"), label);
}

function mcpRow(server) {
  const source = t("web.mcpSourceLabel", { source: mcpSourceLabel(server.source) });
  const desc = server.state === "failed" && server.error ? source + " · " + server.error : source;
  const row = itemRow("plug", server.name, server.transport || null, desc, mcpStateBadge(server));
  if (server.state === "failed") row.classList.add("failed");
  return row;
}

function renderMcpServers(servers, liveSessionId) {
  $("mcp-container").replaceChildren(...(servers.length
    ? servers.map(mcpRow)
    : [el("li", "item-empty", t("web.noMcp"))]));
  $("mcp-live-note").textContent = liveSessionId
    ? t("web.mcpLive")
    : t("web.mcpNoSession");
}

/** Live update from the session's event bus while the dialog is open. */
function onMcpStatus() {
  if ($("settings-modal").open) loadExtensions();
}

let extensionsRequest = 0;

/** Bundled extensions are described in the page language; anything else keeps the server's text. */
function extensionText(suffix, fallback) {
  return MESSAGES["web." + suffix] === undefined ? fallback : t("web." + suffix);
}

async function loadExtensions() {
  // Status events can arrive in bursts; only the latest answer may render.
  const request = ++extensionsRequest;
  try {
    const data = await api("/api/extensions");
    if (request !== extensionsRequest) return;
    const extensions = data.extensions || [];
    $("plugins-container").replaceChildren(...(extensions.length
      ? extensions.map(ext => itemRow("layers", ext.name, extensionText("category." + ext.category, ext.category) || null, extensionText("ext." + ext.id, ext.description)))
      : [el("li", "item-empty", t("web.noExtensions"))]));
    renderMcpServers(data.mcpServers || [], data.mcpSessionId);
  } catch (err) {
    showToast(t("web.extensionsFailed", { error: err.message }), "error");
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
  btnSave.textContent = t("web.saving");
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
    showToast(t("web.saved"), "success");
    closeSettingsModal();
    fetchStatus();
  } catch (err) {
    showToast(t("web.saveFailed", { error: err.message }), "error");
  } finally {
    btnSave.textContent = t("web.save");
    btnSave.disabled = false;
  }
}
