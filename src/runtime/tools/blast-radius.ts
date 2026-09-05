import path from "node:path";
import { runGrepWithEngine } from "./search-backend.ts";

export type BlastRadiusReference = Readonly<{
  file: string;
  line: number;
  snippet: string;
}>;

export type BlastRadiusImpact = Readonly<{
  symbol: string;
  references: readonly BlastRadiusReference[];
}>;

export type BlastRadiusReport = Readonly<{
  impacts: readonly BlastRadiusImpact[];
}>;

// Matches function, class, interface, type, or const declarations in common languages
const EXPORT_SYMBOL_REGEXES: RegExp[] = [
  /export\s+(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([a-zA-Z0-9_$]+)/g,
  /(?:def|class)\s+([a-zA-Z0-9_]+)\s*[(:]/g, // Python
  /(?:pub\s+)?(?:fn|struct|enum|trait|type)\s+([a-zA-Z0-9_]+)/g, // Rust
  /func\s+(?:\([^)]+\)\s+)?([A-Z][a-zA-Z0-9_]*)\s*\(/g, // Go exported
];

export function extractSymbols(content: string): Set<string> {
  const symbols = new Set<string>();
  for (const re of EXPORT_SYMBOL_REGEXES) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      if (match[1] && match[1].length > 2) {
        symbols.add(match[1]);
      }
    }
  }
  return symbols;
}

export function detectChangedSymbols(oldContent: string, newContent: string): string[] {
  const oldSymbols = extractSymbols(oldContent);
  const newSymbols = extractSymbols(newContent);

  const changed: string[] = [];
  // 1. Deleted/renamed symbols
  for (const sym of oldSymbols) {
    if (!newSymbols.has(sym)) {
      changed.push(sym);
    }
  }

  // 2. Modified symbol definitions (signature or body changed)
  for (const sym of oldSymbols) {
    if (newSymbols.has(sym)) {
      // Find lines containing symbol definition in both
      const oldLines = oldContent.split("\n").filter((line) => line.includes(sym));
      const newLines = newContent.split("\n").filter((line) => line.includes(sym));
      if (oldLines.join("\n") !== newLines.join("\n")) {
        changed.push(sym);
      }
    }
  }

  return Array.from(new Set(changed));
}

export type ProbeBlastRadiusOptions = Readonly<{
  maxReferences?: number;
  engine?: string | null;
  grepRunner?: (engine: any, input: any) => Promise<{ kind: string; text?: string }>;
}>;

export async function probeBlastRadius(
  cwd: string,
  filePath: string,
  oldContent: string,
  newContent: string,
  options: ProbeBlastRadiusOptions = {},
): Promise<BlastRadiusReport | undefined> {
  const changedSymbols = detectChangedSymbols(oldContent, newContent);
  if (changedSymbols.length === 0) return undefined;

  const targetRel = path.relative(cwd, filePath);
  const impacts: BlastRadiusImpact[] = [];
  const maxRefs = options.maxReferences ?? 5;

  for (const symbol of changedSymbols.slice(0, 3)) {
    try {
      let grepResult: { kind: string; text?: string };
      if (options.grepRunner) {
        grepResult = await options.grepRunner(options.engine, {
          cwd,
          pattern: `\\b${symbol}\\b`,
          searchRoot: cwd,
        });
      } else {
        const { resolveGrepEngine } = await import("./search-backend.ts");
        const engine = await resolveGrepEngine(options.engine);
        grepResult = await runGrepWithEngine(engine, {
          cwd,
          pattern: `\\b${symbol}\\b`,
          searchRoot: cwd,
        });
      }

      if (grepResult.kind !== "ok" || !grepResult.text) continue;

      const filteredRefs: BlastRadiusReference[] = [];
      const lines = grepResult.text.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const firstColon = line.indexOf(":");
        const secondColon = firstColon !== -1 ? line.indexOf(":", firstColon + 1) : -1;
        if (firstColon === -1 || secondColon === -1) continue;

        const relPath = line.slice(0, firstColon);
        const lineNum = Number(line.slice(firstColon + 1, secondColon));
        const lineText = line.slice(secondColon + 1).trim();

        if (relPath === targetRel || path.resolve(cwd, relPath) === filePath) continue;

        filteredRefs.push({
          file: relPath,
          line: Number.isNaN(lineNum) ? 1 : lineNum,
          snippet: lineText,
        });
        if (filteredRefs.length >= maxRefs) break;
      }

      if (filteredRefs.length > 0) {
        impacts.push({
          symbol,
          references: filteredRefs,
        });
      }
    } catch {
      // Non-blocking best effort
    }
  }

  return impacts.length > 0 ? { impacts } : undefined;
}

export function formatBlastRadiusAlert(report: BlastRadiusReport): string {
  if (!report || report.impacts.length === 0) return "";
  const lines = [
    "\n[Blast Radius Alert] Modified symbols have downstream references in the workspace:",
  ];
  for (const impact of report.impacts) {
    lines.push(`  Symbol "${impact.symbol}" is referenced in:`);
    for (const ref of impact.references) {
      lines.push(`    - ${ref.file}:${ref.line} (${ref.snippet.slice(0, 60)})`);
    }
  }
  lines.push("  Verify and update these call sites to prevent broken contracts.");
  return lines.join("\n");
}
