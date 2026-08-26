import {
  LiveCorpusEvalError,
  type LiveCorpusEvalReport,
  type LiveCorpusSuite,
  type LiveRunnerFailureCode,
  runLiveCorpusEval,
  serializeLiveCorpusEvalReport,
} from './live_corpus_runner.ts';
import { CORPUS_PATH, loadTaskCorpus } from '../corpus/task_corpus.ts';

const encoder = new TextEncoder();

export type LiveCorpusCliWriter = (text: string) => void | PromiseLike<void>;

export type LiveCorpusByteWriter = (
  bytes: Uint8Array,
) => number | PromiseLike<number>;

/** Write every byte, including when a Deno.Writer accepts only a partial chunk. */
export const writeAllLiveCorpusBytes = async (
  writer: LiveCorpusByteWriter,
  bytes: Uint8Array,
): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await writer(bytes.subarray(offset));
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - offset) {
      throw new Error('writer returned an invalid byte count');
    }
    offset += written;
  }
};

export interface LiveCorpusCliDependencies {
  readonly run?: (suite: LiveCorpusSuite) => Promise<LiveCorpusEvalReport>;
  readonly writeStdout?: LiveCorpusCliWriter;
  readonly writeStderr?: LiveCorpusCliWriter;
}

const defaultStdout: LiveCorpusCliWriter = async (text) => {
  await writeAllLiveCorpusBytes((bytes) => Deno.stdout.write(bytes), encoder.encode(text));
};

const defaultStderr: LiveCorpusCliWriter = async (text) => {
  await writeAllLiveCorpusBytes((bytes) => Deno.stderr.write(bytes), encoder.encode(text));
};

const failureCodes: readonly LiveRunnerFailureCode[] = [
  'corpus_preflight_failed',
  'suite_contract_invalid',
  'dependency_construction_failed',
  'provider_invalid_input',
  'provider_missing_credential',
  'provider_transport_error',
  'provider_http_error',
  'provider_response_error',
  'provider_limit_exceeded',
  'external_request_ceiling',
  'case_execution_failed',
  'loop_contract_failure',
  'loop_max_steps',
  'loop_outcome_invalid',
  'transcript_malformed',
  'score_contract_invalid',
  'report_contract_invalid',
  'run_aborted',
];

const compactFailure = (code: LiveRunnerFailureCode): string =>
  `${JSON.stringify({ schemaVersion: 1, errorCode: code })}\n`;

const reportLine = async (
  report: LiveCorpusEvalReport,
): Promise<string> => {
  const corpus = await loadTaskCorpus(CORPUS_PATH, async (path) => await Deno.readTextFile(path));
  return serializeLiveCorpusEvalReport(report, corpus);
};

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: LiveCorpusCliDependencies = {},
): Promise<number> => {
  const stdout = dependencies.writeStdout ?? defaultStdout;
  const stderr = dependencies.writeStderr ?? defaultStderr;
  try {
    if (args.length !== 1 || (args[0] !== 'sentinel' && args[0] !== 'canonical')) {
      throw new LiveCorpusEvalError('report_contract_invalid');
    }
    const suite = args[0] as LiveCorpusSuite;
    const report = await (dependencies.run ?? runLiveCorpusEval)(suite);
    await stdout(await reportLine(report));
    return report.completion.status === 'completed' && report.counts.failed === 0 &&
        report.counts.errors === 0 && report.counts.notRun === 0
      ? 0
      : 1;
  } catch (error) {
    const code = error instanceof LiveCorpusEvalError && failureCodes.includes(error.code)
      ? error.code
      : 'report_contract_invalid';
    await stderr(compactFailure(code));
    return 1;
  }
};

if (import.meta.main) {
  Deno.exit(await main());
}
