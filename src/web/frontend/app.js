/**
 * Console shell: state, sessions, the event stream, running a turn and
 * permission questions. Rendering lives in chat.js / views.js / settings.js.
 */

const DEFAULT_SESSION_ID = "";

let activeSessionId = DEFAULT_SESSION_ID;
let isRunning = false;
let turnStartedAt = 0;
let turnClock = null;
let workspaceName = "";
let allSessions = [];
let currentTrajectorySteps = [];
let currentStats = {};
let currentTimelineError = null;
let defaultModel = null;
/** How fresh the models.dev price catalog behind the usage view is. */
let pricingInfo = null;
/** Unit price of the running model, formatted by the server (`$0.16 / $0.58 / 1M`). */
let currentPriceLabel = null;
const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheKnown: false, toolCalls: 0, toolErrors: 0, costLabel: t("web.unpriced") };
const pendingApprovals = [];
const connection = { source: null, sessionId: null, attempts: 0, timer: null, lost: false };
const RECONNECT_ATTEMPTS = 6;
/** Providers, their models and the effort ladder, as the server reports them. */
let modelCatalog = null;
/** What is running now: { provider, model, thinkingLevel }. */
let currentModel = null;
/** Provider being browsed in an open model menu (not necessarily the running one). */
let menuProvider = null;
/** When the catalog was last fetched; opening the menu refreshes only stale data. */
let modelStateAt = 0;

const chatFlowContainer = $("chat-flow-container");
const chatScrollArea = $("chat-messages");
const composerInput = $("composer-input");
const btnSend = $("btn-send");
const btnAbort = $("btn-abort");
const btnNewSession = $("btn-new-session");
const sidebar = $("sidebar");
const sidebarScrim = $("sidebar-scrim");
const sessionSearch = $("session-search");
const narrowScreen = window.matchMedia("(max-width: 900px)");


document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  initTabs();
  initSidebar();
  initComposer();
  initDelegatedActions();
  initChatScroll();
  initTrajectoryControls();
  initSettingsModal();
  initApprovalDialog();
  initModelMenu();
  initArchiveToggle();
  initConnection();
  setRunningState(false);
  await fetchStatus();
  await refreshModelState();
  await loadSessions();
  // A reload lands on the welcome screen, never on whatever conversation was
  // open before. Opening a session is an explicit click, not a side effect.
  showWelcome();
});

// ---------- Theme ----------

const THEME_KEY = "xio-theme";

function initTheme() {
  let stored = "system";
  // A preference, not state: blocked storage (private mode) just means "follow the system".
  try { stored = localStorage.getItem(THEME_KEY) || "system"; } catch { stored = "system"; }
  applyTheme(stored);
  document.querySelectorAll("[data-theme-choice]").forEach(btn => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.themeChoice);
      try { localStorage.setItem(THEME_KEY, btn.dataset.themeChoice); } catch { /* see initTheme */ }
    });
  });
}

function applyTheme(choice) {
  if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll("[data-theme-choice]").forEach(b => {
    b.setAttribute("aria-checked", b.dataset.themeChoice === (choice || "system") ? "true" : "false");
  });
}

// ---------- Tabs ----------

/** Arrow keys move between tabs and activate them (WAI-ARIA tabs pattern). */
function initRovingTabs(tabs, activate, orientation) {
  const next = orientation === "vertical" ? ["ArrowDown", "ArrowUp"] : ["ArrowRight", "ArrowLeft"];
  tabs.forEach((tab, i) => {
    tab.addEventListener("keydown", (e) => {
      let to = -1;
      if (e.key === next[0]) to = (i + 1) % tabs.length;
      else if (e.key === next[1]) to = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = tabs.length - 1;
      if (to < 0) return;
      e.preventDefault();
      tabs[to].focus();
      activate(tabs[to]);
    });
  });
}

function initTabs() {
  const tabs = [...document.querySelectorAll(".nav-tab")];
  tabs.forEach(btn => btn.addEventListener("click", () => activateTab(btn)));
  initRovingTabs(tabs, activateTab, "horizontal");
  moveTabIndicator(tabs[0]);
  window.addEventListener("resize", () => moveTabIndicator(document.querySelector(".nav-tab.active")));
}

function moveTabIndicator(tab) {
  if (!tab) return;
  document.querySelector(".nav-tab-indicator").style.transform = `translateX(${tab.offsetLeft}px) scaleX(${tab.offsetWidth})`;
}

function activateTab(btn) {
  document.querySelectorAll(".nav-tab").forEach(b => {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  moveTabIndicator(btn);
  document.querySelectorAll(".view-panel").forEach(v => v.classList.remove("active"));
  document.querySelector("main").dataset.view = btn.dataset.view;
  $("view-" + btn.dataset.view)?.classList.add("active");
  if (btn.dataset.view === "trajectory") renderTrajectory(currentTrajectorySteps, currentStats, currentTimelineError);
  else if (btn.dataset.view === "diff") fetchDiff();
  else if (btn.dataset.view === "metrics") renderMetrics();
  else if (btn.dataset.view === "chat") followIfStuck();
}

// ---------- Sidebar ----------

function initSidebar() {
  $("btn-toggle-sidebar").addEventListener("click", closeSidebar);
  $("btn-expand-sidebar").addEventListener("click", openSidebar);
  sidebarScrim.addEventListener("click", closeSidebar);
  sessionSearch.addEventListener("input", () => renderSessionList());
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openSidebar();
      sessionSearch.focus();
    } else if (e.key === "Escape" && sidebar.classList.contains("open")) {
      closeSidebar();
    }
  });
}

function openSidebar() {
  sidebar.classList.remove("collapsed");
  if (narrowScreen.matches) {
    sidebar.classList.add("open");
    sidebarScrim.hidden = false;
  }
}

function closeSidebar() {
  if (narrowScreen.matches) {
    sidebar.classList.remove("open");
    sidebarScrim.hidden = true;
  } else {
    sidebar.classList.add("collapsed");
  }
}

function initDelegatedActions() {
  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-prompt], [data-action], [data-rule-preset], [data-perm-mode], [data-delete-id], [data-archive-id], [data-toggle]");
    if (!target) return;
    const d = target.dataset;
    if (d.deleteId) {
      e.stopPropagation();
      deleteSession(d.deleteId);
    } else if (d.archiveId) {
      e.stopPropagation();
      toggleArchived(d.archiveId, d.archived === "true");
    } else if (d.prompt) insertPrompt(d.prompt);
    else if (d.rulePreset) appendRulePreset(d.rulePreset);
    else if (d.permMode) setPermissionMode(d.permMode);
    else if (d.toggle) {
      const box = target.closest("." + d.toggle);
      if (box) target.setAttribute("aria-expanded", box.classList.toggle("expanded") ? "true" : "false");
    } else if (d.action === "refresh-diff") fetchDiff();
    else if (d.action === "reload-rules") loadRules(true);
    else if (d.action === "copy") copyText(target.closest(".code-block").querySelector("code").textContent, target);
  });
}

// ---------- Composer ----------

function initComposer() {
  composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape" && isRunning) {
      e.preventDefault();
      handleAbort();
    }
  });
  composerInput.addEventListener("input", syncComposer);
  btnSend.addEventListener("click", handleSend);
  btnAbort.addEventListener("click", handleAbort);
  btnNewSession.addEventListener("click", handleNewSession);
  initPermissionMenu();
}

/** Permission is a real menu, not a native <select>: the OS menu brings its own
    font, highlight and glow, which is exactly the inconsistency we can see. */
function initPermissionMenu() {
  const trigger = $("perm-trigger");
  const list = $("perm-list");
  if (!trigger || !list) return;
  const options = [...list.querySelectorAll(".perm-option")];
  const close = (returnFocus = false) => {
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger.focus();
  };
  const open = () => {
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const current = options.find(o => o.getAttribute("aria-selected") === "true") || options[0];
    current?.focus();
  };
  trigger.addEventListener("click", () => (list.hidden ? open() : close()));
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); open(); }
  });
  options.forEach((option, index) => {
    option.addEventListener("click", () => {
      setPermissionMode(option.dataset.permChoice);
      close(true);
    });
    option.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        options[(index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      } else if (e.key === "Tab") {
        close();
      }
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#perm-menu")) close();
  });
}

/** Grow with the text up to the CSS max-height; enable send only when there is something to send. */
function syncComposer() {
  composerInput.style.height = "auto";
  composerInput.style.height = composerInput.scrollHeight + "px";
  btnSend.disabled = isRunning || !composerInput.value.trim();
}

function insertPrompt(text) {
  composerInput.value = text;
  syncComposer();
  composerInput.focus();
}

// ---------- Status & permission ----------

async function fetchStatus() {
  try {
    const data = await api("/api/status");
    defaultModel = data.defaultModel || null;
    pricingInfo = data.pricing || null;
    workspaceName = lastPathSegment(data.cwd);
    reflectPermissionMode(data.permissionMode || "auto");
    $("meta-session-cwd").textContent = workspaceName || "—";
    $("meta-session-cwd").title = data.cwd || "";
  } catch (err) {
    showToast(t("web.statusReadFailed", { error: err.message }), "error");
  }
}

async function setPermissionMode(mode) {
  try {
    const data = await api("/api/permission", { method: "POST", body: { mode } });
    reflectPermissionMode(data.mode);
  } catch (err) {
    showToast(t("web.permSwitchFailed", { error: err.message }), "error");
  }
}

const PERMISSION_ICONS = { auto: "i-shield", strict: "i-eye", full: "i-alert" };
const PERMISSION_LABELS = { auto: "web.modeAuto", strict: "web.modeStrict", full: "web.modeFull" };

function reflectPermissionMode(mode) {
  const key = PERMISSION_LABELS[mode] ? mode : "auto";
  const label = $("perm-label");
  if (label) label.textContent = t(PERMISSION_LABELS[key]);
  const icon = $("perm-icon");
  if (icon) icon.setAttribute("href", "#" + PERMISSION_ICONS[key]);
  document.querySelectorAll(".perm-option").forEach(option => {
    option.setAttribute("aria-selected", String(option.dataset.permChoice === key));
  });
  document.querySelectorAll(".perm-card").forEach(card => {
    const on = card.dataset.permMode === mode;
    card.classList.toggle("active", on);
    card.setAttribute("aria-checked", on ? "true" : "false");
  });
}

// ---------- Model picker (provider · model · effort) ----------

function effortLabel(level) {
  const key = "web.think." + level;
  return MESSAGES[key] === undefined ? level : t(key);
}

async function refreshModelState() {
  try {
    const data = await api("/api/model");
    modelCatalog = data;
    currentModel = data.current;
    currentPriceLabel = data.price || null;
    modelStateAt = Date.now();
    renderModelChip();
    if (document.querySelector("main").dataset.view === "metrics") renderMetrics();
    if (!$("model-menu").hidden) renderModelMenu();
  } catch {
    // The chip keeps its last value; the menu still opens with what we know.
  }
}

function renderModelChip() {
  const provider = currentModel?.provider || "";
  const id = currentModel?.model || "";
  const text = provider && id ? provider + "/" + id : (id || "—");
  $("current-model-text").textContent = text;
  $("current-effort-text").textContent = currentModel?.thinkingLevel ? effortLabel(currentModel.thinkingLevel) : "";
  $("model-trigger").title = currentModel
    ? t("web.modelMenuCurrent", { model: text, effort: effortLabel(currentModel.thinkingLevel) })
    : t("web.modelMenuTitle");
}

let closeModelMenu = () => {};

function initModelMenu() {
  const trigger = $("model-trigger");
  const menu = $("model-menu");
  if (!trigger || !menu) return;
  closeModelMenu = (returnFocus = false) => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger.focus();
  };
  const open = () => {
    menuProvider = currentModel?.provider ?? null;
    renderModelMenu();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    menu.querySelector(".model-option[aria-selected='true']")?.focus();
  };
  trigger.addEventListener("click", () => {
    if (!menu.hidden) {
      closeModelMenu(true);
      return;
    }
    open();
    // Another tab may have switched model; refresh only when what we show is stale.
    if (Date.now() - modelStateAt > 5000) void refreshModelState();
  });
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
    else if (e.key === "Escape") closeModelMenu();
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeModelMenu(true); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = e.target.closest(".model-options");
    if (!list) return;
    const items = [...list.querySelectorAll("button")];
    const index = items.indexOf(e.target);
    if (index < 0) return;
    e.preventDefault();
    items[(index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".model-picker")) closeModelMenu();
  });
}

function modelOption(label, selected, onPick) {
  const b = el("button", "model-option" + (selected ? " selected" : ""), el("span", "model-option-label", label));
  b.type = "button";
  b.setAttribute("role", "option");
  b.setAttribute("aria-selected", String(Boolean(selected)));
  // Re-rendering inside the handler detaches this button, so the document-level
  // "click outside" check would see no .model-picker ancestor and close the menu.
  b.addEventListener("click", (e) => { e.stopPropagation(); onPick(); });
  if (selected) b.append(xioIcon("check", "model-option-check"));
  return b;
}

function renderModelMenu() {
  if (!modelCatalog) return;
  // Current first, then providers that can actually run, then the rest by name:
  // the list stays useful when it has to scroll.
  const providers = [...(modelCatalog.providers || [])].sort((a, b) =>
    Number(b.name === currentModel?.provider) - Number(a.name === currentModel?.provider)
    || Number(b.hasKey) - Number(a.hasKey)
    || a.name.localeCompare(b.name));
  const activeProvider = providers.some(p => p.name === menuProvider)
    ? menuProvider
    : (currentModel?.provider || providers[0]?.name);
  menuProvider = activeProvider;
  const provider = providers.find(p => p.name === activeProvider);
  $("model-provider-list").replaceChildren(...providers.map(p => modelOption(
    p.name + (p.hasKey ? "" : t("web.noKey")),
    p.name === activeProvider,
    () => { menuProvider = p.name; renderModelMenu(); },
  )));
  const models = provider?.models || [];
  $("model-model-list").replaceChildren(...(models.length
    ? models.map(id => modelOption(
      id,
      provider.name === currentModel?.provider && id === currentModel?.model,
      () => chooseModel(provider.name, id),
    ))
    : [el("div", "model-empty", t("web.noModels"))]));
  $("model-effort-list").replaceChildren(...(modelCatalog.thinkingLevels || []).map(level => {
    const on = level === currentModel?.thinkingLevel;
    const b = el("button", "model-effort-option" + (on ? " active" : ""), effortLabel(level));
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(on));
    b.addEventListener("click", (e) => { e.stopPropagation(); chooseEffort(level); });
    return b;
  }));
}

async function applyModelChoice(body) {
  try {
    const data = await api("/api/model", { method: "POST", body });
    currentModel = data.current;
    modelStateAt = Date.now();
    renderModelChip();
    closeModelMenu();
  } catch (err) {
    showToast(t("web.modelSwitchFailed", { error: err.message }), "error");
  }
}

function chooseModel(provider, model) {
  if (provider === currentModel?.provider && model === currentModel?.model) {
    closeModelMenu(true);
    return;
  }
  void applyModelChoice({ provider, model });
}

function chooseEffort(level) {
  if (!currentModel || level === currentModel.thinkingLevel) {
    closeModelMenu(true);
    return;
  }
  void applyModelChoice({ provider: currentModel.provider, model: currentModel.model, thinkingLevel: level });
}

function setHeader(title) {
  $("current-session-title").textContent = title;
  document.title = title + " · XioCode";
}

function updateComposerMeta() {
  const steps = currentStats.totalSteps || currentTrajectorySteps.length;
  const turns = steps > 0 ? (currentStats.totalTurns || 0) : 0;
  $("meta-turns-info").textContent = t("web.turnsStepsN", { turns, steps });
  $("meta-tools-info").textContent = t("web.toolCallsN", { n: usageTotals.toolCalls });
}

/** Header pill: connection problems outrank a waiting question, which outranks running. */
function renderStatusPill() {
  const pill = $("status-pill");
  let cls = "";
  let text = t("web.ready");
  if (connection.lost) { cls = "offline"; text = t("web.offline"); }
  else if (pendingApprovals.length) { cls = "waiting"; text = t("web.waiting"); }
  else if (isRunning) { cls = "running"; text = t("web.running", { elapsed: formatElapsed(Date.now() - turnStartedAt) }); }
  pill.className = "status-pill" + (cls ? " " + cls : "");
  $("status-text").textContent = text;
}

function setRunningState(running) {
  if (running && !isRunning) turnStartedAt = Date.now();
  isRunning = running;
  btnSend.hidden = running;
  btnAbort.hidden = !running;
  btnNewSession.disabled = running;
  syncComposer();
  clearInterval(turnClock);
  turnClock = running ? setInterval(() => { renderStatusPill(); tickWorking(); tickToolRows(); }, 1000) : null;
  renderStatusPill();
  renderSessionList();
}
