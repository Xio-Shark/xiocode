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
      showToast("收到一条无法解析的运行事件，已跳过", "error");
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
  down: "连不上本地服务。确认 xio web 还在运行，然后重试。",
  expired: "xio web 重启过，这个页面的凭据已失效。请打开它新打印的链接。",
};

/** state: ok · reconnecting · down (retries used up) · expired (server restarted, new token). */
function showConnection(state) {
  const banner = $("connection-banner");
  banner.hidden = state === "ok";
  banner.classList.toggle("failed", state === "down" || state === "expired");
  $("btn-reconnect").hidden = state !== "down";
  $("connection-text").textContent = CONNECTION_TEXT[state]
    || "与本地服务的连接断开了，正在重连（第 " + connection.attempts + " 次）…";
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
      setWorking("正在思考");
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
      if (isRunning) setWorking("正在思考");
      break;
    }
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
      appendSystemNote("运行出错：" + (payload.message || "未知错误"), "error");
      break;
    case "web.turn_end":
      if (payload.cost) usageTotals.costLabel = payload.cost;
      addUsage(payload.usage);
      if (payload.cancelled) appendSystemNote("已停止。", "info");
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
  setWorking("正在启动会话");
  try {
    await api(`/api/sessions/${activeSessionId}/prompt`, { method: "POST", body: { prompt: text } });
  } catch (err) {
    clearWorking();
    appendSystemNote("没有开始运行：" + err.message, "error");
    setRunningState(false);
  }
}

async function handleAbort() {
  if (!activeSessionId || !isRunning) return;
  try {
    await api(`/api/sessions/${activeSessionId}/abort`, { method: "POST" });
    setWorking("正在停止");
  } catch (err) {
    showToast("停止失败：" + err.message, "error");
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

function showApproval(payload) {
  const dialog = $("approval-modal");
  $("approval-question").textContent = (payload.question || "").replace(/\s*\[y\/N\]\s*$/i, "");
  const detail = $("approval-detail");
  detail.textContent = payload.detail || "";
  detail.hidden = !payload.detail;
  const choices = Array.isArray(payload.choices) && payload.choices.length > 0
    ? payload.choices
    : [{ label: "允许", value: "__allow" }, { label: "拒绝", value: "deny" }];
  // Declining is always last and focused: Enter never approves by accident.
  const ordered = [...choices.filter(c => c.value !== "deny"), { label: "拒绝", value: "deny" }];
  let declineButton = null;
  $("approval-actions").replaceChildren(...ordered.map((choice, i) => {
    const isDeny = choice.value === "deny";
    const b = el("button", isDeny || i > 0 ? "btn-secondary" : "btn-primary", isDeny ? "拒绝" : choice.label);
    if (isDeny) b.append(" ", el("kbd", null, "Esc"));
    b.type = "button";
    b.addEventListener("click", () => answerApproval(!isDeny, choice.value));
    if (isDeny) declineButton = b;
    return b;
  }));
  if (!dialog.open) dialog.showModal();
  declineButton.focus();
  setWorking("等待你的确认");
}

async function answerApproval(approve, value) {
  const current = pendingApprovals.shift();
  if (!current) return closeApprovalDialog();
  try {
    const body = { id: current.id, approve, ...(value && value !== "__allow" && value !== "deny" ? { value } : {}) };
    await api(`/api/sessions/${activeSessionId}/approval`, { method: "POST", body });
  } catch (err) {
    showToast("提交确认失败：" + err.message, "error");
  }
  if (pendingApprovals.length > 0) showApproval(pendingApprovals[0]);
  else {
    closeApprovalDialog();
    if (isRunning) setWorking(approve ? "正在运行" : "正在思考");
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
