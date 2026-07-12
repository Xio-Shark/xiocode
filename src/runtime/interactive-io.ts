export type SelectChoice = Readonly<{
  label: string;
  value: string;
}>;

export type PromptOptions = Readonly<{
  secret?: boolean;
  placeholder?: string;
}>;

/** Shared interactive surface for TUI bridge and readline REPL. */
export type InteractiveIO = Readonly<{
  ask: (question: string) => Promise<boolean>;
  select: (question: string, choices: readonly SelectChoice[]) => Promise<string | undefined>;
  prompt: (question: string, options?: PromptOptions) => Promise<string | undefined>;
}>;

export function choicesFromLabels(labels: readonly string[]): readonly SelectChoice[] {
  return labels.map((label) => ({ label, value: label }));
}
