import {
  CORPUS_PATH,
  type CorpusCaseScore,
  type CorpusObservation,
  type CorpusTask,
  type FixtureReader,
  loadTaskCorpus,
  scoreCorpusObservation,
  type ValidatedTaskCorpus,
} from '../corpus/task_corpus.ts';
import type { LoopOutcome, Model } from '../agent/core/contracts.ts';
import { runAgent } from '../agent/core/loop.ts';
import { createCorpusRegistry } from '../agent/tools/registries.ts';
import { Registry, type Registry as RegistryType } from '../agent/tools/tools.ts';
import { assertScriptedCorpusTaskSet, createScriptedCorpusModel } from './scripted_corpus_model.ts';
import {
  MAX_STEPS,
  type OfflineCorpusCaseResult,
  type OfflineCorpusCaseResultV2,
  type OfflineCorpusErrorResult,
  OfflineCorpusEvalError,
  type OfflineCorpusEvalReportV1,
  type OfflineCorpusEvalReportV2,
  type OfflineCorpusEvalTestSeam,
  type OfflineCorpusNotRunResult,
  type OfflineRunnerFailureCode,
  REPORT_ID,
  REPORT_ID_V1,
} from './offline_corpus_contract.ts';
import {
  countStatuses,
  validateOfflineCorpusEvalReportV1,
  validateScore,
} from './offline_corpus_report_v1.ts';
import {
  validateCorpusScoreV2,
  validateOfflineCorpusEvalReportV2,
} from './offline_corpus_report_v2.ts';
import { observationFromLoopOutcome, validateLoopOutcome } from './offline_corpus_transcript.ts';
import { fail, isRecord } from './offline_corpus_value.ts';

const defaultFixtureReader: FixtureReader = async (path) => await Deno.readTextFile(path);

const caseError = (
  taskId: string,
  errorCode: OfflineRunnerFailureCode,
): OfflineCorpusErrorResult => ({
  taskId,
  status: 'error',
  errorCode,
});

const notRun = (taskId: string): OfflineCorpusNotRunResult => ({
  taskId,
  status: 'not_run',
  errorCode: 'run_aborted',
});

const reportFor = (
  corpus: ValidatedTaskCorpus,
  results: readonly OfflineCorpusCaseResult[],
  abortCode: OfflineRunnerFailureCode | null,
  abortTaskId: string | null,
): OfflineCorpusEvalReportV1 => {
  const { passed, failed } = countStatuses(results);
  return {
    schemaVersion: 1,
    reportId: REPORT_ID_V1,
    mode: 'offline_scripted',
    corpus: { schemaVersion: corpus.schemaVersion, corpusId: corpus.corpusId },
    completion: {
      status: abortCode === null ? 'completed' : 'aborted',
      abortCode,
      abortTaskId,
    },
    counts: { total: 24, completed: passed + failed, passed, failed },
    results,
  };
};

export const runOfflineCorpusEvalV1 = async (
  seam: OfflineCorpusEvalTestSeam = {},
): Promise<OfflineCorpusEvalReportV1> => {
  let corpus: ValidatedTaskCorpus;
  try {
    corpus = await loadTaskCorpus(
      CORPUS_PATH,
      seam.fixtureReader ?? defaultFixtureReader,
    );
    assertScriptedCorpusTaskSet(corpus.tasks.map((task) => task.id));
  } catch {
    throw new OfflineCorpusEvalError('corpus_preflight_failed');
  }
  const results: OfflineCorpusCaseResult[] = [];
  let abortCode: OfflineRunnerFailureCode | null = null;
  let abortTaskId: string | null = null;
  const createDependencies = seam.createCaseDependencies ??
    ((task: CorpusTask) => ({
      model: createScriptedCorpusModel(task),
      registry: createCorpusRegistry(),
    }));
  const runLoop = seam.runLoop ?? runAgent;
  for (const [index, task] of corpus.tasks.entries()) {
    let dependencies: {
      readonly model: Model;
      readonly registry: RegistryType;
    };
    try {
      dependencies = createDependencies(task);
      if (
        !isRecord(dependencies) || typeof dependencies.model !== 'object' ||
        dependencies.model === null ||
        typeof (dependencies.model as { generate?: unknown }).generate !==
          'function' ||
        !(dependencies.registry instanceof Registry)
      ) fail('dependency_construction_failed');
    } catch {
      abortCode = 'dependency_construction_failed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
      break;
    }
    let outcome: LoopOutcome;
    try {
      outcome = await runLoop(
        task.prompt,
        dependencies.model,
        dependencies.registry,
        {
          maxSteps: MAX_STEPS,
        },
      );
    } catch {
      abortCode = 'case_execution_failed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
      break;
    }
    let checkedOutcome: LoopOutcome;
    try {
      checkedOutcome = validateLoopOutcome(task, outcome);
    } catch (error) {
      const code = error instanceof OfflineCorpusEvalError ? error.code : 'loop_outcome_invalid';
      abortCode = code === 'transcript_malformed' ? 'loop_outcome_invalid' : code;
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
      break;
    }
    if (!checkedOutcome.ok) {
      abortCode = checkedOutcome.outcome === 'max_steps'
        ? 'loop_max_steps'
        : 'loop_contract_failure';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
      break;
    }
    let observation: CorpusObservation;
    try {
      observation = observationFromLoopOutcome(task, checkedOutcome);
    } catch (error) {
      const code = error instanceof OfflineCorpusEvalError ? error.code : 'transcript_malformed';
      abortCode = code === 'loop_outcome_invalid' || code === 'transcript_malformed'
        ? code
        : 'transcript_malformed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
      break;
    }
    let score: CorpusCaseScore;
    try {
      score = scoreCorpusObservation(task, observation);
      validateScore(score, task.id);
    } catch {
      abortCode = 'score_contract_invalid';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
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
  const report = reportFor(corpus, results, abortCode, abortTaskId);
  try {
    return validateOfflineCorpusEvalReportV1(report, corpus);
  } catch {
    throw new OfflineCorpusEvalError('report_contract_invalid');
  }
};

const reportForV2 = (
  corpus: ValidatedTaskCorpus,
  results: readonly OfflineCorpusCaseResultV2[],
  abortCode: OfflineRunnerFailureCode | null,
  abortTaskId: string | null,
): OfflineCorpusEvalReportV2 => {
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  return {
    schemaVersion: 2,
    reportId: REPORT_ID,
    mode: 'offline_scripted',
    corpus: { schemaVersion: corpus.schemaVersion, corpusId: corpus.corpusId },
    completion: {
      status: abortCode === null ? 'completed' : 'aborted',
      abortCode,
      abortTaskId,
    },
    counts: { total: 24, completed: passed + failed, passed, failed },
    results,
  };
};

export const runOfflineCorpusEval = async (
  seam: OfflineCorpusEvalTestSeam = {},
): Promise<OfflineCorpusEvalReportV2> => {
  let corpus: ValidatedTaskCorpus;
  try {
    corpus = await loadTaskCorpus(
      CORPUS_PATH,
      seam.fixtureReader ?? defaultFixtureReader,
    );
    assertScriptedCorpusTaskSet(corpus.tasks.map((task) => task.id));
  } catch {
    throw new OfflineCorpusEvalError('corpus_preflight_failed');
  }
  const results: OfflineCorpusCaseResultV2[] = [];
  let abortCode: OfflineRunnerFailureCode | null = null;
  let abortTaskId: string | null = null;
  const createDependencies = seam.createCaseDependencies ??
    ((task: CorpusTask) => ({
      model: createScriptedCorpusModel(task),
      registry: createCorpusRegistry(),
    }));
  const runLoop = seam.runLoop ?? runAgent;
  for (const [index, task] of corpus.tasks.entries()) {
    let dependencies: {
      readonly model: Model;
      readonly registry: RegistryType;
    };
    try {
      dependencies = createDependencies(task);
      if (
        !isRecord(dependencies) || typeof dependencies.model !== 'object' ||
        dependencies.model === null ||
        typeof (dependencies.model as { generate?: unknown }).generate !==
          'function' ||
        !(dependencies.registry instanceof Registry)
      ) fail('dependency_construction_failed');
    } catch {
      abortCode = 'dependency_construction_failed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
      break;
    }
    let outcome: LoopOutcome;
    try {
      outcome = await runLoop(
        task.prompt,
        dependencies.model,
        dependencies.registry,
        {
          maxSteps: MAX_STEPS,
        },
      );
    } catch {
      abortCode = 'case_execution_failed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
      break;
    }
    let checkedOutcome: LoopOutcome;
    try {
      checkedOutcome = validateLoopOutcome(task, outcome);
    } catch {
      abortCode = 'loop_outcome_invalid';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
      break;
    }
    if (!checkedOutcome.ok) {
      abortCode = checkedOutcome.outcome === 'max_steps'
        ? 'loop_max_steps'
        : 'loop_contract_failure';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
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
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
      break;
    }
    let score: CorpusCaseScore;
    try {
      score = scoreCorpusObservation(task, observation);
      validateCorpusScoreV2(score, task.id);
    } catch {
      abortCode = 'score_contract_invalid';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) {
        results.push(notRun(later.id));
      }
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
  const report = reportForV2(corpus, results, abortCode, abortTaskId);
  try {
    return validateOfflineCorpusEvalReportV2(report, corpus);
  } catch {
    throw new OfflineCorpusEvalError('report_contract_invalid');
  }
};
