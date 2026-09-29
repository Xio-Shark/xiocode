const DEFAULT_SESSION_ID = "";

    let activeSessionId = DEFAULT_SESSION_ID;
    let isRunning = false;
    let eventSource = null;
    let allSessions = [];
    let currentSettingsData = null;
    let selectedThinkingLevel = "high";
    let currentTrajectorySteps = [];
    let currentStats = {};
    let defaultModel = null;
    let workspaceName = "";
    const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheKnown: false, toolCalls: 0 };
    const pendingApprovals = [];

    const chatFlowContainer = document.getElementById("chat-flow-container");
    const chatScrollArea = document.getElementById("chat-messages");
    const composerInput = document.getElementById("composer-input");
    const btnSend = document.getElementById("btn-send");
    const btnAbort = document.getElementById("btn-abort");
    const statusPill = document.getElementById("status-pill");
    const statusText = document.getElementById("status-text");
    const sessionList = document.getElementById("session-list");
    const btnNewSession = document.getElementById("btn-new-session");
    const sidebar = document.getElementById("sidebar");
    const sidebarScrim = document.getElementById("sidebar-scrim");
    const sessionSearch = document.getElementById("session-search");
    const narrowScreen = window.matchMedia("(max-width: 900px)");

    const STARTERS = [
      { title: "跑一遍测试", desc: "运行测试并报告失败用例", prompt: "运行测试套件并报告失败的用例" },
      { title: "审查未提交的改动", desc: "解释 git diff 的影响面", prompt: "检查 git diff 并分析未暂存的改动" },
      { title: "梳理项目结构", desc: "模块分层与依赖关系", prompt: "分析代码库架构与核心模块分层约定" },
    ];

    document.addEventListener("DOMContentLoaded", async () => {
      initTabs();
      initSidebar();
      initComposer();
      initDelegatedActions();
      initTrajectoryControls();
      initSettingsModal();
      initApprovalDialog();
      setRunningState(false);
      await fetchStatus();
      await loadSessions();
      const initial = activeSessionId
        || allSessions.find(s => (s.messageCount && s.messageCount > 0) || s.firstPrompt)?.id
        || allSessions[0]?.id;
      if (initial) {
        selectSession(initial);
      } else {
        startDraftSession();
      }
    });

    // ---------- Shell: tabs, sidebar, delegated actions ----------

    function initTabs() {
      document.querySelectorAll(".nav-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => activateTab(btn));
      });
    }

    function activateTab(btn) {
      document.querySelectorAll(".nav-tab-btn").forEach(b => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      document.querySelectorAll(".view-panel").forEach(v => v.classList.remove("active"));
      const target = document.getElementById("view-" + btn.dataset.view);
      if (target) target.classList.add("active");
      if (btn.dataset.view === "trajectory") renderTrajectory(currentTrajectorySteps, currentStats);
      else if (btn.dataset.view === "diff") fetchDiff();
      else if (btn.dataset.view === "metrics") renderMetrics();
    }

    function initSidebar() {
      document.getElementById("btn-toggle-sidebar").addEventListener("click", closeSidebar);
      document.getElementById("btn-expand-sidebar").addEventListener("click", openSidebar);
      sidebarScrim.addEventListener("click", closeSidebar);
      sessionSearch.addEventListener("input", (e) => renderSessionList(e.target.value.trim().toLowerCase()));
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
        const el = e.target.closest("[data-prompt], [data-action], [data-rule-preset], [data-perm-mode], [data-delete-id], [data-toggle]");
        if (!el) return;
        if (el.dataset.deleteId) {
          e.stopPropagation();
          deleteSession(el.dataset.deleteId);
        } else if (el.dataset.prompt) {
          insertPrompt(el.dataset.prompt);
        } else if (el.dataset.rulePreset) {
          appendRulePreset(el.dataset.rulePreset);
        } else if (el.dataset.permMode) {
          setPermissionMode(el.dataset.permMode);
        } else if (el.dataset.toggle) {
          const box = el.closest("." + el.dataset.toggle);
          if (box) {
            const expanded = box.classList.toggle("expanded");
            el.setAttribute("aria-expanded", expanded ? "true" : "false");
          }
        } else if (el.dataset.action === "refresh-diff") {
          fetchDiff();
        } else if (el.dataset.action === "reload-rules") {
          loadRules(true);
        } else if (el.dataset.action === "copy") {
          copyCode(el);
        }
      });
    }

    function initComposer() {
      composerInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          handleSend();
        }
      });
      btnSend.addEventListener("click", handleSend);
      btnAbort.addEventListener("click", handleAbort);
      btnNewSession.addEventListener("click", handleNewSession);
      document.getElementById("permission-select").addEventListener("change", (e) => setPermissionMode(e.target.value));
    }

    // ---------- Status, permission ----------

    async function fetchStatus() {
      try {
        const data = await api("/api/status");
        defaultModel = data.defaultModel || null;
        workspaceName = data.cwd ? data.cwd.split("/").pop() : "";
        reflectPermissionMode(data.permissionMode || "auto");
        document.getElementById("meta-session-cwd").textContent = "工作区 " + (workspaceName || "—");
      } catch (err) {
        showToast("无法读取控制台状态：" + err.message, "error");
      }
    }

    async function setPermissionMode(mode) {
      try {
        const data = await api("/api/permission", { method: "POST", body: { mode } });
        reflectPermissionMode(data.mode);
      } catch (err) {
        showToast("切换权限失败：" + err.message, "error");
      }
    }

    function reflectPermissionMode(mode) {
      document.getElementById("permission-select").value = mode;
      document.querySelectorAll(".perm-card").forEach(card => {
        const on = card.dataset.permMode === mode;
        card.classList.toggle("active", on);
        card.setAttribute("aria-checked", on ? "true" : "false");
      });
    }

    function modelLabel(model) {
      return model ? (model.provider ? model.provider + "/" : "") + model.id : "—";
    }

    // ---------- Sessions ----------

    async function loadSessions() {
      try {
        allSessions = await api("/api/sessions");
        document.getElementById("session-count-badge").textContent = allSessions.length + " 个会话";
        renderSessionList(sessionSearch.value.trim().toLowerCase());
      } catch (err) {
        showToast("无法读取会话列表：" + err.message, "error");
      }
    }

    function formatRelativeTime(dateStr) {
      if (!dateStr) return "";
      const diffMs = Date.now() - new Date(dateStr).getTime();
      const min = Math.floor(diffMs / 60000);
      if (!Number.isFinite(min) || min < 1) return "刚刚";
      if (min < 60) return min + " 分钟前";
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + " 小时前";
      const day = Math.floor(hr / 24);
      if (day < 30) return day + " 天前";
      const d = new Date(dateStr);
      return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    }

    function sessionTitle(sess) {
      const first = sess.firstPrompt || sess.first_prompt;
      if (first) return first.replace(/\s+/g, " ").slice(0, 40);
      return "会话 " + (sess.id || "").slice(0, 8);
    }

    function renderSessionList(query = "") {
      sessionList.replaceChildren();
      const q = (query || "").trim().toLowerCase();
      const filtered = q
        ? allSessions.filter(s => (sessionTitle(s) + " " + (s.id || "") + " " + (s.cwd || s.main_root || "")).toLowerCase().includes(q))
        : allSessions;

      if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state-list";
        empty.textContent = q ? "没有匹配的会话" : "还没有会话";
        sessionList.appendChild(empty);
        return;
      }

      const groups = new Map();
      filtered.forEach(sess => {
        const rawCwd = sess.cwd || sess.main_root || "";
        const wsName = rawCwd.split("/").filter(Boolean).pop() || "未分组";
        if (!groups.has(wsName)) groups.set(wsName, []);
        groups.get(wsName).push(sess);
      });

      for (const [wsName, sessList] of groups.entries()) {
        const groupEl = document.createElement("div");
        groupEl.className = "ws-group";
        const header = document.createElement("div");
        header.className = "ws-group-header";
        header.textContent = wsName;
        const count = document.createElement("span");
        count.className = "ws-count";
        count.textContent = String(sessList.length);
        header.appendChild(count);
        groupEl.appendChild(header);

        const itemsEl = document.createElement("ul");
        itemsEl.className = "ws-group-items";
        sessList.forEach(sess => {
          const li = document.createElement("li");
          li.className = "session-item" + (sess.id === activeSessionId ? " active" : "");
          const open = document.createElement("button");
          open.type = "button";
          open.className = "session-item-text";
          if (sess.id === activeSessionId) open.setAttribute("aria-current", "true");
          const title = document.createElement("span");
          title.className = "session-title";
          title.textContent = sessionTitle(sess);
          title.title = sess.firstPrompt || sess.first_prompt || "";
          const time = document.createElement("span");
          time.className = "session-time";
          time.textContent = formatRelativeTime(sess.updated_at || sess.created_at);
          open.append(title, time);
          open.addEventListener("click", () => {
            selectSession(sess.id);
            if (narrowScreen.matches) closeSidebar();
          });
          const del = document.createElement("button");
          del.type = "button";
          del.className = "session-del-btn";
          del.dataset.deleteId = sess.id;
          del.setAttribute("aria-label", "删除会话：" + sessionTitle(sess));
          del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
          li.append(open, del);
          itemsEl.appendChild(li);
        });
        groupEl.appendChild(itemsEl);
        sessionList.appendChild(groupEl);
      }
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
      renderMessages([]);
      updateComposerMeta();
      renderSessionList(sessionSearch.value.trim().toLowerCase());
      connectSse(activeSessionId);
    }

    async function deleteSession(id) {
      if (!confirm("删除这个会话？记录会被永久删除。")) return;
      try {
        await api("/api/sessions/" + id, { method: "DELETE" });
        if (activeSessionId === id) await startDraftSession();
        await loadSessions();
      } catch (err) {
        showToast("删除失败：" + err.message, "error");
      }
    }

    function selectSession(id) {
      activeSessionId = id;
      renderSessionList(sessionSearch.value.trim().toLowerCase());
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
      const firstUser = (detail.messages || []).find(m => m.role === "user")?.content;
      setHeader(firstUser ? firstUser.replace(/\s+/g, " ").slice(0, 60) : "会话 " + id.slice(0, 8), modelLabel(detail.metadata?.model));
      renderMessages(detail.messages || []);
      currentTrajectorySteps = detail.trajectory || [];
      currentStats = detail.stats || {};
      usageTotals.toolCalls = currentStats.totalToolCalls || 0;
      renderTrajectory(currentTrajectorySteps, currentStats);
      updateComposerMeta();
    }

    function setHeader(title, model) {
      document.getElementById("current-session-title").textContent = title;
      document.getElementById("current-mode-badge").textContent = model || "—";
      document.title = title + " · XioCode";
    }

    function updateComposerMeta() {
      const steps = currentStats.totalSteps || currentTrajectorySteps.length;
      const turns = steps > 0 ? (currentStats.totalTurns || 0) : 0;
      document.getElementById("meta-turns-info").textContent = turns + " 轮 · " + steps + " 步";
      document.getElementById("meta-tools-info").textContent = "工具调用 " + usageTotals.toolCalls + " 次";
    }

    // ---------- Transcript ----------

    let currentAssistantBox = null;
    const toolCards = new Map();

    function clearChat() {
      chatFlowContainer.replaceChildren();
      toolCards.clear();
      currentAssistantBox = null;
    }

    function renderHero() {
      const hero = document.createElement("div");
      hero.className = "hero-state";
      hero.id = "hero-state";
      const h = document.createElement("h2");
      h.className = "hero-title";
      h.textContent = "要做点什么？";
      const p = document.createElement("p");
      p.className = "hero-subtitle";
      p.textContent = "智能体在" + (workspaceName ? "「" + workspaceName + "」" : "当前工作区") + "里读写代码、运行命令。每个需要确认的操作都会先问你。";
      const grid = document.createElement("div");
      grid.className = "starter-grid";
      STARTERS.forEach(s => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "starter-item";
        b.dataset.prompt = s.prompt;
        const t = document.createElement("span");
        t.className = "starter-title";
        t.textContent = s.title;
        const d = document.createElement("span");
        d.className = "starter-desc";
        d.textContent = s.desc;
        b.append(t, d);
        grid.appendChild(b);
      });
      hero.append(h, p, grid);
      chatFlowContainer.appendChild(hero);
    }

    function renderMessages(messages) {
      clearChat();
      const visible = messages.filter(m => m.role !== "system");
      if (visible.length === 0) {
        renderHero();
        return;
      }
      for (const msg of visible) {
        if (msg.role === "user") {
          appendUserMessage(msg.content);
        } else if (msg.role === "assistant") {
          if (msg.content) appendAssistantText(msg.content);
          (msg.toolCalls || []).forEach(call => appendToolCall(call.id, call.name, call.arguments));
          currentAssistantBox = null;
        } else if (msg.role === "tool") {
          updateToolResult(msg.toolCallId, msg.content, false);
        }
      }
      scrollToBottom();
    }

    function removeHero() {
      document.getElementById("hero-state")?.remove();
    }

    function messageRow(role, label) {
      removeHero();
      const row = document.createElement("article");
      row.className = "message-row " + role;
      const who = document.createElement("div");
      who.className = "message-role";
      who.textContent = label;
      const body = document.createElement("div");
      body.className = "bubble " + role;
      row.append(who, body);
      chatFlowContainer.appendChild(row);
      return body;
    }

    function appendUserMessage(text) {
      const body = messageRow("user", "你");
      const content = document.createElement("div");
      content.className = "bubble-content";
      content.textContent = text;
      body.appendChild(content);
      currentAssistantBox = null;
      scrollToBottom();
    }

    function getOrCreateAssistantBox() {
      if (!currentAssistantBox) currentAssistantBox = messageRow("assistant", "XioCode");
      return currentAssistantBox;
    }

    function appendAssistantText(text) {
      const prose = document.createElement("div");
      prose.className = "prose";
      prose.textContent = text;
      getOrCreateAssistantBox().appendChild(prose);
    }

    function appendTextDelta(delta) {
      const box = getOrCreateAssistantBox();
      let prose = box.lastElementChild;
      if (!prose || !prose.classList.contains("prose") || prose.dataset.done) {
        prose = document.createElement("div");
        prose.className = "prose";
        box.appendChild(prose);
      }
      prose.textContent += delta;
      scrollToBottom();
    }

    function appendThinkingDelta(delta) {
      const box = getOrCreateAssistantBox();
      let drawer = box.lastElementChild;
      if (!drawer || !drawer.classList.contains("thought-drawer")) {
        drawer = document.createElement("div");
        drawer.className = "thought-drawer";
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "thought-drawer-header";
        toggle.dataset.toggle = "thought-drawer";
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "思考过程";
        const body = document.createElement("div");
        body.className = "thought-drawer-body";
        drawer.append(toggle, body);
        box.appendChild(drawer);
      }
      drawer.querySelector(".thought-drawer-body").textContent += delta;
      scrollToBottom();
    }

    function appendToolCall(id, name, args) {
      const box = getOrCreateAssistantBox();
      box.querySelectorAll(".prose").forEach(p => { p.dataset.done = "1"; });
      const card = document.createElement("div");
      card.className = "tool-box";
      const header = document.createElement("button");
      header.type = "button";
      header.className = "tool-box-header";
      header.dataset.toggle = "tool-box";
      header.setAttribute("aria-expanded", "false");
      const tag = document.createElement("span");
      tag.className = "tool-name-tag";
      tag.textContent = name || "tool";
      const summary = document.createElement("span");
      summary.className = "tool-summary";
      summary.textContent = summarizeArgs(name, args);
      const status = document.createElement("span");
      status.className = "tool-status-pill running";
      status.textContent = "运行中";
      header.append(tag, summary, status);
      const bodyEl = document.createElement("div");
      bodyEl.className = "tool-box-body";
      const argsPre = document.createElement("pre");
      argsPre.className = "tool-args";
      argsPre.textContent = JSON.stringify(args || {}, null, 2);
      const outPre = document.createElement("pre");
      outPre.className = "tool-output";
      bodyEl.append(argsPre, outPre);
      card.append(header, bodyEl);
      box.appendChild(card);
      if (id) toolCards.set(id, { status, outPre });
      scrollToBottom();
    }

    function updateToolResult(id, content, isError) {
      const card = toolCards.get(id);
      if (!card) return;
      card.status.className = "tool-status-pill " + (isError ? "error" : "done");
      card.status.textContent = isError ? "失败" : "完成";
      card.outPre.textContent = typeof content === "string" ? content.slice(0, 20000) : JSON.stringify(content ?? "");
    }

    function summarizeArgs(name, args) {
      if (!args) return "";
      if (name === "bash" && args.command) return args.command;
      return args.path || args.pattern || args.query || JSON.stringify(args).slice(0, 80);
    }

    function appendSystemNote(message, level) {
      removeHero();
      const note = document.createElement("div");
      note.className = "system-note " + (level || "info");
      note.textContent = message;
      chatFlowContainer.appendChild(note);
      scrollToBottom();
    }

    function scrollToBottom() {
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    // ---------- Running a turn ----------

    async function handleSend() {
      const text = composerInput.value.trim();
      if (!text || isRunning) return;
      if (!activeSessionId) await startDraftSession();
      appendUserMessage(text);
      composerInput.value = "";
      setRunningState(true);
      try {
        await api(`/api/sessions/${activeSessionId}/prompt`, { method: "POST", body: { prompt: text } });
      } catch (err) {
        appendSystemNote("没有开始运行：" + err.message, "error");
        setRunningState(false);
      }
    }

    async function handleAbort() {
      if (!activeSessionId || !isRunning) return;
      try {
        await api(`/api/sessions/${activeSessionId}/abort`, { method: "POST" });
        statusText.textContent = "正在停止…";
      } catch (err) {
        showToast("停止失败：" + err.message, "error");
      }
    }

    function setRunningState(running) {
      isRunning = running;
      statusPill.className = "status-badge" + (running ? " running" : "");
      statusText.textContent = running ? "运行中" : "就绪";
      btnSend.hidden = running;
      btnAbort.hidden = !running;
      btnNewSession.disabled = running;
    }

    function connectSse(sessionId) {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (!sessionId) return;
      eventSource = new EventSource(`/api/sessions/${sessionId}/events`);
      eventSource.onmessage = (e) => {
        let event;
        try {
          event = JSON.parse(e.data);
        } catch {
          return;
        }
        handleRuntimeEvent(event);
      };
    }

    function handleRuntimeEvent(event) {
      const type = event.event;
      const payload = event.payload || {};
      switch (type) {
        case "turn.start":
          setRunningState(true);
          break;
        case "text.delta":
          appendTextDelta(payload.text || "");
          break;
        case "thinking.delta":
          appendThinkingDelta(payload.text || "");
          break;
        case "tool.call":
          appendToolCall(payload.toolCallId, payload.toolName, payload.args);
          usageTotals.toolCalls += 1;
          updateComposerMeta();
          break;
        case "tool.result":
        case "tool.error":
          updateToolResult(payload.toolCallId, payload.content, type === "tool.error" || payload.isError === true);
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
          appendSystemNote("运行出错：" + (payload.message || "未知错误"), "error");
          break;
        case "web.turn_end":
          addUsage(payload.usage);
          if (payload.cancelled) appendSystemNote("已停止。", "info");
          break;
        case "web.idle":
          setRunningState(false);
          currentAssistantBox = null;
          closeApprovalDialog();
          refreshAfterTurn();
          break;
        default:
          break;
      }
    }

    async function refreshAfterTurn() {
      await loadSessions();
      const saved = allSessions.find(s => s.id === activeSessionId);
      if (saved) setHeader(sessionTitle(saved), document.getElementById("current-mode-badge").textContent);
      try {
        const traj = await api("/api/sessions/" + activeSessionId + "/trajectory");
        currentTrajectorySteps = traj.steps || [];
        currentStats = traj.stats || {};
        renderTrajectory(currentTrajectorySteps, currentStats);
        updateComposerMeta();
      } catch {
        // A turn that failed before saving anything has no trajectory yet.
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

    function renderMetrics() {
      const total = usageTotals.input + usageTotals.output;
      document.getElementById("val-tokens").textContent = total > 0 ? total.toLocaleString() : "—";
      document.getElementById("val-tokens-foot").textContent = total > 0
        ? "输入 " + usageTotals.input.toLocaleString() + " · 输出 " + usageTotals.output.toLocaleString()
        : "输入 + 输出，发起一轮后统计";
      document.getElementById("val-cache").textContent = usageTotals.cacheKnown && usageTotals.input > 0
        ? Math.round((usageTotals.cacheRead / usageTotals.input) * 100) + "%"
        : "—";
      document.getElementById("val-turns").textContent = String(usageTotals.toolCalls);
    }

    // ---------- Permission questions ----------

    function initApprovalDialog() {
      document.getElementById("approval-modal").addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          answerApproval(false);
        }
      });
    }

    function enqueueApproval(payload) {
      pendingApprovals.push(payload);
      if (pendingApprovals.length === 1) showApproval(payload);
    }

    function showApproval(payload) {
      const modal = document.getElementById("approval-modal");
      document.getElementById("approval-question").textContent = (payload.question || "").replace(/\s*\[y\/N\]\s*$/i, "");
      const detail = document.getElementById("approval-detail");
      detail.textContent = payload.detail || "";
      detail.hidden = !payload.detail;
      const actions = document.getElementById("approval-actions");
      actions.replaceChildren();
      const choices = Array.isArray(payload.choices) && payload.choices.length > 0
        ? payload.choices
        : [{ label: "允许", value: "__allow" }, { label: "拒绝", value: "deny" }];
      // Declining is always last and focused: Enter never approves by accident.
      const ordered = [...choices.filter(c => c.value !== "deny"), ...choices.filter(c => c.value === "deny")];
      if (!ordered.some(c => c.value === "deny")) ordered.push({ label: "拒绝", value: "deny" });
      let declineButton = null;
      ordered.forEach(choice => {
        const b = document.createElement("button");
        b.type = "button";
        const isDeny = choice.value === "deny";
        b.className = isDeny ? "btn-cancel-settings" : "btn-save-settings";
        b.textContent = isDeny ? "拒绝（Esc）" : choice.label;
        b.addEventListener("click", () => answerApproval(!isDeny, choice.value));
        actions.appendChild(b);
        if (isDeny) declineButton = b;
      });
      modal.hidden = false;
      modal.classList.add("open");
      declineButton?.focus();
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
      else closeApprovalDialog();
    }

    function closeApprovalDialog() {
      pendingApprovals.length = 0;
      const modal = document.getElementById("approval-modal");
      modal.classList.remove("open");
      modal.hidden = true;
      composerInput.focus();
    }

    // ---------- Settings ----------

    function initSettingsModal() {
      const modal = document.getElementById("settings-modal");
      document.getElementById("btn-open-settings").addEventListener("click", openSettingsModal);
      document.getElementById("btn-close-settings").addEventListener("click", closeSettingsModal);
      document.getElementById("btn-cancel-settings").addEventListener("click", closeSettingsModal);
      document.getElementById("btn-save-settings").addEventListener("click", saveSettings);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeSettingsModal();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modal.classList.contains("open")) closeSettingsModal();
      });

      document.querySelectorAll(".settings-tab-link").forEach(btn => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".settings-tab-link").forEach(b => {
            b.classList.toggle("active", b === btn);
            b.setAttribute("aria-selected", b === btn ? "true" : "false");
          });
          document.querySelectorAll(".settings-tab-content").forEach(c => c.classList.remove("active"));
          document.getElementById("settings-pane-" + btn.dataset.settingsTab)?.classList.add("active");
        });
      });

      document.querySelectorAll("#setting-thinking-picker .segmented-btn").forEach(btn => {
        btn.addEventListener("click", () => selectThinkingLevel(btn.dataset.level));
      });

      const provSelect = document.getElementById("setting-provider-select");
      provSelect.addEventListener("change", () => {
        const hints = {
          deepseek: ["deepseek-chat", "DEEPSEEK_API_KEY"],
          openai: ["gpt-4.1", "OPENAI_API_KEY"],
          anthropic: ["claude-sonnet-4-5", "ANTHROPIC_API_KEY"],
          ollama: ["llama3:8b", "（本地服务，无需 Key）"],
        };
        const [placeholder, envName] = hints[provSelect.value] || ["", ""];
        document.getElementById("setting-model-input").placeholder = placeholder;
        document.getElementById("provider-key-env-name").textContent = envName;
        updateKeyStatusBadge(provSelect.value);
      });
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
      const modal = document.getElementById("settings-modal");
      modal.classList.add("open");
      document.getElementById("btn-close-settings").focus();
      await Promise.all([loadSettings(), loadRules(), loadExtensions()]);
    }

    function closeSettingsModal() {
      document.getElementById("settings-modal").classList.remove("open");
    }

    function updateKeyStatusBadge(providerName) {
      if (!currentSettingsData || !currentSettingsData.providers) return;
      const match = currentSettingsData.providers.find(p => p.name === providerName);
      const badge = document.getElementById("provider-key-status");
      const text = document.getElementById("provider-key-status-text");
      const ok = Boolean(match && match.hasKey);
      badge.className = "provider-status-badge" + (ok ? "" : " missing");
      text.textContent = ok ? "已找到凭据" : "未找到凭据";
    }

    async function loadSettings() {
      try {
        const data = await api("/api/settings");
        currentSettingsData = data;
        if (data.configPath) document.getElementById("setting-config-path").textContent = data.configPath;
        const g = data.general || {};
        if (g.defaultProvider) document.getElementById("setting-provider-select").value = g.defaultProvider;
        document.getElementById("setting-model-input").value = g.defaultModel || "";
        if (g.maxTurns) document.getElementById("setting-max-turns").value = g.maxTurns;
        if (g.maxSessionTokens) document.getElementById("setting-max-tokens").value = g.maxSessionTokens;
        if (g.repeatToolLimit !== undefined) document.getElementById("setting-repeat-tool-limit").value = g.repeatToolLimit;
        if (g.defaultThinkingLevel) selectThinkingLevel(g.defaultThinkingLevel);
        updateKeyStatusBadge(document.getElementById("setting-provider-select").value);
      } catch (err) {
        showToast("无法读取设置：" + err.message, "error");
      }
    }

    async function loadRules(force = false) {
      try {
        const data = await api("/api/rules");
        document.getElementById("setting-rules-editor").value = data.content || "";
        document.getElementById("rules-file-indicator").textContent = (data.filename || "AGENTS.md") + (data.exists ? "" : "（尚未创建）");
        if (force) showToast("已重新读取 AGENTS.md", "success");
      } catch (err) {
        showToast("无法读取 AGENTS.md：" + err.message, "error");
      }
    }

    function card(title, tag, desc) {
      const el = document.createElement("div");
      el.className = "plugin-card";
      const head = document.createElement("div");
      head.className = "plugin-card-header";
      const name = document.createElement("span");
      name.className = "plugin-name";
      name.textContent = title;
      const t = document.createElement("span");
      t.className = "plugin-tag";
      t.textContent = tag;
      head.append(name, t);
      const p = document.createElement("p");
      p.className = "plugin-desc";
      p.textContent = desc;
      el.append(head, p);
      return el;
    }

    async function loadExtensions() {
      try {
        const data = await api("/api/extensions");
        document.getElementById("plugins-container").replaceChildren(
          ...(data.extensions || []).map(ext => card(ext.name, ext.category || "extension", ext.description)),
        );
        const mcp = document.getElementById("mcp-container");
        const servers = data.mcpServers || [];
        if (servers.length === 0) {
          const empty = document.createElement("p");
          empty.className = "form-hint";
          empty.textContent = "没有发现 MCP 服务器。可以在工作区 .mcp.json 或配置文件的 [mcp] 段里添加。";
          mcp.replaceChildren(empty);
        } else {
          mcp.replaceChildren(...servers.map(s => card(s.name, s.transport, "来源：" + s.source)));
        }
      } catch (err) {
        showToast("无法读取扩展列表：" + err.message, "error");
      }
    }

    function appendRulePreset(type) {
      const snippets = {
        Surgical: "\n## 最小改动\n- 只改实现需求所必需的文件与代码行。\n- 不做无关的格式化、重构或清理。\n",
        TestFirst: "\n## 交付前跑测试\n- 交付前运行受影响模块的测试并确认通过。\n- 回复里附上测试命令与结果。\n",
        Security: "\n## 不硬编码凭据\n- 源码与日志里不写任何 API Key 或密钥，使用环境变量。\n- 数据库与命令调用一律参数化。\n",
      };
      const editor = document.getElementById("setting-rules-editor");
      editor.value = (editor.value.trim() + (snippets[type] || "")).trim() + "\n";
    }

    async function saveSettings() {
      const btnSave = document.getElementById("btn-save-settings");
      btnSave.textContent = "保存中…";
      btnSave.disabled = true;
      try {
        const providerName = document.getElementById("setting-provider-select").value;
        const modelName = document.getElementById("setting-model-input").value.trim();
        const apiKey = document.getElementById("setting-api-key-input").value.trim();
        await api("/api/settings", {
          method: "POST",
          body: {
            general: {
              defaultProvider: providerName,
              ...(modelName ? { defaultModel: modelName } : {}),
              defaultThinkingLevel: selectedThinkingLevel,
              maxTurns: parseInt(document.getElementById("setting-max-turns").value, 10) || 24,
              maxSessionTokens: parseInt(document.getElementById("setting-max-tokens").value, 10) || 48000,
              repeatToolLimit: parseInt(document.getElementById("setting-repeat-tool-limit").value, 10) || 0,
            },
            provider: { name: providerName, ...(modelName ? { model: modelName } : {}), ...(apiKey ? { apiKey } : {}) },
          },
        });
        await api("/api/rules", { method: "POST", body: { content: document.getElementById("setting-rules-editor").value } });
        document.getElementById("setting-api-key-input").value = "";
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

    // ---------- Trajectory ----------

    function renderTrajectory(steps, stats) {
      const durEl = document.getElementById("traj-stat-duration");
      if (stats && stats.createdAt && stats.updatedAt) {
        const sec = Math.max(1, Math.round((new Date(stats.updatedAt) - new Date(stats.createdAt)) / 1000));
        durEl.textContent = (sec >= 60 ? Math.floor(sec / 60) + "m" : "") + (sec % 60) + "s";
      } else {
        durEl.textContent = "—";
      }
      const stepCount = stats?.totalSteps || steps.length;
      document.getElementById("traj-stat-turns").textContent = (stepCount > 0 ? (stats?.totalTurns || 0) : 0) + " 轮 · " + stepCount + " 步";
      document.getElementById("traj-stat-calls").textContent = (stats?.totalToolCalls || 0) + " 次工具调用" + (stats?.totalErrors ? "（" + stats.totalErrors + " 次失败）" : "");
      renderTimelineWaterfall(steps);
      renderTrajectoryList(steps, document.getElementById("trajectory-search-input").value.trim());
    }

    function renderTimelineWaterfall(steps) {
      const rows = {
        input: document.getElementById("track-row-input"),
        model: document.getElementById("track-row-model"),
        tools: document.getElementById("track-row-tools"),
      };
      Object.values(rows).forEach(r => r.replaceChildren());
      if (!steps || steps.length === 0) return;
      const n = steps.length;
      const width = Math.max(2, Math.min(8, 92 / n));
      steps.forEach((s, idx) => {
        const block = document.createElement("div");
        block.style.left = (idx / n) * 98 + "%";
        block.style.width = width + "%";
        const row = s.type === "input" ? "input" : s.type === "tool" ? "tools" : "model";
        block.className = "timeline-block " + (row === "input" ? "block-input" : row === "tools" ? "block-tool" + (s.isError ? " error" : "") : "block-model");
        block.title = "#" + s.stepNumber + " " + (s.name || s.type) + " " + (s.argsPreview || s.content || "").slice(0, 80);
        block.addEventListener("click", () => {
          const target = document.getElementById("traj-step-" + s.id);
          if (!target) return;
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("highlighted");
          setTimeout(() => target.classList.remove("highlighted"), 1500);
        });
        rows[row].appendChild(block);
      });
    }

    function renderTrajectoryList(steps, query = "") {
      const stream = document.getElementById("trajectory-stream");
      stream.replaceChildren();
      const q = (query || "").toLowerCase();
      const filtered = q
        ? steps.filter(s => [s.name, s.argsPreview, s.outputPreview, s.content, s.thought].join(" ").toLowerCase().includes(q))
        : steps;
      if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "trajectory-empty";
        empty.textContent = q ? "没有包含「" + query + "」的步骤" : "暂无轨迹。选择一个会话，或在对话里发起任务。";
        stream.appendChild(empty);
        return;
      }
      const labels = { input: "用户", thinking: "思考", assistant: "回复", tool: "工具" };
      filtered.forEach(s => {
        const item = document.createElement("div");
        item.className = "traj-item";
        item.id = "traj-step-" + s.id;
        const summary = document.createElement("button");
        summary.type = "button";
        summary.className = "traj-row-summary";
        summary.dataset.toggle = "traj-item";
        summary.setAttribute("aria-expanded", "false");
        const dot = document.createElement("span");
        dot.className = "traj-dot" + (s.isError ? " error" : "");
        const badge = document.createElement("span");
        badge.className = "traj-badge " + (s.type === "input" ? "user" : s.type);
        badge.textContent = labels[s.type] || s.type;
        const preview = document.createElement("span");
        preview.className = "traj-content-preview";
        preview.textContent = s.type === "tool"
          ? (s.name || "tool") + "  " + (s.argsPreview || "") + "  →  " + (s.outputPreview || "")
          : (s.content || s.thought || "").slice(0, 160);
        summary.append(dot, badge, preview);

        const detail = document.createElement("div");
        detail.className = "traj-detail-panel";
        const meta = document.createElement("div");
        meta.className = "traj-detail-meta";
        meta.textContent = "步骤 #" + s.stepNumber + " · 第 " + s.turnNumber + " 轮" + (s.callId ? " · " + s.callId : "") + (s.isError ? " · 失败" : "");
        detail.appendChild(meta);
        if (s.type === "tool") {
          detail.append(codeBlock("参数", JSON.stringify(s.args || {}, null, 2)), codeBlock("输出", s.output || "（无输出）"));
        } else {
          if (s.thought) detail.appendChild(codeBlock("思考", s.thought));
          detail.appendChild(codeBlock(labels[s.type] || "内容", s.content || ""));
        }
        item.append(summary, detail);
        stream.appendChild(item);
      });
    }

    function codeBlock(title, text) {
      const wrap = document.createElement("div");
      const h = document.createElement("div");
      h.className = "traj-section-title";
      h.textContent = title;
      const block = document.createElement("div");
      block.className = "traj-code-block";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "traj-btn-copy";
      copy.dataset.action = "copy";
      copy.textContent = "复制";
      const code = document.createElement("code");
      code.textContent = text;
      block.append(copy, code);
      wrap.append(h, block);
      return wrap;
    }

    function initTrajectoryControls() {
      document.getElementById("trajectory-search-input").addEventListener("input", (e) => {
        renderTrajectoryList(currentTrajectorySteps, e.target.value);
      });
      document.getElementById("btn-export-log").addEventListener("click", () => {
        if (!activeSessionId || !allSessions.some(s => s.id === activeSessionId)) {
          showToast("这个会话还没有记录可导出", "error");
          return;
        }
        window.open("/api/sessions/" + activeSessionId + "/log", "_blank", "noopener");
      });
    }

    function copyCode(btn) {
      const code = btn.parentElement.querySelector("code");
      if (!code) return;
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = "复制"; }, 1500);
      });
    }

    async function fetchDiff() {
      const body = document.getElementById("diff-output-body");
      body.textContent = "正在读取 git diff…";
      try {
        const data = await api("/api/workspace/diff");
        body.textContent = data.diff && data.diff.trim() ? data.diff : "工作区没有未提交的改动。";
      } catch (err) {
        body.textContent = "读取失败：" + err.message;
      }
    }

    // ---------- Utilities ----------

    /** Same-origin JSON call; the session cookie authenticates it. Errors carry the server's message. */
    async function api(url, options = {}) {
      const res = await fetch(url, {
        method: options.method || "GET",
        headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        if (res.status === 401) throw new Error("访问凭据已失效，请重新打开 xio web 打印的链接");
        throw new Error((data && data.error) || ("HTTP " + res.status));
      }
      return data;
    }

    function showToast(message, type = "success") {
      const container = document.getElementById("toast-container");
      const toast = document.createElement("div");
      toast.className = "toast " + type;
      toast.textContent = message;
      container.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add("show"));
      setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
      }, type === "error" ? 6000 : 3000);
    }

    function insertPrompt(text) {
      composerInput.value = text;
      composerInput.focus();
    }
