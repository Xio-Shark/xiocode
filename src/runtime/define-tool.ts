import type { ToolDefinition } from "./types.ts";

export function defineTool(tool: ToolDefinition): ToolDefinition {
  if (!tool.name || tool.name.trim().length === 0) {
    throw new Error("tool name is required");
  }
  if (!tool.description || tool.description.trim().length === 0) {
    throw new Error(`tool ${tool.name}: description is required`);
  }
  if (!tool.parameters || typeof tool.parameters !== "object") {
    throw new Error(`tool ${tool.name}: parameters must be a JSON Schema object`);
  }
  return tool;
}
