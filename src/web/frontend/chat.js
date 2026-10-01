/**
 * The transcript: user and assistant messages, streamed markdown, thinking,
 * tool activity rows, the live "working" line and follow-to-bottom scrolling.
 */

const TOOL_OUTPUT_LIMIT = 20000;

/** How each tool reads in the transcript: an icon, a verb and the thing it acts on. */
const TOOL_KINDS = {
  read: { icon: "file", title: t("web.toolRead"), target: a => a.path || a.file_path },
  write: { icon: "file-plus", title: t("web.toolWrite"), target: a => a.path || a.file_path },
  edit: { icon: "pen", title: t("web.toolEdit"), target: a => a.path || a.file_path },
  bash: { icon: "terminal", title: t("web.toolBash"), target: a => a.command },
  grep: { icon: "text-search", title: t("web.toolGrep"), target: a => [a.pattern, a.path].filter(Boolean).join("  ·  ") },
  glob: { icon: "folder", title: t("web.toolGlob"), target: a => a.pattern },
  skill: { icon: "sparkle", title: t("web.toolSkill"), target: a => a.name || a.skill },
  parallel_edit: { icon: "layers", title: t("web.toolParallel"), target: a => Array.isArray(a.tasks) ? t("web.subtasks", { n: a.tasks.length }) : "" },
};

function toolKind(name, args) {
  const known = TOOL_KINDS[name];
  if (known) return { icon: known.icon, title: known.title, target: String(known.target(args) || "") };
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name || "");
  if (mcp) return { icon: "plug", title: mcp[2], target: mcp[1] };
  const firstValue = Object.values(args).find(v => typeof v === "string");
  return { icon: "wrench", title: name || t("web.tool"), target: firstValue || "" };
}

const chat = {
  assistantBox: null,
  toolRows: new Map(),
  stick: true,
  working: null,
  pendingRender: new Set(),
  renderScheduled: false,
};

// ---------- Rows ----------

function clearChat() {
  chatFlowContainer.replaceChildren();
  chat.toolRows.clear();
  chat.assistantBox = null;
  chat.working = null;
}

/** Insert above the live "working" line so it always stays last. */
function appendToColumn(node) {
  chatFlowContainer.insertBefore(node, chat.working);
  followIfStuck();
}

function renderHero() {
  const grid = el("div", "starter-grid");
  STARTERS.forEach(s => {
    const b = el("button", "starter-item",
      el("span", "starter-icon", xioIcon(s.icon)),
      el("span", "starter-title", s.title),
      el("span", "starter-desc", s.desc));
    b.type = "button";
    b.dataset.prompt = s.prompt;
    grid.appendChild(b);
  });
  const hero = el("div", "hero-state",
    el("div", "hero-mark", xioIcon("fin")),
    el("h2", "hero-title", t("web.heroTitle")),
    el("p", "hero-subtitle", t("web.heroSubtitle")),
    workspaceName ? el("span", "hero-workspace", xioIcon("folder"), workspaceName) : null,
    grid);
  hero.id = "hero-state";
  chatFlowContainer.appendChild(hero);
}

function removeHero() {
  $("hero-state")?.remove();
}

function messageRow(role) {
  removeHero();
  const body = el("div", "bubble " + role);
  const row = el("article", "message-row " + role);
  if (role === "assistant") {
    row.append(el("div", "message-role", el("span", "avatar", xioIcon("fin")), "XioCode"));
  } else {
    row.setAttribute("aria-label", t("web.you"));
  }
  row.appendChild(body);
  appendToColumn(row);
  return body;
}

function appendUserMessage(text) {
  finishAssistant();
  messageRow("user").appendChild(el("div", "bubble-content", text));
  chat.assistantBox = null;
}

function assistantBox() {
  if (!chat.assistantBox) chat.assistantBox = messageRow("assistant");
  return chat.assistantBox;
}

/** Restored sessions arrive as plain messages. */
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
      if (msg.content && msg.content.trim()) appendAssistantText(msg.content);
      (Array.isArray(msg.toolCalls) ? msg.toolCalls : []).forEach(call => appendToolCall(call.id, call.name, call.arguments, false));
    } else if (msg.role === "tool") {
      // The server classifies restored results (true / false / "unknown"); the client does not guess.
      updateToolResult(msg.toolCallId, msg.content, msg.isError);
    }
  }
  scrollToBottom();
}

// ---------- Prose ----------

function appendAssistantText(text) {
  const prose = el("div", "prose");
  prose._src = text;
  XioMarkdown.render(prose, text);
  assistantBox().appendChild(prose);
}

function appendTextDelta(delta) {
  const box = assistantBox();
  let prose = box.lastElementChild;
  if (!prose || !prose.classList.contains("streaming")) {
    finishThinking();
    prose = el("div", "prose streaming");
    prose._src = "";
    box.appendChild(prose);
  }
  prose._src += delta;
  scheduleRender(prose);
  setWorking(t("web.workingReply"));
}

/** Deltas arrive faster than frames; render each streaming block at most once per frame. */
function scheduleRender(prose) {
  chat.pendingRender.add(prose);
  if (chat.renderScheduled) return;
  chat.renderScheduled = true;
  requestAnimationFrame(() => {
    chat.renderScheduled = false;
    chat.pendingRender.forEach(p => XioMarkdown.render(p, p._src));
    chat.pendingRender.clear();
    followIfStuck();
  });
}

function finishProse() {
  chatFlowContainer.querySelectorAll(".prose.streaming").forEach(p => {
    p.classList.remove("streaming");
    chat.pendingRender.delete(p);
    XioMarkdown.render(p, p._src);
  });
}

// ---------- Thinking ----------

function thoughtBlock(live) {
  const label = el("span", live ? "shimmer" : null, live ? t("web.workingThink") : t("web.thinkingProcess"));
  const header = el("button", "thought-header", xioIcon("brain", "icon-brain"), label, xioIcon("chevron", "chev"));
  header.type = "button";
  header.dataset.toggle = "thought";
  header.setAttribute("aria-expanded", "false");
  const block = el("div", "thought" + (live ? " live" : ""), header, el("div", "thought-body"));
  block._label = label;
  block._started = Date.now();
  return block;
}

function appendThinkingDelta(delta) {
  const box = assistantBox();
  let block = box.lastElementChild;
  if (!block || !block.classList.contains("live")) {
    block = thoughtBlock(true);
    box.appendChild(block);
  }
  block.querySelector(".thought-body").textContent += delta;
  setWorking(t("web.workingThink"));
  followIfStuck();
}

function finishThinking() {
  chatFlowContainer.querySelectorAll(".thought.live").forEach(block => {
    block.classList.remove("live");
    block._label.className = "";
    const took = formatDuration(Date.now() - block._started);
    block._label.textContent = t("web.thoughtFor", { took });
  });
}

function finishAssistant() {
  finishProse();
  finishThinking();
}

// ---------- Tool rows ----------

function toolList(box) {
  const last = box.lastElementChild;
  if (last && last.classList.contains("tool-list")) return last;
  finishAssistant();
  const list = el("div", "tool-list");
  box.appendChild(list);
  return list;
}

const TOOL_STATES = {
  running: { label: t("web.stateRunning"), node: () => el("span", "spinner") },
  done: { label: t("web.stateDone"), node: () => xioIcon("check") },
  error: { label: t("web.stateFailed"), node: () => xioIcon("x") },
  unknown: { label: t("web.stateUnknown"), node: () => xioIcon("help") },
};

function setToolState(entry, state) {
  const spec = TOOL_STATES[state];
  entry.row.className = "tool-row " + state + (entry.row.classList.contains("expanded") ? " expanded" : "");
  entry.state.replaceChildren(spec.node(), el("span", "visually-hidden", spec.label));
  entry.state.title = spec.label;
}

function toolSection(label, text, className) {
  const pre = el("pre", "tool-pre" + (className ? " " + className : ""));
  pre.textContent = text;
  return el("div", "tool-section", el("div", "tool-section-label", label), pre);
}

function appendToolCall(id, name, args, live) {
  const params = args || {};
  const kind = toolKind(name, params);
  const target = el("span", "tool-target", kind.target);
  target.title = kind.target;
  const meta = el("span", "tool-meta");
  const state = el("span", "tool-state");
  const header = el("button", "tool-header",
    el("span", "tool-icon", xioIcon(kind.icon)),
    el("span", "tool-title", kind.title),
    target, meta, state, xioIcon("chevron", "chev"));
  header.type = "button";
  header.dataset.toggle = "tool-row";
  header.setAttribute("aria-expanded", "false");
  const input = name === "bash" && params.command
    ? toolSection(t("web.command"), "$ " + params.command)
    : toolSection(t("web.params"), JSON.stringify(params, null, 2));
  const output = el("div", "tool-output");
  const row = el("div", "tool-row", header, el("div", "tool-body", input, output));
  toolList(assistantBox()).appendChild(row);
  const entry = { row, state, meta, output, started: live ? Date.now() : null };
  setToolState(entry, "running");
  chat.toolRows.set(id || "orphan-" + chat.toolRows.size, entry);
  if (live) setWorking(kind.title + " " + kind.target.slice(0, 60));
  followIfStuck();
  return entry;
}

/** errorState: true / false / "unknown" (the server could not tell). */
function updateToolResult(id, content, errorState) {
  // A result without a matching call is shown on its own row, never attached to a guess.
  const entry = (id && chat.toolRows.get(id)) || appendToolCall(id, t("web.toolResult"), {}, false);
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "", null, 2);
  const state = errorState === true ? "error" : errorState === false ? "done" : "unknown";
  setToolState(entry, state);
  if (entry.started) {
    entry.meta.textContent = formatToolTime(Date.now() - entry.started);
    entry.started = null;
  }
  const parts = [toolSection(state === "error" ? t("web.errorOutput") : t("web.output"), text.length > TOOL_OUTPUT_LIMIT ? text.slice(0, TOOL_OUTPUT_LIMIT) : (text || t("web.noOutput")), "out")];
  if (text.length > TOOL_OUTPUT_LIMIT) {
    parts.push(el("div", "tool-note", xioIcon("alert"),
      t("web.outputClipped", { total: formatNumber(text.length), shown: formatNumber(TOOL_OUTPUT_LIMIT) })));
  }
  entry.output.replaceChildren(...parts);
  // Failures are what the reader needs to see; open them.
  if (state === "error") {
    entry.row.classList.add("expanded");
    entry.row.querySelector(".tool-header").setAttribute("aria-expanded", "true");
  }
  followIfStuck();
}

function formatToolTime(ms) {
  return ms < 10000 ? (ms / 1000).toFixed(1) + "s" : formatElapsed(ms);
}

/** Live durations on running tool rows; called once a second by the turn clock. */
function tickToolRows() {
  chat.toolRows.forEach(entry => {
    if (entry.started) entry.meta.textContent = formatElapsed(Date.now() - entry.started);
  });
}

/** A turn that ends without results (stopped, failed) leaves no spinner behind. */
function settleRunningTools() {
  chat.toolRows.forEach(entry => {
    if (entry.row.classList.contains("running")) {
      entry.started = null;
      setToolState(entry, "unknown");
      entry.meta.textContent = t("web.noResult");
    }
  });
}

// ---------- Notes & the working line ----------

const NOTE_ICONS = { info: "info", warning: "alert", error: "alert" };

function appendSystemNote(message, level) {
  finishAssistant();
  chat.assistantBox = null;
  removeHero();
  const kind = level || "info";
  appendToColumn(el("div", "system-note " + kind, xioIcon(NOTE_ICONS[kind] || "info"), el("span", null, message)));
}

function setWorking(label) {
  if (!chat.working) {
    chat.working = el("div", "working", el("span", "spinner"), el("span", "shimmer"), el("span", "working-time"));
    chat.working.setAttribute("aria-hidden", "true");
    chatFlowContainer.appendChild(chat.working);
  }
  chat.working.children[1].textContent = label;
  tickWorking();
  followIfStuck();
}

function tickWorking() {
  if (chat.working && turnStartedAt) chat.working.children[2].textContent = "· " + formatElapsed(Date.now() - turnStartedAt);
}

function clearWorking() {
  chat.working?.remove();
  chat.working = null;
}

// ---------- Follow-to-bottom ----------

function initChatScroll() {
  const jump = $("btn-jump-bottom");
  chatScrollArea.addEventListener("scroll", () => {
    const gap = chatScrollArea.scrollHeight - chatScrollArea.scrollTop - chatScrollArea.clientHeight;
    // A couple of pixels of rounding must not count as "scrolled away".
    chat.stick = gap < 32;
    jump.hidden = chat.stick;
    if (chat.stick) jump.classList.remove("has-new");
  }, { passive: true });
  // Expanding a row or re-rendering markdown changes height without a delta.
  new ResizeObserver(() => followIfStuck()).observe(chatFlowContainer);
  jump.addEventListener("click", () => scrollToBottom());
}

function followIfStuck() {
  if (chat.stick) chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
  else if (isRunning) $("btn-jump-bottom").classList.add("has-new");
}

function scrollToBottom() {
  chat.stick = true;
  chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
}
