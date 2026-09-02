/**
 * XioCode Web Console - HTML Markup
 */
export function renderUiMarkup(): string {
  return `
<body>
  <div class="app-layout">
    <aside id="sidebar">
      <div class="sidebar-brand-row">
        <div class="brand-link">
          <div class="brand-logo-icon">
            <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
          </div>
          <span class="brand-name">XioCode Web</span>
          <span class="harness-badge">HARNESS</span>
        </div>
        <button id="btn-toggle-sidebar" class="btn-toggle-sidebar" title="收起边栏">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
        </button>
      </div>

      <div class="sidebar-action-box">
        <button id="btn-new-session" class="btn-new-session">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>新会话</span>
        </button>
        <div class="search-input-wrap">
          <svg class="search-icon" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/></svg>
          <input type="text" id="session-search" class="search-input" placeholder="搜索会话...">
        </div>
      </div>

      <div id="session-list" class="session-list-container">
        <!-- Sessions dynamic -->
      </div>

      <div class="sidebar-footer">
        <button id="btn-open-settings" class="sidebar-footer-btn" title="控制台设置">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          <span>设置</span>
        </button>
        <span id="session-count-badge" class="sidebar-count-text">0 个会话</span>
      </div>
    </aside>

    <main>
      <!-- DeepSeek Harness Merged Top Bar -->
      <div class="main-subhead">
        <div class="subhead-top-row">
          <div class="subhead-left">
            <button id="btn-expand-sidebar" class="btn-expand-sidebar" title="展开侧边栏" style="display: none;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
            </button>
            <h2 id="current-session-title" class="subhead-title">新会话 · 准备就绪</h2>
            <span id="current-mode-badge" class="mode-badge">⚖️ 极简模式</span>
          </div>

          <div class="subhead-right">
            <button id="btn-export-log" class="btn-session-log" title="导出完整轨迹日志 (Session Log)">
              <span>Session log</span>
              <span>📥</span>
            </button>
            <select id="permission-select" class="permission-select">
              <option value="auto">权限: 自动 (Auto)</option>
              <option value="strict">权限: 严格 (Strict)</option>
              <option value="full">权限: 完全 (Full)</option>
            </select>
            <div id="status-pill" class="status-badge">
              <span class="status-dot"></span>
              <span id="status-text">就绪</span>
            </div>
          </div>
        </div>

        <nav class="nav-tabs">
          <button class="nav-tab-btn active" data-view="chat">对话</button>
          <button class="nav-tab-btn" data-view="trajectory">轨迹</button>
          <button class="nav-tab-btn" data-view="diff">代码差异</button>
          <button class="nav-tab-btn" data-view="metrics">运行指标</button>
        </nav>
      </div>

      <!-- Views Container -->
      <div class="view-content-wrapper" style="flex: 1; overflow: hidden; display: flex; flex-direction: column; position: relative;">
        <!-- Chat View -->
        <section id="view-chat" class="view-panel active">
          <div id="chat-messages" class="chat-messages">
            <div class="chat-inner-wrap" id="chat-flow-container">
              <!-- Hero State -->
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
                      <span class="starter-desc">检测本地环境、配置及模型供应商凭据</span>
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
            </div>
          </div>
        </section>

        <!-- Trajectory View -->
        <section id="view-trajectory" class="view-panel">
          <div class="trajectory-container">
            <!-- Ribbon Stats -->
            <div class="trajectory-ribbon">
              <div class="ribbon-stats">
                <span class="ribbon-stat-item"><span class="stat-icon">⏱</span> <span id="traj-stat-duration">0s</span></span>
                <span class="ribbon-stat-item"><span class="stat-icon">🔄</span> <span id="traj-stat-turns">0 轮 · 0 步</span></span>
                <span class="ribbon-stat-item"><span class="stat-icon">⚙</span> <span id="traj-stat-calls">0 次调用</span></span>
              </div>
              <div class="trajectory-search-wrap">
                <svg class="search-icon" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/></svg>
                <input type="text" id="trajectory-search-input" class="trajectory-search-input" placeholder="搜索轨迹 (工具/参数/输出/推理)...">
              </div>
            </div>

            <!-- Waterfall Timeline Chart -->
            <div class="timeline-waterfall" id="timeline-waterfall">
              <div class="track-labels">
                <span class="track-label">Input</span>
                <span class="track-label">Model</span>
                <span class="track-label">Tools</span>
              </div>
              <div class="track-bars-container" id="track-bars-container">
                <div class="track-row" id="track-row-input"></div>
                <div class="track-row" id="track-row-model"></div>
                <div class="track-row" id="track-row-tools"></div>
              </div>
            </div>

            <!-- Steps Stream -->
            <div class="trajectory-stream-wrapper">
              <div class="trajectory-stream" id="trajectory-stream">
                <div class="trajectory-empty" id="trajectory-empty">
                  <span>暂无运行轨迹数据。请选择左侧会话或在对话中发起任务。</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Metrics View -->
        <section id="view-metrics" class="view-panel">
          <div class="clean-deck">
            <div class="metrics-row">
              <div class="metric-box">
                <span class="metric-heading">总 Token 消耗</span>
                <span class="metric-digit" id="val-tokens">0</span>
                <span class="metric-foot">提示词 + 生成 Tokens</span>
              </div>
              <div class="metric-box">
                <span class="metric-heading">缓存命中率</span>
                <span class="metric-digit" id="val-cache">94.2%</span>
                <span class="metric-foot">冷启动感知加速</span>
              </div>
              <div class="metric-box">
                <span class="metric-heading">预估费用</span>
                <span class="metric-digit" id="val-cost">$0.00</span>
                <span class="metric-foot">标准模型费率核算</span>
              </div>
              <div class="metric-box">
                <span class="metric-heading">工具调用次数</span>
                <span class="metric-digit" id="val-turns">0</span>
                <span class="metric-foot">执行总计次数</span>
              </div>
            </div>
          </div>
        </section>

        <!-- Diff View -->
        <section id="view-diff" class="view-panel">
          <div class="clean-deck">
            <div class="diff-panel">
              <div class="diff-panel-header">
                <span>工作区代码变更 (Working Tree Changes)</span>
                <button class="filter-chip" onclick="fetchDiff()">刷新变更</button>
              </div>
              <div class="diff-panel-body" id="diff-output-body">正在加载工作区 diff...</div>
            </div>
          </div>
        </section>
      </div>

      <!-- Shared Floating Composer at Bottom -->
      <div class="composer-section">
        <div class="composer-card">
          <textarea id="composer-input" class="composer-input" placeholder="给智能体发消息... (Enter 发送，Shift+Enter 换行)"></textarea>
          <div class="composer-bar">
            <div class="composer-bar-left">
              <span class="composer-add-btn" title="快捷指令">+</span>
              <div class="chip-list">
                <span class="filter-chip" onclick="insertPrompt('运行测试套件')">运行测试</span>
                <span class="filter-chip" onclick="insertPrompt('检查代码差异')">查看Diff</span>
                <span class="filter-chip" onclick="insertPrompt('运行 xio doctor 体检')">系统体检</span>
              </div>
            </div>
            <div class="action-group">
              <span class="key-tip">↵ 发送 · ⇧↵ 换行</span>
              <button id="btn-abort" class="btn-abort">中止</button>
              <button id="btn-send" class="btn-send" title="发送消息">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
              </button>
            </div>
          </div>
        </div>
        <div class="composer-statusbar" id="composer-statusbar">
          <span id="meta-turns-info">0 轮 · 0 步</span>
          <span class="meta-sep">|</span>
          <span id="meta-tools-info">工具调用 0 次</span>
          <span class="meta-sep">|</span>
          <span id="meta-session-cwd">工作区: local</span>
        </div>
      </div>
    </main>
  </div>

  <!-- Settings Modal (Claude Warm Paper style) -->
  <div id="settings-modal" class="settings-modal-overlay">
    <div class="settings-modal-container">
      <div class="settings-modal-header">
        <div class="settings-header-title-group">
          <div class="settings-modal-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            <span>XioCode 控制台设置 (Settings)</span>
          </div>
          <span class="settings-modal-desc">管理模型供应商、思维链策略、工作区规则、扩展插件与安全护栏</span>
        </div>
        <button id="btn-close-settings" class="btn-modal-close" title="关闭 (Esc)">✕</button>
      </div>

      <div class="settings-modal-body">
        <div class="settings-sidebar">
          <button class="settings-tab-link active" data-settings-tab="models">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM4 12a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm12 0a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2zM9 19a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-1z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>模型与推理 (Models)</span>
          </button>
          <button class="settings-tab-link" data-settings-tab="rules">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
            <span>规则与规范 (Rules)</span>
          </button>
          <button class="settings-tab-link" data-settings-tab="plugins">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
            <span>插件与扩展 (Plugins)</span>
          </button>
          <button class="settings-tab-link" data-settings-tab="safety">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
            <span>安全与权限 (Safety)</span>
          </button>
        </div>

        <div class="settings-main-pane">
          <!-- Tab 1: Models & Inference -->
          <div id="settings-pane-models" class="settings-tab-content active">
            <div>
              <h3 class="setting-group-title">模型供应商与推理引擎</h3>
              <p class="setting-group-desc">配置默认 Provider、模型标识、思维链深度 (Thinking Ladder) 与 Token 压缩预算。</p>
            </div>

            <div class="form-grid-2">
              <div class="form-field">
                <label for="setting-provider-select">默认 Provider</label>
                <select id="setting-provider-select">
                  <option value="deepseek">DeepSeek (默认)</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="ollama">Local Ollama</option>
                </select>
              </div>

              <div class="form-field">
                <label for="setting-model-input">默认模型名称 (Model ID)</label>
                <input type="text" id="setting-model-input" placeholder="deepseek-chat">
              </div>
            </div>

            <div class="form-field">
              <label>思维链深度梯度 (Thinking Level Ladder)</label>
              <div class="segmented-picker" id="setting-thinking-picker">
                <button type="button" class="segmented-btn" data-level="off">Off</button>
                <button type="button" class="segmented-btn" data-level="minimal">Minimal</button>
                <button type="button" class="segmented-btn" data-level="low">Low</button>
                <button type="button" class="segmented-btn" data-level="medium">Medium</button>
                <button type="button" class="segmented-btn active" data-level="high">High</button>
                <button type="button" class="segmented-btn" data-level="max">Max</button>
                <button type="button" class="segmented-btn" data-level="ultra">Ultra</button>
              </div>
            </div>

            <div class="form-grid-2">
              <div class="form-field">
                <label for="setting-max-turns">单轮最大 Turn 限制 (Max Turns, 1–40)</label>
                <input type="number" id="setting-max-turns" min="1" max="40" value="24">
              </div>

              <div class="form-field">
                <label for="setting-max-tokens">上下文压缩阈值 (Token Budget)</label>
                <input type="number" id="setting-max-tokens" min="1024" step="1024" value="48000">
              </div>
            </div>

            <div class="form-field">
              <label>API Key 凭据检测与更新 (安全加密存储)</label>
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
                <span id="provider-key-status" class="provider-status-badge">
                  <span class="status-dot"></span>
                  <span id="provider-key-status-text">检测中...</span>
                </span>
                <span style="font-size: 11.5px; color: var(--text-tertiary);" id="provider-key-env-name">DEEPSEEK_API_KEY</span>
              </div>
              <input type="password" id="setting-api-key-input" placeholder="输入新的 API Key（留空则保持现有凭据不变）">
            </div>
          </div>

          <!-- Tab 2: Rules & Prompts -->
          <div id="settings-pane-rules" class="settings-tab-content">
            <div>
              <h3 class="setting-group-title">工作区规则与系统规范 (Rules & Directives)</h3>
              <p class="setting-group-desc">定义 Agent 在当前工作区内的改码纪律、执行守卫与禁止项（映射本地 <code>AGENTS.md</code>）。</p>
            </div>

            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <span class="filter-chip" onclick="appendRulePreset('Surgical')">+ Surgical Diff 最小改动规范</span>
              <span class="filter-chip" onclick="appendRulePreset('TestFirst')">+ Test-First 严格测试验证</span>
              <span class="filter-chip" onclick="appendRulePreset('Security')">+ A3 零凭证硬编码安全基线</span>
            </div>

            <div class="rules-box-wrap">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <span style="font-size: 12px; font-weight: 600; color: var(--text-secondary);" id="rules-file-indicator">AGENTS.md</span>
                <button type="button" class="filter-chip" onclick="loadRules(true)">重载本地文件</button>
              </div>
              <textarea id="setting-rules-editor" class="rules-editor-textarea" placeholder="# 工作区 Agent 规则定义..."></textarea>
            </div>
          </div>

          <!-- Tab 3: Plugins & Extensions -->
          <div id="settings-pane-plugins" class="settings-tab-content">
            <div>
              <h3 class="setting-group-title">微内核扩展与插件中心 (Plugins & MCP)</h3>
              <p class="setting-group-desc">参考 deepseek-harness 插件生态：管理 XioCode 7 大内置扩展与外部 Model Context Protocol 服务。</p>
            </div>

            <div class="plugin-grid" id="plugins-container">
              <!-- Dynamically populated -->
            </div>
          </div>

          <!-- Tab 4: Safety & Permissions -->
          <div id="settings-pane-safety" class="settings-tab-content">
            <div>
              <h3 class="setting-group-title">安全门禁与权限模式 (Safety & Permissions)</h3>
              <p class="setting-group-desc">控制 Agent 在工作区内修改文件、执行 Shell 与调用危险命令的审批级别。</p>
            </div>

            <div class="perm-cards-grid">
              <div class="perm-card active" data-perm-mode="auto" onclick="selectPermCard('auto')">
                <div class="perm-card-title">
                  <span style="color: #15803d;">●</span> Workspace-Only (推荐)
                </div>
                <div class="perm-card-desc">自动放行工作区内安全读写与常规单测；高危命令 (rm/reset/push) 需确认。</div>
              </div>

              <div class="perm-card" data-perm-mode="strict" onclick="selectPermCard('strict')">
                <div class="perm-card-title">
                  <span style="color: #ca8a04;">●</span> Strict / Ask-Always
                </div>
                <div class="perm-card-desc">任何文件写入修改、Shell 命令与外部调用均须在控制台手动审批。</div>
              </div>

              <div class="perm-card" data-perm-mode="full" onclick="selectPermCard('full')">
                <div class="perm-card-title">
                  <span style="color: #dc2626;">●</span> Full-Auto (沙箱模式)
                </div>
                <div class="perm-card-desc">全自主执行无需干预；推荐仅在 Git Worktree 或 Docker 沙箱中启用。</div>
              </div>
            </div>

            <div class="form-grid-2">
              <div class="form-field">
                <label for="setting-repeat-tool-limit">工具连续重复调用熔断上限 (Repeat Limit)</label>
                <input type="number" id="setting-repeat-tool-limit" min="0" max="20" value="3">
              </div>

              <div class="form-field">
                <label>高危操作拦截名单 (Blocked High-Risk)</label>
                <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px;">
                  <span class="extension-tag" style="background:#fee2e2; color:#991b1b;">rm -rf</span>
                  <span class="extension-tag" style="background:#fee2e2; color:#991b1b;">git reset --hard</span>
                  <span class="extension-tag" style="background:#fee2e2; color:#991b1b;">git push --force</span>
                  <span class="extension-tag" style="background:#fee2e2; color:#991b1b;">drop database</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-modal-footer">
        <span class="config-path-hint" id="setting-config-path">~/.xiocode/config.toml</span>
        <div class="footer-actions">
          <button type="button" class="btn-cancel-settings" id="btn-cancel-settings">取消</button>
          <button type="button" class="btn-save-settings" id="btn-save-settings">保存配置</button>
        </div>
      </div>
    </div>
  </div>

  <div id="toast-container" class="toast-container"></div>
  `;
}
