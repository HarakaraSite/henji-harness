import { LinuxProcessExecutor, sourceProcessRunnerLaunch } from '../runtime/process_executor.ts';
import type { Registry } from '../tools/tools.ts';
import { PRODUCTION_PROFILE } from '../provider/provider_profile.ts';
import { type CredentialSource, OpenRouterAgentModel } from '../provider/openrouter_model.ts';
import {
  type JsonObject,
  type LoopOutcome,
  type Message,
  type Model,
  type ModelRequest,
  type ModelResult,
  type ToolCall,
  type ToolDefinition,
} from '../core/contracts.ts';
import { runAgent } from '../core/loop.ts';
import { createWorkToolsRegistry } from '../tools/registries.ts';
import { MAX_STEPS } from '../runtime/runtime.ts';
import { resolveWorkspace, type Workspace } from '../tools/work_tools.ts';

export const FIXED_TASK =
  'This is a fixed local-work sentinel. Use exactly one tool call in each assistant response and perform these five calls in order. Do not answer with assistant text and do not call any other tool.\n\n' +
  '1. Call write with {"path":"work/item.txt","content":"alpha\\n"}.\n' +
  '2. Call read with {"path":"work/item.txt"}.\n' +
  '3. Call edit with {"path":"work/item.txt","edits":[{"oldText":"alpha\\n","newText":"beta\\n"}]}.\n' +
  '4. Call bash with {"command":"test \\"$(cat work/item.txt)\\" = beta && printf \'verified:%s\' \\"$(wc -c < work/item.txt)\\"","timeoutMs":5000}.\n' +
  '5. Only after the prior tool results confirm those operations, call submit_json_result as the sole call with {"json":"{\\"path\\":\\"work/item.txt\\",\\"content\\":\\"beta\\\\n\\",\\"bytes\\":5,\\"bash\\":\\"verified:5\\"}"}.';

export const TASK_ID = 'v1.work-tools.fixed' as const;
export const TOOL_ORDER = ['write', 'read', 'edit', 'bash', 'submit_json_result'] as const;
export const MAX_SENTINEL_REQUESTS = TOOL_ORDER.length;
export const MAX_SENTINEL_TOOL_CALLS = TOOL_ORDER.length;
export const EXPECTED_PROFILE = PRODUCTION_PROFILE.id;

export const EXPECTED_RESULT = {
  path: 'work/item.txt',
  content: 'beta\n',
  bytes: 5,
  bash: 'verified:5',
} as const;

const EXPECTED_CALLS: readonly { readonly name: string; readonly arguments: JsonObject }[] = [
  { name: 'write', arguments: { path: 'work/item.txt', content: 'alpha\n' } },
  { name: 'read', arguments: { path: 'work/item.txt' } },
  {
    name: 'edit',
    arguments: {
      path: 'work/item.txt',
      edits: [{ oldText: 'alpha\n', newText: 'beta\n' }],
    },
  },
  {
    name: 'bash',
    arguments: {
      command:
        'test "$(cat work/item.txt)" = beta && printf \'verified:%s\' "$(wc -c < work/item.txt)"',
      timeoutMs: 5000,
    },
  },
  {
    name: 'submit_json_result',
    arguments: {
      json: '{"path":"work/item.txt","content":"beta\\n","bytes":5,"bash":"verified:5"}',
    },
  },
];

const EXPECTED_RESULTS = [
  '{"path":"work/item.txt","bytes":6}',
  'alpha\n',
  '{"path":"work/item.txt","edits":1,"bytes":5}',
  '{"stdout":"verified:5","stderr":"","exitCode":0,"signal":null,"timedOut":false,"stdoutTruncated":false,"stderrTruncated":false}',
  'json result submitted',
] as const;

export type SentinelFailureCode =
  | 'provider_failure'
  | 'model_adherence_failure'
  | 'tool_execution_failure'
  | 'terminal_result_mismatch'
  | 'workspace_mismatch'
  | 'internal_failure';

export type SentinelReport = SentinelSuccessReport | SentinelFailureReport;

export interface SentinelSuccessReport {
  readonly schemaVersion: 1;
  readonly taskId: typeof TASK_ID;
  readonly profile: typeof EXPECTED_PROFILE;
  readonly ok: true;
  readonly outcome: 'passed';
  readonly modelRequests: number;
  readonly externalRequests: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly toolOrder: readonly string[];
  readonly stopReason: 'tool_terminal';
  readonly terminalKind: 'json_result';
  readonly transcriptValidated: true;
  readonly workspaceValidated: true;
  readonly result: typeof EXPECTED_RESULT;
}

export interface SentinelFailureReport {
  readonly schemaVersion: 1;
  readonly taskId: typeof TASK_ID;
  readonly profile: typeof EXPECTED_PROFILE;
  readonly ok: false;
  readonly outcome: 'aborted';
  readonly code: SentinelFailureCode;
  readonly modelRequests: number;
  readonly externalRequests: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly toolOrder: readonly string[];
  readonly stopReason: string | null;
  readonly terminalKind: 'json_result' | null;
  readonly transcriptValidated: false;
  readonly workspaceValidated: false;
}

export class SentinelContractError extends Error {
  readonly code: SentinelFailureCode;

  constructor(code: SentinelFailureCode) {
    super('fixed local-work sentinel contract failed');
    this.name = 'SentinelContractError';
    this.code = code;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stableJson = (value: unknown): string | undefined => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const parts = value.map(stableJson);
    return parts.every((part): part is string => part !== undefined)
      ? `[${parts.join(',')}]`
      : undefined;
  }
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const encoded = stableJson(value[key]);
    if (encoded === undefined) return undefined;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
};

const equalJson = (left: unknown, right: unknown): boolean =>
  stableJson(left) === stableJson(right);

const expectedToolCall = (ordinal: number): ToolCall => ({
  callId: `work-tools-${ordinal + 1}`,
  name: EXPECTED_CALLS[ordinal].name,
  arguments: EXPECTED_CALLS[ordinal].arguments,
});

const isToolCall = (value: unknown): value is ToolCall => {
  if (!isObject(value)) return false;
  return typeof value.callId === 'string' && value.callId.length > 0 &&
    typeof value.name === 'string' && value.name.length > 0 && 'arguments' in value;
};

const expectedResultText = (ordinal: number): string => EXPECTED_RESULTS[ordinal];

const validatePriorRound = (message: Message, call: ToolCall, ordinal: number): boolean => {
  if (message.role !== 'tool' || message.content.length !== 1) return false;
  const result = message.content[0];
  return result.kind === 'tool_result' && result.callId === call.callId &&
    result.name === call.name && result.outcome === 'success' &&
    result.text === expectedResultText(ordinal);
};

const hasExpectedToolExecutionError = (
  request: ModelRequest,
  ordinal: number,
): boolean => {
  if (ordinal < 1 || request.transcript.length !== 1 + ordinal * 2) return false;
  for (let index = 0; index < ordinal; index += 1) {
    const assistant = request.transcript[1 + index * 2];
    const tool = request.transcript[2 + index * 2];
    if (
      assistant.role !== 'assistant' || !Array.isArray(assistant.content) ||
      assistant.content.length !== 1 || !isToolCall(assistant.content[0]) ||
      tool.role !== 'tool' || tool.content.length !== 1
    ) continue;
    const call = assistant.content[0];
    const expected = expectedToolCall(index);
    const result = tool.content[0];
    if (
      call.name === expected.name && equalJson(call.arguments, expected.arguments) &&
      result.kind === 'tool_result' && result.callId === call.callId &&
      result.name === call.name && result.outcome === 'error'
    ) return true;
  }
  return false;
};

/** Validate the causal transcript before a provider request is dispatched. */
export const validateSentinelRequestTranscript = (
  request: ModelRequest,
  ordinal: number,
): boolean => {
  if (ordinal < 0 || ordinal > MAX_SENTINEL_REQUESTS) return false;
  if (request.transcript.length !== 1 + ordinal * 2) return false;
  const user = request.transcript[0];
  if (user.role !== 'user' || user.content.kind !== 'text' || user.content.text !== FIXED_TASK) {
    return false;
  }
  const seenCallIds = new Set<string>();
  for (let index = 0; index < ordinal; index += 1) {
    const assistant = request.transcript[1 + index * 2];
    const tool = request.transcript[2 + index * 2];
    if (
      assistant.role !== 'assistant' || !Array.isArray(assistant.content) ||
      assistant.content.length !== 1 || !isToolCall(assistant.content[0])
    ) return false;
    const call = assistant.content[0];
    const expected = expectedToolCall(index);
    if (seenCallIds.has(call.callId)) return false;
    seenCallIds.add(call.callId);
    if (call.name !== expected.name || !equalJson(call.arguments, expected.arguments)) return false;
    if (!validatePriorRound(tool, call, index)) return false;
  }
  return true;
};

export const validateSentinelToolResponse = (result: ModelResult, ordinal: number): boolean => {
  if (ordinal < 0 || ordinal >= MAX_SENTINEL_REQUESTS) return false;
  if (result.kind !== 'tool_calls' || result.calls.length !== 1) return false;
  const call = result.calls[0];
  const expected = EXPECTED_CALLS[ordinal];
  return isToolCall(call) && call.name === expected.name &&
    equalJson(call.arguments, expected.arguments);
};

export const validateSentinelTranscript = (transcript: readonly Message[]): boolean => {
  if (transcript.length !== 1 + MAX_SENTINEL_REQUESTS * 2) return false;
  if (!validateSentinelRequestTranscript({ transcript, tools: [] }, MAX_SENTINEL_REQUESTS)) {
    return false;
  }
  const finalAssistant = transcript[1 + (MAX_SENTINEL_REQUESTS - 1) * 2];
  const last = transcript[transcript.length - 1];
  if (
    finalAssistant.role !== 'assistant' || !Array.isArray(finalAssistant.content) ||
    finalAssistant.content.length !== 1 || !isToolCall(finalAssistant.content[0]) ||
    last.role !== 'tool' || last.content.length !== 1
  ) return false;
  const finalCall = finalAssistant.content[0];
  const result = last.content[0];
  return result.kind === 'tool_result' && 'terminal' in result &&
    result.terminal === 'json_result' &&
    result.callId === finalCall.callId &&
    result.name === 'submit_json_result' && result.outcome === 'success' &&
    result.text === expectedResultText(MAX_SENTINEL_REQUESTS - 1);
};

const workspaceIsValid = async (workspace: Workspace): Promise<boolean> => {
  try {
    const root = await Deno.lstat(workspace.root);
    if (!root.isDirectory || root.isSymlink) return false;
    const rootEntries: string[] = [];
    for await (const entry of Deno.readDir(workspace.root)) rootEntries.push(entry.name);
    if (rootEntries.length !== 1 || rootEntries[0] !== 'work') return false;
    const workPath = `${workspace.root}/work`;
    const work = await Deno.lstat(workPath);
    if (!work.isDirectory || work.isSymlink) return false;
    const workEntries: string[] = [];
    for await (const entry of Deno.readDir(workPath)) workEntries.push(entry.name);
    if (workEntries.length !== 1 || workEntries[0] !== 'item.txt') return false;
    const itemPath = `${workPath}/item.txt`;
    const item = await Deno.lstat(itemPath);
    if (!item.isFile || item.isSymlink) return false;
    const bytes = await Deno.readFile(itemPath);
    return equalJson(
      Array.from(bytes),
      Array.from(new TextEncoder().encode(EXPECTED_RESULT.content)),
    );
  } catch {
    return false;
  }
};

export const validateSentinelWorkspace = workspaceIsValid;

const failureCodeForOutcome = (outcome: LoopOutcome): SentinelFailureCode => {
  if (
    outcome.transcript.some((message) =>
      message.role === 'tool' && message.content.some((result) => result.outcome === 'error')
    )
  ) return 'tool_execution_failure';
  if (outcome.stopReason === 'tool_terminal') return 'terminal_result_mismatch';
  return 'model_adherence_failure';
};

const boundedCount = (value: number): number => Number.isInteger(value) && value >= 0 ? value : 0;

const failureReport = (
  code: SentinelFailureCode,
  requestCount: number,
  externalRequests: number,
  outcome?: LoopOutcome,
): SentinelFailureReport => ({
  schemaVersion: 1,
  taskId: TASK_ID,
  profile: EXPECTED_PROFILE,
  ok: false,
  outcome: 'aborted',
  code,
  modelRequests: Math.min(MAX_SENTINEL_REQUESTS, boundedCount(requestCount)),
  externalRequests: boundedCount(externalRequests),
  steps: Math.min(MAX_STEPS, boundedCount(outcome?.steps ?? requestCount)),
  toolCalls: Math.min(MAX_SENTINEL_TOOL_CALLS, boundedCount(outcome?.toolCallCount ?? 0)),
  toolResults: Math.min(MAX_SENTINEL_TOOL_CALLS, boundedCount(outcome?.toolResultCount ?? 0)),
  toolOrder: outcome === undefined
    ? []
    : outcome.transcript.flatMap((message) =>
      message.role === 'assistant' && Array.isArray(message.content) && message.content.length === 1
        ? [message.content[0].name]
        : []
    ).slice(0, MAX_SENTINEL_REQUESTS),
  stopReason: outcome?.stopReason ?? null,
  terminalKind: outcome?.terminalKind ?? null,
  transcriptValidated: false,
  workspaceValidated: false,
});

export interface SentinelRunDependencies {
  readonly fetcher?: typeof fetch;
  readonly credential?: string;
  readonly credentialSource?: CredentialSource;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly workspaceRoot?: string;
}

export interface SentinelRunResult {
  readonly report: SentinelReport;
  readonly externalRequests: number;
}

export class GuardedModel implements Model {
  private requestCount = 0;
  private lastFailure: SentinelFailureCode | undefined;

  constructor(
    private readonly delegate: Model,
    private readonly definitions: readonly ToolDefinition[],
  ) {}

  get calls(): number {
    return this.requestCount;
  }

  get failureCode(): SentinelFailureCode | undefined {
    return this.lastFailure;
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    if (this.requestCount >= MAX_SENTINEL_REQUESTS) {
      this.lastFailure = 'model_adherence_failure';
      throw new SentinelContractError('model_adherence_failure');
    }
    if (hasExpectedToolExecutionError(request, this.requestCount)) {
      this.lastFailure = 'tool_execution_failure';
      throw new SentinelContractError('tool_execution_failure');
    }
    if (
      !validateSentinelRequestTranscript(request, this.requestCount) ||
      !equalJson(request.tools, this.definitions)
    ) {
      this.lastFailure = 'model_adherence_failure';
      throw new SentinelContractError('model_adherence_failure');
    }
    const ordinal = this.requestCount;
    this.requestCount += 1;
    let result: ModelResult;
    try {
      result = await this.delegate.generate(request);
    } catch (error) {
      if (error instanceof SentinelContractError) {
        this.lastFailure = error.code;
        throw error;
      }
      this.lastFailure = 'provider_failure';
      throw new SentinelContractError('provider_failure');
    }
    if (!validateSentinelToolResponse(result, ordinal)) {
      this.lastFailure = 'model_adherence_failure';
      throw new SentinelContractError('model_adherence_failure');
    }
    return result;
  }
}

export const runSentinel = async (
  dependencies: SentinelRunDependencies = {},
): Promise<SentinelRunResult> => {
  const processExecutor = new LinuxProcessExecutor(sourceProcessRunnerLaunch());
  let registry: Registry | undefined;
  let externalRequests = 0;
  let guarded: GuardedModel | undefined;
  try {
    const workspace = await resolveWorkspace(dependencies.workspaceRoot);
    const baseFetcher = dependencies.fetcher ?? fetch;
    const fetcher: typeof fetch = (input, init) => {
      if (externalRequests >= (guarded?.calls ?? 0)) {
        throw new SentinelContractError('provider_failure');
      }
      externalRequests += 1;
      return baseFetcher(input, init);
    };
    registry = createWorkToolsRegistry(workspace, processExecutor);
    const model = new OpenRouterAgentModel({
      fetcher,
      credential: dependencies.credential,
      credentialSource: dependencies.credentialSource,
      endpoint: dependencies.endpoint,
      timeoutMs: dependencies.timeoutMs,
    });
    guarded = new GuardedModel(model, registry.definitions());
    const outcome = await runAgent(FIXED_TASK, guarded, registry, { maxSteps: MAX_STEPS });
    if (!outcome.ok || outcome.outcome !== 'final') {
      return {
        report: failureReport(
          guarded.failureCode ?? failureCodeForOutcome(outcome),
          guarded.calls,
          externalRequests,
          outcome,
        ),
        externalRequests,
      };
    }
    const transcriptValid = validateSentinelTranscript(outcome.transcript);
    const terminalValid = outcome.stopReason === 'tool_terminal' &&
      outcome.terminalKind === 'json_result' &&
      outcome.finalText === JSON.stringify(EXPECTED_RESULT);
    if (!transcriptValid || !terminalValid) {
      return {
        report: failureReport('terminal_result_mismatch', guarded.calls, externalRequests, outcome),
        externalRequests,
      };
    }
    const workspaceValid = await workspaceIsValid(workspace);
    if (!workspaceValid) {
      return {
        report: failureReport('workspace_mismatch', guarded.calls, externalRequests, outcome),
        externalRequests,
      };
    }
    const report: SentinelSuccessReport = {
      schemaVersion: 1,
      taskId: TASK_ID,
      profile: EXPECTED_PROFILE,
      ok: true,
      outcome: 'passed',
      modelRequests: guarded.calls,
      externalRequests,
      steps: outcome.steps,
      toolCalls: outcome.toolCallCount,
      toolResults: outcome.toolResultCount,
      toolOrder: [...TOOL_ORDER],
      stopReason: 'tool_terminal',
      terminalKind: 'json_result',
      transcriptValidated: true,
      workspaceValidated: true,
      result: EXPECTED_RESULT,
    };
    return { report, externalRequests };
  } catch (error) {
    const code = error instanceof SentinelContractError ? error.code : 'internal_failure';
    return { report: failureReport(code, guarded?.calls ?? 0, externalRequests), externalRequests };
  } finally {
    try {
      await processExecutor.close();
    } finally {
      await registry?.close();
    }
  }
};

const writeStdoutLine = async (report: SentinelReport): Promise<void> => {
  const bytes = new TextEncoder().encode(`${JSON.stringify(report)}\n`);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await Deno.stdout.write(bytes.subarray(offset));
    if (!Number.isSafeInteger(written) || written <= 0) throw new Error('stdout failed');
    offset += written;
  }
};

export const main = async (args: readonly string[] = Deno.args): Promise<number> => {
  if (args.length !== 0) {
    await writeStdoutLine(failureReport('model_adherence_failure', 0, 0));
    return 1;
  }
  const result = await runSentinel();
  await writeStdoutLine(result.report);
  return result.report.ok ? 0 : 1;
};

if (import.meta.main) Deno.exit(await main());
