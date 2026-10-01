import type { CommandOptions, ContextCompactionMode } from "./types.ts";

type ExtensionHostLike = Readonly<{
  registerCommand: (name: string, options: CommandOptions) => void;
}>;

export function registerContextCommands(options: Readonly<{
  host: ExtensionHostLike;
  compact: (mode: ContextCompactionMode, focus?: string) => Promise<unknown>;
}>): void {
  options.host.registerCommand("compact", {
    description: "Compact older context into a continuation summary.",
    group: "common",
    weight: 70,
    handler: async (args) => {
      const focus = typeof args === "string" && args.trim().length > 0 ? args.trim() : undefined;
      await options.compact("manual", focus);
      return undefined;
    },
  });
}
