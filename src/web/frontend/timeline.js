/**
 * Trajectory waterfall on a real time axis (steps carry startedAt / endedAt from
 * the session timeline). Idle time between turns — often hours — is folded into
 * a fixed-width break so the work itself stays readable; the break says how long
 * the gap was. Sessions without timeline data fall back to the ordered strip.
 */

const LANES = [
  { key: "input", label: t("web.legendInput") },
  { key: "model", label: t("web.model") },
  { key: "tool", label: t("web.legendTool") },
];
const TOOL_ROWS_MAX = 4;

function laneOf(step) {
  return step.type === "tool" ? "tool" : step.type === "input" ? "input" : "model";
}

function stepEnd(step) {
  return Date.parse(step.endedAt || step.startedAt);
}

/**
 * Busy segments (one per turn, merged when they overlap) laid end to end,
 * with each idle gap longer than `breakMs` drawn as a break of that width.
 */
function buildAxis(timed) {
  const byTurn = new Map();
  timed.forEach(s => {
    const seg = byTurn.get(s.turnNumber) || { start: Infinity, end: -Infinity };
    seg.start = Math.min(seg.start, Date.parse(s.startedAt));
    seg.end = Math.max(seg.end, stepEnd(s));
    byTurn.set(s.turnNumber, seg);
  });
  const segs = [...byTurn.values()].sort((a, b) => a.start - b.start).reduce((out, seg) => {
    const last = out[out.length - 1];
    if (last && seg.start <= last.end) last.end = Math.max(last.end, seg.end);
    else out.push({ ...seg });
    return out;
  }, []);
  const busy = segs.reduce((sum, s) => sum + (s.end - s.start), 0);
  // An idle gap is drawn at most this wide: 4% of the busy time.
  const breakMs = Math.max(busy * 0.04, 500);
  let cursor = 0;
  const breaks = [];
  segs.forEach((seg, i) => {
    if (i > 0) {
      const idle = seg.start - segs[i - 1].end;
      const width = Math.min(idle, breakMs);
      if (idle > breakMs) breaks.push({ at: cursor + width / 2, idle });
      cursor += width;
    }
    seg.offset = cursor;
    cursor += seg.end - seg.start;
  });
  const total = Math.max(cursor, 1);
  const pos = (ms) => {
    const seg = segs.find(s => ms <= s.end) || segs[segs.length - 1];
    return (seg.offset + Math.max(0, Math.min(ms, seg.end) - seg.start)) / total;
  };
  return { pos, breaks: breaks.map(b => ({ ...b, at: b.at / total })) };
}

/** Greedy interval packing so parallel tool calls sit on separate rows. */
function packRows(steps) {
  const rowEnds = [];
  return steps.map(s => {
    const start = Date.parse(s.startedAt);
    let row = rowEnds.findIndex(end => end <= start);
    if (row < 0) row = rowEnds.length < TOOL_ROWS_MAX ? rowEnds.length : TOOL_ROWS_MAX - 1;
    rowEnds[row] = stepEnd(s);
    return row;
  });
}

function timelineBlock(step, axis, row) {
  const start = Date.parse(step.startedAt);
  const left = axis.pos(start);
  const width = Math.max(0, axis.pos(stepEnd(step)) - left);
  const lane = laneOf(step);
  const open = !step.endedAt;
  const b = el("button", "tl-block " + lane + (step.isError ? " error" : "") + (open ? " open" : ""));
  b.type = "button";
  b.style.left = (left * 100).toFixed(3) + "%";
  b.style.width = (width * 100).toFixed(3) + "%";
  if (row) b.style.top = row * 10 + "px";
  const took = step.endedAt ? formatToolTime(stepEnd(step) - start) : t("web.notEnded");
  const label = "#" + step.stepNumber + " " + (STEP_LABELS[step.type] || step.type) + (step.name ? " " + step.name : "") + " · " + took + (step.isError ? t("web.failedSuffix") : "");
  b.setAttribute("aria-label", label);
  b.title = label + (step.argsPreview ? "\n" + step.argsPreview : "");
  b.addEventListener("click", () => focusStep(step.id));
  return b;
}

function timelineLane(lane, steps, axis) {
  const mine = steps.filter(s => laneOf(s) === lane.key)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const rows = lane.key === "tool" ? packRows(mine) : mine.map(() => 0);
  const track = el("div", "tl-track", ...axis.breaks.map(b => {
    const mark = el("span", "tl-break");
    mark.style.left = (b.at * 100).toFixed(3) + "%";
    return mark;
  }), ...mine.map((s, i) => timelineBlock(s, axis, rows[i])));
  track.style.height = (14 + 10 * Math.max(0, ...rows)) + "px";
  return el("div", "tl-lane", el("span", "tl-label", lane.label), track);
}

/** Labels for the folded idle gaps; the active total is in the header, said once. */
function timelineAxis(axis) {
  const labels = axis.breaks.map(b => {
    const tag = el("span", "tl-break-label", t("web.idle", { duration: formatDuration(b.idle) }));
    tag.style.left = (b.at * 100).toFixed(3) + "%";
    return tag;
  });
  return el("div", "tl-axis", el("span", "tl-label"), el("div", "tl-axis-track", ...labels));
}

/** Waterfall when steps have times; otherwise the ordered strip, saying why. */
function renderTimeline(steps, stats, timelineError) {
  const wrap = $("timeline-waterfall");
  wrap.hidden = !steps || steps.length === 0;
  const timed = (steps || []).filter(s => s.startedAt);
  const untimed = (steps || []).length - timed.length;
  const note = $("timeline-note");
  $("step-strip").hidden = timed.length > 0;
  $("tl-chart").hidden = timed.length === 0;
  if (timed.length === 0) {
    $("timeline-title").textContent = t("web.stepOrder");
    note.textContent = timelineError
      ? t("web.timelineFailed", { error: timelineError })
      : t("web.noTimeline");
    note.classList.toggle("error", Boolean(timelineError));
    renderStepStrip(steps || []);
    return;
  }
  const axis = buildAxis(timed);
  $("timeline-title").textContent = t("web.timeline");
  note.textContent = untimed > 0 ? t("web.untimed", { n: untimed }) : "";
  note.classList.remove("error");
  $("tl-chart").replaceChildren(...LANES.map(lane => timelineLane(lane, timed, axis)), axis.breaks.length ? timelineAxis(axis) : null);
}
