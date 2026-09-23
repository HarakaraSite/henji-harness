import {
  CORPUS_PATH,
  type CorpusCaseScore,
  type CorpusObservation,
  type CorpusTask,
  loadTaskCorpus,
  scoreCorpusObservation,
  type ValidatedTaskCorpus,
} from '../corpus/task_corpus.ts';
import type { LoopOutcome, Model } from '../agent/core/contracts.ts';
import { OpenRouterAgentError, OpenRouterAgentModel } from '../agent/provider/openrouter_model.ts';
import { runAgent } from '../agent/core/loop.ts';
import { createCorpusRegistry } from '../agent/tools/registries.ts';
import { Registry, type Registry as RegistryType } from '../agent/tools/tools.ts';
import { PRODUCTION_PROFILE } from '../agent/provider/provider_profile.ts';
import {
  observationFromLoopOutcome,
  OfflineCorpusEvalError,
  validateCorpusScoreV2,
} from './offline_corpus_runner.ts';
import {
  type LiveCorpusCaseResult,
  type LiveCorpusCaseResultV2,
  type LiveCorpusErrorResult,
  LiveCorpusEvalError,
  type LiveCorpusEvalReportV1,
  type LiveCorpusEvalReportV2,
  type LiveCorpusEvalTestSeam,
  type LiveCorpusNotRunResult,
  type LiveCorpusSuite,
  type LiveRunnerFailureCode,
  REPORT_ID,
  REPORT_ID_V1,
} from './live_corpus_contract.ts';
import {
  fail,
  isRecord,
  suiteReportName,
  suiteRequestCeiling,
  suiteTasks,
} from './live_corpus_value.ts';
import {
  reportStatusCounts,
  validateLiveCorpusEvalReportV1,
  validateLoopOutcome,
  validateScore,
} from './live_corpus_report_v1.ts';
import { validateLiveCorpusEvalReportV2 } from './live_corpus_report_v2.ts';

interface FetchState {
  externalRequests: number;
  ceilingExceeded: boolean;
}

const makeBoundedFetcher = (
  delegate: typeof fetch,
  ceiling: number,
  state: FetchState,
): typeof fetch =>
(input, init) => {
  if (state.externalRequests >= ceiling) {
    state.ceilingExceeded = true;
    throw new Error('external request ceiling reached');
  }
  state.externalRequests += 1;
  return delegate(input, init);
};

const providerFailureCode = (
  error: OpenRouterAgentError,
  ceilingExceeded: boolean,
): LiveRunnerFailureCode => {
  if (ceilingExceeded) return 'external_request_ceiling';
  switch (error.code) {
    case 'invalid_input':
      return 'provider_invalid_input';
    case 'missing_credential':
      return 'provider_missing_credential';
    case 'provider_timeout':
      return 'provider_transport_error';
    case 'transport_error':
      return 'provider_transport_error';
    case 'http_error':
      return 'provider_http_error';
    case 'response_error':
      return 'provider_response_error';
    case 'limit_exceeded':
      return 'provider_limit_exceeded';
  }
};

const isModel = (value: unknown): value is Model =>
  isRecord(value) && typeof value.generate === 'function';

const caseError = (
  taskId: string,
  errorCode: LiveRunnerFailureCode,
  externalRequests: number,
): LiveCorpusErrorResult => ({ taskId, status: 'error', errorCode, externalRequests });

const notRun = (taskId: string): LiveCorpusNotRunResult => ({
  taskId,
  status: 'not_run',
  errorCode: 'run_aborted',
});

const reportFor = (
  corpus: ValidatedTaskCorpus,
  suite: LiveCorpusSuite,
  state: FetchState,
  results: readonly LiveCorpusCaseResult[],
  abortCode: LiveRunnerFailureCode | null,
  abortTaskId: string | null,
): LiveCorpusEvalReportV1 => {
  const counts = reportStatusCounts(results);
  return {
    schemaVersion: 1,
    reportId: REPORT_ID_V1,
    mode: 'live_openrouter',
    suite: suiteReportName(suite),
    profile: { id: PRODUCTION_PROFILE.id, model: PRODUCTION_PROFILE.model },
    corpus: { schemaVersion: corpus.schemaVersion, corpusId: corpus.corpusId },
    requestCeiling: suiteRequestCeiling(suite),
    externalRequests: state.externalRequests,
    completion: {
      status: abortCode === null ? 'completed' : 'aborted',
      abortCode,
      abortTaskId,
    },
    counts: {
      total: suite === 'sentinel' ? 6 : 24,
      completed: counts.passed + counts.failed,
      passed: counts.passed,
      failed: counts.failed,
      errors: counts.errors,
      notRun: counts.notRun,
    },
    results,
  };
};

export const runLiveCorpusEvalV1 = async (
  suite: LiveCorpusSuite,
  seam: LiveCorpusEvalTestSeam = {},
): Promise<LiveCorpusEvalReportV1> => {
  if (suite !== 'sentinel' && suite !== 'canonical') fail('suite_contract_invalid');
  let corpus: ValidatedTaskCorpus;
  try {
    corpus = await loadTaskCorpus(
      CORPUS_PATH,
      seam.fixtureReader ?? (async (path) => {
        return await Deno.readTextFile(path);
      }),
    );
  } catch {
    throw new LiveCorpusEvalError('corpus_preflight_failed');
  }
  let tasks: readonly CorpusTask[];
  try {
    tasks = suiteTasks(corpus, suite);
  } catch {
    throw new LiveCorpusEvalError('suite_contract_invalid');
  }

  const state: FetchState = { externalRequests: 0, ceilingExceeded: false };
  const boundedFetcher = makeBoundedFetcher(
    seam.fetcher ?? fetch,
    suiteRequestCeiling(suite),
    state,
  );
  const results: LiveCorpusCaseResult[] = [];
  let abortCode: LiveRunnerFailureCode | null = null;
  let abortTaskId: string | null = null;
  const createRegistry = seam.createRegistry ?? (() => createCorpusRegistry());
  const createModel = seam.createModel ?? ((options) => new OpenRouterAgentModel(options));
  const runLoop = seam.runLoop ?? runAgent;
  const scoreObservation = seam.scoreObservation ?? scoreCorpusObservation;

  for (const [index, task] of tasks.entries()) {
    const caseStart = state.externalRequests;
    let registry: RegistryType;
    let baseModel: Model;
    try {
      registry = createRegistry();
      if (!(registry instanceof Registry)) fail('dependency_construction_failed');
      baseModel = createModel({
        fetcher: boundedFetcher,
        credential: seam.credential,
        credentialSource: seam.credentialSource,
      });
      if (!isModel(baseModel)) fail('dependency_construction_failed');
    } catch {
      abortCode = 'dependency_construction_failed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }

    let providerError: OpenRouterAgentError | undefined;
    const trackedModel: Model = {
      generate: async (request) => {
        try {
          return await baseModel.generate(request);
        } catch (error) {
          if (error instanceof OpenRouterAgentError) providerError = error;
          throw error;
        }
      },
    };
    let outcome: LoopOutcome;
    try {
      outcome = await runLoop(task.prompt, trackedModel, registry, { maxSteps: task.maxRequests });
    } catch (error) {
      if (error instanceof OpenRouterAgentError) providerError = error;
      const code = providerError
        ? providerFailureCode(providerError, state.ceilingExceeded)
        : 'case_execution_failed';
      abortCode = code;
      abortTaskId = task.id;
      results.push(caseError(task.id, code, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    if (providerError) {
      const code = providerFailureCode(providerError, state.ceilingExceeded);
      abortCode = code;
      abortTaskId = task.id;
      results.push(caseError(task.id, code, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }

    let checkedOutcome: LoopOutcome;
    try {
      checkedOutcome = validateLoopOutcome(task, outcome);
    } catch (error) {
      const code = error instanceof LiveCorpusEvalError ? error.code : 'loop_outcome_invalid';
      abortCode = code === 'transcript_malformed' ? 'loop_outcome_invalid' : code;
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    if (!checkedOutcome.ok) {
      abortCode = checkedOutcome.outcome === 'max_steps'
        ? 'loop_max_steps'
        : 'loop_contract_failure';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }

    let observation: CorpusObservation;
    try {
      observation = observationFromLoopOutcome(task, checkedOutcome);
    } catch (error) {
      const observedCode = error instanceof OfflineCorpusEvalError
        ? error.code
        : 'transcript_malformed';
      const code: LiveRunnerFailureCode = observedCode === 'loop_outcome_invalid'
        ? 'loop_outcome_invalid'
        : 'transcript_malformed';
      abortCode = code;
      abortTaskId = task.id;
      results.push(caseError(task.id, code, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let score: CorpusCaseScore;
    try {
      score = scoreObservation(task, observation);
      validateScore(score, task.id);
    } catch {
      abortCode = 'score_contract_invalid';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    results.push({
      taskId: task.id,
      status: score.passed ? 'passed' : 'failed',
      finalText: observation.finalText,
      requestCount: observation.requestCount,
      toolEvents: observation.toolEvents,
      score,
    });
  }
  const report = reportFor(corpus, suite, state, results, abortCode, abortTaskId);
  try {
    return validateLiveCorpusEvalReportV1(report, corpus);
  } catch {
    throw new LiveCorpusEvalError('report_contract_invalid');
  }
};

const reportForV2 = (
  corpus: ValidatedTaskCorpus,
  suite: LiveCorpusSuite,
  state: FetchState,
  results: readonly LiveCorpusCaseResultV2[],
  abortCode: LiveRunnerFailureCode | null,
  abortTaskId: string | null,
): LiveCorpusEvalReportV2 => {
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const errors = results.filter((result) => result.status === 'error').length;
  const notRun = results.filter((result) => result.status === 'not_run').length;
  return {
    schemaVersion: 2,
    reportId: REPORT_ID,
    mode: 'live_openrouter',
    suite: suiteReportName(suite),
    profile: { id: PRODUCTION_PROFILE.id, model: PRODUCTION_PROFILE.model },
    corpus: { schemaVersion: corpus.schemaVersion, corpusId: corpus.corpusId },
    requestCeiling: suiteRequestCeiling(suite),
    externalRequests: state.externalRequests,
    completion: { status: abortCode === null ? 'completed' : 'aborted', abortCode, abortTaskId },
    counts: {
      total: suite === 'sentinel' ? 6 : 24,
      completed: passed + failed,
      passed,
      failed,
      errors,
      notRun,
    },
    results,
  };
};

export const runLiveCorpusEval = async (
  suite: LiveCorpusSuite,
  seam: LiveCorpusEvalTestSeam = {},
): Promise<LiveCorpusEvalReportV2> => {
  if (suite !== 'sentinel' && suite !== 'canonical') fail('suite_contract_invalid');
  let corpus: ValidatedTaskCorpus;
  try {
    corpus = await loadTaskCorpus(
      CORPUS_PATH,
      seam.fixtureReader ?? (async (path) => await Deno.readTextFile(path)),
    );
  } catch {
    throw new LiveCorpusEvalError('corpus_preflight_failed');
  }
  let tasks: readonly CorpusTask[];
  try {
    tasks = suiteTasks(corpus, suite);
  } catch {
    throw new LiveCorpusEvalError('suite_contract_invalid');
  }
  const state: FetchState = { externalRequests: 0, ceilingExceeded: false };
  const boundedFetcher = makeBoundedFetcher(
    seam.fetcher ?? fetch,
    suiteRequestCeiling(suite),
    state,
  );
  const results: LiveCorpusCaseResultV2[] = [];
  let abortCode: LiveRunnerFailureCode | null = null;
  let abortTaskId: string | null = null;
  const createRegistry = seam.createRegistry ?? (() => createCorpusRegistry());
  const createModel = seam.createModel ?? ((options) => new OpenRouterAgentModel(options));
  const runLoop = seam.runLoop ?? runAgent;
  const scoreObservation = seam.scoreObservation ?? scoreCorpusObservation;
  for (const [index, task] of tasks.entries()) {
    const caseStart = state.externalRequests;
    let fetchesThisGenerate = 0;
    let retryBlocked = false;
    let lastHttpFailure: number | undefined;
    const caseFetcher: typeof fetch = (input, init) => {
      if (fetchesThisGenerate >= 1) {
        retryBlocked = true;
        throw new Error('additional fetch within one model request');
      }
      fetchesThisGenerate += 1;
      return boundedFetcher(input, init).then((response) => {
        if (response.status >= 500 && response.status <= 599) {
          lastHttpFailure = response.status;
        }
        return response;
      });
    };
    const caseProviderFailureCode = (error: OpenRouterAgentError): LiveRunnerFailureCode =>
      retryBlocked && lastHttpFailure !== undefined
        ? 'provider_http_error'
        : providerFailureCode(error, state.ceilingExceeded);
    let registry: RegistryType;
    let baseModel: Model;
    try {
      registry = createRegistry();
      if (!(registry instanceof Registry)) fail('dependency_construction_failed');
      baseModel = createModel({
        fetcher: caseFetcher,
        credential: seam.credential,
        credentialSource: seam.credentialSource,
      });
      if (!isModel(baseModel)) fail('dependency_construction_failed');
    } catch {
      abortCode = 'dependency_construction_failed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let providerError: OpenRouterAgentError | undefined;
    const trackedModel: Model = {
      generate: async (request) => {
        fetchesThisGenerate = 0;
        retryBlocked = false;
        lastHttpFailure = undefined;
        try {
          return await baseModel.generate(request);
        } catch (error) {
          if (error instanceof OpenRouterAgentError) providerError = error;
          throw error;
        }
      },
    };
    let outcome: LoopOutcome;
    try {
      outcome = await runLoop(task.prompt, trackedModel, registry, { maxSteps: task.maxRequests });
    } catch (error) {
      if (error instanceof OpenRouterAgentError) providerError = error;
      const code = providerError ? caseProviderFailureCode(providerError) : 'case_execution_failed';
      abortCode = code;
      abortTaskId = task.id;
      results.push(caseError(task.id, code, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    if (providerError) {
      const code = caseProviderFailureCode(providerError);
      abortCode = code;
      abortTaskId = task.id;
      results.push(caseError(task.id, code, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let checkedOutcome: LoopOutcome;
    try {
      checkedOutcome = validateLoopOutcome(task, outcome);
    } catch {
      abortCode = 'loop_outcome_invalid';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    if (!checkedOutcome.ok) {
      abortCode = checkedOutcome.outcome === 'max_steps'
        ? 'loop_max_steps'
        : 'loop_contract_failure';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let observation: CorpusObservation;
    try {
      observation = observationFromLoopOutcome(task, checkedOutcome);
    } catch (error) {
      const observedCode = error instanceof OfflineCorpusEvalError
        ? error.code
        : 'transcript_malformed';
      abortCode = observedCode === 'loop_outcome_invalid'
        ? 'loop_outcome_invalid'
        : 'transcript_malformed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let score: CorpusCaseScore;
    try {
      score = scoreObservation(task, observation);
      validateCorpusScoreV2(score, task.id);
    } catch {
      abortCode = 'score_contract_invalid';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    results.push({
      taskId: task.id,
      status: score.passed ? 'passed' : 'failed',
      finalText: observation.finalText,
      requestCount: observation.requestCount,
      toolEvents: observation.toolEvents,
      submission: observation.submission,
      score,
    });
  }
  const report = reportForV2(corpus, suite, state, results, abortCode, abortTaskId);
  try {
    return validateLiveCorpusEvalReportV2(report, corpus);
  } catch {
    throw new LiveCorpusEvalError('report_contract_invalid');
  }
};
