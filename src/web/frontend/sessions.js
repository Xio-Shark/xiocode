/**
 * Session list, opening / creating / deleting sessions and post-turn refresh.
 */

/** Archived conversations are listed separately; the sidebar shows one or the other. */
let showArchived = false;

async function loadSessions() {
  try {
    allSessions = await api("/api/sessions");
    renderSessionList();
  } catch (err) {
    showToast(t("web.listFailed", { error: err.message }), "error");
  }
}

function archivedSessions() {
  return allSessions.filter(s => Boolean(s.archived_at));
}

function activeSessions() {
  return allSessions.filter(s => !s.archived_at);
}

function initArchiveToggle() {
  const toggle = $("archive-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    showArchived = !showArchived;
    renderSessionList();
    if (narrowScreen.matches && showArchived) closeSidebar();
  });
}

function renderArchiveToggle() {
  const toggle = $("archive-toggle");
  if (!toggle) return;
  const count = archivedSessions().length;
  // Nothing archived and nothing to go back to: the row has nothing to say.
  toggle.hidden = count === 0 && !showArchived;
  toggle.classList.toggle("active", showArchived);
  toggle.setAttribute("aria-pressed", String(showArchived));
  $("archive-toggle-text").textContent = showArchived ? t("web.backToSessions") : t("web.archived");
  $("archive-count").textContent = String(showArchived ? activeSessions().length : count);
}

async function toggleArchived(id, archived) {
  try {
    await api("/api/sessions/" + id + "/archive", { method: "POST", body: { archived } });
    await loadSessions();
    showToast(t(archived ? "web.archivedToast" : "web.restoredToast"));
  } catch (err) {
    showToast(t("web.archiveFailed", { error: err.message }), "error");
  }
}

function sessionTitle(sess) {
  const first = sess.firstPrompt || sess.first_prompt;
  if (first) return first.replace(/\s+/g, " ").slice(0, 60);
  return t("web.sessionN", { id: (sess.id || "").slice(0, 8) });
}

/** "10-01 14:32": tells apart sessions that started with the same prompt. */
function sessionStartLabel(sess) {
  const started = new Date(sess.created_at || sess.updated_at);
  if (Number.isNaN(started.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return pad(started.getMonth() + 1) + "-" + pad(started.getDate()) + " " + pad(started.getHours()) + ":" + pad(started.getMinutes());
}

function renderSessionList() {
  const list = $("session-list");
  const q = sessionSearch.value.trim().toLowerCase();
  list.classList.toggle("archived-view", showArchived);
  renderArchiveToggle();
  const scope = showArchived ? archivedSessions() : activeSessions();
  const filtered = q
    ? scope.filter(s => (sessionTitle(s) + " " + (s.id || "") + " " + (s.cwd || s.main_root || "")).toLowerCase().includes(q))
    : scope;
  if (filtered.length === 0) {
    list.replaceChildren(el("div", "empty-state-list",
      q ? t("web.noMatchingSessions") : t(showArchived ? "web.archivedEmpty" : "web.noSessions")));
    return;
  }
  const groups = new Map();
  filtered.forEach(sess => {
    const ws = lastPathSegment(sess.cwd || sess.main_root) || t("web.ungrouped");
    if (!groups.has(ws)) groups.set(ws, []);
    groups.get(ws).push(sess);
  });
  list.replaceChildren(...[...groups.entries()].map(([ws, sessions]) => el("div", "ws-group",
    el("div", "ws-group-header", el("span", "ws-group-name", ws), el("span", "ws-count", String(sessions.length))),
    el("ul", "ws-group-items", ...sessions.map(sess => sessionItem(sess))))));
}

function sessionItem(sess) {
  const active = sess.id === activeSessionId;
  // One time format for the whole list: relative. Two sessions that started with
  // the same prompt are told apart by the tooltip, not by a second date style.
  const startedAt = sessionStartLabel(sess);
  const timeLabel = formatRelativeTime(sess.updated_at || sess.created_at);
  const open = el("button", "session-item-text",
    el("span", "session-title", sessionTitle(sess)),
    active && isRunning ? el("span", "session-live-dot") : el("span", "session-time", timeLabel));
  open.type = "button";
  open.title = [sess.firstPrompt || sess.first_prompt || "", startedAt].filter(Boolean).join(" · ");
  if (active) open.setAttribute("aria-current", "true");
  open.addEventListener("click", () => {
    selectSession(sess.id);
    if (narrowScreen.matches) closeSidebar();
  });
  const del = iconButton("trash", t("web.deleteSessionLabel", { title: sessionTitle(sess) }), "session-del-btn");
  del.dataset.deleteId = sess.id;
  const archive = iconButton(
    showArchived ? "refresh" : "archive",
    t(showArchived ? "web.restoreSession" : "web.archiveSession", { title: sessionTitle(sess) }),
    "session-archive-btn",
  );
  archive.dataset.archiveId = sess.id;
  archive.dataset.archived = showArchived ? "false" : "true";
  return el("li", "session-item" + (active ? " active" : ""), open, archive, del);
}

function resetUsage() {
  Object.assign(usageTotals, { input: 0, output: 0, cacheRead: 0, cacheKnown: false, toolCalls: 0, toolErrors: 0, costLabel: t("web.unpriced"), persisted: false });
}

async function handleNewSession() {
  if (isRunning) {
    showToast(t("web.stillRunning"), "error");
    return;
  }
  showWelcome();
  composerInput.focus();
  if (narrowScreen.matches) closeSidebar();
}

/** Home screen: no server session yet — one is created with the first prompt. */
function showWelcome() {
  activeSessionId = "";
  connectSse("");
  connection.lost = false;
  renderStatusPill();
  setHeader(t("web.newSession"));
  currentTrajectorySteps = [];
  currentStats = {};
  resetUsage();
  renderMetrics();
  renderMessages([]);
  currentTimelineError = null;
  renderTrajectory([], {});
  updateComposerMeta();
  renderSessionList();
}

/** A new session only exists on the server once its first prompt runs. */
async function startDraftSession() {
  try {
    const data = await api("/api/sessions", { method: "POST" });
    activeSessionId = data.id;
    defaultModel = data.model || defaultModel;
  } catch (err) {
    showToast(t("web.createFailed", { error: err.message }), "error");
    return;
  }
  setHeader(t("web.newSession"));
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
    title: t("web.deleteTitle"),
    description: t("web.deleteDesc", { title: sess ? sessionTitle(sess) : id.slice(0, 8) }),
    confirmLabel: t("web.delete"),
  });
  if (!ok) return;
  try {
    await api("/api/sessions/" + id, { method: "DELETE" });
    if (activeSessionId === id) await startDraftSession();
    await loadSessions();
    showToast(t("web.deleted"), "success");
  } catch (err) {
    showToast(t("web.deleteFailed", { error: err.message }), "error");
  }
}

function selectSession(id) {
  openView("chat");
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
    showToast(t("web.readFailed", { error: err.message }), "error");
    return;
  }
  if (id !== activeSessionId) return;
  const firstUser = (detail.messages || []).find(m => m.role === "user")?.content;
  setHeader(firstUser ? firstUser.replace(/\s+/g, " ").slice(0, 80) : t("web.sessionN", { id: id.slice(0, 8) }));
  // Opening a session makes its stored model live; the chip follows the server.
  void refreshModelState();
  resetUsage();
  renderMessages(detail.messages || []);
  currentTrajectorySteps = detail.trajectory || [];
  currentStats = detail.stats || {};
  usageTotals.toolCalls = currentStats.totalToolCalls || 0;
  usageTotals.toolErrors = currentStats.totalErrors || 0;
  usageTotals.costLabel = detail.cost || t("web.unpriced");
  applyStoredUsage(currentStats.usage);
  currentTimelineError = detail.timelineError || null;
  // Running is per session and owned by the server; a reload or reconnect must not guess it.
  setRunningState(detail.running === true);
  if (detail.running) setWorking(t("web.workingRun"));
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
  if (saved) setHeader(sessionTitle(saved));
  let traj;
  try {
    traj = await api("/api/sessions/" + activeSessionId + "/trajectory");
  } catch (err) {
    // A turn that failed before anything was saved has no session file yet; anything else is a real failure.
    if (!saved && /not found/i.test(err.message)) return;
    showToast(t("web.trajectoryFailed", { error: err.message }), "error");
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
      showToast(t("web.nothingToExport"), "error");
      return;
    }
    window.open("/api/sessions/" + activeSessionId + "/log", "_blank", "noopener");
  });
}
