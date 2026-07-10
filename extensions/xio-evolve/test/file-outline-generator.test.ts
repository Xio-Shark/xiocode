import { describe, expect, it } from "vitest";

import { FileOutlineGenerator } from "../src/file-outline-generator.ts";

describe("FileOutlineGenerator", () => {
  it("extracts symbols with regex outline", async () => {
    const content = [
      "import { x } from './x';",
      "export class Foo {}",
      "export function bar() {}",
      "export type Baz = string;",
    ].join("\n");
    const outline = await FileOutlineGenerator.generate("test.ts", content);
    expect(outline?.language).toBe("typescript");
    expect(outline?.items.some((item) => item.type === "class" && item.name === "Foo")).toBe(true);
    expect(outline?.items.some((item) => item.type === "function" && item.name === "bar")).toBe(true);
    expect(FileOutlineGenerator.formatOutline(outline!).length).toBeGreaterThan(0);
  });

  it("returns null for unsupported extensions", async () => {
    expect(await FileOutlineGenerator.generate("notes.txt", "hello")).toBeNull();
  });

  it("generateSmartOutline only for large files", async () => {
    const small = "function a() {}\n";
    expect(await FileOutlineGenerator.generateSmartOutline("a.ts", small, 100)).toBeNull();
    const large = Array.from({ length: 120 }, (_, i) => `function f${i}() {}`).join("\n");
    const smart = await FileOutlineGenerator.generateSmartOutline("a.ts", large, 50);
    expect(smart).toContain("File outline");
  });
});
