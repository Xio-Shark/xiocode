import { afterEach, describe, expect, it } from "vitest";

import {
  DiscoveryCache,
  discoveryCacheKey,
  processDiscoveryCache,
} from "../src/discovery-cache.ts";
import type { SpecBundle } from "../src/agents-md.ts";
import type { SkillsIndex } from "../src/skills.ts";

const emptyBundle = (): SpecBundle => ({ text: "a", sources: [], warnings: [] });
const emptySkills = (): SkillsIndex => ({ skills: [], warnings: [] });

afterEach(() => {
  processDiscoveryCache.clear();
});

describe("DiscoveryCache", () => {
  it("stores and returns agents until TTL expires", () => {
    let now = 1_000;
    const cache = new DiscoveryCache({ ttlMs: 100, now: () => now });
    const key = discoveryCacheKey("agents", "/proj", "/home", { enabled: true });
    cache.setAgents(key, emptyBundle());
    expect(cache.getAgents(key)?.text).toBe("a");
    now = 1_050;
    expect(cache.getAgents(key)?.text).toBe("a");
    now = 1_200;
    expect(cache.getAgents(key)).toBeUndefined();
  });

  it("stores skills with independent keys", () => {
    const cache = new DiscoveryCache({ ttlMs: 60_000 });
    const a = discoveryCacheKey("skills", "/a", undefined, { enabled: true });
    const b = discoveryCacheKey("skills", "/b", undefined, { enabled: true });
    cache.setSkills(a, emptySkills());
    cache.setSkills(b, { skills: [], warnings: ["x"] });
    expect(cache.getSkills(a)?.warnings).toEqual([]);
    expect(cache.getSkills(b)?.warnings).toEqual(["x"]);
  });

  it("fingerprints config so different options miss", () => {
    const k1 = discoveryCacheKey("agents", "/p", "/h", { enabled: true, maxBytes: 10 });
    const k2 = discoveryCacheKey("agents", "/p", "/h", { enabled: true, maxBytes: 20 });
    expect(k1).not.toBe(k2);
  });
});
