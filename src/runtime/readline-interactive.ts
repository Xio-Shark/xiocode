import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type { InteractiveIO, PromptOptions, SelectChoice } from "./interactive-io.ts";

export function createReadlineInteractiveIO(
  ask: (question: string) => Promise<boolean>,
): InteractiveIO {
  return {
    ask,
    async select(question, choices) {
      if (choices.length === 0) return undefined;
      output.write(`${question}\n`);
      for (const [index, choice] of choices.entries()) {
        output.write(`  ${index + 1}) ${choice.label}\n`);
      }
      output.write("  0) Cancel\n");
      const rl = createInterface({ input, output, terminal: true });
      try {
        const raw = (await rl.question("Select number: ")).trim();
        if (raw === "0" || raw.toLowerCase() === "q" || raw.toLowerCase() === "cancel") {
          return undefined;
        }
        const index = Number.parseInt(raw, 10);
        if (!Number.isFinite(index) || index < 1 || index > choices.length) {
          output.write("Invalid selection.\n");
          return undefined;
        }
        return choices[index - 1]?.value;
      } finally {
        rl.close();
      }
    },
    async prompt(question, options) {
      const rl = createInterface({ input, output, terminal: true });
      try {
        const suffix = options?.secret ? " (visible in REPL)" : "";
        const answer = (await rl.question(`${question}${suffix}: `)).trim();
        return answer.length > 0 ? answer : undefined;
      } finally {
        rl.close();
      }
    },
  };
}

export type { PromptOptions, SelectChoice };
