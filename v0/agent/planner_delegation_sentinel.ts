import { PROFILE } from '../model.ts';
import { type ToolDefinition } from './contracts.ts';
import { runRuntime } from './runtime.ts';
import { resolveBuiltinAgent } from './agent_catalog.ts';
import { PLANNER_AGENT_INSTRUCTION } from './agent_definition.ts';
import { createPlannerRegistry, createProductionRegistry } from './registries.ts';
import { resolveWorkspace, type Workspace } from './work_tools.ts';
import { type LoopOutcome } from './contracts.ts';

export const TASK_ID = 'v1.planner-delegation.fixed' as const;
export const EXPECTED_PROFILE = PROFILE.id;
export const FIXED_DELEGATED_TASK =
  'Return exactly this one-line implementation plan and nothing else:\nPLAN: inspect requirements; implement the smallest change; run focused tests.' as const;
export const FIXED_PARENT_TASK =
  'This is a fixed planner-delegation sentinel. Use exactly one delegate_to_planner call and no other tool.\n\n' +
  'First, call delegate_to_planner as the sole tool call with this exact task:\n' +
  FIXED_DELEGATED_TASK +
  '\n\nAfter, and only after, its successful result confirms that exact planner output with modelRequests 1 and externalRequests 1, answer exactly:\nPLANNER_DELEGATION_CONFIRMED\n\n' +
  'Do not answer before delegation. Do not call a mutation tool, submit_json_result, skill, or a second delegation.';
export const EXPECTED_CHILD_FINAL =
  'PLAN: inspect requirements; implement the smallest change; run focused tests.' as const;
export const EXPECTED_PARENT_FINAL = 'PLANNER_DELEGATION_CONFIRMED' as const;
export const REQUEST_ORDER = ['parent', 'child', 'parent'] as const;
export const PARENT_TOOL_ORDER = ['delegate_to_planner'] as const;
export const PARENT_MODEL_REQUESTS = 2 as const;
export const CHILD_MODEL_REQUESTS = 1 as const;
export const MAX_SENTINEL_REQUESTS = 3 as const;

export type SentinelFailureCode =
  | 'provider_failure'
  | 'request_contract_failure'
  | 'model_adherence_failure'
  | 'delegation_contract_failure'
  | 'parent_final_mismatch'
  | 'workspace_mismatch'
  | 'internal_failure';

export interface SentinelSuccessReport {
  readonly schemaVersion: 1;
  readonly taskId: typeof TASK_ID;
  readonly profile: typeof EXPECTED_PROFILE;
  readonly ok: true;
  readonly outcome: 'passed';
  readonly parentModelRequests: 2;
  readonly childModelRequests: 1;
  readonly aggregateModelRequests: 3;
  readonly externalRequests: 3;
  readonly delegationCalls: 1;
  readonly delegationResults: 1;
  readonly requestOrder: readonly ['parent', 'child', 'parent'];
  readonly parentToolOrder: readonly ['delegate_to_planner'];
  readonly parentStopReason: 'final';
  readonly plannerFinalValidated: true;
  readonly childCompletedBeforeParentFinal: true;
  readonly plannerNonMutating: true;
  readonly plannerNonRecursive: true;
  readonly transcriptValidated: true;
  readonly workspaceValidated: true;
}

export interface SentinelFailureReport {
  readonly schemaVersion: 1;
  readonly taskId: typeof TASK_ID;
  readonly profile: typeof EXPECTED_PROFILE;
  readonly ok: false;
  readonly outcome: 'aborted';
  readonly code: SentinelFailureCode;
  readonly parentModelRequests: number;
  readonly childModelRequests: number;
  readonly aggregateModelRequests: number;
  readonly externalRequests: number;
  readonly delegationCalls: number;
  readonly delegationResults: number;
  readonly requestOrder: readonly string[];
  readonly parentToolOrder: readonly string[];
  readonly parentStopReason: string | null;
  readonly plannerFinalValidated: boolean;
  readonly childCompletedBeforeParentFinal: boolean;
  readonly plannerNonMutating: boolean;
  readonly plannerNonRecursive: boolean;
  readonly transcriptValidated: boolean;
  readonly workspaceValidated: boolean;
}

export type SentinelReport = SentinelSuccessReport | SentinelFailureReport;

export class SentinelContractError extends Error {
  readonly code: SentinelFailureCode;

  constructor(code: SentinelFailureCode) {
    super('fixed planner-delegation sentinel contract failed');
    this.name = 'SentinelContractError';
    this.code = code;
  }
}

const encoder = new TextEncoder();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stableJson = (value: unknown): string | undefined => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const values = value.map(stableJson);
    return values.every((item): item is string => item !== undefined)
      ? `[${values.join(',')}]`
      : undefined;
  }
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value).sort();
  const values = keys.map((key) => stableJson(value[key]));
  return values.every((item): item is string => item !== undefined)
    ? `{${keys.map((key, index) => `${JSON.stringify(key)}:${values[index]}`).join(',')}}`
    : undefined;
};

const equalJson = (left: unknown, right: unknown): boolean =>
  stableJson(left) === stableJson(right);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
};

const bounded = (value: number, maximum: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const expectedDelegationResult = (): string =>
  JSON.stringify({
    ok: true,
    agent: 'planner',
    output: { kind: 'text', text: EXPECTED_CHILD_FINAL },
    usage: { modelRequests: 1, externalRequests: 1 },
  });

const expectedParentCall = (callId: string): Record<string, unknown> => ({
  id: callId,
  type: 'function',
  function: {
    name: 'delegate_to_planner',
    arguments: JSON.stringify({ task: FIXED_DELEGATED_TASK }),
  },
});

const expectedParentTools = (workspace: Workspace): readonly ToolDefinition[] =>
  createProductionRegistry(workspace, {}, { skills: [] }, () => {
    throw new Error('sentinel-only registry handler');
  }).definitions();

const expectedChildTools = (workspace: Workspace): readonly ToolDefinition[] =>
  createPlannerRegistry(workspace, { skills: [] }).definitions();

const wireRequest = (input: RequestInfo | URL, init: RequestInit | undefined): {
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
} => {
  if (
    String(input) !== `${PROFILE.origin}${PROFILE.path}` || init?.method !== 'POST' ||
    init?.redirect !== 'error' || typeof init.body !== 'string'
  ) {
    throw new SentinelContractError('request_contract_failure');
  }
  const headers = new Headers(init.headers);
  if (
    headers.get('content-type') !== 'application/json' ||
    !/^Bearer\s+\S+$/.test(headers.get('authorization') ?? '') ||
    [...headers.keys()].sort().join(',') !== 'authorization,content-type'
  ) throw new SentinelContractError('request_contract_failure');
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    throw new SentinelContractError('request_contract_failure');
  }
  if (!isObject(body)) throw new SentinelContractError('request_contract_failure');
  return { body, headers };
};

const validateCommonBody = (body: Record<string, unknown>): void => {
  if (
    !exactKeys(body, ['model', 'messages', 'tools', 'stream', 'max_completion_tokens']) ||
    body.model !== PROFILE.model || body.stream !== false || body.max_completion_tokens !== 1024 ||
    !Array.isArray(body.messages) || !Array.isArray(body.tools)
  ) throw new SentinelContractError('request_contract_failure');
};

const validateParentMessages = (
  body: Record<string, unknown>,
  ordinal: 0 | 2,
  callId: string | undefined,
): void => {
  const messages = body.messages as unknown[];
  if (ordinal === 0) {
    if (
      messages.length !== 1 || !equalJson(messages[0], { role: 'user', content: FIXED_PARENT_TASK })
    ) {
      throw new SentinelContractError('request_contract_failure');
    }
    return;
  }
  if (
    callId === undefined || messages.length !== 3 ||
    !equalJson(messages[0], { role: 'user', content: FIXED_PARENT_TASK })
  ) throw new SentinelContractError('request_contract_failure');
  const assistant = messages[1];
  const tool = messages[2];
  if (
    !isObject(assistant) || !exactKeys(assistant, ['role', 'content', 'tool_calls']) ||
    assistant.role !== 'assistant' || assistant.content !== null ||
    !Array.isArray(assistant.tool_calls) ||
    assistant.tool_calls.length !== 1 ||
    !equalJson(assistant.tool_calls[0], expectedParentCall(callId))
  ) throw new SentinelContractError('request_contract_failure');
  if (
    !isObject(tool) || !exactKeys(tool, ['role', 'tool_call_id', 'content']) ||
    tool.role !== 'tool' ||
    tool.tool_call_id !== callId || tool.content !== expectedDelegationResult()
  ) throw new SentinelContractError('delegation_contract_failure');
};

const validateChildMessages = (body: Record<string, unknown>): void => {
  if (
    !equalJson(body.messages, [
      { role: 'system', content: PLANNER_AGENT_INSTRUCTION },
      { role: 'user', content: FIXED_DELEGATED_TASK },
    ])
  ) throw new SentinelContractError('request_contract_failure');
};

interface GuardState {
  readonly workspace: Workspace;
  readonly requestOrder: string[];
  readonly parentToolOrder: string[];
  requestCount: number;
  parentModelRequests: number;
  childModelRequests: number;
  delegationCalls: number;
  delegationResults: number;
  parentCallId?: string;
  childCompleted: boolean;
  childCompletedBeforeParentFinal: boolean;
  parentFinal: boolean;
  plannerFinalValidated: boolean;
  transcriptValidated: boolean;
  failureCode?: SentinelFailureCode;
}

const responsePayload = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new SentinelContractError('provider_failure');
  let text: string;
  try {
    text = await response.clone().text();
  } catch {
    throw new SentinelContractError('provider_failure');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SentinelContractError('provider_failure');
  }
};

const validParentToolCall = (
  value: unknown,
): value is Record<string, unknown> & { readonly id: string } => {
  if (!isObject(value) || !nonBlank(value.id) || value.type !== 'function') return false;
  if (!isObject(value.function) || value.function.name !== 'delegate_to_planner') return false;
  if (typeof value.function.arguments !== 'string') return false;
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(value.function.arguments);
  } catch {
    return false;
  }
  return isObject(argumentsValue) && exactKeys(argumentsValue, ['task']) &&
    argumentsValue.task === FIXED_DELEGATED_TASK;
};

const validFinalMessage = (message: Record<string, unknown>, expected: string): boolean => {
  if (message.content !== expected) return false;
  return !Object.prototype.hasOwnProperty.call(message, 'tool_calls') ||
    message.tool_calls === null;
};

const validateProviderResponse = (
  payload: unknown,
  phase: string,
  state: GuardState,
): void => {
  if (!isObject(payload) || !Array.isArray(payload.choices) || payload.choices.length !== 1) {
    throw new SentinelContractError('provider_failure');
  }
  const choice = payload.choices[0];
  if (!isObject(choice) || !isObject(choice.message) || choice.message.role !== 'assistant') {
    throw new SentinelContractError('provider_failure');
  }
  const message = choice.message;
  if (phase === 'parent1') {
    if (
      message.content !== null || !Array.isArray(message.tool_calls) ||
      message.tool_calls.length !== 1
    ) throw new SentinelContractError('model_adherence_failure');
    const call = message.tool_calls[0];
    if (!validParentToolCall(call)) throw new SentinelContractError('model_adherence_failure');
    state.parentCallId = call.id;
    state.delegationCalls += 1;
    state.parentToolOrder.push('delegate_to_planner');
    return;
  }
  if (
    !validFinalMessage(message, phase === 'child' ? EXPECTED_CHILD_FINAL : EXPECTED_PARENT_FINAL)
  ) {
    throw new SentinelContractError(
      phase === 'child' ? 'model_adherence_failure' : 'parent_final_mismatch',
    );
  }
  if (phase === 'child') {
    state.childCompleted = true;
    state.plannerFinalValidated = true;
    return;
  }
  state.parentFinal = true;
  state.delegationResults += 1;
};

export interface GuardedFetch {
  readonly fetch: typeof fetch;
  readonly state: GuardState;
}

/** A fetch seam that proves each fixed request before allowing the underlying fetch to start. */
export const createGuardedFetch = (
  workspace: Workspace,
  baseFetcher: typeof fetch,
): GuardedFetch => {
  const state: GuardState = {
    workspace,
    requestOrder: [],
    parentToolOrder: [],
    requestCount: 0,
    parentModelRequests: 0,
    childModelRequests: 0,
    delegationCalls: 0,
    delegationResults: 0,
    childCompleted: false,
    childCompletedBeforeParentFinal: false,
    parentFinal: false,
    plannerFinalValidated: false,
    transcriptValidated: false,
  };
  const guarded: typeof fetch = async (input, init) => {
    try {
      if (state.requestCount >= MAX_SENTINEL_REQUESTS) {
        throw new SentinelContractError('request_contract_failure');
      }
      const { body } = wireRequest(input, init);
      validateCommonBody(body);
      const index = state.requestCount;
      const phase = index === 0 ? 'parent1' : index === 1 ? 'child' : 'parent2';
      const expectedTools = phase === 'child'
        ? expectedChildTools(workspace)
        : expectedParentTools(workspace);
      if (
        !equalJson(
          body.tools,
          expectedTools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        )
      ) throw new SentinelContractError('request_contract_failure');
      if (phase === 'parent1') {
        validateParentMessages(body, 0, undefined);
        state.requestOrder.push('parent');
        state.parentModelRequests += 1;
      } else if (phase === 'child') {
        validateChildMessages(body);
        if (state.parentCallId === undefined || state.delegationCalls !== 1) {
          throw new SentinelContractError('delegation_contract_failure');
        }
        state.requestOrder.push('child');
        state.childModelRequests += 1;
      } else {
        validateParentMessages(body, 2, state.parentCallId);
        if (!state.childCompleted || state.parentFinal) {
          throw new SentinelContractError('delegation_contract_failure');
        }
        state.childCompletedBeforeParentFinal = true;
        state.requestOrder.push('parent');
        state.parentModelRequests += 1;
      }
      state.requestCount += 1;
      let response: Response;
      try {
        response = await baseFetcher(input, init);
      } catch {
        throw new SentinelContractError('provider_failure');
      }
      const payload = await responsePayload(response);
      validateProviderResponse(payload, phase, state);
      return response;
    } catch (error) {
      if (error instanceof SentinelContractError) {
        if (state.failureCode === undefined) state.failureCode = error.code;
        throw error;
      }
      state.failureCode = 'internal_failure';
      throw new SentinelContractError('internal_failure');
    }
  };
  return { fetch: guarded, state };
};

const validateEmptyWorkspace = async (workspace: Workspace): Promise<boolean> => {
  try {
    const info = await Deno.lstat(workspace.root);
    if (
      !info.isDirectory || info.isSymlink || info.mode === null || (info.mode & 0o7777) !== 0o700
    ) {
      return false;
    }
    for await (const _entry of Deno.readDir(workspace.root)) return false;
    return true;
  } catch {
    return false;
  }
};

export const validateSentinelWorkspace = validateEmptyWorkspace;

const validateParentTranscript = (outcome: LoopOutcome, state: GuardState): boolean => {
  if (!state.parentCallId || outcome.transcript.length !== 4) return false;
  const [user, assistant, tool, final] = outcome.transcript;
  if (!equalJson(user, { role: 'user', content: { kind: 'text', text: FIXED_PARENT_TASK } })) {
    return false;
  }
  if (
    assistant.role !== 'assistant' || !Array.isArray(assistant.content) ||
    assistant.content.length !== 1 || !equalJson(assistant.content[0], {
      kind: 'tool_call',
      callId: state.parentCallId,
      name: 'delegate_to_planner',
      arguments: { task: FIXED_DELEGATED_TASK },
    })
  ) return false;
  if (
    tool.role !== 'tool' || tool.content.length !== 1 ||
    !equalJson(tool.content[0], {
      kind: 'tool_result',
      callId: state.parentCallId,
      name: 'delegate_to_planner',
      text: expectedDelegationResult(),
      outcome: 'success',
    })
  ) return false;
  return final.role === 'assistant' && !Array.isArray(final.content) &&
    equalJson(final.content, { kind: 'text', text: EXPECTED_PARENT_FINAL });
};

const failureReport = (
  code: SentinelFailureCode,
  state: GuardState | undefined,
  outcome?: LoopOutcome,
  workspaceValidated = false,
): SentinelFailureReport => ({
  schemaVersion: 1,
  taskId: TASK_ID,
  profile: EXPECTED_PROFILE,
  ok: false,
  outcome: 'aborted',
  code,
  parentModelRequests: bounded(state?.parentModelRequests ?? 0, PARENT_MODEL_REQUESTS),
  childModelRequests: bounded(state?.childModelRequests ?? 0, CHILD_MODEL_REQUESTS),
  aggregateModelRequests: bounded(
    (state?.parentModelRequests ?? 0) + (state?.childModelRequests ?? 0),
    MAX_SENTINEL_REQUESTS,
  ),
  externalRequests: bounded(state?.requestCount ?? 0, MAX_SENTINEL_REQUESTS),
  delegationCalls: bounded(state?.delegationCalls ?? 0, 1),
  delegationResults: bounded(state?.delegationResults ?? 0, 1),
  requestOrder: (state?.requestOrder ?? []).slice(0, MAX_SENTINEL_REQUESTS),
  parentToolOrder: (state?.parentToolOrder ?? []).slice(0, 1),
  parentStopReason: outcome?.stopReason ?? null,
  plannerFinalValidated: state?.plannerFinalValidated ?? false,
  childCompletedBeforeParentFinal: state?.childCompletedBeforeParentFinal ?? false,
  plannerNonMutating: true,
  plannerNonRecursive: true,
  transcriptValidated: state?.transcriptValidated ?? false,
  workspaceValidated,
});

export interface SentinelRunDependencies {
  readonly fetcher?: typeof fetch;
  readonly credential?: string;
  readonly credentialSource?: () => string | undefined;
  readonly workspaceRoot?: string;
}

export interface SentinelRunResult {
  readonly report: SentinelReport;
  readonly externalRequests: number;
}

export const runSentinel = async (
  dependencies: SentinelRunDependencies = {},
): Promise<SentinelRunResult> => {
  let workspace: Workspace | undefined;
  let guarded: GuardedFetch | undefined;
  let outcome: LoopOutcome | undefined;
  try {
    workspace = await resolveWorkspace(dependencies.workspaceRoot);
    if (!(await validateEmptyWorkspace(workspace))) {
      const state = createGuardedFetch(workspace, dependencies.fetcher ?? fetch).state;
      state.failureCode = 'workspace_mismatch';
      return { report: failureReport('workspace_mismatch', state), externalRequests: 0 };
    }
    guarded = createGuardedFetch(workspace, dependencies.fetcher ?? fetch);
    const result = await runRuntime(
      FIXED_PARENT_TASK,
      {
        fetcher: guarded.fetch,
        credential: dependencies.credential,
        credentialSource: dependencies.credentialSource,
        workspaceRoot: workspace.root,
      },
      resolveBuiltinAgent('default'),
    );
    outcome = result.outcome;
    const state = guarded.state;
    state.transcriptValidated = outcome.ok && state.requestOrder.length === MAX_SENTINEL_REQUESTS &&
      state.requestOrder.every((item, index) => item === REQUEST_ORDER[index]) &&
      validateParentTranscript(outcome, state);
    if (
      outcome.ok && outcome.stopReason === 'final' && outcome.finalText === EXPECTED_PARENT_FINAL &&
      state.requestCount === MAX_SENTINEL_REQUESTS &&
      state.parentModelRequests === PARENT_MODEL_REQUESTS &&
      state.childModelRequests === CHILD_MODEL_REQUESTS && state.delegationCalls === 1 &&
      state.delegationResults === 1 && state.transcriptValidated && state.childCompleted &&
      state.plannerFinalValidated && state.parentFinal && state.childCompletedBeforeParentFinal
    ) {
      const workspaceValidated = await validateEmptyWorkspace(workspace);
      if (workspaceValidated) {
        const report: SentinelSuccessReport = {
          schemaVersion: 1,
          taskId: TASK_ID,
          profile: EXPECTED_PROFILE,
          ok: true,
          outcome: 'passed',
          parentModelRequests: 2,
          childModelRequests: 1,
          aggregateModelRequests: 3,
          externalRequests: 3,
          delegationCalls: 1,
          delegationResults: 1,
          requestOrder: [...REQUEST_ORDER],
          parentToolOrder: [...PARENT_TOOL_ORDER],
          parentStopReason: 'final',
          plannerFinalValidated: true,
          childCompletedBeforeParentFinal: true,
          plannerNonMutating: true,
          plannerNonRecursive: true,
          transcriptValidated: true,
          workspaceValidated: true,
        };
        return { report, externalRequests: state.requestCount };
      }
      state.failureCode = 'workspace_mismatch';
    }
    const code = state.failureCode ?? (
      outcome.stopReason === 'final' && outcome.finalText !== EXPECTED_PARENT_FINAL
        ? 'parent_final_mismatch'
        : 'model_adherence_failure'
    );
    return {
      report: failureReport(code, state, outcome, await validateEmptyWorkspace(workspace)),
      externalRequests: state.requestCount,
    };
  } catch (error) {
    const state = guarded?.state;
    const code = error instanceof SentinelContractError
      ? error.code
      : state?.failureCode ?? 'internal_failure';
    return {
      report: failureReport(
        code,
        state,
        outcome,
        workspace === undefined ? false : await validateEmptyWorkspace(workspace),
      ),
      externalRequests: state?.requestCount ?? 0,
    };
  }
};

const writeLine = async (
  stream: { write(bytes: Uint8Array): Promise<number> },
  report: SentinelReport,
) => {
  const bytes = encoder.encode(`${JSON.stringify(report)}\n`);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await stream.write(bytes.subarray(offset));
    if (!Number.isSafeInteger(written) || written <= 0) throw new Error('output failed');
    offset += written;
  }
};

export const main = async (args: readonly string[] = Deno.args): Promise<number> => {
  if (args.length !== 0) {
    const state = {
      workspace: { root: '' },
      requestOrder: [],
      parentToolOrder: [],
      requestCount: 0,
      parentModelRequests: 0,
      childModelRequests: 0,
      delegationCalls: 0,
      delegationResults: 0,
      childCompleted: false,
      parentFinal: false,
      childCompletedBeforeParentFinal: false,
      plannerFinalValidated: false,
      transcriptValidated: false,
    } as GuardState;
    await writeLine(Deno.stdout, failureReport('request_contract_failure', state));
    return 1;
  }
  const result = await runSentinel();
  await writeLine(Deno.stdout, result.report);
  return result.report.ok ? 0 : 1;
};

if (import.meta.main) Deno.exit(await main());
