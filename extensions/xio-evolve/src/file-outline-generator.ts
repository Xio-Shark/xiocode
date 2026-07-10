export type OutlineItem = Readonly<{
  type: "import" | "class" | "function" | "interface" | "enum" | "type";
  name: string;
  startLine: number;
  endLine: number;
  signature?: string;
}>;

export type FileOutline = Readonly<{
  language: string;
  items: readonly OutlineItem[];
  totalLines: number;
}>;

const PATTERNS: ReadonlyArray<Readonly<{ type: OutlineItem["type"]; re: RegExp }>> = [
  { type: "import", re: /^\s*(?:import|from|use|require)\b/ },
  { type: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/ },
  { type: "interface", re: /^\s*(?:export\s+)?interface\s+(\w+)/ },
  { type: "type", re: /^\s*(?:export\s+)?type\s+(\w+)\s*=/ },
  { type: "enum", re: /^\s*(?:export\s+)?enum\s+(\w+)/ },
  { type: "function", re: /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()/ },
  { type: "function", re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/ },
  { type: "function", re: /^\s*def\s+(\w+)\s*\(/ },
  { type: "class", re: /^\s*class\s+(\w+)/ },
];

/** Light regex outline — no tree-sitter / wasm. */
export class FileOutlineGenerator {
  static async init(): Promise<void> {
    // no-op: kept for API compatibility with callers that awaited wasm load
  }

  static async generate(filePath: string, content: string): Promise<FileOutline | null> {
    const language = languageFromPath(filePath);
    if (!language) {
      return null;
    }
    const lines = content.split(/\r?\n/);
    const items: OutlineItem[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const pattern of PATTERNS) {
        const match = pattern.re.exec(line);
        if (!match) {
          continue;
        }
        const name = match[1] ?? match[2] ?? line.trim().slice(0, 48);
        items.push({
          type: pattern.type,
          name,
          startLine: i + 1,
          endLine: i + 1,
          signature: line.trim().slice(0, 120),
        });
        break;
      }
    }
    return { language, items, totalLines: lines.length };
  }

  static async generateSmartOutline(filePath: string, content: string, threshold: number): Promise<string | null> {
    const lineCount = content.split(/\r?\n/).length;
    if (lineCount <= threshold) {
      return null;
    }
    const outline = await this.generate(filePath, content);
    return outline ? this.formatOutline(outline) : null;
  }

  static formatOutline(outline: FileOutline): string {
    const lines = [`File outline (${outline.language}, ${outline.totalLines} lines)`, ""];
    const byType = new Map<string, OutlineItem[]>();
    for (const item of outline.items) {
      const list = byType.get(item.type) ?? [];
      list.push(item);
      byType.set(item.type, list);
    }
    for (const [type, items] of byType) {
      lines.push(`## ${type}s`);
      for (const item of items) {
        lines.push(`- L${item.startLine} ${item.name}`);
      }
      lines.push("");
    }
    if (outline.items.length === 0) {
      lines.push("(no symbols matched; content truncated elsewhere)");
    }
    return lines.join("\n");
  }
}

function languageFromPath(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "typescript";
  }
  if (lower.endsWith(".py")) {
    return "python";
  }
  if (lower.endsWith(".rs")) {
    return "rust";
  }
  if (lower.endsWith(".java")) {
    return "java";
  }
  if (lower.endsWith(".go")) {
    return "go";
  }
  return null;
}
