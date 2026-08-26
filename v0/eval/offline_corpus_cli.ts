import {
  OfflineCorpusEvalError,
  type OfflineCorpusEvalReport,
  type OfflineRunnerFailureCode,
  runOfflineCorpusEval,
  serializeOfflineCorpusEvalReport,
} from './offline_corpus_runner.ts';
import { CORPUS_PATH, loadTaskCorpus } from '../corpus/task_corpus.ts';

const encoder = new TextEncoder();

export type OfflineCorpusCliWriter = (text: string) => void | PromiseLike<void>;

export interface OfflineCorpusCliDependencies {
  readonly run?: () => Promise<OfflineCorpusEvalReport>;
  readonly writeStdout?: OfflineCorpusCliWriter;
  readonly writeStderr?: OfflineCorpusCliWriter;
}

const defaultStdout: OfflineCorpusCliWriter = async (text) => {
  await Deno.stdout.write(encoder.encode(text));
};

const defaultStderr: OfflineCorpusCliWriter = async (text) => {
  await Deno.stderr.write(encoder.encode(text));
};

const failureCodes: readonly OfflineRunnerFailureCode[] = [
  'corpus_preflight_failed',
  'dependency_construction_failed',
  'case_execution_failed',
  'loop_contract_failure',
  'loop_max_steps',
  'loop_outcome_invalid',
  'transcript_malformed',
  'score_contract_invalid',
  'report_contract_invalid',
  'run_aborted',
];

const compactFailure = (code: OfflineRunnerFailureCode): string =>
  `${JSON.stringify({ schemaVersion: 1, errorCode: code })}\n`;

const reportLine = async (report: OfflineCorpusEvalReport): Promise<string> => {
  const corpus = await loadTaskCorpus(CORPUS_PATH, async (path) => await Deno.readTextFile(path));
  return serializeOfflineCorpusEvalReport(report, corpus);
};

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: OfflineCorpusCliDependencies = {},
): Promise<number> => {
  const stdout = dependencies.writeStdout ?? defaultStdout;
  const stderr = dependencies.writeStderr ?? defaultStderr;
  try {
    if (args.length !== 0) throw new OfflineCorpusEvalError('report_contract_invalid');
    const report = await (dependencies.run ?? runOfflineCorpusEval)();
    await stdout(await reportLine(report));
    return report.completion.status === 'completed' && report.counts.failed === 0 ? 0 : 1;
  } catch (error) {
    const code = error instanceof OfflineCorpusEvalError && failureCodes.includes(error.code)
      ? error.code
      : 'report_contract_invalid';
    await stderr(compactFailure(code));
    return 1;
  }
};

if (import.meta.main) {
  Deno.exit(await main());
}
