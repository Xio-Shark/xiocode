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
const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheKnown: false, toolCalls: 0, toolErrors: 0, costLabel: t("web.unpriced") };
const pendingApprovals = [];
const connection = { source: null, sessionId: null, attempts: 0, timer: null, lost: false };
const RECONNECT_ATTEMPTS = 6;

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

const STARTERS = [
  { icon: "test", title: t("web.starterTest"), desc: t("web.starterTestDesc"), prompt: t("web.chipTestPrompt") },
  { icon: "diff", title: t("web.starterReview"), desc: t("web.starterReviewDesc"), prompt: t("web.starterReviewPrompt") },
  { icon: "layers", title: t("web.starterArch"), desc: t("web.starterArchDesc"), prompt: t("web.starterArchPrompt") },
];

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
  initConnection();
  setRunningState(false);
  await fetchStatus();
  await loadSessions();
  const initial = activeSessionId
    || allSessions.find(s => (s.messageCount && s.messageCount > 0) || s.firstPrompt)?.id
    || allSessions[0]?.id;
  if (initial) selectSession(initial);
  else startDraftSession();
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
    const target = e.target.closest("[data-prompt], [data-action], [data-rule-preset], [data-perm-mode], [data-delete-id], [data-toggle]");
    if (!target) return;
    const d = target.dataset;
    if (d.deleteId) {
      e.stopPropagation();
      deleteSession(d.deleteId);
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
  $("permission-select").addEventListener("change", (e) => setPermissionMode(e.target.value));
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

function reflectPermissionMode(mode) {
  $("permission-select").value = mode;
  document.querySelectorAll(".perm-card").forEach(card => {
    const on = card.dataset.permMode === mode;
    card.classList.toggle("active", on);
    card.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function modelLabel(model) {
  return model ? (model.provider ? model.provider + "/" : "") + model.id : "—";
}

function setHeader(title, model) {
  $("current-session-title").textContent = title;
  $("current-model-text").textContent = model || "—";
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
