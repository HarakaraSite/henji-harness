import type {
  CorpusCategory,
  CorpusOracle,
  CorpusToolName,
  ResolvedFixture,
  ResolvedFixtures,
} from './task_corpus_contract.ts';
import { fail } from './task_corpus_value.ts';

export const canonicalFixtureTuples: Readonly<
  Record<string, {
    readonly objectKey: string;
    readonly expectedSortedKeys: readonly string[];
  }>
> = {
  'deno-v0-fmt': {
    objectKey: 'fmt',
    expectedSortedKeys: ['lineWidth', 'semiColons', 'singleQuote'],
  },
  'deno-v0-lint': {
    objectKey: 'lint',
    expectedSortedKeys: ['rules'],
  },
};

export const expectedPrompts: Readonly<Record<string, string>> = {
  'v1.character-count.henji-chick.explicit':
    'Use the character_count tool on exactly this text and return only its JSON result: Henji 🐣',
  'v1.character-count.henji-chick.implicit':
    'Count the Unicode code points in this text and return only a JSON object with the count: Henji 🐣',
  'v1.character-count.naive.explicit':
    'Use the character_count tool on exactly this text and return only its JSON result: naïve',
  'v1.character-count.naive.implicit':
    'Count the Unicode code points in this text and return only a JSON object with the count: naïve',
  'v1.count-json-array-items.complex.explicit':
    'Use the count_json_array_items tool on exactly this JSON array string and return only its JSON result: [["a","b"],{"x":1},false,null]',
  'v1.count-json-array-items.complex.implicit':
    'Count the top-level items in this JSON array and return only a JSON object with the count: [["a","b"],{"x":1},false,null]',
  'v1.count-json-array-items.simple.explicit':
    'Use the count_json_array_items tool on exactly this JSON array string and return only its JSON result: [1,2,3]',
  'v1.count-json-array-items.simple.implicit':
    'Count the top-level items in this JSON array and return only a JSON object with the count: [1,2,3]',
  'v1.final-only.echo':
    'Echo exactly the text between the brackets, without the brackets: [MiXeD 123 !]',
  'v1.final-only.json':
    'Return only this JSON object, with no code fence: {"status":"ready","version":1}',
  'v1.final-only.multiline': 'Return exactly these two lines and nothing else:\nalpha\nbeta',
  'v1.final-only.token': 'Reply with exactly: HENJI CORPUS READY',
  'v1.list-json-object-keys.fmt.explicit':
    'Use the list_json_object_keys tool with literal path "deno.v0.json" and object key "fmt". Return only the resulting JSON array.',
  'v1.list-json-object-keys.fmt.implicit':
    'Read the literal local file "deno.v0.json", list the sorted keys of its "fmt" object, and return only the JSON array.',
  'v1.list-json-object-keys.lint.explicit':
    'Use the list_json_object_keys tool with literal path "deno.v0.json" and object key "lint". Return only the resulting JSON array.',
  'v1.list-json-object-keys.lint.implicit':
    'Read the literal local file "deno.v0.json", list the sorted keys of its "lint" object, and return only the JSON array.',
  'v1.multi-tool.fmt.explicit':
    'Use list_json_object_keys to list the keys of object "fmt" in the literal path "deno.v0.json", then use count_json_array_items on the returned JSON array. Return only a JSON object with the count.',
  'v1.multi-tool.fmt.implicit':
    'In the literal local file "deno.v0.json", obtain the sorted key list for object "fmt", then count the items in that returned JSON array. Return only a JSON object with the count.',
  'v1.multi-tool.lint.explicit':
    'Use list_json_object_keys to list the keys of object "lint" in the literal path "deno.v0.json", then use count_json_array_items on the returned JSON array. Return only a JSON object with the count.',
  'v1.multi-tool.lint.implicit':
    'In the literal local file "deno.v0.json", obtain the sorted key list for object "lint", then count the items in that returned JSON array. Return only a JSON object with the count.',
  'v1.uppercase-text.ascii.explicit':
    'Use the uppercase_text tool on exactly this text and return only its result: Henji harness',
  'v1.uppercase-text.ascii.implicit':
    'Convert this text to uppercase and return only the converted text: Henji harness',
  'v1.uppercase-text.unicode.explicit':
    'Use the uppercase_text tool on exactly this text and return only its result: Straße café',
  'v1.uppercase-text.unicode.implicit':
    'Convert this text to uppercase and return only the converted text: Straße café',
};

export const expectedOracle = (id: string): CorpusOracle => {
  if (id.includes('character-count.henji-chick')) {
    return { kind: 'json_value', expected: { count: 7 } };
  }
  if (id.includes('character-count.naive')) {
    return { kind: 'json_value', expected: { count: 5 } };
  }
  if (id.includes('count-json-array-items.complex')) {
    return { kind: 'json_value', expected: { count: 4 } };
  }
  if (id.includes('count-json-array-items.simple')) {
    return { kind: 'json_value', expected: { count: 3 } };
  }
  if (id === 'v1.final-only.echo') {
    return { kind: 'exact_text', expected: 'MiXeD 123 !' };
  }
  if (id === 'v1.final-only.json') {
    return { kind: 'json_value', expected: { status: 'ready', version: 1 } };
  }
  if (id === 'v1.final-only.multiline') {
    return { kind: 'exact_text', expected: 'alpha\nbeta' };
  }
  if (id === 'v1.final-only.token') {
    return { kind: 'exact_text', expected: 'HENJI CORPUS READY' };
  }
  if (id.includes('list-json-object-keys.fmt')) {
    return {
      kind: 'json_value',
      expected: ['lineWidth', 'semiColons', 'singleQuote'],
    };
  }
  if (id.includes('list-json-object-keys.lint')) {
    return { kind: 'json_value', expected: ['rules'] };
  }
  if (id.includes('multi-tool.fmt')) {
    return { kind: 'json_value', expected: { count: 3 } };
  }
  if (id.includes('multi-tool.lint')) {
    return { kind: 'json_value', expected: { count: 1 } };
  }
  if (id.includes('uppercase-text')) {
    return {
      kind: 'exact_text',
      expected: id.includes('unicode') ? 'STRASSE CAFÉ' : 'HENJI HARNESS',
    };
  }
  return fail('task', `no canonical oracle for ${id}`);
};

export const expectedCategory = (id: string): CorpusCategory => {
  if (id.includes('.character-count.')) return 'character_count';
  if (id.includes('.count-json-array-items.')) return 'count_json_array_items';
  if (id.includes('.list-json-object-keys.')) return 'list_json_object_keys';
  if (id.includes('.multi-tool.')) return 'multi_tool';
  if (id.includes('.uppercase-text.')) return 'uppercase_text';
  if (id.includes('.final-only.')) return 'final_only';
  return fail('task', `no canonical category for ${id}`);
};

export const expectedFixtureRefs = (id: string): readonly string[] => {
  if (id.includes('.fmt.')) return ['deno-v0-fmt'];
  if (id.includes('.lint.')) return ['deno-v0-lint'];
  return [];
};

export const expectedTools = (category: CorpusCategory): readonly CorpusToolName[] => {
  if (category === 'final_only') return [];
  if (category === 'multi_tool') {
    return ['list_json_object_keys', 'count_json_array_items'];
  }
  return [category];
};

export const expectedMaxRequests = (category: CorpusCategory): number =>
  category === 'final_only' ? 1 : category === 'multi_tool' ? 3 : 2;

export const expectedMaxCalls = (category: CorpusCategory): number =>
  category === 'final_only' ? 0 : category === 'multi_tool' ? 2 : 1;

export const canonicalTaskIds = Object.keys(expectedPrompts).sort();

export const resolvedFixture = (
  fixtures: ResolvedFixtures,
  id: string,
): ResolvedFixture | undefined =>
  fixtures instanceof Map
    ? fixtures.get(id)
    : (fixtures as Readonly<Record<string, ResolvedFixture>>)[id];
