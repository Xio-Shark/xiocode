import { describe, expect, it } from "vitest";

import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";

describe("DEFAULT_SYSTEM_PROMPT", () => {
  it("states identity, first principles, no-jargon, and surgical change rules", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("XioCode");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("第一性原理");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("不用黑话");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("前因后果");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("用户没写但通常决定对错");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("只动完成目标所必需");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("修根因");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("假成功");
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("Less is more");
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("sunk cost");
  });
});
