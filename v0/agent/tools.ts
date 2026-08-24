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
