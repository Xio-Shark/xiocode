import type { JsonSchema } from "./types.ts";

type SchemaOptions = Readonly<{
  description?: string;
}>;

function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  options: SchemaOptions & Readonly<{ required?: readonly string[] }> = {},
): JsonSchema {
  return {
    type: "object",
    properties,
    required: options.required ?? Object.keys(properties),
    additionalProperties: false,
    ...(options.description ? { description: options.description } : {}),
  };
}

function stringSchema(options: SchemaOptions = {}): JsonSchema {
  return {
    type: "string",
    ...(options.description ? { description: options.description } : {}),
  };
}

function numberSchema(options: SchemaOptions = {}): JsonSchema {
  return {
    type: "number",
    ...(options.description ? { description: options.description } : {}),
  };
}

function booleanSchema(options: SchemaOptions = {}): JsonSchema {
  return {
    type: "boolean",
    ...(options.description ? { description: options.description } : {}),
  };
}

function arraySchema(items: JsonSchema, options: SchemaOptions = {}): JsonSchema {
  return {
    type: "array",
    items,
    ...(options.description ? { description: options.description } : {}),
  };
}

/** Minimal JSON Schema builders replacing pi-ai `Type`. */
export const Type = {
  Object: objectSchema,
  String: stringSchema,
  Number: numberSchema,
  Boolean: booleanSchema,
  Array: arraySchema,
} as const;
