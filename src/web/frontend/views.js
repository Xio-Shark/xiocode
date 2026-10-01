/**
 * Secondary views: trajectory, workspace diff and usage.
 */

// ---------- Trajectory ----------

const STEP_LABELS = { input: t("web.step.input"), thinking: t("web.step.thinking"), assistant: t("web.step.assistant"), tool: t("web.step.tool") };

function renderTrajectory(steps, stats, timelineError) {
  const span = stats && stats.createdAt && stats.updatedAt
    ? new Date(stats.updatedAt) - new Date(stats.createdAt)
    : NaN;
  const duration = $("traj-stat-duration");
  // Active = time inside turns (from the timeline); span = first save to last save, idle included.
  duration.textContent = (typeof stats?.activeMs === "number" ? t("web.active", { duration: formatDuration(stats.activeMs) }) + " · " : "")
    + t("web.span", { duration: Number.isFinite(span) ? formatDuration(span) : "—" });
  duration.title = t("web.durationHelp");
  const stepCount = stats?.totalSteps || steps.length;
  $("traj-stat-turns").textContent = t("web.turnsStepsN", { turns: stepCount > 0 ? (stats?.totalTurns || 0) : 0, steps: stepCount });
  $("traj-stat-calls").textContent = t("web.toolCallsTotal", { n: stats?.totalToolCalls || 0 }) + (stats?.totalErrors ? t("web.toolCallsFailed", { n: stats.totalErrors }) : "");
  renderTimeline(steps, stats, timelineError);
  renderTrajectoryList(steps, $("trajectory-search-input").value.trim());
}

/** Fallback for steps without times: equal-width blocks in order (the header says so). */
function renderStepStrip(steps) {
  const strip = $("step-strip");
  strip.replaceChildren(...(steps || []).map(s => {
    const lane = s.type === "tool" ? "tool" : s.type === "input" ? "input" : "model";
    const b = el("button", "step-block " + lane + (s.isError ? " error" : ""));
    b.type = "button";
    b.setAttribute("role", "listitem");
    const label = "#" + s.stepNumber + " " + (STEP_LABELS[s.type] || s.type) + " " + (s.name || "") + (s.isError ? t("web.failedParen") : "");
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
      q ? t("web.noStepsMatch", { query }) : t("web.noTrajectory")));
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
    el("div", "traj-detail-meta", t("web.turnN", { n: s.turnNumber })
      + (s.startedAt ? " · " + new Date(s.startedAt).toLocaleTimeString(document.documentElement.lang, { hour12: false }) : t("web.untimedStep"))
      + (s.callId ? " · " + s.callId : "") + (s.isError ? t("web.failedSuffix") : "")));
  if (s.type === "tool") {
    detail.append(section(t("web.params"), XioMarkdown.codeBlock(JSON.stringify(s.args || {}, null, 2), "json")),
      section(t("web.output"), XioMarkdown.codeBlock(s.output || t("web.noOutput"), "text")));
  } else {
    if (s.thought) detail.appendChild(section(t("web.thinkingSection"), XioMarkdown.codeBlock(s.thought, "text")));
    detail.appendChild(section(STEP_LABELS[s.type] || t("web.content"), XioMarkdown.codeBlock(s.content || "", "text")));
  }
  const item = el("div", "traj-item" + (s.isError ? " error" : ""), summary, detail);
  item.id = "traj-step-" + s.id;
  return item;
}

/** One line of plain text from a markdown reply: no #, *, backticks or table pipes. */
function previewText(text) {
  if (text === "(tool call only)") return t("web.toolOnly");
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

const DIFF_TAGS = { new: t("web.diffNew"), deleted: t("web.diffDeleted"), renamed: t("web.diffRenamed") };

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
  if (file.binary) lines.appendChild(el("div", "diff-more", t("web.binary")));
  else {
    file.lines.slice(0, DIFF_LINE_LIMIT).forEach(l => lines.appendChild(diffLine(l)));
    if (file.lines.length > DIFF_LINE_LIMIT) lines.appendChild(el("div", "diff-more", t("web.moreLines", { n: formatNumber(file.lines.length - DIFF_LINE_LIMIT) })));
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
  body.replaceChildren(el("div", "empty-view", el("span", "spinner"), t("web.readingDiff")));
  let data;
  try {
    data = await api("/api/workspace/diff");
  } catch (err) {
    files.replaceChildren();
    $("diff-summary").textContent = "";
    body.replaceChildren(el("div", "empty-view", xioIcon("alert"), t("web.readFailedShort", { error: err.message })));
    return;
  }
  const parsed = parseUnifiedDiff(data.diff || "");
  const untracked = Array.isArray(data.untracked) ? data.untracked : [];
  if (parsed.length === 0 && untracked.length === 0) {
    files.replaceChildren();
    $("diff-summary").textContent = "";
    body.replaceChildren(el("div", "empty-view", xioIcon("check"), t("web.noChanges")));
    return;
  }
  const added = parsed.reduce((n, f) => n + f.added, 0);
  const removed = parsed.reduce((n, f) => n + f.removed, 0);
  $("diff-summary").textContent = t("web.diffSummary", { files: parsed.length, added, removed }) + (untracked.length ? t("web.untrackedN", { n: untracked.length }) : "");
  files.replaceChildren(...parsed.map(diffFileLink));
  const cards = parsed.map(diffFileCard);
  if (untracked.length) {
    cards.push(el("section", "diff-file",
      el("div", "diff-file-header", xioIcon("file-plus"), el("span", "path", t("web.untrackedFiles"))),
      el("div", "diff-lines", ...untracked.map(p => el("div", "diff-line ctx", el("span", "ln"), el("span", "ln"), el("span", "sign", "?"), el("span", "code", p))))));
  }
  body.replaceChildren(...cards);
}

// ---------- Usage ----------

function setMetric(id, value, foot) {
  const node = $(id);
  const empty = value === null;
  node.textContent = empty ? t("web.noData") : value;
  node.classList.toggle("muted", empty);
  if (foot !== undefined) $(id + "-foot").textContent = foot;
}

function renderMetrics() {
  const total = usageTotals.input + usageTotals.output;
  setMetric("val-tokens", total > 0 ? formatNumber(total) : null,
    total > 0 ? t("web.inOut", { input: formatNumber(usageTotals.input), output: formatNumber(usageTotals.output) }) : t("web.tokensFoot"));
  const cacheKnown = usageTotals.cacheKnown && usageTotals.input > 0;
  setMetric("val-cache", cacheKnown ? Math.round((usageTotals.cacheRead / usageTotals.input) * 100) + "%" : null,
    cacheKnown ? t("web.cacheRead", { n: formatNumber(usageTotals.cacheRead) }) : t("web.noCacheReport"));
  const priced = usageTotals.costLabel && usageTotals.costLabel !== t("web.unpriced") && usageTotals.costLabel !== "~unknown";
  setMetric("val-cost", priced ? usageTotals.costLabel : null, priced ? t("web.pricedFoot") : t("web.costFoot"));
  $("metrics-note-text").textContent = (usageTotals.persisted
    ? t("web.usageTimeline")
    : t("web.usageNoTimeline"))
    + t("web.costNote");
  setMetric("val-turns", String(usageTotals.toolCalls), usageTotals.toolErrors ? t("web.ofWhichFailed", { n: usageTotals.toolErrors }) : t("web.sessionTotal"));
}
