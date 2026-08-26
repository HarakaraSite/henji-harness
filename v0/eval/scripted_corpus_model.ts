import {
  type JsonValue,
  type Model,
  type ModelRequest,
  type ModelResult,
  type ToolCall,
  type ToolDefinition,
} from '../agent/contracts.ts';
import { FixtureModelContractError } from '../agent/fixture_model.ts';
import { type CorpusTask } from '../corpus/task_corpus.ts';

interface ScriptCall {
  readonly name: string;
  readonly arguments: JsonValue;
  readonly resultText: string;
}

interface ScriptEntry {
  readonly taskId: string;
  readonly prompt: string;
  readonly rounds: readonly (readonly ScriptCall[])[];
  readonly finalText: string;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const expectedTools: readonly ToolDefinition[] = [
  {
    name: 'character_count',
    description: 'Count Unicode code points in one input text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'count_json_array_items',
    description: 'Count the items in one JSON array string.',
    inputSchema: {
      type: 'object',
      properties: { json: { type: 'string' } },
      required: ['json'],
      additionalProperties: false,
    },
  },
  {
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
  },
  {
    name: 'submit_json_result',
    description:
      'Submit the final answer when it is a JSON value. Call it as the only tool call in the assistant batch. Pass the complete JSON text in `json`. Use the normal assistant final response for plain text.',
    inputSchema: {
      type: 'object',
      properties: { json: { type: 'string' } },
      required: ['json'],
      additionalProperties: false,
    },
  },
  {
    name: 'uppercase_text',
    description: 'Convert one input text to uppercase.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

const call = (name: string, argumentsValue: JsonValue, resultText: string): ScriptCall => ({
  name,
  arguments: argumentsValue,
  resultText,
});

const scripts: readonly ScriptEntry[] = [
  {
    taskId: 'v1.character-count.henji-chick.explicit',
    prompt:
      'Use the character_count tool on exactly this text and return only its JSON result: Henji 🐣',
    rounds: [[call('character_count', { text: 'Henji 🐣' }, '{"count":7}')]],
    finalText: '{"count":7}',
  },
  {
    taskId: 'v1.character-count.henji-chick.implicit',
    prompt:
      'Count the Unicode code points in this text and return only a JSON object with the count: Henji 🐣',
    rounds: [[call('character_count', { text: 'Henji 🐣' }, '{"count":7}')]],
    finalText: '{"count":7}',
  },
  {
    taskId: 'v1.character-count.naive.explicit',
    prompt:
      'Use the character_count tool on exactly this text and return only its JSON result: naïve',
    rounds: [[call('character_count', { text: 'naïve' }, '{"count":5}')]],
    finalText: '{"count":5}',
  },
  {
    taskId: 'v1.character-count.naive.implicit',
    prompt:
      'Count the Unicode code points in this text and return only a JSON object with the count: naïve',
    rounds: [[call('character_count', { text: 'naïve' }, '{"count":5}')]],
    finalText: '{"count":5}',
  },
  {
    taskId: 'v1.count-json-array-items.complex.explicit',
    prompt:
      'Use the count_json_array_items tool on exactly this JSON array string and return only its JSON result: [["a","b"],{"x":1},false,null]',
    rounds: [[
      call(
        'count_json_array_items',
        { json: '[["a","b"],{"x":1},false,null]' },
        '{"count":4}',
      ),
    ]],
    finalText: '{"count":4}',
  },
  {
    taskId: 'v1.count-json-array-items.complex.implicit',
    prompt:
      'Count the top-level items in this JSON array and return only a JSON object with the count: [["a","b"],{"x":1},false,null]',
    rounds: [[
      call(
        'count_json_array_items',
        { json: '[["a","b"],{"x":1},false,null]' },
        '{"count":4}',
      ),
    ]],
    finalText: '{"count":4}',
  },
  {
    taskId: 'v1.count-json-array-items.simple.explicit',
    prompt:
      'Use the count_json_array_items tool on exactly this JSON array string and return only its JSON result: [1,2,3]',
    rounds: [[call('count_json_array_items', { json: '[1,2,3]' }, '{"count":3}')]],
    finalText: '{"count":3}',
  },
  {
    taskId: 'v1.count-json-array-items.simple.implicit',
    prompt:
      'Count the top-level items in this JSON array and return only a JSON object with the count: [1,2,3]',
    rounds: [[call('count_json_array_items', { json: '[1,2,3]' }, '{"count":3}')]],
    finalText: '{"count":3}',
  },
  {
    taskId: 'v1.final-only.echo',
    prompt: 'Echo exactly the text between the brackets, without the brackets: [MiXeD 123 !]',
    rounds: [],
    finalText: 'MiXeD 123 !',
  },
  {
    taskId: 'v1.final-only.json',
    prompt: 'Return only this JSON object, with no code fence: {"status":"ready","version":1}',
    rounds: [],
    finalText: '{"status":"ready","version":1}',
  },
  {
    taskId: 'v1.final-only.multiline',
    prompt: 'Return exactly these two lines and nothing else:\nalpha\nbeta',
    rounds: [],
    finalText: 'alpha\nbeta',
  },
  {
    taskId: 'v1.final-only.token',
    prompt: 'Reply with exactly: HENJI CORPUS READY',
    rounds: [],
    finalText: 'HENJI CORPUS READY',
  },
  {
    taskId: 'v1.list-json-object-keys.fmt.explicit',
    prompt:
      'Use the list_json_object_keys tool with literal path "deno.v0.json" and object key "fmt". Return only the resulting JSON array.',
    rounds: [[
      call(
        'list_json_object_keys',
        { path: 'deno.v0.json', objectKey: 'fmt' },
        '["lineWidth","semiColons","singleQuote"]',
      ),
    ]],
    finalText: '["lineWidth","semiColons","singleQuote"]',
  },
  {
    taskId: 'v1.list-json-object-keys.fmt.implicit',
    prompt:
      'Read the literal local file "deno.v0.json", list the sorted keys of its "fmt" object, and return only the JSON array.',
    rounds: [[
      call(
        'list_json_object_keys',
        { path: 'deno.v0.json', objectKey: 'fmt' },
        '["lineWidth","semiColons","singleQuote"]',
      ),
    ]],
    finalText: '["lineWidth","semiColons","singleQuote"]',
  },
  {
    taskId: 'v1.list-json-object-keys.lint.explicit',
    prompt:
      'Use the list_json_object_keys tool with literal path "deno.v0.json" and object key "lint". Return only the resulting JSON array.',
    rounds: [[call(
      'list_json_object_keys',
      { path: 'deno.v0.json', objectKey: 'lint' },
      '["rules"]',
    )]],
    finalText: '["rules"]',
  },
  {
    taskId: 'v1.list-json-object-keys.lint.implicit',
    prompt:
      'Read the literal local file "deno.v0.json", list the sorted keys of its "lint" object, and return only the JSON array.',
    rounds: [[call(
      'list_json_object_keys',
      { path: 'deno.v0.json', objectKey: 'lint' },
      '["rules"]',
    )]],
    finalText: '["rules"]',
  },
  {
    taskId: 'v1.multi-tool.fmt.explicit',
    prompt:
      'Use list_json_object_keys to list the keys of object "fmt" in the literal path "deno.v0.json", then use count_json_array_items on the returned JSON array. Return only a JSON object with the count.',
    rounds: [
      [call(
        'list_json_object_keys',
        { path: 'deno.v0.json', objectKey: 'fmt' },
        '["lineWidth","semiColons","singleQuote"]',
      )],
      [call(
        'count_json_array_items',
        { json: '["lineWidth","semiColons","singleQuote"]' },
        '{"count":3}',
      )],
    ],
    finalText: '{"count":3}',
  },
  {
    taskId: 'v1.multi-tool.fmt.implicit',
    prompt:
      'In the literal local file "deno.v0.json", obtain the sorted key list for object "fmt", then count the items in that returned JSON array. Return only a JSON object with the count.',
    rounds: [
      [call(
        'list_json_object_keys',
        { path: 'deno.v0.json', objectKey: 'fmt' },
        '["lineWidth","semiColons","singleQuote"]',
      )],
      [call(
        'count_json_array_items',
        { json: '["lineWidth","semiColons","singleQuote"]' },
        '{"count":3}',
      )],
    ],
    finalText: '{"count":3}',
  },
  {
    taskId: 'v1.multi-tool.lint.explicit',
    prompt:
      'Use list_json_object_keys to list the keys of object "lint" in the literal path "deno.v0.json", then use count_json_array_items on the returned JSON array. Return only a JSON object with the count.',
    rounds: [
      [call(
        'list_json_object_keys',
        { path: 'deno.v0.json', objectKey: 'lint' },
        '["rules"]',
      )],
      [call('count_json_array_items', { json: '["rules"]' }, '{"count":1}')],
    ],
    finalText: '{"count":1}',
  },
  {
    taskId: 'v1.multi-tool.lint.implicit',
    prompt:
      'In the literal local file "deno.v0.json", obtain the sorted key list for object "lint", then count the items in that returned JSON array. Return only a JSON object with the count.',
    rounds: [
      [call(
        'list_json_object_keys',
        { path: 'deno.v0.json', objectKey: 'lint' },
        '["rules"]',
      )],
      [call('count_json_array_items', { json: '["rules"]' }, '{"count":1}')],
    ],
    finalText: '{"count":1}',
  },
  {
    taskId: 'v1.uppercase-text.ascii.explicit',
    prompt:
      'Use the uppercase_text tool on exactly this text and return only its result: Henji harness',
    rounds: [[call('uppercase_text', { text: 'Henji harness' }, 'HENJI HARNESS')]],
    finalText: 'HENJI HARNESS',
  },
  {
    taskId: 'v1.uppercase-text.ascii.implicit',
    prompt: 'Convert this text to uppercase and return only the converted text: Henji harness',
    rounds: [[call('uppercase_text', { text: 'Henji harness' }, 'HENJI HARNESS')]],
    finalText: 'HENJI HARNESS',
  },
  {
    taskId: 'v1.uppercase-text.unicode.explicit',
    prompt:
      'Use the uppercase_text tool on exactly this text and return only its result: Straße café',
    rounds: [[call('uppercase_text', { text: 'Straße café' }, 'STRASSE CAFÉ')]],
    finalText: 'STRASSE CAFÉ',
  },
  {
    taskId: 'v1.uppercase-text.unicode.implicit',
    prompt: 'Convert this text to uppercase and return only the converted text: Straße café',
    rounds: [[call('uppercase_text', { text: 'Straße café' }, 'STRASSE CAFÉ')]],
    finalText: 'STRASSE CAFÉ',
  },
];

const scriptById = new Map(scripts.map((entry) => [entry.taskId, entry]));
const sortedScriptIds = scripts.map((entry) => entry.taskId).sort();
if (
  sortedScriptIds.length !== 24 ||
  new Set(sortedScriptIds).size !== 24 ||
  sortedScriptIds.some((id, index) => id !== scripts[index].taskId)
) {
  throw new Error('script table must be in canonical task ID order');
}

export const SCRIPTED_TASK_IDS: readonly string[] = scripts.map((entry) => entry.taskId);

/** Require the executable fixture table to match the validated corpus exactly. */
export const assertScriptedCorpusTaskSet = (taskIds: readonly string[]): void => {
  if (
    taskIds.length !== SCRIPTED_TASK_IDS.length ||
    new Set(taskIds).size !== taskIds.length ||
    taskIds.some((taskId, index) => taskId !== SCRIPTED_TASK_IDS[index])
  ) {
    throw new FixtureModelContractError('script table task IDs do not match corpus');
  }
};

const expectedTranscript = (
  prompt: string,
  rounds: readonly (readonly ScriptCall[])[],
  roundCount: number,
): readonly Record<string, unknown>[] => {
  const transcript: Record<string, unknown>[] = [{
    role: 'user',
    content: { kind: 'text', text: prompt },
  }];
  let callNumber = 1;
  for (let round = 0; round < roundCount; round += 1) {
    const calls = rounds[round].map((step) => ({
      kind: 'tool_call',
      callId: `call-${callNumber++}`,
      name: step.name,
      arguments: step.arguments,
    }));
    transcript.push({ role: 'assistant', content: calls });
    transcript.push({
      role: 'tool',
      content: calls.map((item, index) => ({
        kind: 'tool_result',
        callId: item.callId,
        name: item.name,
        text: rounds[round][index].resultText,
        outcome: 'success',
      })),
    });
  }
  return transcript;
};

const sameJson = (left: unknown, right: unknown): boolean => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

class ScriptedCorpusModel implements Model {
  readonly #script: ScriptEntry;
  #round = 0;
  #nextCall = 1;
  #finalReturned = false;
  #terminalReturned = false;

  constructor(script: ScriptEntry) {
    this.#script = script;
  }

  generate(request: ModelRequest): ModelResult {
    if (this.#finalReturned || this.#terminalReturned) {
      throw new FixtureModelContractError('script exhausted after final response');
    }
    if (!sameJson(request.tools, expectedTools)) {
      throw new FixtureModelContractError('advertised tool definitions changed');
    }
    const expected = expectedTranscript(this.#script.prompt, this.#script.rounds, this.#round);
    if (!sameJson(request.transcript, expected)) {
      throw new FixtureModelContractError('transcript prefix does not match scripted corpus');
    }
    if (this.#round < this.#script.rounds.length) {
      const calls: ToolCall[] = this.#script.rounds[this.#round].map((step) => ({
        callId: `call-${this.#nextCall++}`,
        name: step.name,
        arguments: clone(step.arguments),
      }));
      this.#round += 1;
      return { kind: 'tool_calls', calls };
    }
    let jsonTerminal = false;
    try {
      JSON.parse(this.#script.finalText);
      jsonTerminal = true;
    } catch {
      // Plain text cases intentionally use the assistant final path.
    }
    if (jsonTerminal) {
      this.#terminalReturned = true;
      return {
        kind: 'tool_calls',
        calls: [{
          callId: `call-${this.#nextCall++}`,
          name: 'submit_json_result',
          arguments: { json: this.#script.finalText },
        }],
      };
    }
    this.#finalReturned = true;
    return { kind: 'final', text: this.#script.finalText };
  }
}

export const createScriptedCorpusModel = (task: CorpusTask): Model => {
  const script = scriptById.get(task.id);
  if (!script) throw new FixtureModelContractError('unknown corpus task ID');
  if (script.prompt !== task.prompt) {
    throw new FixtureModelContractError('corpus task prompt does not match script');
  }
  return new ScriptedCorpusModel(script);
};

export const scriptedCorpusModelFor = createScriptedCorpusModel;
