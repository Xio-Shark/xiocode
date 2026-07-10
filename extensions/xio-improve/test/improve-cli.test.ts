import { describe, expect, it } from "vitest";

import { parseImproveArgs } from "../../../src/cli/improve-cli.ts";

describe("parseImproveArgs", () => {
  it("parses max and check append", () => {
    expect(parseImproveArgs(["--max", "3", "--check", "npm test"])).toEqual({
      max: 3,
      help: false,
      verifierCommands: ["npm test"],
      noBuiltinSeeds: false,
    });
  });

  it("parses help and no-builtin-seeds", () => {
    expect(parseImproveArgs(["--help", "--no-builtin-seeds"])).toEqual({
      max: 1,
      help: true,
      verifierCommands: [],
      noBuiltinSeeds: true,
    });
  });
});
