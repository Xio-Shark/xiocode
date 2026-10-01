/**
 * Secondary views: trajectory, workspace diff and usage.
 */

// ---------- Trajectory ----------

const STEP_LABELS = { input: "用户", thinking: "思考", assistant: "回复", tool: "工具" };

function renderTrajectory(steps, stats, timelineError) {
  const span = stats && stats.createdAt && stats.updatedAt
    ? new Date(stats.updatedAt) - new Date(stats.createdAt)
    : NaN;
  const duration = $("traj-stat-duration");
  // Active = time inside turns (from the timeline); span = first save to last save, idle included.
  duration.textContent = (typeof stats?.activeMs === "number" ? "活跃 " + formatDuration(stats.activeMs) + " · " : "")
    + "跨度 " + (Number.isFinite(span) ? formatDuration(span) : "—");
  duration.title = "活跃：各轮从开始到结束的时间之和；跨度：会话创建到最后一次保存，含空闲";
  const stepCount = stats?.totalSteps || steps.length;
  $("traj-stat-turns").textContent = (stepCount > 0 ? (stats?.totalTurns || 0) : 0) + " 轮 · " + stepCount + " 步";
  $("traj-stat-calls").textContent = (stats?.totalToolCalls || 0) + " 次工具调用" + (stats?.totalErrors ? "（" + stats.totalErrors + " 次失败）" : "");
  renderTimeline(steps, stats, timelineError);
  renderTrajectoryList(steps, $("trajectory-search-input").value.trim());
}

/** Fallback for steps without times: equal-width blocks in order (the header says "步骤顺序"). */
function renderStepStrip(steps) {
  const strip = $("step-strip");
  strip.replaceChildren(...(steps || []).map(s => {
    const lane = s.type === "tool" ? "tool" : s.type === "input" ? "input" : "model";
    const b = el("button", "step-block " + lane + (s.isError ? " error" : ""));
    b.type = "button";
    b.setAttribute("role", "listitem");
    const label = "#" + s.stepNumber + " " + (STEP_LABELS[s.type] || s.type) + " " + (s.name || "") + (s.isError ? "（失败）" : "");
    b.setAttribute("aria-label", label);
    b.title = label + "\n" + (s.argsPreview || s.content || "").slice(0, 120);
    b.addEventListener("click", () => focusStep(s.id));
    return b;
  }));
}

function focusStep(id) {
  const target = $("traj-step-" + id);
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  target.classList.add("highlighted");
  target.querySelector(".traj-row-summary")?.focus({ preventScroll: true });
  setTimeout(() => target.classList.remove("highlighted"), 1600);
}

function renderTrajectoryList(steps, query = "") {
  const stream = $("trajectory-stream");
  const q = (query || "").toLowerCase();
  const filtered = q
    ? steps.filter(s => [s.name, s.argsPreview, s.outputPreview, s.content, s.thought].join(" ").toLowerCase().includes(q))
    : steps;
  if (filtered.length === 0) {
    stream.replaceChildren(el("div", "trajectory-empty", xioIcon(q ? "search" : "route"),
      q ? "没有包含「" + query + "」的步骤" : "还没有轨迹。在对话里发起任务后，每一步都会记在这里。"));
    return;
  }
  stream.replaceChildren(...filtered.map(trajectoryItem));
}

function trajectoryItem(s) {
  const preview = el("span", "traj-content-preview");
  if (s.type === "tool") {
    preview.append(el("strong", null, s.name || "tool"), "  ", el("span", "mono", s.argsPreview || ""));
  } else {
    preview.textContent = previewText(s.content || s.thought || "");
  }
  const summary = el("button", "traj-row-summary",
    el("span", "traj-num", String(s.stepNumber)),
    el("span", "traj-badge " + (s.type === "input" ? "user" : s.type), STEP_LABELS[s.type] || s.type),
    preview,
    s.startedAt && s.endedAt && s.type !== "input"
      ? el("span", "traj-time", formatToolTime(Date.parse(s.endedAt) - Date.parse(s.startedAt)))
      : null,
    xioIcon("chevron", "chev"));
  summary.type = "button";
  summary.dataset.toggle = "traj-item";
  summary.setAttribute("aria-expanded", "false");

  const detail = el("div", "traj-detail-panel",
    el("div", "traj-detail-meta", "第 " + s.turnNumber + " 轮"
      + (s.startedAt ? " · " + new Date(s.startedAt).toLocaleTimeString("zh-CN", { hour12: false }) : " · 无时间记录")
      + (s.callId ? " · " + s.callId : "") + (s.isError ? " · 失败" : "")));
  if (s.type === "tool") {
    detail.append(section("参数", XioMarkdown.codeBlock(JSON.stringify(s.args || {}, null, 2), "json")),
      section("输出", XioMarkdown.codeBlock(s.output || "（无输出）", "text")));
  } else {
    if (s.thought) detail.appendChild(section("思考", XioMarkdown.codeBlock(s.thought, "text")));
    detail.appendChild(section(STEP_LABELS[s.type] || "内容", XioMarkdown.codeBlock(s.content || "", "text")));
  }
  const item = el("div", "traj-item" + (s.isError ? " error" : ""), summary, detail);
  item.id = "traj-step-" + s.id;
  return item;
}

/** One line of plain text from a markdown reply: no #, *, backticks or table pipes. */
function previewText(text) {
  if (text === "(tool call only)") return "（只调用了工具，没有文字回复）";
  return text.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function section(title, body) {
  return el("div", null, el("div", "traj-section-title", title), body);
}

// ---------- Diff ----------

const DIFF_LINE_LIMIT = 3000;

/** Unified diff → [{ path, oldPath, status, binary, added, removed, lines }]. */
function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      file = { path: head[2], oldPath: head[1], status: head[1] !== head[2] ? "renamed" : "modified", binary: false, added: 0, removed: 0, lines: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) file.status = "new";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("Binary files")) file.binary = true;
    else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      file.lines.push({ kind: "hunk", text: line });
    } else if (file.lines.length > 0) {
      if (line.startsWith("+")) { file.added += 1; file.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ }); }
      else if (line.startsWith("-")) { file.removed += 1; file.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ }); }
      else if (line.startsWith(" ")) file.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

const DIFF_TAGS = { new: "新增", deleted: "删除", renamed: "重命名" };

function diffStat(added, removed) {
  return el("span", "diff-stat", el("span", "add", "+" + added), el("span", "del", "−" + removed));
}

function diffLine(line) {
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : "";
  if (line.kind === "hunk") return el("div", "diff-line hunk", el("span", "ln"), el("span", "ln"), el("span", "sign"), el("span", "code", line.text));
  return el("div", "diff-line " + line.kind,
    el("span", "ln", line.oldNo ? String(line.oldNo) : ""),
    el("span", "ln", line.newNo ? String(line.newNo) : ""),
    el("span", "sign", sign),
    el("span", "code", line.text));
}

function diffFileCard(file, index) {
  const header = el("button", "diff-file-header", xioIcon("chevron", "chev"),
    el("span", "path", file.status === "renamed" ? file.oldPath + " → " + file.path : file.path),
    DIFF_TAGS[file.status] ? el("span", "diff-tag " + file.status, DIFF_TAGS[file.status]) : null,
    diffStat(file.added, file.removed));
  header.type = "button";
  header.setAttribute("aria-expanded", "true");
  const lines = el("div", "diff-lines");
  if (file.binary) lines.appendChild(el("div", "diff-more", "二进制文件，不显示内容"));
  else {
    file.lines.slice(0, DIFF_LINE_LIMIT).forEach(l => lines.appendChild(diffLine(l)));
    if (file.lines.length > DIFF_LINE_LIMIT) lines.appendChild(el("div", "diff-more", "还有 " + formatNumber(file.lines.length - DIFF_LINE_LIMIT) + " 行未显示"));
  }
  const card = el("section", "diff-file", header, lines);
  card.id = "diff-file-" + index;
  header.addEventListener("click", () => {
    const collapsed = card.classList.toggle("collapsed");
    header.setAttribute("aria-expanded", collapsed ? "false" : "true");
  });
  return card;
}

function diffFileLink(file, index) {
  const link = el("button", "diff-file-link", xioIcon(file.status === "new" ? "file-plus" : "file"),
    el("span", "diff-file-name", file.path), diffStat(file.added, file.removed));
  link.type = "button";
  link.title = file.path;
  link.addEventListener("click", () => {
    document.querySelectorAll(".diff-file-link").forEach(l => l.classList.toggle("active", l === link));
    $("diff-file-" + index)?.scrollIntoView({ block: "start" });
  });
  return link;
}

async function fetchDiff() {
  const body = $("diff-output-body");
  const files = $("diff-files");
  body.replaceChildren(el("div", "empty-view", el("span", "spinner"), "正在读取 git diff…"));
  let data;
  try {
    data = await api("/api/workspace/diff");
  } catch (err) {
    files.replaceChildren();
    $("diff-summary").textContent = "";
    body.replaceChildren(el("div", "empty-view", xioIcon("alert"), "读取失败：" + err.message));
    return;
  }
  const parsed = parseUnifiedDiff(data.diff || "");
  const untracked = Array.isArray(data.untracked) ? data.untracked : [];
  if (parsed.length === 0 && untracked.length === 0) {
    files.replaceChildren();
    $("diff-summary").textContent = "";
    body.replaceChildren(el("div", "empty-view", xioIcon("check"), "工作区没有未提交的改动。"));
    return;
  }
  const added = parsed.reduce((n, f) => n + f.added, 0);
  const removed = parsed.reduce((n, f) => n + f.removed, 0);
  $("diff-summary").textContent = parsed.length + " 个文件 · +" + added + " −" + removed + (untracked.length ? " · " + untracked.length + " 个未跟踪" : "");
  files.replaceChildren(...parsed.map(diffFileLink));
  const cards = parsed.map(diffFileCard);
  if (untracked.length) {
    cards.push(el("section", "diff-file",
      el("div", "diff-file-header", xioIcon("file-plus"), el("span", "path", "未跟踪的文件（git diff 不包含，内容未显示）")),
      el("div", "diff-lines", ...untracked.map(p => el("div", "diff-line ctx", el("span", "ln"), el("span", "ln"), el("span", "sign", "?"), el("span", "code", p))))));
  }
  body.replaceChildren(...cards);
}

// ---------- Usage ----------

function setMetric(id, value, foot) {
  const node = $(id);
  const empty = value === null;
  node.textContent = empty ? "暂无数据" : value;
  node.classList.toggle("muted", empty);
  if (foot !== undefined) $(id + "-foot").textContent = foot;
}

function renderMetrics() {
  const total = usageTotals.input + usageTotals.output;
  setMetric("val-tokens", total > 0 ? formatNumber(total) : null,
    total > 0 ? "输入 " + formatNumber(usageTotals.input) + " · 输出 " + formatNumber(usageTotals.output) : "发起一轮后统计输入与输出");
  const cacheKnown = usageTotals.cacheKnown && usageTotals.input > 0;
  setMetric("val-cache", cacheKnown ? Math.round((usageTotals.cacheRead / usageTotals.input) * 100) + "%" : null,
    cacheKnown ? "缓存读取 " + formatNumber(usageTotals.cacheRead) + " Token" : "供应商未报告缓存读取");
  const priced = usageTotals.costLabel && usageTotals.costLabel !== "未计价" && usageTotals.costLabel !== "~unknown";
  setMetric("val-cost", priced ? usageTotals.costLabel : null, priced ? "按内置定价表折算" : "尚未发起请求或当前模型未计价");
  $("metrics-note-text").textContent = (usageTotals.persisted
    ? "Token 与缓存按会话时间线累计，刷新后仍在；早于时间线功能的轮次不计入。"
    : "这个会话没有时间线记录，Token 与缓存只统计本页打开之后的轮次。")
    + "费用只在会话运行时可得，按内置定价表折算。";
  setMetric("val-turns", String(usageTotals.toolCalls), usageTotals.toolErrors ? "其中 " + usageTotals.toolErrors + " 次失败" : "当前会话累计");
}
