export type SelectChoice = Readonly<{
  label: string;
  value: string;
  /** What an approval covers, shown beside the label (e.g. "this session: mcp__github"). */
  scope?: string;
}>;

export type PromptOptions = Readonly<{
  secret?: boolean;
  placeholder?: string;
}>;

/**
 * Shared interactive surface for TUI bridge and readline REPL.
 * `ask` accepts an optional action-specific `detail` (diff, tool args, etc.).
 * Callers must pass detail explicitly — never rely on a global last-notice field.
 */
export type InteractiveIO = Readonly<{
  ask: (question: string, detail?: string) => Promise<boolean>;
  select: (question: string, choices: readonly SelectChoice[], detail?: string) => Promise<string | undefined>;
  prompt: (question: string, options?: PromptOptions) => Promise<string | undefined>;
}>;

export function choicesFromLabels(labels: readonly string[]): readonly SelectChoice[] {
  return labels.map((label) => ({ label, value: label }));
}
