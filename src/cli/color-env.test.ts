import { describe, expect, it } from "vitest";

import { applyNoColorEnv } from "./color-env.ts";

describe("applyNoColorEnv", () => {
  it("translates NO_COLOR into FORCE_COLOR=0", () => {
    const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
    applyNoColorEnv(env);
    expect(env["FORCE_COLOR"]).toBe("0");
  });

  it("ignores an empty NO_COLOR (the spec only counts a non-empty value)", () => {
    const env: NodeJS.ProcessEnv = { NO_COLOR: "" };
    applyNoColorEnv(env);
    expect(env["FORCE_COLOR"]).toBeUndefined();
  });

  it("does not override an explicit FORCE_COLOR", () => {
    const env: NodeJS.ProcessEnv = { NO_COLOR: "1", FORCE_COLOR: "3" };
    applyNoColorEnv(env);
    expect(env["FORCE_COLOR"]).toBe("3");
  });
});
