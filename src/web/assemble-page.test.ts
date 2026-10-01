import { describe, expect, it } from "vitest";

import { inlinePage, inlineScripts, personalize, scriptNames } from "./assemble-page.ts";

const markup = [
  "<head><link rel=\"stylesheet\" href=\"a.css\"></head>",
  "<body><script src=\"one.js\"></script><script src=\"two.js\"></script></body>",
].join("");

describe("assemble-page", () => {
  const files = { "index.html": markup, "a.css": "p{}", "one.js": "var a = 1;", "two.js": "var b = a;" };

  it("inlines stylesheets and scripts in document order", () => {
    const page = inlinePage(files);
    expect(page).not.toMatch(/src=|href=/);
    expect(page.indexOf("var a = 1;")).toBeLessThan(page.indexOf("var b = a;"));
    expect(page).toContain("<style>\np{}\n</style>");
    expect(scriptNames(markup)).toEqual(["one.js", "two.js"]);
    expect(inlineScripts(files)).toBe("var a = 1;\nvar b = a;");
  });

  it("fails loudly when index.html references a file that does not exist", () => {
    expect(() => inlinePage({ ...files, "two.js": undefined as unknown as string })).toThrow(/two\.js/);
  });

  it("injects the version and the session id as a JS string literal", () => {
    const out = personalize('const DEFAULT_SESSION_ID = "";\nv=__VERSION__', { version: "1.2.3", defaultSessionId: 'x"; alert(1); "' });
    expect(out).toContain("v=1.2.3");
    expect(out).toContain('const DEFAULT_SESSION_ID = "x\\"; alert(1); \\"";');
  });
});

describe("assemble-page copy", () => {
  it("words the real console entirely in the configured language", async () => {
    const { getWebUiHtml } = await import("./ui-bundle.ts");
    const english = getWebUiHtml({ version: "1.0.0", language: "en" });
    expect(english).toContain('<html lang="en">');
    expect(english).not.toMatch(/[一-鿿]/);
    expect(english).not.toContain("{{t:");
    const chinese = getWebUiHtml({ version: "1.0.0" });
    expect(chinese).toContain('<html lang="zh-CN">');
    expect(chinese).toContain("<title>XioCode 控制台</title>");
  });

  it("refuses a page that names a message key that does not exist", () => {
    expect(() => personalize("<p>{{t:web.nope}}</p>", { version: "1" })).toThrow(/web\.nope/);
  });

  it("keeps injected messages inert inside the script element", () => {
    const out = personalize("const MESSAGES = {};", { version: "1", language: "en" });
    expect(out).not.toContain("</");
  });
});
