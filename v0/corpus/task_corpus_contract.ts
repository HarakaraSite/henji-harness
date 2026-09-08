export const CANONICAL_CORPUS_PATH = 'v0/corpus/task-corpus.v1.json';
export const CANONICAL_FIXTURE_PATH = 'deno.v0.json';
export const SCHEMA_VERSION = 1;
export const CORPUS_ID = 'henji-normal-cli-small-v1';
export const MAX_REQUESTS = 8;
export const MAX_PROMPT_BYTES = 64 * 1024;

export const CORPUS_PATH = CANONICAL_CORPUS_PATH;
export const FIXTURE_PATH = CANONICAL_FIXTURE_PATH;

export const TOOL_NAMES = [
  'character_count',
  'count_json_array_items',
  'list_json_object_keys',
  'uppercase_text',
] as const;
export type CorpusToolName = (typeof TOOL_NAMES)[number];
export type CorpusCategory =
  | 'final_only'
  | 'uppercase_text'
  | 'character_count'
  | 'count_json_array_items'
  | 'list_json_object_keys'
  | 'multi_tool';
export type CorpusVariant = 'explicit' | 'implicit' | 'none';

export interface ExactTextOracle {
  readonly kind: 'exact_text';
  readonly expected: string;
}

export interface JsonValueOracle {
  readonly kind: 'json_value';
  readonly expected: JsonValue;
}

export type CorpusOracle = ExactTextOracle | JsonValueOracle;
export type JsonValue = null | boolean | string | number | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

export interface ToolExpectation {
  readonly requiredSequence: readonly CorpusToolName[];
  readonly allowedTools: readonly CorpusToolName[];
  readonly forbiddenTools: readonly CorpusToolName[];
  readonly maxCalls: number;
  readonly requireSuccessfulResults: boolean;
  readonly requireSeparateRounds: boolean;
}

export interface CorpusFixture {
  readonly id: string;
  readonly kind: 'local_json_object';
  readonly path: typeof CANONICAL_FIXTURE_PATH;
  readonly objectKey: string;
  readonly expectedSortedKeys: readonly string[];
}

export interface CorpusTask {
  readonly id: string;
  readonly category: CorpusCategory;
  readonly variant: CorpusVariant;
  readonly pairId: string | null;
  readonly prompt: string;
  readonly fixtureRefs: readonly string[];
  readonly oracle: CorpusOracle;
  readonly toolExpectation: ToolExpectation;
  readonly maxRequests: number;
}

export interface ValidatedTaskCorpus {
  readonly schemaVersion: 1;
  readonly corpusId: typeof CORPUS_ID;
  readonly fixtures: readonly CorpusFixture[];
  readonly tasks: readonly CorpusTask[];
}

export interface ResolvedFixture {
  readonly id: string;
  readonly path: string;
  readonly objectKey: string;
  readonly expectedSortedKeys: readonly string[];
  readonly actualSortedKeys: readonly string[];
}

export type ResolvedFixtures =
  | ReadonlyMap<string, ResolvedFixture>
  | Readonly<Record<string, ResolvedFixture>>;

export type FixtureReader = (
  path: typeof CANONICAL_FIXTURE_PATH,
) => Promise<string | Uint8Array>;

export type SubmissionEvidence =
  | null
  | {
    readonly kind: 'json_result';
    readonly requestOrdinal: number;
    readonly callId: string;
    readonly resultCallId: string;
    readonly outcome: 'success';
  };

export interface CorpusObservation {
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: readonly {
    readonly requestOrdinal: number;
    readonly callId: string;
    readonly resultCallId: string;
    readonly callName: string;
    readonly resultName: string;
    readonly outcome: 'success' | 'error';
  }[];
  readonly submission?: SubmissionEvidence;
}

export type CorpusFailureCode =
  | 'invalid_observation'
  | 'request_ceiling'
  | 'oracle_text_mismatch'
  | 'oracle_json_malformed'
  | 'oracle_json_mismatch'
  | 'tool_missing'
  | 'tool_extra'
  | 'tool_not_allowed'
  | 'tool_forbidden'
  | 'tool_error'
  | 'tool_missing_result'
  | 'tool_call_result_id_mismatch'
  | 'tool_call_result_name_mismatch'
  | 'tool_order'
  | 'tool_same_round'
  | 'submission_missing'
  | 'submission_unexpected';

export interface CorpusDimensionScore {
  readonly passed: boolean;
  readonly failureCodes: readonly CorpusFailureCode[];
}

export interface CorpusCaseScore {
  readonly taskId: string;
  readonly passed: boolean;
  readonly oracle: CorpusDimensionScore;
  readonly tools: CorpusDimensionScore;
  readonly submission: CorpusDimensionScore;
  readonly requests: CorpusDimensionScore;
  readonly failureCodes: readonly CorpusFailureCode[];
}

export class CorpusValidationError extends Error {
  constructor(message: string) {
    super(`invalid task corpus: ${message}`);
    this.name = 'CorpusValidationError';
  }
}
