#!/usr/bin/env node
/**
 * Count round trips and tool usage from a `xio -p ... --output-format stream-json` run.
 *
 * Usage:
 *   xio -p "<task>" --output-format stream-json 2>/dev/null | node scripts/count-run-events.mjs
 *
 * Prints provider.request (model round trips), tool.call histogram, and other event count.
 * `tool.batch` spans live in the perf tracer, not RuntimeEvent.v1, so they are not counted here.
 */
let buffer = "";
const toolCounts = new Map();
let provider = 0;
let others = 0;
let firstEvent = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
});
process.stdin.on("end", () => {
  for (const line of buffer.split("\n")) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!firstEvent) firstEvent = JSON.stringify(event).slice(0, 200);
    const type = String(event.type ?? event.event ?? "");
    if (type === "provider.request") {
      provider += 1;
    } else if (type === "tool.call") {
      const name = String(event.toolName ?? event.payload?.toolName ?? "?");
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    } else {
      others += 1;
    }
  }
  const calls = [...toolCounts.values()].reduce((a, b) => a + b, 0);
  console.log("provider.request (round trips) =", provider);
  console.log("tool.calls =", calls);
  for (const [name, count] of [...toolCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x ${name}`);
  }
  console.log("other_events =", others);
  if (provider === 0 && calls === 0) console.log("first_event =", firstEvent);
});
