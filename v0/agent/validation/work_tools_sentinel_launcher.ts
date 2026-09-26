import {
  type CredentialFileSystem,
  CredentialLauncherError,
  readCredential,
} from '../../eval/live_corpus_credential_launcher.ts';
import {
  EXPECTED_PROFILE,
  EXPECTED_RESULT,
  MAX_SENTINEL_REQUESTS,
  type SentinelFailureReport,
  type SentinelReport,
  type SentinelSuccessReport,
  TASK_ID,
  TOOL_ORDER,
} from './work_tools_sentinel.ts';

export const DENO_COMMAND = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno' as const;
export const CHILD_ENTRYPOINT =
  '/home/masat.guest/src/henji-harness/v0/agent/validation/work_tools_sentinel.ts' as const;
export const SECRET_ENV = 'HENJI_OPENROUTER_API_KEY' as const;
export const WORKSPACE_PARENT = '/tmp' as const;
export const WORKSPACE_PREFIX = 'henji-work-tools-sentinel-' as const;
export const CHILD_DEADLINE_MS = 180_000 as const;
export const CHILD_GRACE_MS = 250 as const;
export const CHILD_CHANNEL_LIMIT = 8 * 1024;
export type SentinelHandledSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';

export type LauncherFailureStage =
  | 'preflight'
  | 'credential'
  | 'workspace'
  | 'process'
  | 'bounds'
  | 'evidence'
  | 'execution'
  | 'terminal'
  | 'cleanup'
  | 'internal';

export type LauncherFailureCode =
  | 'arguments_invalid'
  | 'credential_metadata_invalid'
  | 'credential_metadata_changed'
  | 'credential_open_failed'
  | 'credential_read_failed'
  | 'credential_oversize'
  | 'credential_invalid'
  | 'workspace_create_failed'
  | 'workspace_invalid'
  | 'child_spawn_failed'
  | 'child_wait_failed'
  | 'child_exit_failed'
  | 'child_signal'
  | 'deadline_exceeded'
  | 'stdout_overflow'
  | 'stderr_overflow'
  | 'child_report_invalid'
  | 'provider_failure'
  | 'model_adherence_failure'
  | 'tool_execution_failure'
  | 'terminal_result_mismatch'
  | 'workspace_mismatch'
  | 'cleanup_failed'
  | 'internal_failure';

export interface LauncherSuccess {
  readonly schemaVersion: 1;
  readonly taskId: typeof TASK_ID;
  readonly profile: typeof EXPECTED_PROFILE;
  readonly ok: true;
  readonly outcome: 'passed';
  readonly modelRequests: 5;
  readonly externalRequests: 5;
  readonly toolCalls: 5;
  readonly toolResults: 5;
  readonly toolOrder: readonly string[];
  readonly stopReason: 'tool_terminal';
  readonly result: typeof EXPECTED_RESULT;
  readonly workspaceVerified: true;
  readonly workspaceRemoved: true;
  readonly retryCount: 0;
}

export interface LauncherFailure {
  readonly schemaVersion: 1;
  readonly taskId: typeof TASK_ID;
  readonly profile: typeof EXPECTED_PROFILE;
  readonly ok: false;
  readonly outcome: 'aborted';
  readonly stage: LauncherFailureStage;
  readonly code: LauncherFailureCode;
  readonly childCount: 0 | 1;
  readonly externalRequests: number | null;
  readonly externalRequestCeiling: typeof MAX_SENTINEL_REQUESTS;
  readonly retryCount: 0;
  readonly workspaceRemoved: boolean | null;
}

export type LauncherReport = LauncherSuccess | LauncherFailure;

export class LauncherError extends Error {
  readonly stage: LauncherFailureStage;
  readonly code: LauncherFailureCode;

  constructor(stage: LauncherFailureStage, code: LauncherFailureCode) {
    super('fixed local-work sentinel launcher failed');
    this.name = 'LauncherError';
    this.stage = stage;
    this.code = code;
  }
}

export interface SentinelChildStatus {
  readonly success: boolean;
  readonly code: number | null;
  readonly signal: string | null;
}

export interface SentinelChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<SentinelChildStatus>;
  readonly kill: (signal?: Deno.Signal) => void;
}

export interface SentinelCommandOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly clearEnv: true;
  readonly env: Readonly<Record<typeof SECRET_ENV, string>>;
  readonly stdin: 'null';
  readonly stdout: 'piped';
  readonly stderr: 'piped';
}

export interface LauncherDependencies {
  readonly filesystem?: CredentialFileSystem;
  readonly makeWorkspace?: () => Promise<string>;
  readonly realPath?: (path: string) => Promise<string>;
  readonly validateWorkspace?: (path: string) => Promise<boolean>;
  readonly removeWorkspace?: (path: string) => Promise<void>;
  readonly spawn?: (command: typeof DENO_COMMAND, options: SentinelCommandOptions) => SentinelChild;
  /** Test-only lifecycle seams; production always uses the fixed bounds below. */
  readonly childDeadlineMs?: number;
  readonly childGraceMs?: number;
  readonly addSignalListener?: (
    signal: SentinelHandledSignal,
    handler: () => void,
  ) => () => void;
  readonly writeStdout?: (text: string) => void | PromiseLike<void>;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const validCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

const validToolOrder = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length <= TOOL_ORDER.length &&
  value.every((item, index) => item === TOOL_ORDER[index]);

const equalResult = (value: unknown): value is typeof EXPECTED_RESULT =>
  isObject(value) && exactKeys(value, ['path', 'content', 'bytes', 'bash']) &&
  value.path === EXPECTED_RESULT.path && value.content === EXPECTED_RESULT.content &&
  value.bytes === EXPECTED_RESULT.bytes && value.bash === EXPECTED_RESULT.bash;

/** Strictly validate the only report shape accepted from the child. */
export const parseChildReport = (text: string): SentinelReport | undefined => {
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    return undefined;
  }
  if (
    !isObject(value) || value.schemaVersion !== 1 || value.taskId !== TASK_ID ||
    value.profile !== EXPECTED_PROFILE || typeof value.ok !== 'boolean' ||
    (value.outcome !== 'passed' && value.outcome !== 'aborted') ||
    !validCount(value.modelRequests, MAX_SENTINEL_REQUESTS) ||
    !validCount(value.externalRequests, MAX_SENTINEL_REQUESTS) ||
    !validCount(value.steps, 8) || !validCount(value.toolCalls, MAX_SENTINEL_REQUESTS) ||
    !validCount(value.toolResults, MAX_SENTINEL_REQUESTS) || !validToolOrder(value.toolOrder) ||
    (value.stopReason !== 'final' && value.stopReason !== 'tool_terminal' &&
      value.stopReason !== 'max_steps' && value.stopReason !== 'contract_failure' &&
      value.stopReason !== null) ||
    (value.terminalKind !== 'json_result' && value.terminalKind !== null) ||
    typeof value.transcriptValidated !== 'boolean' || typeof value.workspaceValidated !== 'boolean'
  ) return undefined;
  if (value.ok && value.outcome === 'passed') {
    if (
      !exactKeys(value, [
        'schemaVersion',
        'taskId',
        'profile',
        'ok',
        'outcome',
        'modelRequests',
        'externalRequests',
        'steps',
        'toolCalls',
        'toolResults',
        'toolOrder',
        'stopReason',
        'terminalKind',
        'transcriptValidated',
        'workspaceValidated',
        'result',
      ]) || value.modelRequests !== 5 || value.externalRequests !== 5 || value.steps !== 5 ||
      value.toolCalls !== 5 || value.toolResults !== 5 || value.stopReason !== 'tool_terminal' ||
      value.terminalKind !== 'json_result' || value.transcriptValidated !== true ||
      value.workspaceValidated !== true || !validToolOrder(value.toolOrder) ||
      value.toolOrder.length !== TOOL_ORDER.length || !equalResult(value.result)
    ) return undefined;
    return value as unknown as SentinelSuccessReport;
  }
  if (
    value.ok || value.outcome !== 'aborted' ||
    !exactKeys(value, [
      'schemaVersion',
      'taskId',
      'profile',
      'ok',
      'outcome',
      'code',
      'modelRequests',
      'externalRequests',
      'steps',
      'toolCalls',
      'toolResults',
      'toolOrder',
      'stopReason',
      'terminalKind',
      'transcriptValidated',
      'workspaceValidated',
    ]) || typeof value.code !== 'string' ||
    ![
      'provider_failure',
      'model_adherence_failure',
      'tool_execution_failure',
      'terminal_result_mismatch',
      'workspace_mismatch',
      'internal_failure',
    ].includes(value.code) || value.transcriptValidated !== false ||
    value.workspaceValidated !== false
  ) return undefined;
  return value as unknown as SentinelFailureReport;
};

const defaultMakeWorkspace = async (): Promise<string> => {
  const created = await Deno.makeTempDir({ dir: WORKSPACE_PARENT, prefix: WORKSPACE_PREFIX });
  await Deno.chmod(created, 0o700);
  const canonical = await Deno.realPath(created);
  if (!(await validateFreshWorkspace(canonical))) {
    throw new LauncherError('workspace', 'workspace_invalid');
  }
  return canonical;
};

const validateFreshWorkspace = async (path: string): Promise<boolean> => {
  try {
    const info = await Deno.lstat(path);
    if (
      !info.isDirectory || info.isSymlink || info.mode === null ||
      (info.mode & 0o7777) !== 0o700
    ) return false;
    for await (const _entry of Deno.readDir(path)) return false;
    return true;
  } catch {
    return false;
  }
};

const defaultRemoveWorkspace = async (path: string): Promise<void> => {
  await Deno.remove(path, { recursive: true });
};

const defaultValidateWorkspace = async (path: string): Promise<boolean> => {
  try {
    const root = await Deno.lstat(path);
    if (!root.isDirectory || root.isSymlink) return false;
    const rootEntries: string[] = [];
    for await (const entry of Deno.readDir(path)) rootEntries.push(entry.name);
    if (rootEntries.length !== 1 || rootEntries[0] !== 'work') return false;
    const work = await Deno.lstat(`${path}/work`);
    if (!work.isDirectory || work.isSymlink) return false;
    const workEntries: string[] = [];
    for await (const entry of Deno.readDir(`${path}/work`)) workEntries.push(entry.name);
    if (workEntries.length !== 1 || workEntries[0] !== 'item.txt') return false;
    const item = await Deno.lstat(`${path}/work/item.txt`);
    if (!item.isFile || item.isSymlink) return false;
    const actual = await Deno.readFile(`${path}/work/item.txt`);
    const expected = encoder.encode(EXPECTED_RESULT.content);
    return actual.byteLength === expected.byteLength &&
      actual.every((byte, index) => byte === expected[index]);
  } catch {
    return false;
  }
};

const defaultRealPath = (path: string): Promise<string> => Deno.realPath(path);

const defaultSpawn = (
  command: typeof DENO_COMMAND,
  options: SentinelCommandOptions,
): SentinelChild => {
  const child = new Deno.Command(command, {
    args: [...options.args],
    cwd: options.cwd,
    clearEnv: true,
    env: { ...options.env },
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  }).spawn();
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    status: child.status.then((status) => ({
      success: status.success,
      code: status.code,
      signal: status.signal,
    })),
    kill: (signal = 'SIGTERM') => child.kill(signal),
  };
};

const childOptions = (workspace: string, credential: string): SentinelCommandOptions => ({
  args: [
    'run',
    '--no-prompt',
    '--no-remote',
    '--allow-env=HENJI_OPENROUTER_API_KEY,NODE_V8_COVERAGE',
    '--allow-net=openrouter.ai',
    `--allow-read=${workspace}`,
    `--allow-write=${workspace}`,
    '--allow-run=/bin/bash',
    CHILD_ENTRYPOINT,
  ],
  cwd: workspace,
  clearEnv: true,
  env: { [SECRET_ENV]: credential },
  stdin: 'null',
  stdout: 'piped',
  stderr: 'piped',
});

interface Captured {
  readonly text: string;
  readonly overflow: boolean;
}

const capture = async (
  stream: ReadableStream<Uint8Array>,
  onOverflow: () => void,
): Promise<Captured> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (total + item.value.byteLength > CHILD_CHANNEL_LIMIT) {
        overflow = true;
        onOverflow();
        try {
          await reader.cancel();
        } catch { /* best effort */ }
        break;
      }
      chunks.push(item.value);
      total += item.value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* best effort */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: decoder.decode(bytes), overflow };
  } catch {
    return { text: '', overflow: true };
  }
};

const terminateAndReap = async (
  child: SentinelChild,
  statusPromise: Promise<SentinelChildStatus>,
  graceMs: number,
): Promise<SentinelChildStatus | undefined> => {
  try {
    child.kill('SIGTERM');
  } catch { /* child may already be gone */ }
  const grace = await Promise.race([
    statusPromise.then((status) => ({ status }), () => ({ status: undefined })),
    new Promise<{ status?: undefined }>((resolve) => setTimeout(() => resolve({}), graceMs)),
  ]);
  if (grace.status !== undefined) return grace.status;
  try {
    child.kill('SIGKILL');
  } catch { /* child may already be gone */ }
  try {
    return await statusPromise;
  } catch {
    return undefined;
  }
};

interface ChildRun {
  readonly status?: SentinelChildStatus;
  readonly stdout: Captured;
  readonly stderr: Captured;
  readonly failure?: LauncherFailureCode;
}

const runChild = async (
  child: SentinelChild,
  deadlineMs: number,
  graceMs: number,
  signalPromise: Promise<void>,
): Promise<ChildRun> => {
  let overflowCode: 'stdout_overflow' | 'stderr_overflow' | undefined;
  let terminatePromise: Promise<SentinelChildStatus | undefined> | undefined;
  let signalOverflow!: (code: 'stdout_overflow' | 'stderr_overflow') => void;
  const overflowSignal = new Promise<'stdout_overflow' | 'stderr_overflow'>((resolve) => {
    signalOverflow = resolve;
  });
  const requestTermination = (code: 'stdout_overflow' | 'stderr_overflow'): void => {
    if (overflowCode === undefined) overflowCode = code;
    signalOverflow(code);
    if (terminatePromise === undefined) {
      terminatePromise = terminateAndReap(child, statusPromise, graceMs);
    }
  };
  const statusPromise = child.status;
  const stdoutPromise = capture(child.stdout, () => requestTermination('stdout_overflow'));
  const stderrPromise = capture(child.stderr, () => requestTermination('stderr_overflow'));
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline = false;
  const deadlinePromise = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      deadline = true;
      if (terminatePromise === undefined) {
        terminatePromise = terminateAndReap(child, statusPromise, graceMs);
      }
      resolve();
    }, deadlineMs);
  });
  const first = await Promise.race([
    statusPromise.then(() => 'status' as const, () => 'status_error' as const),
    deadlinePromise.then(() => 'deadline' as const),
    overflowSignal.then(() => 'overflow' as const),
    signalPromise.then(() => 'signal' as const),
  ]);
  if (first !== 'status' && terminatePromise === undefined) {
    terminatePromise = terminateAndReap(child, statusPromise, graceMs);
  }
  let status: SentinelChildStatus | undefined;
  try {
    status = await statusPromise;
  } catch {
    status = undefined;
  }
  if (terminatePromise !== undefined) status = await terminatePromise;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  if (deadline) return { status, stdout, stderr, failure: 'deadline_exceeded' };
  if (overflowCode !== undefined) return { status, stdout, stderr, failure: overflowCode };
  if (status === undefined) return { stdout, stderr, failure: 'child_wait_failed' };
  return { status, stdout, stderr };
};

interface ByteWriter {
  write(bytes: Uint8Array): Promise<number>;
}

const defaultWrite = async (stream: ByteWriter, text: string): Promise<void> => {
  const bytes = encoder.encode(text);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await stream.write(bytes.subarray(offset));
    if (!Number.isSafeInteger(written) || written <= 0) return;
    offset += written;
  }
};

const writeFailure = async (
  report: LauncherFailure,
  writer: (text: string) => void | PromiseLike<void>,
): Promise<void> => {
  try {
    await writer(`${JSON.stringify(report)}\n`);
  } catch { /* sanitized failure remains best effort */ }
};

const writeSuccess = async (
  report: LauncherSuccess,
  writer: (text: string) => void | PromiseLike<void>,
): Promise<void> => {
  await writer(`${JSON.stringify(report)}\n`);
};

const stageForChildCode = (code: string): LauncherFailureStage => {
  if (code === 'provider_failure') return 'execution';
  if (code === 'model_adherence_failure') return 'execution';
  if (code === 'tool_execution_failure') return 'execution';
  if (code === 'terminal_result_mismatch') return 'terminal';
  if (code === 'workspace_mismatch') return 'terminal';
  return 'evidence';
};

const failureReport = (
  stage: LauncherFailureStage,
  code: LauncherFailureCode,
  childCount: 0 | 1,
  externalRequests: number | null,
  workspaceRemoved: boolean | null,
): LauncherFailure => ({
  schemaVersion: 1,
  taskId: TASK_ID,
  profile: EXPECTED_PROFILE,
  ok: false,
  outcome: 'aborted',
  stage,
  code,
  childCount,
  externalRequests,
  externalRequestCeiling: MAX_SENTINEL_REQUESTS,
  retryCount: 0,
  workspaceRemoved,
});

const productionSignals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;

const removeSignalHandlers = (handlers: readonly (() => void)[]): void => {
  for (const remove of handlers) {
    try {
      remove();
    } catch { /* best effort */ }
  }
};

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: LauncherDependencies = {},
): Promise<number> => {
  let workspace: string | undefined;
  let childCount: 0 | 1 = 0;
  let externalRequests: number | null = 0;
  let workspaceRemoved: boolean | null = null;
  let signalHandlers: (() => void)[] = [];
  let handledSignal = false;
  let resolveHandledSignal!: () => void;
  const signalPromise = new Promise<void>((resolve) => resolveHandledSignal = resolve);
  let result: LauncherReport | undefined;
  try {
    if (args.length !== 0) throw new LauncherError('preflight', 'arguments_invalid');
    let credential: string;
    try {
      credential = await readCredential(dependencies.filesystem);
    } catch (error) {
      if (error instanceof CredentialLauncherError && error.code.startsWith('credential_')) {
        throw new LauncherError(
          'credential',
          error.code as Extract<LauncherFailureCode, `credential_${string}`>,
        );
      }
      throw error;
    }
    const makeWorkspace = dependencies.makeWorkspace ?? defaultMakeWorkspace;
    try {
      workspace = await makeWorkspace();
      const realPath = dependencies.realPath ?? defaultRealPath;
      const canonical = await realPath(workspace);
      if (canonical !== workspace) throw new LauncherError('workspace', 'workspace_invalid');
      if (!(await validateFreshWorkspace(canonical))) {
        throw new LauncherError('workspace', 'workspace_invalid');
      }
      workspace = canonical;
    } catch (error) {
      if (error instanceof LauncherError) throw error;
      throw new LauncherError('workspace', 'workspace_create_failed');
    }
    const spawn = dependencies.spawn ?? defaultSpawn;
    let child: SentinelChild;
    try {
      child = spawn(DENO_COMMAND, childOptions(workspace, credential));
      childCount = 1;
    } catch {
      throw new LauncherError('process', 'child_spawn_failed');
    }
    // Signal registration is intentionally narrow and never changes the child argv/env.
    const stopOnSignal = (): void => {
      if (handledSignal) return;
      handledSignal = true;
      resolveHandledSignal();
    };
    for (const signal of productionSignals) {
      try {
        if (dependencies.addSignalListener !== undefined) {
          signalHandlers.push(dependencies.addSignalListener(signal, stopOnSignal));
        } else {
          Deno.addSignalListener(signal, stopOnSignal);
          signalHandlers.push(() => Deno.removeSignalListener(signal, stopOnSignal));
        }
      } catch { /* unavailable in a restricted test host */ }
    }
    const childRun = await runChild(
      child,
      dependencies.childDeadlineMs ?? CHILD_DEADLINE_MS,
      dependencies.childGraceMs ?? CHILD_GRACE_MS,
      signalPromise,
    );
    removeSignalHandlers(signalHandlers);
    signalHandlers = [];
    if (handledSignal) {
      externalRequests = null;
      throw new LauncherError('process', 'child_signal');
    }
    if (childRun.failure !== undefined) {
      externalRequests = null;
      throw new LauncherError('bounds', childRun.failure);
    }
    if (childRun.stderr.text !== '') {
      externalRequests = null;
      throw new LauncherError('evidence', 'child_report_invalid');
    }
    if (childRun.status === undefined) {
      externalRequests = null;
      throw new LauncherError('process', 'child_wait_failed');
    }
    const childExitedUnsuccessfully = !childRun.status.success || childRun.status.code !== 0 ||
      childRun.status.signal !== null;
    if (childExitedUnsuccessfully && childRun.stdout.text === '') {
      externalRequests = null;
      throw new LauncherError('process', 'child_exit_failed');
    }
    const childReport = parseChildReport(childRun.stdout.text);
    if (childReport === undefined) {
      externalRequests = null;
      throw new LauncherError('evidence', 'child_report_invalid');
    }
    externalRequests = childReport.externalRequests;
    if (!childReport.ok) {
      throw new LauncherError(stageForChildCode(childReport.code), childReport.code);
    }
    if (!childRun.status.success || childRun.status.code !== 0 || childRun.status.signal !== null) {
      throw new LauncherError('process', 'child_exit_failed');
    }
    const validateWorkspace = dependencies.validateWorkspace ?? defaultValidateWorkspace;
    if (!(await validateWorkspace(workspace))) {
      throw new LauncherError('terminal', 'workspace_mismatch');
    }
    result = {
      schemaVersion: 1,
      taskId: TASK_ID,
      profile: EXPECTED_PROFILE,
      ok: true,
      outcome: 'passed',
      modelRequests: 5,
      externalRequests: 5,
      toolCalls: 5,
      toolResults: 5,
      toolOrder: [...TOOL_ORDER],
      stopReason: 'tool_terminal',
      result: EXPECTED_RESULT,
      workspaceVerified: true,
      workspaceRemoved: true,
      retryCount: 0,
    };
  } catch (error) {
    const failure = error instanceof LauncherError
      ? error
      : new LauncherError('internal', 'internal_failure');
    result = failureReport(
      failure.stage,
      failure.code,
      childCount,
      externalRequests,
      workspaceRemoved,
    );
  } finally {
    removeSignalHandlers(signalHandlers);
    if (workspace !== undefined) {
      try {
        await (dependencies.removeWorkspace ?? defaultRemoveWorkspace)(workspace);
        workspaceRemoved = true;
      } catch {
        workspaceRemoved = false;
      }
    }
    if (result?.ok && workspaceRemoved !== true) {
      result = failureReport(
        'cleanup',
        'cleanup_failed',
        childCount,
        externalRequests,
        workspaceRemoved,
      );
    } else if (!result?.ok && result !== undefined) {
      result = { ...result, workspaceRemoved };
    }
  }
  const output = dependencies.writeStdout ?? ((text: string) => defaultWrite(Deno.stdout, text));
  const errorOutput = dependencies.writeStderr ??
    ((text: string) => defaultWrite(Deno.stderr, text));
  if (result?.ok) {
    await writeSuccess(result, output);
    return 0;
  }
  await writeFailure(
    result ??
      failureReport('internal', 'internal_failure', childCount, externalRequests, workspaceRemoved),
    errorOutput,
  );
  return 1;
};

if (import.meta.main) Deno.exit(await main());
