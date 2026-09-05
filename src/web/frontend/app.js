let activeSessionId = "";
    let isRunning = false;
    let eventSource = null;
    let allSessions = [];
    let metricsState = { turns: 0, tokens: 0 };
    let currentSettingsData = null;
    let selectedThinkingLevel = "high";
    let selectedPermMode = "auto";
    let currentTrajectorySteps = [];
    let currentStats = {};

    const chatFlowContainer = document.getElementById("chat-flow-container");
    const chatScrollArea = document.getElementById("chat-messages");
    const composerInput = document.getElementById("composer-input");
    const btnSend = document.getElementById("btn-send");
    const btnAbort = document.getElementById("btn-abort");
    const statusPill = document.getElementById("status-pill");
    const statusText = document.getElementById("status-text");
    const sessionList = document.getElementById("session-list");
    const btnNewSession = document.getElementById("btn-new-session");
    const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");
    const sidebar = document.getElementById("sidebar");
    const sessionSearch = document.getElementById("session-search");

    document.addEventListener("DOMContentLoaded", async () => {
      initTabs();
      initSidebar();
      initComposer();
      initTrajectoryControls();
      initSettingsModal();
      await fetchStatus();
      await loadSessions();
      if (activeSessionId) {
        selectSession(activeSessionId);
      } else if (allSessions.length > 0) {
        const withMsgs = allSessions.find(s => (s.messageCount && s.messageCount > 0) || s.firstPrompt);
        const target = withMsgs || allSessions[0];
        selectSession(target.id || target.metadata?.id);
      }
    });

    function initTabs() {
      document.querySelectorAll(".nav-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".nav-tab-btn").forEach(b => b.classList.remove("active"));
          document.querySelectorAll(".view-panel").forEach(v => v.classList.remove("active"));
          btn.classList.add("active");
          const viewId = "view-" + btn.dataset.view;
          const target = document.getElementById(viewId);
          if (target) target.classList.add("active");
          if (btn.dataset.view === "trajectory") {
            renderTrajectory(currentTrajectorySteps, currentStats);
          } else if (btn.dataset.view === "diff") {
            fetchDiff();
          }
        });
      });
    }

    function initSidebar() {
      const btnExpandSidebar = document.getElementById("btn-expand-sidebar");
      if (btnToggleSidebar) {
        btnToggleSidebar.addEventListener("click", () => {
          sidebar.classList.add("collapsed");
          if (btnExpandSidebar) btnExpandSidebar.style.display = "inline-flex";
        });
      }
      if (btnExpandSidebar) {
        btnExpandSidebar.addEventListener("click", () => {
          sidebar.classList.remove("collapsed");
          btnExpandSidebar.style.display = "none";
        });
      }
      if (sessionSearch) {
        sessionSearch.addEventListener("input", (e) => {
          renderSessionList(e.target.value.trim().toLowerCase());
        });
      }
    }

    function initComposer() {
      composerInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });
      btnSend.addEventListener("click", handleSend);
      btnAbort.addEventListener("click", handleAbort);
      btnNewSession.addEventListener("click", handleNewSession);
    }

    function initSettingsModal() {
      const btnOpen = document.getElementById("btn-open-settings");
      const btnClose = document.getElementById("btn-close-settings");
      const btnCancel = document.getElementById("btn-cancel-settings");
      const btnSave = document.getElementById("btn-save-settings");
      const modal = document.getElementById("settings-modal");

      btnOpen.addEventListener("click", openSettingsModal);
      btnClose.addEventListener("click", closeSettingsModal);
      btnCancel.addEventListener("click", closeSettingsModal);
      btnSave.addEventListener("click", saveSettings);

      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeSettingsModal();
      });

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modal.classList.contains("open")) {
          closeSettingsModal();
        }
      });

      // Settings tab switching
      document.querySelectorAll(".settings-tab-link").forEach(btn => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".settings-tab-link").forEach(b => b.classList.remove("active"));
          document.querySelectorAll(".settings-tab-content").forEach(c => c.classList.remove("active"));
          btn.classList.add("active");
          const tabId = "settings-pane-" + btn.dataset.settingsTab;
          const pane = document.getElementById(tabId);
          if (pane) pane.classList.add("active");
        });
      });

      // Thinking level buttons
      document.querySelectorAll("#setting-thinking-picker .segmented-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          document.querySelectorAll("#setting-thinking-picker .segmented-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          selectedThinkingLevel = btn.dataset.level;
        });
      });

      // Provider change listener
      const provSelect = document.getElementById("setting-provider-select");
      provSelect.addEventListener("change", () => {
        const val = provSelect.value;
        const modelInput = document.getElementById("setting-model-input");
        const envName = document.getElementById("provider-key-env-name");
        if (val === "deepseek") {
          modelInput.placeholder = "deepseek-chat";
          envName.textContent = "DEEPSEEK_API_KEY";
        } else if (val === "openai") {
          modelInput.placeholder = "gpt-4.1";
          envName.textContent = "OPENAI_API_KEY";
        } else if (val === "anthropic") {
          modelInput.placeholder = "claude-3-7-sonnet";
          envName.textContent = "ANTHROPIC_API_KEY";
        } else if (val === "ollama") {
          modelInput.placeholder = "llama3:8b";
          envName.textContent = "OLLAMA_HOST (Optional)";
        }
        updateKeyStatusBadge(val);
      });

      // Permission selector sync
      const permSelect = document.getElementById("permission-select");
      permSelect.addEventListener("change", () => {
        selectPermCard(permSelect.value);
      });
    }

    async function openSettingsModal() {
      const modal = document.getElementById("settings-modal");
      modal.classList.add("open");
      await loadSettings();
      await loadRules();
      await loadExtensions();
    }

    function closeSettingsModal() {
      const modal = document.getElementById("settings-modal");
      modal.classList.remove("open");
    }

    function selectPermCard(mode) {
      selectedPermMode = mode;
      document.querySelectorAll(".perm-card").forEach(card => {
        card.classList.toggle("active", card.dataset.permMode === mode);
      });
      const permSelect = document.getElementById("permission-select");
      if (permSelect) permSelect.value = mode;
    }

    function updateKeyStatusBadge(providerName) {
      if (!currentSettingsData || !currentSettingsData.providers) return;
      const match = currentSettingsData.providers.find(p => p.name === providerName);
      const statusBadge = document.getElementById("provider-key-status");
      const statusText = document.getElementById("provider-key-status-text");
      if (match && match.hasKey) {
        statusBadge.className = "provider-status-badge";
        statusText.textContent = "已就绪 (检测到凭据)";
      } else {
        statusBadge.className = "provider-status-badge missing";
        statusText.textContent = "未检测到环境变量 / 密钥";
      }
    }

    async function loadSettings() {
      try {
        const res = await fetch("/api/settings");
        if (!res.json) return;
        const data = await res.json();
        currentSettingsData = data;

        if (data.configPath) {
          document.getElementById("setting-config-path").textContent = data.configPath;
        }

        if (data.general) {
          const provSelect = document.getElementById("setting-provider-select");
          if (data.general.defaultProvider) {
            provSelect.value = data.general.defaultProvider;
          }
          if (data.general.defaultModel) {
            document.getElementById("setting-model-input").value = data.general.defaultModel;
          }
          if (data.general.maxTurns) {
            document.getElementById("setting-max-turns").value = data.general.maxTurns;
          }
          if (data.general.maxSessionTokens) {
            document.getElementById("setting-max-tokens").value = data.general.maxSessionTokens;
          }
          if (data.general.repeatToolLimit !== undefined) {
            document.getElementById("setting-repeat-tool-limit").value = data.general.repeatToolLimit;
          }
          if (data.general.defaultThinkingLevel) {
            selectedThinkingLevel = data.general.defaultThinkingLevel;
            document.querySelectorAll("#setting-thinking-picker .segmented-btn").forEach(b => {
              b.classList.toggle("active", b.dataset.level === selectedThinkingLevel);
            });
          }
        }

        updateKeyStatusBadge(document.getElementById("setting-provider-select").value);
      } catch (err) {
        console.error("loadSettings error", err);
      }
    }

    async function loadRules(force = false) {
      try {
        const res = await fetch("/api/rules");
        const data = await res.json();
        const editor = document.getElementById("setting-rules-editor");
        if (editor) {
          editor.value = data.content || "";
          document.getElementById("rules-file-indicator").textContent = (data.filename || "AGENTS.md") + (data.exists ? " (本地已加载)" : " (新建)");
        }
        if (force) showToast("已重新读取工作区规则文件", "success");
      } catch (err) {
        console.error("loadRules error", err);
      }
    }

    async function loadExtensions() {
      try {
        const res = await fetch("/api/extensions");
        const data = await res.json();
        const container = document.getElementById("plugins-container");
        if (!container || !data.extensions) return;

        container.innerHTML = data.extensions.map(ext => `
          <div class="plugin-card">
            <div class="plugin-card-header">
              <span class="plugin-name">${escapeHtml(ext.name)}</span>
              <span class="plugin-tag">${escapeHtml(ext.category || 'plugin')}</span>
            </div>
            <p class="plugin-desc">${escapeHtml(ext.description)}</p>
          </div>
        `).join("");
      } catch (err) {
        console.error("loadExtensions error", err);
      }
    }

    function appendRulePreset(type) {
      const editor = document.getElementById("setting-rules-editor");
      let snippet = "";
      if (type === "Surgical") {
        snippet = "\n## Surgical Diff 最小修改原则\n- 只改动实现意图所必需的文件与代码行。\n- 严禁无关格式化、顺手重构或清理已有代码。\n";
      } else if (type === "TestFirst") {
        snippet = "\n## Test-First 严格测试交付\n- 交付前须执行并通过受影响模块的单元测试。\n- 输出中必须附带明确的测试执行状态证据。\n";
      } else if (type === "Security") {
        snippet = "\n## A3 凭据安全基线\n- 源码与日志中绝不硬编码任何 API Key 或敏感凭据。\n- 数据库与命令调用一律强制参数化。\n";
      }
      editor.value = (editor.value.trim() + snippet).trim() + "\n";
      showToast("已插入规则预设模板", "success");
    }

    async function saveSettings() {
      const btnSave = document.getElementById("btn-save-settings");
      btnSave.textContent = "保存中...";
      btnSave.disabled = true;

      try {
        const providerName = document.getElementById("setting-provider-select").value;
        const modelName = document.getElementById("setting-model-input").value.trim();
        const maxTurns = parseInt(document.getElementById("setting-max-turns").value, 10) || 24;
        const maxTokens = parseInt(document.getElementById("setting-max-tokens").value, 10) || 48000;
        const repeatLimit = parseInt(document.getElementById("setting-repeat-tool-limit").value, 10) || 3;
        const apiKey = document.getElementById("setting-api-key-input").value.trim();
        const rulesContent = document.getElementById("setting-rules-editor").value;

        // 1. Save general settings & provider
        const payload = {
          general: {
            defaultProvider: providerName,
            ...(modelName ? { defaultModel: modelName } : {}),
            defaultThinkingLevel: selectedThinkingLevel,
            maxTurns,
            maxSessionTokens: maxTokens,
            repeatToolLimit: repeatLimit,
          },
          provider: {
            name: providerName,
            ...(modelName ? { model: modelName } : {}),
            ...(apiKey ? { apiKey } : {}),
          },
          permissions: {
            allowHighRisk: selectedPermMode === "full",
          },
        };

        const res1 = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        // 2. Save rules content
        const res2 = await fetch("/api/rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: rulesContent }),
        });

        if (res1.ok && res2.ok) {
          showToast("配置与规则已成功保存生效！", "success");
          document.getElementById("setting-api-key-input").value = "";
          closeSettingsModal();
        } else {
          showToast("保存失败，请检查控制台输出", "error");
        }
      } catch (err) {
        showToast("保存异常: " + err.message, "error");
      } finally {
        btnSave.textContent = "保存配置";
        btnSave.disabled = false;
      }
    }

    function showToast(message, type = "success") {
      const container = document.getElementById("toast-container");
      const toast = document.createElement("div");
      toast.className = "toast " + type;
      toast.innerHTML = (type === "success" ? "✓ " : "✕ ") + escapeHtml(message);
      container.appendChild(toast);

      requestAnimationFrame(() => {
        toast.classList.add("show");
      });

      setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }

    function insertPrompt(text) {
      composerInput.value = text;
      composerInput.focus();
    }

    async function fetchStatus() {
      try {
        const res = await fetch("/api/status");
        const data = await res.json();
        const wsName = data.cwd ? data.cwd.split("/").pop() : "工作区";
        const wsChip = document.getElementById("active-workspace-chip");
        if (wsChip) wsChip.textContent = "工作区: " + wsName;
      } catch (err) {
        console.error("fetchStatus err", err);
      }
    }

    async function loadSessions() {
      try {
        const res = await fetch("/api/sessions");
        allSessions = await res.json();
        const badge = document.getElementById("session-count-badge");
        if (badge) badge.textContent = allSessions.length + " 个会话";
        renderSessionList();
      } catch (err) {
        console.error("loadSessions err", err);
      }
    }

    function formatRelativeTime(dateStr) {
      if (!dateStr) return "";
      try {
        const diffMs = Date.now() - new Date(dateStr).getTime();
        if (diffMs < 0) return "刚刚";
        const sec = Math.floor(diffMs / 1000);
        if (sec < 60) return "刚刚";
        const min = Math.floor(sec / 60);
        if (min < 60) return min + "分钟前";
        const hr = Math.floor(min / 60);
        if (hr < 24) return hr + "小时前";
        const day = Math.floor(hr / 24);
        if (day < 30) return day + "天前";
        const d = new Date(dateStr);
        return (d.getMonth() + 1) + "月" + d.getDate() + "日";
      } catch {
        return "";
      }
    }

    function formatSessionTitle(sess, index) {
      if (sess.firstPrompt) return sess.firstPrompt.slice(0, 32);
      if (sess.first_prompt) return sess.first_prompt.slice(0, 32);
      const id = sess.id || sess.metadata?.id || "";
      if (id) {
        return (sess.messageCount === 0 ? "新会话 · " : "会话 ") + id.slice(0, 8);
      }
      return "会话 #" + (index + 1);
    }

    function renderSessionList(query = "") {
      sessionList.innerHTML = "";
      const q = (query || "").trim().toLowerCase();
      const filtered = q
        ? allSessions.filter(s => {
            const title = (s.firstPrompt || s.first_prompt || formatSessionTitle(s, 0)).toLowerCase();
            const id = (s.id || s.metadata?.id || "").toLowerCase();
            const rawCwd = (s.cwd || s.main_root || "").toLowerCase();
            return title.includes(q) || id.includes(q) || rawCwd.includes(q);
          })
        : allSessions;

      if (filtered.length === 0) {
        sessionList.innerHTML = `<div class="empty-state-list">未找到相关会话</div>`;
        return;
      }

      // Group sessions by workspace directory name (e.g. bff, xiocode, 未分组)
      const groups = new Map();
      filtered.forEach(sess => {
        const rawCwd = sess.cwd || sess.main_root || "";
        let wsName = "未分组";
        if (rawCwd) {
          const parts = rawCwd.split("/").filter(Boolean);
          wsName = parts[parts.length - 1] || "未分组";
        }
        if (!groups.has(wsName)) {
          groups.set(wsName, []);
        }
        groups.get(wsName).push(sess);
      });

      // Render workspace header
      const wsHeader = document.createElement("div");
      wsHeader.className = "sidebar-section-title";
      wsHeader.innerHTML = `<span>工作区</span><span style="font-size: 10.5px; font-weight: normal; color: var(--text-tertiary);">${filtered.length} 个会话</span>`;
      sessionList.appendChild(wsHeader);

      for (const [wsName, sessList] of groups.entries()) {
        const groupEl = document.createElement("div");
        groupEl.className = "ws-group";
        groupEl.id = "ws-group-" + wsName;

        const headerEl = document.createElement("div");
        headerEl.className = "ws-group-header";
        headerEl.innerHTML = `
          <span class="ws-arrow">▾</span>
          <span class="ws-icon">📁</span>
          <span class="ws-name">${escapeHtml(wsName)}</span>
          <span class="ws-count" style="font-size: 11px; color: var(--text-tertiary); margin-left: auto;">${sessList.length}</span>
        `;
        headerEl.onclick = () => {
          groupEl.classList.toggle("collapsed");
        };
        groupEl.appendChild(headerEl);

        const itemsEl = document.createElement("div");
        itemsEl.className = "ws-group-items";

        sessList.forEach((sess, idx) => {
          const id = sess.id || sess.metadata?.id;
          const isActive = id === activeSessionId;
          const item = document.createElement("div");
          item.className = "session-item" + (isActive ? " active" : "");
          const timeText = formatRelativeTime(sess.updated_at || sess.created_at);
          const fullTitle = sess.firstPrompt || sess.first_prompt || formatSessionTitle(sess, idx);
          item.innerHTML = `
            <div class="session-item-text">
              <span class="session-title" title="${escapeHtml(fullTitle)}">${escapeHtml(formatSessionTitle(sess, idx))}</span>
              <span class="session-time">${timeText}</span>
            </div>
            <button class="session-del-btn" title="删除会话" onclick="event.stopPropagation(); deleteSession('${id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          `;
          item.addEventListener("click", () => selectSession(id));
          itemsEl.appendChild(item);
        });

        groupEl.appendChild(itemsEl);
        sessionList.appendChild(groupEl);
      }
    }

    async function handleNewSession() {
      try {
        const res = await fetch("/api/sessions", { method: "POST" });
        const data = await res.json();
        await loadSessions();
        selectSession(data.id);
      } catch (err) {
        console.error("handleNewSession err", err);
      }
    }

    async function deleteSession(id) {
      if (!confirm("Are you sure you want to delete this session?")) return;
      try {
        await fetch("/api/sessions/" + id, { method: "DELETE" });
        if (activeSessionId === id) {
          activeSessionId = "";
          clearChat();
        }
        await loadSessions();
      } catch (err) {
        console.error("deleteSession err", err);
      }
    }

    function selectSession(id) {
      activeSessionId = id;
      document.querySelectorAll(".session-item").forEach(el => el.classList.remove("active"));
      renderSessionList();
      connectSse(id);
      loadSessionDetail(id);
    }

    async function loadSessionDetail(id) {
      try {
        const res = await fetch("/api/sessions/" + id);
        if (!res.ok) return;
        const detail = await res.json();

        // Update header session title & badge
        const sessItem = allSessions.find(s => (s.metadata?.id || s.id) === id);
        const firstUserPrompt = detail.messages?.find(m => m.role === "user")?.content;
        const title = sessItem?.first_prompt || (firstUserPrompt ? firstUserPrompt.slice(0, 40) : ("Session " + id.slice(0, 8)));
        const titleEl = document.getElementById("current-session-title");
        if (titleEl) titleEl.textContent = title;
        const modeBadge = document.getElementById("current-mode-badge");
        if (modeBadge) {
          modeBadge.textContent = detail.metadata?.model?.id || "极简模式";
        }

        renderMessages(detail.messages || []);

        currentTrajectorySteps = detail.trajectory || [];
        currentStats = detail.stats || {};
        renderTrajectory(currentTrajectorySteps, currentStats);

        // Update composer statusbar
        const metaTurns = document.getElementById("meta-turns-info");
        if (metaTurns) metaTurns.textContent = (currentStats.totalTurns || 1) + " 轮 · " + (currentStats.totalSteps || currentTrajectorySteps.length) + " 步";
        const metaTools = document.getElementById("meta-tools-info");
        if (metaTools) metaTools.textContent = "工具调用 " + (currentStats.totalToolCalls || 0) + " 次";
        const metaCwd = document.getElementById("meta-session-cwd");
        if (metaCwd) metaCwd.textContent = "工作区: " + (detail.metadata?.cwd ? detail.metadata.cwd.split("/").pop() : "local");
      } catch (err) {
        console.error("loadSessionDetail err", err);
      }
    }

    function clearChat() {
      chatFlowContainer.innerHTML = "";
    }

    function renderMessages(messages) {
      clearChat();
      if (messages.length === 0) {
        chatFlowContainer.innerHTML = `
          <div class="hero-state" id="hero-state">
            <h1 class="hero-title">今天想构建什么？</h1>
            <p class="hero-subtitle">XioCode 是基于当前工作区自主运行的智能体，具备严格的安全审查与可观测轨迹。</p>
            <div class="starter-grid">
              <div class="starter-item" onclick="insertPrompt('运行完整测试套件并验证当前工作区完整性')">
                <div class="starter-icon-wrap">⚡</div>
                <div class="starter-text-wrap">
                  <span class="starter-title">运行测试套件</span>
                  <span class="starter-desc">执行单元测试与代码完整性断言</span>
                </div>
              </div>
              <div class="starter-item" onclick="insertPrompt('检查 git diff 并分析未暂存的改动')">
                <div class="starter-icon-wrap">📋</div>
                <div class="starter-text-wrap">
                  <span class="starter-title">检查代码差异</span>
                  <span class="starter-desc">审查工作树修改与改动影响面</span>
                </div>
              </div>
              <div class="starter-item" onclick="insertPrompt('运行 xio doctor 检查系统健康度与密钥状态')">
                <div class="starter-icon-wrap">🩺</div>
                <div class="starter-text-wrap">
                  <span class="starter-title">系统体检 (Doctor)</span>
                  <span class="starter-desc">检测本地环境、配置及模型凭据</span>
                </div>
              </div>
              <div class="starter-item" onclick="insertPrompt('分析代码库架构与核心模块分层约定')">
                <div class="starter-icon-wrap">🧭</div>
                <div class="starter-text-wrap">
                  <span class="starter-title">分析代码库架构</span>
                  <span class="starter-desc">梳理依赖链路与设计规范</span>
                </div>
              </div>
            </div>
          </div>
        `;
        return;
      }

      messages.forEach(msg => {
        if (msg.role === "user") {
          appendUserMessage(msg.content);
        } else if (msg.role === "assistant") {
          appendAssistantMessage(msg.content);
        }
      });
    }

    function appendUserMessage(text) {
      const hero = document.getElementById("hero-state");
      if (hero) hero.remove();

      const row = document.createElement("div");
      row.className = "message-row user";
      row.innerHTML = `
        <div class="bubble user">
          <div class="bubble-content">${escapeHtml(text)}</div>
        </div>
      `;
      chatFlowContainer.appendChild(row);
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    let currentAssistantBox = null;

    function getOrCreateAssistantBox() {
      const hero = document.getElementById("hero-state");
      if (hero) hero.remove();

      if (!currentAssistantBox) {
        const row = document.createElement("div");
        row.className = "message-row assistant";
        const bubble = document.createElement("div");
        bubble.className = "bubble assistant";
        const content = document.createElement("div");
        content.className = "bubble-content";
        bubble.appendChild(content);
        row.appendChild(bubble);
        chatFlowContainer.appendChild(row);
        currentAssistantBox = content;
      }
      return currentAssistantBox;
    }

    async function handleSend() {
      const text = composerInput.value.trim();
      if (!text || isRunning) return;

      if (!activeSessionId) {
        const res = await fetch("/api/sessions", { method: "POST" });
        const data = await res.json();
        activeSessionId = data.id;
        await loadSessions();
      }

      appendUserMessage(text);
      composerInput.value = "";
      currentAssistantBox = null;
      setRunningState(true);

      try {
        const res = await fetch(`/api/sessions/${activeSessionId}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: text }),
        });
        if (!res.ok) {
          throw new Error("Failed to send prompt");
        }
      } catch (err) {
        appendAssistantMessage("Error dispatching prompt: " + err.message);
        setRunningState(false);
      }
    }

    async function handleAbort() {
      if (!activeSessionId || !isRunning) return;
      try {
        await fetch(`/api/sessions/${activeSessionId}/abort`, { method: "POST" });
      } catch (err) {
        console.error("abort error", err);
      }
    }

    function setRunningState(running) {
      isRunning = running;
      statusPill.className = "status-badge" + (running ? " running" : "");
      statusText.textContent = running ? "Thinking..." : "Ready";
      btnSend.style.display = running ? "none" : "flex";
      btnAbort.style.display = running ? "flex" : "none";
    }

    function connectSse(sessionId) {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (!sessionId) return;

      eventSource = new EventSource(`/api/sessions/${sessionId}/events`);
      eventSource.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          handleRuntimeEvent(event);
        } catch (err) {
          // ignore keepalive
        }
      };
      eventSource.onerror = () => {
        // SSE auto reconnects
      };
    }

    function handleRuntimeEvent(event) {
      const type = event.event;
      const payload = event.payload || {};

      if (type === "run.start") {
        setRunningState(true);
        if (payload.prompt) {
          const stepNum = currentTrajectorySteps.length + 1;
          currentTrajectorySteps.push({
            id: "step-live-" + stepNum + "-user",
            stepNumber: stepNum,
            turnNumber: Math.max(1, currentStats.totalTurns || 1),
            type: "input",
            role: "user",
            content: payload.prompt,
          });
          currentStats.totalSteps = currentTrajectorySteps.length;
          renderTrajectory(currentTrajectorySteps, currentStats);
        }
      } else if (type === "run.end" || type === "cancel") {
        setRunningState(false);
        currentAssistantBox = null;
        if (activeSessionId) {
          fetch("/api/sessions/" + activeSessionId + "/trajectory")
            .then(res => res.json())
            .then(data => {
              if (data && data.steps) {
                currentTrajectorySteps = data.steps;
                currentStats = data.stats;
                renderTrajectory(currentTrajectorySteps, currentStats);
              }
            }).catch(() => {});
        }
      } else if (type === "thinking.delta") {
        appendThinkingDelta(payload.delta || "");
      } else if (type === "text.delta") {
        appendTextDelta(payload.delta || "");
      } else if (type === "tool.call") {
        appendToolCall(payload);
        metricsState.turns++;
        const valTurns = document.getElementById("val-turns");
        if (valTurns) valTurns.textContent = metricsState.turns;

        const stepNum = currentTrajectorySteps.length + 1;
        currentTrajectorySteps.push({
          id: "step-live-" + stepNum + "-tool",
          stepNumber: stepNum,
          turnNumber: Math.max(1, currentStats.totalTurns || 1),
          type: "tool",
          role: "tool",
          name: payload.tool || "tool",
          args: payload.args || {},
          argsPreview: JSON.stringify(payload.args || {}).slice(0, 80),
          output: "",
          outputPreview: "running...",
          isError: false,
          callId: payload.call_id,
        });
        currentStats.totalSteps = currentTrajectorySteps.length;
        currentStats.totalToolCalls = (currentStats.totalToolCalls || 0) + 1;
        renderTrajectory(currentTrajectorySteps, currentStats);
      } else if (type === "tool.result") {
        updateToolResult(payload);
        const matched = currentTrajectorySteps.find(s => s.callId === payload.call_id);
        if (matched) {
          matched.output = payload.result || "";
          matched.outputPreview = (payload.result || "").replace(/\s+/g, " ").slice(0, 100);
          matched.isError = Boolean(payload.is_error);
          if (matched.isError) currentStats.totalErrors = (currentStats.totalErrors || 0) + 1;
          renderTrajectory(currentTrajectorySteps, currentStats);
        }
      }
    }

    function renderTrajectory(steps, stats) {
      const durEl = document.getElementById("traj-stat-duration");
      if (durEl) {
        let durText = "0s";
        if (stats && stats.createdAt && stats.updatedAt) {
          const ms = Math.max(1000, new Date(stats.updatedAt).getTime() - new Date(stats.createdAt).getTime());
          const sec = Math.round(ms / 1000);
          const m = Math.floor(sec / 60);
          const s = sec % 60;
          durText = (m > 0 ? m + "m" : "") + (s > 0 ? s + "s" : (m === 0 ? "1s" : ""));
        }
        durEl.textContent = stats && stats.totalToolCalls > 0 ? ("LLM " + durText + " · 工具调用 " + stats.totalToolCalls + " 次") : durText;
      }

      const turnsEl = document.getElementById("traj-stat-turns");
      if (turnsEl) {
        turnsEl.textContent = (stats?.totalTurns || 1) + " 轮 · " + (stats?.totalSteps || steps.length) + " 步";
      }

      const callsEl = document.getElementById("traj-stat-calls");
      if (callsEl) {
        callsEl.textContent = (stats?.totalToolCalls || 0) + " Calls" + (stats?.totalErrors ? (" (" + stats.totalErrors + " 异常)") : "");
      }

      renderTimelineWaterfall(steps);

      const searchInput = document.getElementById("trajectory-search-input");
      const q = searchInput ? searchInput.value.trim() : "";
      renderTrajectoryList(steps, q);
    }

    function renderTimelineWaterfall(steps) {
      const inputRow = document.getElementById("track-row-input");
      const modelRow = document.getElementById("track-row-model");
      const toolsRow = document.getElementById("track-row-tools");
      if (!inputRow || !modelRow || !toolsRow) return;

      inputRow.innerHTML = "";
      modelRow.innerHTML = "";
      toolsRow.innerHTML = "";

      if (!steps || steps.length === 0) return;

      const N = steps.length;
      const blockWidth = Math.max(2, Math.min(8, 92 / N));

      steps.forEach((s, idx) => {
        const leftPct = (idx / N) * 98;
        const block = document.createElement("div");
        block.style.left = leftPct + "%";
        block.style.width = blockWidth + "%";

        if (s.type === "input") {
          block.className = "timeline-block block-input";
          block.title = "[用户输入] #" + s.stepNumber + ": " + (s.content ? s.content.slice(0, 80) : "");
          inputRow.appendChild(block);
        } else if (s.type === "assistant" || s.type === "thinking") {
          block.className = "timeline-block block-model";
          block.title = "[模型推理] #" + s.stepNumber + ": " + ((s.content || s.thought || "").slice(0, 80));
          modelRow.appendChild(block);
        } else if (s.type === "tool") {
          block.className = "timeline-block block-tool" + (s.isError ? " error" : "");
          block.title = "[工具执行 " + (s.name || "") + "] #" + s.stepNumber + ": " + (s.argsPreview || "");
          toolsRow.appendChild(block);
        }

        block.addEventListener("click", () => {
          const target = document.getElementById("traj-step-" + s.id);
          if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            target.classList.add("highlighted");
            setTimeout(() => target.classList.remove("highlighted"), 1500);
          }
        });
      });
    }

    function renderTrajectoryList(steps, query = "") {
      const stream = document.getElementById("trajectory-stream");
      if (!stream) return;
      stream.innerHTML = "";

      const q = (query || "").trim().toLowerCase();
      const filtered = q
        ? steps.filter(s => {
            const str = (s.name || "") + " " + (s.argsPreview || "") + " " + (s.outputPreview || "") + " " + (s.content || "") + " " + (s.thought || "");
            return str.toLowerCase().includes(q);
          })
        : steps;

      if (filtered.length === 0) {
        stream.innerHTML = '<div class="trajectory-empty">' + (query ? '未找到包含 "' + escapeHtml(query) + '" 的轨迹步骤' : '暂无运行轨迹数据。请选择左侧会话或在对话中发起任务。') + '</div>';
        return;
      }

      filtered.forEach(s => {
        const item = document.createElement("div");
        item.className = "traj-item";
        item.id = "traj-step-" + s.id;

        let badgeClass = s.type;
        let badgeLabel = s.type.toUpperCase();
        if (s.type === "input") { badgeClass = "user"; badgeLabel = "USER"; }
        else if (s.type === "thinking") { badgeClass = "thinking"; badgeLabel = "THINKING"; }
        else if (s.type === "assistant") { badgeClass = "assistant"; badgeLabel = "ASSISTANT"; }
        else if (s.type === "tool") { badgeClass = "tool"; badgeLabel = "TOOL"; }

        let summaryHtml = "";
        if (s.type === "tool") {
          summaryHtml = `
            <span class="traj-tool-name">${escapeHtml(s.name || "tool")}</span>
            <span class="traj-tool-args">${escapeHtml(s.argsPreview || "{}")}</span>
            <span class="traj-arrow">→</span>
            <span class="traj-tool-output">${escapeHtml(s.outputPreview || "")}</span>
          `;
        } else if (s.type === "assistant") {
          const isOnly = s.content === "(仅工具调用)" || s.content === "(tool call only)";
          summaryHtml = `<span class="traj-assistant-text ${isOnly ? 'traj-assistant-toolonly' : ''}">${escapeHtml(s.content || "")}</span>`;
        } else if (s.type === "thinking") {
          summaryHtml = `<span class="traj-assistant-text" style="color: #64748b;">${escapeHtml((s.thought || s.content || "").slice(0, 140))}</span>`;
        } else if (s.type === "input") {
          summaryHtml = `<span class="traj-content-preview" style="font-weight: 600; color: #1e293b;">${escapeHtml(s.content || "")}</span>`;
        }

        let detailHtml = `
          <div class="traj-detail-meta">
            <span>步骤 #${s.stepNumber} · 轮次 ${s.turnNumber}</span>
            <div>
              <span class="detail-status-pill ${s.isError ? 'error' : 'success'}">${s.isError ? '异常 / 失败' : '执行成功'}</span>
              ${s.callId ? '<span style="margin-left: 8px; font-family: var(--font-mono); font-size: 11px;">ID: ' + escapeHtml(s.callId) + '</span>' : ''}
            </div>
          </div>
        `;

        if (s.type === "tool") {
          detailHtml += `
            <div class="traj-section-title">调用参数 (Arguments)</div>
            <div class="traj-code-block">
              <button class="traj-btn-copy" onclick="event.stopPropagation(); copyCode(this)">复制</button>
              <code>${escapeHtml(JSON.stringify(s.args || {}, null, 2))}</code>
            </div>
            <div class="traj-section-title" style="margin-top: 10px;">执行结果 (Output)</div>
            <div class="traj-code-block output-block">
              <button class="traj-btn-copy" onclick="event.stopPropagation(); copyCode(this)">复制</button>
              <code>${escapeHtml(s.output || "(无输出)")}</code>
            </div>
          `;
        } else if (s.type === "assistant") {
          if (s.thought) {
            detailHtml += `
              <div class="traj-thought-box">
                <div class="traj-thought-label">思考推理过程 (Thinking)</div>
                <div>${escapeHtml(s.thought)}</div>
              </div>
            `;
          }
          detailHtml += `
            <div class="traj-section-title">模型回复</div>
            <div style="font-size: 13px; line-height: 1.6; color: var(--text-primary); white-space: pre-wrap; padding: 4px 0;">${escapeHtml(s.content || "(仅工具调用)")}</div>
          `;
        } else if (s.type === "thinking") {
          detailHtml += `
            <div class="traj-thought-box">
              <div class="traj-thought-label">思考推理过程 (Thinking)</div>
              <div>${escapeHtml(s.thought || s.content || "")}</div>
            </div>
          `;
        } else if (s.type === "input") {
          detailHtml += `
            <div class="traj-section-title">用户指令 (User Prompt)</div>
            <div style="font-size: 13.5px; line-height: 1.6; color: var(--text-primary); white-space: pre-wrap; padding: 4px 0;">${escapeHtml(s.content || "")}</div>
          `;
        }

        item.innerHTML = `
          <div class="traj-row-summary" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="traj-dot ${s.isError ? 'error' : ''}"></span>
            <span class="traj-badge ${badgeClass}">${badgeLabel}</span>
            <div class="traj-content-preview">
              ${summaryHtml}
            </div>
          </div>
          <div class="traj-detail-panel">
            ${detailHtml}
          </div>
        `;
        stream.appendChild(item);
      });
    }

    function initTrajectoryControls() {
      const searchInput = document.getElementById("trajectory-search-input");
      if (searchInput) {
        searchInput.addEventListener("input", (e) => {
          renderTrajectoryList(currentTrajectorySteps, e.target.value);
        });
      }

      const btnExport = document.getElementById("btn-export-log");
      if (btnExport) {
        btnExport.addEventListener("click", () => {
          if (!activeSessionId) {
            showToast("请先选择一个会话", "error");
            return;
          }
          window.open("/api/sessions/" + activeSessionId + "/log", "_blank");
        });
      }
    }

    function copyCode(btn) {
      const code = btn.parentElement.querySelector("code");
      if (!code) return;
      navigator.clipboard.writeText(code.innerText).then(() => {
        const orig = btn.textContent;
        btn.textContent = "已复制!";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      });
    }

    function appendThinkingDelta(delta) {
      const box = getOrCreateAssistantBox();
      let card = box.querySelector(".thought-drawer");
      if (!card) {
        card = document.createElement("div");
        card.className = "thought-drawer";
        card.innerHTML = `
          <div class="thought-drawer-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="thought-badge">思考推理</span>
            <span class="thought-expand-hint">点击折叠/展开</span>
          </div>
          <div class="thought-drawer-body"></div>
        `;
        box.appendChild(card);
      }
      const body = card.querySelector(".thought-drawer-body");
      body.textContent += delta;
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    function appendTextDelta(delta) {
      const box = getOrCreateAssistantBox();
      let prose = box.querySelector(".prose");
      if (!prose) {
        prose = document.createElement("div");
        prose.className = "prose";
        box.appendChild(prose);
      }
      prose.textContent += delta;
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    function appendAssistantMessage(text) {
      const box = getOrCreateAssistantBox();
      const prose = document.createElement("div");
      prose.className = "prose";
      prose.innerHTML = `<p>${escapeHtml(text)}</p>`;
      box.appendChild(prose);
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    function appendToolCall(payload) {
      const box = getOrCreateAssistantBox();
      const card = document.createElement("div");
      card.className = "tool-box";
      card.id = "tool-" + (payload.call_id || Date.now());
      card.innerHTML = `
        <div class="tool-box-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="tool-name-tag">${payload.tool}</span>
          <span class="tool-status-pill">running</span>
        </div>
        <div class="tool-box-body">${JSON.stringify(payload.args || {}, null, 2)}</div>
      `;
      box.appendChild(card);
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    function updateToolResult(payload) {
      const card = document.getElementById("tool-" + payload.call_id);
      if (card) {
        const badge = card.querySelector(".tool-status-pill");
        if (badge) {
          badge.className = "tool-status-pill " + (payload.is_error ? "error" : "done");
          badge.textContent = payload.is_error ? "error" : "done";
        }
        const body = card.querySelector(".tool-box-body");
        if (body && payload.result) {
          body.textContent = payload.result;
        }
      }
    }

    async function fetchDiff() {
      const body = document.getElementById("diff-output-body");
      body.textContent = "Loading git diff...";
      try {
        const res = await fetch("/api/workspace/diff");
        const data = await res.json();
        body.textContent = data.diff && data.diff.trim().length > 0 ? data.diff : "Working tree clean. No uncommitted modifications.";
      } catch (err) {
        body.textContent = "Failed to fetch workspace diff.";
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
