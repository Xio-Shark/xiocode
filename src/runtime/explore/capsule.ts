import type { RoleOwnership } from "./roles.ts";

export const POLICY_CAPSULE_SCHEMA = "xio-explore-capsule.v1" as const;

/** Default hard caps for capsule text fields (bytes approx via UTF-16 length). */
export const CAPSULE_INSTRUCTIONS_MAX_CHARS = 2_000;
export const CAPSULE_DIFF_SUMMARY_MAX_CHARS = 1_500;

export type PolicyCapsule = Readonly<{
  schema_version: typeof POLICY_CAPSULE_SCHEMA;
  workspace_id: string;
  main_root_hint: string;
  project_instructions_excerpt: string;
  diff_summary: string;
  safety: Readonly<{
    read_only: true;
    no_recursive_explore: true;
    no_merge: true;
  }>;
  ownership: Readonly<{
    paths: readonly string[];
    questions: readonly string[];
    role?: string;
  }>;
  budgets: Readonly<{
    wall_ms: number;
    max_turns: number;
    max_output_chars: number;
  }>;
}>;

export type BuildPolicyCapsuleInput = Readonly<{
  workspaceId: string;
  mainRootHint: string;
  projectInstructions?: string;
  diffSummary?: string;
  ownership: RoleOwnership | Readonly<{ paths: readonly string[]; questions: readonly string[]; role?: string }>;
  wallMs: number;
  maxTurns: number;
  maxOutputChars: number;
}>;

export function buildPolicyCapsule(input: BuildPolicyCapsuleInput): PolicyCapsule {
  return {
    schema_version: POLICY_CAPSULE_SCHEMA,
    workspace_id: input.workspaceId,
    main_root_hint: input.mainRootHint,
    project_instructions_excerpt: clip(input.projectInstructions ?? "", CAPSULE_INSTRUCTIONS_MAX_CHARS),
    diff_summary: clip(input.diffSummary ?? "", CAPSULE_DIFF_SUMMARY_MAX_CHARS),
    safety: {
      read_only: true,
      no_recursive_explore: true,
      no_merge: true,
    },
    ownership: {
      paths: [...input.ownership.paths],
      questions: [...input.ownership.questions],
      role: "role" in input.ownership ? input.ownership.role : undefined,
    },
    budgets: {
      wall_ms: Math.max(1, Math.floor(input.wallMs)),
      max_turns: Math.max(1, Math.floor(input.maxTurns)),
      max_output_chars: Math.max(256, Math.floor(input.maxOutputChars)),
    },
  };
}

export function formatCapsuleForPrompt(capsule: PolicyCapsule): string {
  const lines = [
    "### Policy capsule (binding)",
    `workspace_id: ${capsule.workspace_id}`,
    `main_root_hint: ${capsule.main_root_hint}`,
    `safety: read_only=${capsule.safety.read_only} no_recursive_explore=${capsule.safety.no_recursive_explore} no_merge=${capsule.safety.no_merge}`,
    `budgets: wall_ms=${capsule.budgets.wall_ms} max_turns=${capsule.budgets.max_turns} max_output_chars=${capsule.budgets.max_output_chars}`,
  ];
  if (capsule.ownership.role) {
    lines.push(`role: ${capsule.ownership.role}`);
  }
  if (capsule.ownership.paths.length > 0) {
    lines.push(`ownership.paths: ${capsule.ownership.paths.join(", ")}`);
  }
  if (capsule.ownership.questions.length > 0) {
    lines.push(`ownership.questions: ${capsule.ownership.questions.join(" | ")}`);
  }
  if (capsule.project_instructions_excerpt) {
    lines.push("project_instructions_excerpt:");
    lines.push(capsule.project_instructions_excerpt);
  }
  if (capsule.diff_summary) {
    lines.push("diff_summary:");
    lines.push(capsule.diff_summary);
  }
  return lines.join("\n");
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
