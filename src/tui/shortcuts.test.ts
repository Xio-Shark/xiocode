import { describe, expect, it } from "vitest";

import {
  composerHint,
  formatShortcutLines,
  shortcutGroups,
  shortcutKeyWidth,
} from "./shortcuts.ts";

describe("shortcutGroups", () => {
  it("keeps every group non-empty and every binding described", () => {
    const groups = shortcutGroups({ fullscreen: false });
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item.keys.trim()).toBe(item.keys);
        expect(item.keys.length).toBeGreaterThan(0);
        expect(item.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("advertises the steer prefixes the composer actually parses", () => {
    const running = shortcutGroups().find((group) => group.title === "While a task runs");
    const keys = running?.items.map((item) => item.keys) ?? [];
    expect(keys).toContain("!text");
    expect(keys).toContain(">>text");
    expect(keys).toContain("esc");
    expect(keys).toContain("ctrl+x");
  });

  it("only claims transcript scroll keys on the route that owns scrollback", () => {
    const scrollLine = (fullscreen: boolean) =>
      shortcutGroups({ fullscreen })
        .find((group) => group.title === "Prompt")
        ?.items.find((item) => item.keys === "↑ ↓")?.description;
    expect(scrollLine(true)).toBe("Scroll the transcript");
    expect(scrollLine(false)).toBe("Walk prompt history (or draft lines)");

    const fullscreenOutput = shortcutGroups({ fullscreen: true })
      .find((group) => group.title === "Output")?.items.map((item) => item.keys) ?? [];
    const scrollbackOutput = shortcutGroups({ fullscreen: false })
      .find((group) => group.title === "Output")?.items.map((item) => item.keys) ?? [];
    expect(fullscreenOutput).toContain("drag");
    expect(scrollbackOutput).not.toContain("drag");
  });
});

describe("formatShortcutLines", () => {
  it("aligns every key column to one grid across groups", () => {
    const groups = shortcutGroups();
    const width = shortcutKeyWidth(groups);
    const lines = formatShortcutLines(groups);
    const rows = lines.filter((line) => line.startsWith("  "));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.slice(2 + width, 4 + width)).toBe("  ");
    }
  });

  it("separates groups with a blank line and leads with the title", () => {
    const lines = formatShortcutLines(shortcutGroups());
    expect(lines[0]).toBe("Prompt");
    expect(lines).toContain("");
    expect(lines).toContain("While a task runs");
  });
});

describe("composerHint", () => {
  const base = { busy: false, queued: false, canSteer: true } as const;

  it("stays quiet when the footer already covers the state", () => {
    expect(composerHint(base)).toBeUndefined();
  });

  it("leads with cancel while a task runs and lists the steer prefixes", () => {
    const hint = composerHint({ ...base, busy: true }) ?? "";
    expect(hint.startsWith("esc cancel")).toBe(true);
    expect(hint).toContain("!now");
    expect(hint).toContain(">>after");
  });

  it("drops the steer prefixes when the session cannot steer", () => {
    const hint = composerHint({ ...base, busy: true, canSteer: false }) ?? "";
    expect(hint).toBe("esc cancel");
  });

  it("explains the armed keystroke and the queued draft", () => {
    expect(composerHint({ ...base, armed: "clear-draft" })).toBe("esc again to clear the draft");
    expect(composerHint({ ...base, armed: "exit" })).toBe("ctrl+c again to exit");
    expect(composerHint({ ...base, queued: true })).toContain("ctrl+x");
  });

  it("prefers the running-task hint over the queued one", () => {
    const hint = composerHint({ ...base, busy: true, queued: true }) ?? "";
    expect(hint.startsWith("esc cancel")).toBe(true);
    expect(hint).toContain("ctrl+x drop queued");
  });

  it("puts an armed keystroke ahead of every other hint", () => {
    // The armed press is a question already on screen; it must not be buried.
    expect(composerHint({ ...base, busy: true, armed: "exit" })).toBe("ctrl+c again to exit");
    expect(composerHint({ ...base, queued: true, armed: "clear-draft" }))
      .toBe("esc again to clear the draft");
  });
});
