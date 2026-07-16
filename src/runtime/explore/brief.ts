/** Default aggregate brief budget for primary injection (PRD: ≤12KB). */
export const DEFAULT_WORKSPACE_BRIEF_MAX_CHARS = 12 * 1024;

export const WORKSPACE_BRIEF_SCHEMA = "xio-workspace-brief.v1" as const;

export type BriefCitation = Readonly<{
  path: string;
  start_line?: number;
  end_line?: number;
  content_hash?: string;
}>;

export type BriefClaim = Readonly<{
  text: string;
  citations: readonly BriefCitation[];
  confidence: number;
  source_role?: string;
}>;

export type WorkerEvidenceReport = Readonly<{
  role?: string;
  claims: readonly BriefClaim[];
  symbols?: readonly string[];
  tests?: readonly string[];
  gaps?: readonly string[];
  raw_chars?: number;
}>;

export type WorkspaceBrief = Readonly<{
  schema_version: typeof WORKSPACE_BRIEF_SCHEMA;
  claims: readonly BriefClaim[];
  symbols: readonly string[];
  tests: readonly string[];
  contradictions: readonly string[];
  gaps: readonly string[];
  confidence: number;
  /** Path/symbol overlap across workers 0–1. */
  overlap: number;
  /** Fraction of claims with ≥1 citation. */
  citation_coverage: number;
  /** Serialized size after budget enforcement. */
  text_chars: number;
  truncated: boolean;
}>;

/**
 * Aggregate worker reports into a compact WorkspaceBrief.
 * Raw evidence stays out of the brief; only claims + citations + gaps.
 */
export function aggregateWorkspaceBrief(
  reports: readonly WorkerEvidenceReport[],
  options: Readonly<{ maxChars?: number }> = {},
): WorkspaceBrief {
  const maxChars = options.maxChars ?? DEFAULT_WORKSPACE_BRIEF_MAX_CHARS;
  const claims = dedupeClaims(reports.flatMap((report) =>
    report.claims.map((claim) => ({
      ...claim,
      source_role: claim.source_role ?? report.role,
      confidence: clamp01(claim.confidence),
    }))));
  const symbols = unique(reports.flatMap((report) => report.symbols ?? []));
  const tests = unique(reports.flatMap((report) => report.tests ?? []));
  const gaps = unique(reports.flatMap((report) => report.gaps ?? []));
  const contradictions = findContradictions(claims);
  const overlap = measurePathOverlap(reports);
  const withCitations = claims.filter((claim) => claim.citations.length > 0).length;
  const citationCoverage = claims.length === 0 ? 1 : withCitations / claims.length;
  const confidence = claims.length === 0
    ? 0
    : claims.reduce((sum, claim) => sum + claim.confidence, 0) / claims.length;

  let selected = claims;
  let truncated = false;
  let text = serializeBrief({
    claims: selected,
    symbols,
    tests,
    contradictions,
    gaps,
    confidence,
    overlap,
    citation_coverage: citationCoverage,
  });
  if (text.length > maxChars) {
    truncated = true;
    // Drop lowest-confidence claims first; keep gaps visible.
    selected = [...claims].sort((a, b) => b.confidence - a.confidence);
    while (selected.length > 0) {
      text = serializeBrief({
        claims: selected,
        symbols,
        tests,
        contradictions,
        gaps,
        confidence,
        overlap,
        citation_coverage: citationCoverage,
      });
      if (text.length <= maxChars) break;
      selected = selected.slice(0, -1);
    }
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars - 1)}…`;
    }
  }

  return {
    schema_version: WORKSPACE_BRIEF_SCHEMA,
    claims: selected,
    symbols,
    tests,
    contradictions,
    gaps,
    confidence,
    overlap,
    citation_coverage: citationCoverage,
    text_chars: text.length,
    truncated,
  };
}

export function formatWorkspaceBrief(brief: WorkspaceBrief): string {
  return serializeBrief(brief);
}

/**
 * Append visible incompleteness notes (budget / early-stop / deferred slices).
 * PRD: incomplete coverage must remain visible in brief.gaps.
 */
export function appendBriefGaps(
  brief: WorkspaceBrief,
  extraGaps: readonly string[],
): WorkspaceBrief {
  const gaps = unique([...brief.gaps, ...extraGaps]);
  if (gaps.length === brief.gaps.length) return brief;
  const text = serializeBrief({
    claims: brief.claims,
    symbols: brief.symbols,
    tests: brief.tests,
    contradictions: brief.contradictions,
    gaps,
    confidence: brief.confidence,
    overlap: brief.overlap,
    citation_coverage: brief.citation_coverage,
  });
  return {
    ...brief,
    gaps,
    text_chars: text.length,
  };
}

function serializeBrief(input: Readonly<{
  claims: readonly BriefClaim[];
  symbols: readonly string[];
  tests: readonly string[];
  contradictions: readonly string[];
  gaps: readonly string[];
  confidence: number;
  overlap: number;
  citation_coverage: number;
}>): string {
  const lines = [
    "### WorkspaceBrief",
    `confidence=${input.confidence.toFixed(2)} citation_coverage=${input.citation_coverage.toFixed(2)} overlap=${input.overlap.toFixed(2)}`,
  ];
  if (input.claims.length > 0) {
    lines.push("claims:");
    for (const claim of input.claims) {
      const cites = claim.citations.map(formatCitation).join("; ") || "uncited";
      lines.push(`- (${claim.confidence.toFixed(2)}) ${claim.text} [${cites}]`);
    }
  }
  if (input.symbols.length > 0) {
    lines.push(`symbols: ${input.symbols.join(", ")}`);
  }
  if (input.tests.length > 0) {
    lines.push(`tests: ${input.tests.join(", ")}`);
  }
  if (input.contradictions.length > 0) {
    lines.push("contradictions:");
    for (const item of input.contradictions) lines.push(`- ${item}`);
  }
  if (input.gaps.length > 0) {
    lines.push("gaps:");
    for (const item of input.gaps) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

function formatCitation(citation: BriefCitation): string {
  const range = citation.start_line !== undefined
    ? `:${citation.start_line}${citation.end_line !== undefined ? `-${citation.end_line}` : ""}`
    : "";
  const hash = citation.content_hash ? `#${citation.content_hash.slice(0, 8)}` : "";
  return `${citation.path}${range}${hash}`;
}

function dedupeClaims(claims: readonly BriefClaim[]): BriefClaim[] {
  const seen = new Map<string, BriefClaim>();
  for (const claim of claims) {
    const key = normalizeClaimKey(claim.text);
    const existing = seen.get(key);
    if (!existing || claim.confidence > existing.confidence) {
      seen.set(key, claim);
    }
  }
  return [...seen.values()];
}

function normalizeClaimKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function findContradictions(claims: readonly BriefClaim[]): string[] {
  const contradictions: string[] = [];
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i]!;
      const b = claims[j]!;
      if (a.confidence >= 0.6 && b.confidence >= 0.6 && looksContradictory(a.text, b.text)) {
        contradictions.push(`"${a.text}" vs "${b.text}"`);
      }
    }
  }
  return contradictions;
}

function looksContradictory(a: string, b: string): boolean {
  const na = normalizeClaimKey(a);
  const nb = normalizeClaimKey(b);
  if (na === nb) return false;
  const neg = (s: string) => s.includes(" not ") || s.startsWith("no ") || s.includes("never ");
  return (neg(na) && !neg(nb) && sharesTokens(na, nb)) || (neg(nb) && !neg(na) && sharesTokens(na, nb));
}

function sharesTokens(a: string, b: string): boolean {
  const tokens = (s: string) => new Set(s.split(/[^a-z0-9_./-]+/).filter((t) => t.length > 3));
  const ta = tokens(a);
  const tb = tokens(b);
  let shared = 0;
  for (const token of ta) {
    if (tb.has(token)) shared += 1;
  }
  return shared >= 2;
}

function measurePathOverlap(reports: readonly WorkerEvidenceReport[]): number {
  if (reports.length < 2) return 0;
  const pathSets = reports.map((report) => {
    const paths = new Set<string>();
    for (const claim of report.claims) {
      for (const citation of claim.citations) {
        paths.add(citation.path);
      }
    }
    return paths;
  });
  const all = new Set<string>();
  const counts = new Map<string, number>();
  for (const set of pathSets) {
    for (const pathValue of set) {
      all.add(pathValue);
      counts.set(pathValue, (counts.get(pathValue) ?? 0) + 1);
    }
  }
  if (all.size === 0) return 0;
  let multi = 0;
  for (const count of counts.values()) {
    if (count > 1) multi += 1;
  }
  return multi / all.size;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
