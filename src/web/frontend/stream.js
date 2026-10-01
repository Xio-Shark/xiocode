/**
 * The live link to a session: the SSE stream (with visible reconnects),
 * runtime events, sending / stopping a turn and permission questions.
 */

// ---------- Event stream ----------

function connectSse(sessionId) {
  clearTimeout(connection.timer);
  connection.source?.close();
  connection.source = null;
  connection.sessionId = sessionId;
  connection.attempts = 0;
  if (sessionId) openStream();
}

function openStream() {
  const source = new EventSource(`/api/sessions/${connection.sessionId}/events`);
  connection.source = source;
  source.onopen = () => {
    const recovered = connection.lost;
    connection.attempts = 0;
    connection.lost = false;
    showConnection("ok");
    // Events sent while we were away are gone; the saved session is the truth.
    if (recovered) {
      loadSessions();
      if (allSessions.some(s => s.id === activeSessionId)) loadSessionDetail(activeSessionId);
      else setRunningState(false);
    }
  };
  source.onmessage = (e) => {
    let event;
    try {
      event = JSON.parse(e.data);
    } catch {
      showToast(t("web.badEvent"), "error");
      return;
    }
    handleRuntimeEvent(event);
  };
  // EventSource retries silently on its own; take over so the user sees the outage and the backoff.
  source.onerror = async () => {
    if (connection.source !== source) return;
    source.close();
    connection.source = null;
    connection.lost = true;
    const sessionId = connection.sessionId;
    // EventSource cannot see status codes. A restarted `xio web` has a new token, and retrying
    // with the old cookie can never succeed, so ask the API what went wrong.
    const expired = await serverRejectsUs();
    if (connection.sessionId !== sessionId || connection.source) return; // switched session meanwhile
    if (expired) showConnection("expired");
    else scheduleReconnect();
  };
}

async function serverRejectsUs() {
  try {
    await api("/api/status");
    return false;
  } catch (err) {
    return err.status === 401;
  }
}

function scheduleReconnect() {
  if (connection.attempts >= RECONNECT_ATTEMPTS) {
    showConnection("down");
    return;
  }
  const delay = Math.min(1000 * 2 ** connection.attempts, 16000);
  connection.attempts += 1;
  showConnection("reconnecting");
  connection.timer = setTimeout(openStream, delay);
}

const CONNECTION_TEXT = {
  down: "web.connDown",
  expired: "web.connExpired",
};

/** state: ok · reconnecting · down (retries used up) · expired (server restarted, new token). */
function showConnection(state) {
  const banner = $("connection-banner");
  banner.hidden = state === "ok";
  banner.classList.toggle("failed", state === "down" || state === "expired");
  $("btn-reconnect").hidden = state !== "down";
  $("connection-text").textContent = CONNECTION_TEXT[state]
    ? t(CONNECTION_TEXT[state])
    : t("web.connRetrying", { n: connection.attempts });
  renderStatusPill();
}

function initConnection() {
  $("btn-reconnect").addEventListener("click", () => {
    connection.attempts = 0;
    showConnection("reconnecting");
    openStream();
  });
}

function handleRuntimeEvent(event) {
  const payload = event.payload || {};
  switch (event.event) {
    case "turn.start":
      finishAssistant();
      chat.assistantBox = null;
      setRunningState(true);
      setWorking(t("web.workingThink"));
      break;
    case "text.delta":
      appendTextDelta(payload.text || "");
      break;
    case "thinking.delta":
      appendThinkingDelta(payload.text || "");
      break;
    case "tool.call":
      appendToolCall(payload.toolCallId, payload.toolName, payload.args, true);
      usageTotals.toolCalls += 1;
      updateComposerMeta();
      break;
    case "tool.result":
    case "tool.error": {
      const failed = event.event === "tool.error" || payload.isError === true;
      updateToolResult(payload.toolCallId, payload.content, failed);
      if (failed) usageTotals.toolErrors += 1;
      if (isRunning) setWorking(t("web.workingThink"));
      break;
    }
    case "mcp.status":
      onMcpStatus();
      break;
    case "web.approval":
      enqueueApproval(payload);
      break;
    case "web.notice":
      // Warnings (recovery, refused leases, denied questions) stay in the transcript; routine info is transient.
      if (payload.level === "warning" || payload.level === "warn" || payload.level === "error") {
        appendSystemNote(payload.message || "", "warning");
      } else {
        showToast(payload.message || "", "info");
      }
      break;
    case "web.error":
      appendSystemNote(t("web.runError", { error: payload.message || t("web.unknownError") }), "error");
      break;
    case "web.turn_end":
      if (payload.cost) usageTotals.costLabel = payload.cost;
      addUsage(payload.usage);
      if (payload.cancelled) appendSystemNote(t("web.stopped"), "info");
      break;
    case "web.idle":
      finishAssistant();
      settleRunningTools();
      clearWorking();
      chat.assistantBox = null;
      closeApprovalDialog();
      setRunningState(false);
      refreshAfterTurn();
      break;
    default:
      break;
  }
}

function addUsage(usage) {
  if (!usage) return;
  usageTotals.input += usage.inputTokens || 0;
  usageTotals.output += usage.outputTokens || 0;
  if (typeof usage.cacheReadTokens === "number") {
    usageTotals.cacheRead += usage.cacheReadTokens;
    usageTotals.cacheKnown = true;
  }
  renderMetrics();
}

// ---------- Running a turn ----------

async function handleSend() {
  const text = composerInput.value.trim();
  if (!text || isRunning) return;
  if (!activeSessionId) await startDraftSession();
  appendUserMessage(text);
  scrollToBottom();
  composerInput.value = "";
  setRunningState(true);
  setWorking(t("web.workingStart"));
  try {
    await api(`/api/sessions/${activeSessionId}/prompt`, { method: "POST", body: { prompt: text } });
  } catch (err) {
    clearWorking();
    appendSystemNote(t("web.notStarted", { error: err.message }), "error");
    setRunningState(false);
  }
}

async function handleAbort() {
  if (!activeSessionId || !isRunning) return;
  try {
    await api(`/api/sessions/${activeSessionId}/abort`, { method: "POST" });
    setWorking(t("web.workingStop"));
  } catch (err) {
    showToast(t("web.stopFailed", { error: err.message }), "error");
  }
}

// ---------- Permission questions ----------

function initApprovalDialog() {
  // Esc fires `cancel`: it declines, it never just hides the question.
  $("approval-modal").addEventListener("cancel", (e) => {
    e.preventDefault();
    answerApproval(false);
  });
}

function enqueueApproval(payload) {
  pendingApprovals.push(payload);
  if (pendingApprovals.length === 1) showApproval(payload);
  renderStatusPill();
}

// Approval choices come from the runtime by value; the page words them itself.
const APPROVAL_LABELS = { once: "web.approveOnce", session: "web.approveSession", "deny-reason": "web.denyReason" };

/** A patch shown as file cards (numbers, +/− colours, stats); anything else as plain text. */
function renderApprovalDetail(text) {
  const box = $("approval-detail");
  box.hidden = !text;
  if (!text) return box.replaceChildren();
  let files = parseUnifiedDiff(text);
  if (files.length === 0 && /^@@ /m.test(text)) {
    const name = (/^\+\+\+ (?:b\/)?(.+)$/m.exec(text) || [])[1] || "diff";
    files = parseUnifiedDiff(`diff --git a/${name} b/${name}\n${text}`);
  }
  box.classList.toggle("is-diff", files.length > 0);
  box.replaceChildren(...(files.length > 0 ? files.map(diffFileCard) : [el("pre", "approval-text", text)]));
}

function showApproval(payload) {
  const dialog = $("approval-modal");
  $("approval-question").textContent = (payload.question || "").replace(/\s*\[y\/N\]\s*$/i, "");
  renderApprovalDetail(payload.detail || "");
  if (payload.input) return showApprovalInput(payload, dialog);
  $("approval-sub").textContent = t("web.waitingConfirm");
  const choices = Array.isArray(payload.choices) && payload.choices.length > 0
    ? payload.choices
    : [{ label: t("web.allow"), value: "__allow" }, { label: t("web.deny"), value: "deny" }];
  // Declining is always last and focused: Enter never approves by accident.
  const ordered = [...choices.filter(c => c.value !== "deny"), { label: t("web.deny"), value: "deny" }];
  let declineButton = null;
  $("approval-actions").replaceChildren(...ordered.map((choice, i) => {
    const isDeny = choice.value === "deny";
    const b = el("button", isDeny || i > 0 ? "btn-secondary" : "btn-primary", isDeny ? t("web.deny") : APPROVAL_LABELS[choice.value] ? t(APPROVAL_LABELS[choice.value]) : choice.label);
    if (isDeny) b.append(" ", el("kbd", null, "Esc"));
    if (choice.scope) b.title = choice.scope;
    b.type = "button";
    b.addEventListener("click", () => answerApproval(!isDeny, choice.value));
    if (isDeny) declineButton = b;
    return b;
  }));
  if (!dialog.open) dialog.showModal();
  declineButton.focus();
  setWorking(t("web.workingApprove"));
}

/** A free-text question (why a call was denied, a model id). Esc skips it. */
function showApprovalInput(payload, dialog) {
  $("approval-sub").textContent = t("web.reasonHint");
  const field = el("textarea", "approval-input");
  field.rows = 3;
  field.placeholder = payload.placeholder || "";
  field.setAttribute("aria-label", payload.question || "");
  const send = el("button", "btn-primary", t("web.send"));
  send.type = "button";
  send.addEventListener("click", () => answerApproval(field.value.trim() !== "", "", field.value.trim()));
  const skip = el("button", "btn-secondary", t("web.skip"));
  skip.append(" ", el("kbd", null, "Esc"));
  skip.type = "button";
  skip.addEventListener("click", () => answerApproval(false));
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send.click(); }
  });
  $("approval-actions").replaceChildren(field, skip, send);
  if (!dialog.open) dialog.showModal();
  field.focus();
  setWorking(t("web.workingReplyWait"));
}

async function answerApproval(approve, value, text) {
  const current = pendingApprovals.shift();
  if (!current) return closeApprovalDialog();
  try {
    const body = {
      id: current.id,
      approve,
      ...(value && value !== "__allow" && value !== "deny" ? { value } : {}),
      ...(text ? { text } : {}),
    };
    await api(`/api/sessions/${activeSessionId}/approval`, { method: "POST", body });
  } catch (err) {
    showToast(t("web.answerFailed", { error: err.message }), "error");
  }
  if (pendingApprovals.length > 0) showApproval(pendingApprovals[0]);
  else {
    closeApprovalDialog();
    if (isRunning) setWorking(approve ? t("web.workingRun") : t("web.workingThink"));
  }
}

function closeApprovalDialog() {
  pendingApprovals.length = 0;
  const dialog = $("approval-modal");
  if (dialog.open) {
    dialog.close();
    composerInput.focus();
  }
  renderStatusPill();
}
