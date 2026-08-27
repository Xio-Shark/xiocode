import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";

import { BrandHeader, XioMark } from "./shark-logo.ts";

describe("XioMark", () => {
  it("renders a four-row X I O lettermark with a trailing shark fin", () => {
    const frame = renderToString(React.createElement(XioMark));
    // X glyph
    expect(frame).toContain("█   █");
    expect(frame).toContain("▀▄▀");
    // I stem
    expect(frame).toContain("███");
    // Rounded O ring
    expect(frame).toContain("▄██▄");
    expect(frame).toContain("█▀  ▀█");
    expect(frame).toContain("▀██▀");
    // Shark fin
    expect(frame).toContain("▄▄█████");
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
    expect(frame).toContain("███");
  });
});
