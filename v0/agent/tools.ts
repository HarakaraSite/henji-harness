import {
  type JsonObject,
  type JsonValue,
  type ToolCall,
  type ToolDefinition,
  type ToolResultContent,
} from './contracts.ts';

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
  execute(argumentsValue: JsonValue): string | PromiseLike<string>;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class Registry {
  private readonly byName: ReadonlyMap<string, Tool>;

  constructor(tools: readonly Tool[]) {
    const entries = new Map<string, Tool>();
    for (const tool of tools) {
      if (tool.name.trim() === '') throw new Error('tool name must not be empty');
      if (entries.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
      entries.set(tool.name, tool);
    }
    this.byName = entries;
  }

  definitions(): readonly ToolDefinition[] {
    return [...this.byName.values()]
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }

  resolve(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  async dispatch(call: ToolCall): Promise<ToolResultContent> {
    const tool = this.resolve(call.name);
    if (!tool) {
      return {
        kind: 'tool_result',
        callId: call.callId,
        name: call.name,
        text: `unknown tool: ${call.name}`,
        outcome: 'error',
      };
    }

    try {
      const text = await tool.execute(call.arguments);
      if (typeof text !== 'string') throw new Error('tool returned non-text result');
      return {
        kind: 'tool_result',
        callId: call.callId,
        name: call.name,
        text,
        outcome: 'success',
      };
    } catch (error) {
      const prefix = error instanceof ToolInputError ? 'invalid arguments' : 'tool execution error';
      return {
        kind: 'tool_result',
        callId: call.callId,
        name: call.name,
        text: `${prefix}: ${errorText(error)}`,
        outcome: 'error',
      };
    }
  }
}

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const createFixtureTool = (): Tool => ({
  name: 'uppercase_text',
  description: 'Convert one input text to uppercase.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  execute(argumentsValue: JsonValue): string {
    if (!isObject(argumentsValue)) {
      throw new ToolInputError('expected an object with only a text string');
    }
    const keys = Object.keys(argumentsValue);
    if (keys.length !== 1 || typeof argumentsValue.text !== 'string') {
      throw new ToolInputError('expected an object with only a text string');
    }
    return argumentsValue.text.toUpperCase();
  },
});

export const createCharacterCountTool = (): Tool => ({
  name: 'character_count',
  description: 'Count Unicode code points in one input text.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  execute(argumentsValue: JsonValue): string {
    if (!isObject(argumentsValue)) {
      throw new ToolInputError('expected an object with only a text string');
    }
    const keys = Object.keys(argumentsValue);
    if (keys.length !== 1 || typeof argumentsValue.text !== 'string') {
      throw new ToolInputError('expected an object with only a text string');
    }
    return JSON.stringify({ count: Array.from(argumentsValue.text).length });
  },
});

export interface JsonObjectKeysToolOptions {
  readonly allowedPath: string;
  readonly maxBytes?: number;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

export const createJsonObjectKeysTool = (
  options: JsonObjectKeysToolOptions,
): Tool => ({
  name: 'list_json_object_keys',
  description: 'List the sorted keys of one object in an explicitly allowed local JSON file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      objectKey: { type: 'string' },
    },
    required: ['path', 'objectKey'],
    additionalProperties: false,
  },
  async execute(argumentsValue: JsonValue): Promise<string> {
    if (!isObject(argumentsValue)) {
      throw new ToolInputError('expected an object with only path and objectKey strings');
    }
    const keys = Object.keys(argumentsValue);
    if (
      keys.length !== 2 ||
      typeof argumentsValue.path !== 'string' ||
      typeof argumentsValue.objectKey !== 'string' ||
      argumentsValue.path !== options.allowedPath ||
      argumentsValue.objectKey.trim() === ''
    ) {
      throw new ToolInputError('expected the allowed path and one non-empty objectKey');
    }

    const bytes = await (options.readFile ?? Deno.readFile)(options.allowedPath);
    if (bytes.byteLength > (options.maxBytes ?? 64 * 1024)) {
      throw new Error('JSON file exceeds the configured byte limit');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Error('local file is not valid UTF-8 JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('JSON root is not an object');
    }
    const selected = (parsed as Record<string, unknown>)[argumentsValue.objectKey];
    if (typeof selected !== 'object' || selected === null || Array.isArray(selected)) {
      throw new Error('selected JSON value is not an object');
    }
    return JSON.stringify(Object.keys(selected).sort());
  },
});

export const createJsonArrayCountTool = (): Tool => ({
  name: 'count_json_array_items',
  description: 'Count the items in one JSON array string.',
  inputSchema: {
    type: 'object',
    properties: { json: { type: 'string' } },
    required: ['json'],
    additionalProperties: false,
  },
  execute(argumentsValue: JsonValue): string {
    if (!isObject(argumentsValue)) {
      throw new ToolInputError('expected an object with only a json string');
    }
    const keys = Object.keys(argumentsValue);
    if (keys.length !== 1 || typeof argumentsValue.json !== 'string') {
      throw new ToolInputError('expected an object with only a json string');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsValue.json);
    } catch {
      throw new ToolInputError('json must contain a valid JSON array');
    }
    if (!Array.isArray(parsed)) {
      throw new ToolInputError('json must contain a valid JSON array');
    }
    return JSON.stringify({ count: parsed.length });
  },
});
