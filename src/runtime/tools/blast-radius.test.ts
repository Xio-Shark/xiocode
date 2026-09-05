import { describe, expect, it } from "vitest";
import {
  detectChangedSymbols,
  extractSymbols,
  formatBlastRadiusAlert,
  probeBlastRadius,
  type BlastRadiusReport,
} from "./blast-radius.ts";

describe("Blast Radius Probe", () => {
  it("extracts exported symbols correctly from various languages", () => {
    const tsCode = `
      export function verifyToken(token: string) {}
      export class AuthManager {}
      export const DEFAULT_TIMEOUT = 1000;
      export type UserRole = "admin" | "user";
      export interface SessionData {}
    `;
    const symbols = extractSymbols(tsCode);
    expect(symbols.has("verifyToken")).toBe(true);
    expect(symbols.has("AuthManager")).toBe(true);
    expect(symbols.has("DEFAULT_TIMEOUT")).toBe(true);
    expect(symbols.has("UserRole")).toBe(true);
    expect(symbols.has("SessionData")).toBe(true);
  });

  it("detects deleted or modified symbols between two versions", () => {
    const oldCode = `
      export function calculateTax(amount: number) { return amount * 0.1; }
      export function unchangedFn() {}
    `;
    const newCode = `
      export function calculateTax(amount: number, rate: number) { return amount * rate; }
      export function unchangedFn() {}
    `;
    const changed = detectChangedSymbols(oldCode, newCode);
    expect(changed).toContain("calculateTax");
    expect(changed).not.toContain("unchangedFn");
  });

  it("probes blast radius using mock grep runner", async () => {
    const oldCode = "export function parseConfig() {}";
    const newCode = "export function parseConfig(strict: boolean) {}";

    const mockGrep = async () => ({
      kind: "ok",
      text: [
        "src/config.ts:1:export function parseConfig() {}",
        "src/cli.ts:15:const cfg = parseConfig();",
        "test/cli.test.ts:22:expect(parseConfig()).toBeDefined();",
      ].join("\n"),
    });

    const report = await probeBlastRadius(
      "/repo",
      "/repo/src/config.ts",
      oldCode,
      newCode,
      { grepRunner: mockGrep as any },
    );

    expect(report).toBeDefined();
    expect(report?.impacts.length).toBe(1);
    expect(report?.impacts[0]?.symbol).toBe("parseConfig");
    expect(report?.impacts[0]?.references.length).toBe(2);
    expect(report?.impacts[0]?.references[0]?.file).toBe("src/cli.ts");
    expect(report?.impacts[0]?.references[1]?.file).toBe("test/cli.test.ts");

    const alert = formatBlastRadiusAlert(report!);
    expect(alert).toContain("[Blast Radius Alert]");
    expect(alert).toContain("parseConfig");
    expect(alert).toContain("src/cli.ts:15");
    expect(alert).toContain("test/cli.test.ts:22");
  });
});
