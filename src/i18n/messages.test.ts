import { afterEach, describe, expect, it } from "vitest";

import { en } from "./en.ts";
import { zh } from "./zh.ts";
import { applyConfiguredLanguage, getLanguage, hasMessage, setLanguage, t, webMessages } from "./messages.ts";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
// English needs only the mode name here; Chinese shows the translated label and the name.
const ENGLISH_DROPS: Readonly<Record<string, readonly string[]>> = { "mode.changed": ["label"] };

describe("interface messages", () => {
  afterEach(() => setLanguage("en"));

  it("has the same keys and the same placeholders in both languages", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      const dropped = ENGLISH_DROPS[key] ?? [];
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]).filter((name) => !dropped.includes(name!)));
      expect(zh[key].trim().length, key).toBeGreaterThan(0);
    }
  });

  it("defaults to Chinese and switches with [ui] language", () => {
    expect(applyConfiguredLanguage(undefined)).toBeUndefined();
    expect(getLanguage()).toBe("zh");
    expect(t("footer.shortcuts")).toBe("? 查看快捷键");
    expect(applyConfiguredLanguage(" EN ")).toBeUndefined();
    expect(t("footer.shortcuts")).toBe("? for shortcuts");
  });

  it("warns about an unknown language and keeps Chinese", () => {
    expect(applyConfiguredLanguage("fr")).toContain('"fr"');
    expect(getLanguage()).toBe("zh");
  });

  it("fills placeholders and leaves a missing one visible", () => {
    expect(t("footer.turn", { count: 3 }, "zh")).toBe("第 3 轮");
    expect(t("footer.turn", undefined, "en")).toBe("turn {count}");
  });

  it("narrows run-time keys and ships only web/common keys to the page", () => {
    expect(hasMessage("slash.help")).toBe(true);
    expect(hasMessage("slash.not-a-command")).toBe(false);
    const web = webMessages("zh");
    expect(Object.keys(web).every((key) => key.startsWith("web.") || key.startsWith("common."))).toBe(true);
  });
});
