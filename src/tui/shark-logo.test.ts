import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";

import { BrandHeader, XioMark } from "./shark-logo.ts";

describe("XioMark", () => {
  it("renders a three-row X I O lettermark", () => {
    const frame = renderToString(React.createElement(XioMark));
    // X cross
    expect(frame).toContain("█ █");
    expect(frame).toContain("▀█▀");
    // I stem
    expect(frame).toContain("▄█▄");
    // O ring
    expect(frame).toContain("▄▀▄");
    expect(frame).toContain("▀▄▀");
  });
});

describe("BrandHeader", () => {
  it("places XioCode title beside the XIO mark", () => {
    const frame = renderToString(React.createElement(BrandHeader, {
      version: "1.1.0",
      meta: "test/model · think:off",
      path: "~/proj",
    }));
    expect(frame).toContain("XioCode");
    expect(frame).toContain("v1.1.0");
    expect(frame).toContain("test/model · think:off");
    expect(frame).toContain("~/proj");
    expect(frame).toContain("▄█▄");
  });
});
