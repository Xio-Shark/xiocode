/**
 * Session list, opening / creating / deleting sessions and post-turn refresh.
 */

async function loadSessions() {
  try {
    allSessions = await api("/api/sessions");
    renderSessionList();
  } catch (err) {
    showToast("无法读取会话列表：" + err.message, "error");
  }
}

function sessionTitle(sess) {
  const first = sess.firstPrompt || sess.first_prompt;
  if (first) return first.replace(/\s+/g, " ").slice(0, 60);
  return "会话 " + (sess.id || "").slice(0, 8);
}

function renderSessionList() {
  const list = $("session-list");
  const q = sessionSearch.value.trim().toLowerCase();
  const filtered = q
    ? allSessions.filter(s => (sessionTitle(s) + " " + (s.id || "") + " " + (s.cwd || s.main_root || "")).toLowerCase().includes(q))
    : allSessions;
  if (filtered.length === 0) {
    list.replaceChildren(el("div", "empty-state-list", q ? "没有匹配的会话" : "还没有会话"));
    return;
  }
  const groups = new Map();
  filtered.forEach(sess => {
    const ws = lastPathSegment(sess.cwd || sess.main_root) || "未分组";
    if (!groups.has(ws)) groups.set(ws, []);
    groups.get(ws).push(sess);
  });
  list.replaceChildren(...[...groups.entries()].map(([ws, sessions]) => el("div", "ws-group",
    el("div", "ws-group-header", xioIcon("folder"), el("span", "ws-group-name", ws), el("span", "ws-count", String(sessions.length))),
    el("ul", "ws-group-items", ...sessions.map(sessionItem)))));
}

function sessionItem(sess) {
  const active = sess.id === activeSessionId;
  const open = el("button", "session-item-text",
    el("span", "session-title", sessionTitle(sess)),
    active && isRunning ? el("span", "session-live-dot") : el("span", "session-time", formatRelativeTime(sess.updated_at || sess.created_at)));
  open.type = "button";
  open.title = sess.firstPrompt || sess.first_prompt || "";
  if (active) open.setAttribute("aria-current", "true");
  open.addEventListener("click", () => {
    selectSession(sess.id);
    if (narrowScreen.matches) closeSidebar();
  });
  const del = iconButton("trash", "删除会话：" + sessionTitle(sess), "session-del-btn");
  del.dataset.deleteId = sess.id;
  return el("li", "session-item" + (active ? " active" : ""), open, del);
}

function resetUsage() {
  Object.assign(usageTotals, { input: 0, output: 0, cacheRead: 0, cacheKnown: false, toolCalls: 0, toolErrors: 0, costLabel: "未计价", persisted: false });
}

async function handleNewSession() {
  if (isRunning) {
    showToast("当前会话还在运行，先停止或等待它结束", "error");
    return;
  }
  await startDraftSession();
  composerInput.focus();
  if (narrowScreen.matches) closeSidebar();
}

/** A new session only exists on the server once its first prompt runs. */
async function startDraftSession() {
  try {
    const data = await api("/api/sessions", { method: "POST" });
    activeSessionId = data.id;
    defaultModel = data.model || defaultModel;
  } catch (err) {
    showToast("无法创建会话：" + err.message, "error");
    return;
  }
  setHeader("新会话", modelLabel(defaultModel));
  currentTrajectorySteps = [];
  currentStats = {};
  resetUsage();
  renderMetrics();
  renderMessages([]);
  currentTimelineError = null;
  renderTrajectory([], {});
  updateComposerMeta();
  renderSessionList();
  connectSse(activeSessionId);
}

async function deleteSession(id) {
  const sess = allSessions.find(s => s.id === id);
  const ok = await confirmDialog({
    title: "删除这个会话？",
    description: "「" + (sess ? sessionTitle(sess) : id.slice(0, 8)) + "」的记录会被永久删除，无法恢复。",
    confirmLabel: "删除",
  });
  if (!ok) return;
  try {
    await api("/api/sessions/" + id, { method: "DELETE" });
    if (activeSessionId === id) await startDraftSession();
    await loadSessions();
    showToast("会话已删除", "success");
  } catch (err) {
    showToast("删除失败：" + err.message, "error");
  }
}

function selectSession(id) {
  activeSessionId = id;
  renderSessionList();
  connectSse(id);
  loadSessionDetail(id);
}

async function loadSessionDetail(id) {
  let detail;
  try {
    detail = await api("/api/sessions/" + id);
  } catch (err) {
    showToast("无法读取会话：" + err.message, "error");
    return;
  }
  if (id !== activeSessionId) return;
  const firstUser = (detail.messages || []).find(m => m.role === "user")?.content;
  setHeader(firstUser ? firstUser.replace(/\s+/g, " ").slice(0, 80) : "会话 " + id.slice(0, 8), modelLabel(detail.metadata?.model));
  resetUsage();
  renderMessages(detail.messages || []);
  currentTrajectorySteps = detail.trajectory || [];
  currentStats = detail.stats || {};
  usageTotals.toolCalls = currentStats.totalToolCalls || 0;
  usageTotals.toolErrors = currentStats.totalErrors || 0;
  usageTotals.costLabel = detail.cost || "未计价";
  applyStoredUsage(currentStats.usage);
  currentTimelineError = detail.timelineError || null;
  // Running is per session and owned by the server; a reload or reconnect must not guess it.
  setRunningState(detail.running === true);
  if (detail.running) setWorking("正在运行");
  renderMetrics();
  renderTrajectory(currentTrajectorySteps, currentStats, currentTimelineError);
  updateComposerMeta();
}

/** Token totals saved in the session timeline replace the in-page tally (which only saw this page's turns). */
function applyStoredUsage(usage) {
  if (!usage) return;
  usageTotals.input = usage.inputTokens;
  usageTotals.output = usage.outputTokens;
  usageTotals.cacheRead = usage.cacheReadTokens ?? 0;
  usageTotals.cacheKnown = usage.cacheReadTokens !== null;
  usageTotals.persisted = true;
}

async function refreshAfterTurn() {
  await loadSessions();
  const saved = allSessions.find(s => s.id === activeSessionId);
  if (saved) setHeader(sessionTitle(saved), $("current-model-text").textContent);
  let traj;
  try {
    traj = await api("/api/sessions/" + activeSessionId + "/trajectory");
  } catch (err) {
    // A turn that failed before anything was saved has no session file yet; anything else is a real failure.
    if (!saved && /not found/i.test(err.message)) return;
    showToast("无法刷新轨迹：" + err.message, "error");
    return;
  }
  currentTrajectorySteps = traj.steps || [];
  currentStats = traj.stats || {};
  currentTimelineError = traj.timelineError || null;
  applyStoredUsage(currentStats.usage);
  renderMetrics();
  renderTrajectory(currentTrajectorySteps, currentStats, currentTimelineError);
  updateComposerMeta();
}

function initTrajectoryControls() {
  $("trajectory-search-input").addEventListener("input", (e) => renderTrajectoryList(currentTrajectorySteps, e.target.value));
  $("btn-export-log").addEventListener("click", () => {
    if (!activeSessionId || !allSessions.some(s => s.id === activeSessionId)) {
      showToast("这个会话还没有记录可导出", "error");
      return;
    }
    window.open("/api/sessions/" + activeSessionId + "/log", "_blank", "noopener");
  });
}
