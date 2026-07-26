import { describe, expect, it } from "vitest";

import { runFeedbackCli } from "./feedback-cli.ts";

function capture() {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string) => void chunks.push(chunk), text: () => chunks.join("") };
}

describe("runFeedbackCli", () => {
  it("lists every channel and states that nothing is transmitted", async () => {
    const out = capture();
    const opened: string[] = [];
    const code = await runFeedbackCli([], { write: out.write, open: (url) => void opened.push(url) });

    expect(code).toBe(0);
    expect(out.text()).toContain("issues/new?template=bug_report.yml");
    expect(out.text()).toContain("issues/new?template=feature_request.yml");
    expect(out.text()).toContain("/discussions");
    expect(out.text()).toContain("collects no telemetry");
    expect(opened).toEqual(["https://github.com/Xio-Shark/xiocode/discussions"]);
  });

  it("--bug opens the bug form and asks for xio doctor output", async () => {
    const out = capture();
    const opened: string[] = [];
    await runFeedbackCli(["--bug"], { write: out.write, open: (url) => void opened.push(url) });

    expect(opened[0]).toContain("bug_report.yml");
    expect(out.text()).toContain("`xio doctor`");
  });

  it("--feature opens the feature form", async () => {
    const opened: string[] = [];
    await runFeedbackCli(["--feature"], { write: () => {}, open: (url) => void opened.push(url) });
    expect(opened[0]).toContain("feature_request.yml");
  });

  it("--no-open never launches a browser", async () => {
    const out = capture();
    const opened: string[] = [];
    await runFeedbackCli(["--bug", "--no-open"], {
      write: out.write,
      open: (url) => void opened.push(url),
    });

    expect(opened).toEqual([]);
    expect(out.text()).toContain("Open manually:");
  });

  it("prints the URL instead of opening under CI", async () => {
    const out = capture();
    await runFeedbackCli([], { write: out.write, env: { CI: "1" } });
    expect(out.text()).toContain("Open this in your browser:");
  });

  it("--help explains the flags without opening anything", async () => {
    const out = capture();
    const opened: string[] = [];
    const code = await runFeedbackCli(["--help"], {
      write: out.write,
      open: (url) => void opened.push(url),
    });

    expect(code).toBe(0);
    expect(opened).toEqual([]);
    expect(out.text()).toContain("xio feedback --bug");
  });
});
