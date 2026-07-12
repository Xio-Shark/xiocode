import type {
  CommandHandlerContext,
  CommandOptions,
  ExtensionEventName,
  ExtensionHandler,
  ModelInfo,
  ProviderRegistration,
  ThinkingLevel,
  ToolDefinition,
  ToolInfo,
  XioExtensionAPI,
} from "./types.ts";

type HandlerEntry = Readonly<{
  event: string;
  handler: ExtensionHandler;
}>;

export type ExtensionHostOptions = Readonly<{
  initialModel?: ModelInfo;
  initialThinkingLevel?: ThinkingLevel;
  initialActiveTools?: readonly string[];
  ui?: CommandHandlerContext["ui"];
  getSystemPrompt?: () => string;
}>;

export class ExtensionHost implements XioExtensionAPI {
  readonly #handlers: HandlerEntry[] = [];
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #commands = new Map<string, CommandOptions>();
  readonly #providers = new Map<string, ProviderRegistration>();
  #activeTools: string[];
  #model: ModelInfo | undefined;
  #thinkingLevel: ThinkingLevel;
  #systemPrompt = "";
  #activationFilter: ((name: string) => boolean) | undefined;
  readonly #ui: CommandHandlerContext["ui"];
  readonly #getSystemPrompt: (() => string) | undefined;

  constructor(options: ExtensionHostOptions = {}) {
    this.#model = options.initialModel;
    this.#thinkingLevel = options.initialThinkingLevel ?? "off";
    this.#activeTools = options.initialActiveTools ? [...options.initialActiveTools] : [];
    this.#ui = options.ui;
    this.#getSystemPrompt = options.getSystemPrompt;
  }

  on(event: ExtensionEventName | string, handler: ExtensionHandler): void {
    this.#handlers.push({ event, handler });
  }

  registerTool(tool: ToolDefinition): void {
    this.#tools.set(tool.name, tool);
    const allowed = !this.#activationFilter || this.#activationFilter(tool.name);
    if (allowed && !this.#activeTools.includes(tool.name)) {
      this.#activeTools.push(tool.name);
    }
  }

  /**
   * When set, newly registered tools only join the active set if the filter returns true.
   * Does not remove already-active tools — call setActiveTools / re-apply after changing.
   */
  setToolActivationFilter(filter: ((name: string) => boolean) | undefined): void {
    this.#activationFilter = filter;
  }

  registerCommand(name: string, options: CommandOptions): void {
    this.#commands.set(name, options);
  }

  registerProvider(name: string, config: ProviderRegistration): void {
    this.#providers.set(name, config);
  }

  getActiveTools(): readonly string[] {
    return [...this.#activeTools];
  }

  getAllTools(): readonly ToolInfo[] {
    return [...this.#tools.keys()].map((name) => ({ name }));
  }

  setActiveTools(toolNames: readonly string[]): void {
    this.#activeTools = [...toolNames];
  }

  async setModel(model: ModelInfo): Promise<boolean> {
    this.#model = model;
    return true;
  }

  getThinkingLevel(): ThinkingLevel {
    return this.#thinkingLevel;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.#thinkingLevel = level;
  }

  get model(): ModelInfo | undefined {
    return this.#model;
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  listTools(): readonly ToolDefinition[] {
    const active = new Set(this.#activeTools);
    return [...this.#tools.values()].filter((tool) => active.has(tool.name));
  }

  listProviders(): readonly ProviderRegistration[] {
    return [...this.#providers.values()];
  }

  getProvider(name: string): ProviderRegistration | undefined {
    return this.#providers.get(name);
  }

  getCommand(name: string): CommandOptions | undefined {
    return this.#commands.get(name);
  }

  listCommands(): readonly string[] {
    return [...this.#commands.keys()];
  }

  listCommandEntries(): readonly Readonly<{ name: string; description: string }>[] {
    return [...this.#commands.entries()]
      .map(([name, options]) => ({
        name,
        description: options.description?.trim() || "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  setSystemPrompt(prompt: string): void {
    this.#systemPrompt = prompt;
  }

  createContext(): CommandHandlerContext {
    return {
      ui: this.#ui,
      model: this.#model,
      modelRegistry: {
        find: (provider, modelId) => {
          const registration = this.#providers.get(provider);
          const found = registration?.models.find((model) => model.id === modelId);
          if (!found) {
            return undefined;
          }
          return { provider, id: found.id, name: found.name, api: registration?.api };
        },
      },
      setModel: (model) => this.setModel(model),
      getThinkingLevel: () => this.getThinkingLevel(),
      setThinkingLevel: (level) => this.setThinkingLevel(level),
      getSystemPrompt: () => this.#getSystemPrompt?.() ?? this.#systemPrompt,
      hasUI: this.#ui !== undefined,
    };
  }

  async emit<T = unknown>(event: string, payload: T, ctx?: CommandHandlerContext): Promise<unknown[]> {
    const context = ctx ?? this.createContext();
    const results: unknown[] = [];
    for (const entry of this.#handlers) {
      if (entry.event !== event) {
        continue;
      }
      const result = await entry.handler(payload, context);
      results.push(result);
      // Progressive systemPrompt so later handlers (e.g. TodoEnforcer) see prior addenda.
      const record = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : undefined;
      if (typeof record?.systemPrompt === "string" && record.systemPrompt.length > 0) {
        this.#systemPrompt = record.systemPrompt;
      }
    }
    return results;
  }

  async runCommand(name: string, args?: unknown, ctx?: CommandHandlerContext): Promise<unknown> {
    const command = this.#commands.get(name);
    if (!command) {
      throw new Error(`unknown command: ${name}`);
    }
    return command.handler(args, ctx ?? this.createContext());
  }
}
