import {
  type CredentialFileSystem,
  CredentialLauncherError,
  readCredential,
} from '../eval/live_corpus_credential_launcher.ts';
import {
  CHILD_MODEL_REQUESTS,
  EXPECTED_PROFILE,
  MAX_SENTINEL_REQUESTS,
  PARENT_MODEL_REQUESTS,
  PARENT_TOOL_ORDER,
  REQUEST_ORDER,
  type SentinelFailureCode,
  type SentinelReport,
  type SentinelSuccessReport,
  TASK_ID,
} from './planner_delegation_sentinel.ts';

export const DENO_COMMAND = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno' as const;
export const CHILD_ENTRYPOINT =
  '/home/masat.guest/src/henji-harness/v0/agent/planner_delegation_sentinel.ts' as const;
export const SECRET_ENV = 'HENJI_OPENROUTER_API_KEY' as const;
export const WORKSPACE_PARENT = '/tmp' as const;
export const WORKSPACE_PREFIX = 'henji-planner-delegation-sentinel-' as const;
export const CHILD_DEADLINE_MS = 120_000 as const;
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
  | SentinelFailureCode
  | 'cleanup_failed'
  | 'internal_failure';

export interface LauncherSuccess {
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
    super('fixed planner-delegation sentinel launcher failed');
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

const validCount = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;

const validPrefix = (value: unknown, expected: readonly string[]): value is readonly string[] =>
  Array.isArray(value) && value.length <= expected.length &&
  value.every((item, index) => item === expected[index]);

const validFailureCode = (value: unknown): value is SentinelFailureCode =>
  typeof value === 'string' && [
    'provider_failure',
    'request_contract_failure',
    'model_adherence_failure',
    'delegation_contract_failure',
    'parent_final_mismatch',
    'workspace_mismatch',
    'internal_failure',
  ].includes(value);

const validFailureTuple = (value: Record<string, unknown>): boolean => {
  const requestOrder = value.requestOrder as readonly string[];
  const parentToolOrder = value.parentToolOrder as readonly string[];
  const parentModelRequests = value.parentModelRequests as number;
  const childModelRequests = value.childModelRequests as number;
  const aggregateModelRequests = value.aggregateModelRequests as number;
  const externalRequests = value.externalRequests as number;
  const delegationCalls = value.delegationCalls as number;
  const delegationResults = value.delegationResults as number;
  if (
    aggregateModelRequests !== parentModelRequests + childModelRequests ||
    delegationResults > delegationCalls || requestOrder.length !== externalRequests ||
    parentToolOrder.length !== delegationCalls
  ) return false;
  const parents = requestOrder.filter((item) => item === 'parent').length;
  const children = requestOrder.filter((item) => item === 'child').length;
  const plannerFinalValidated = value.plannerFinalValidated as boolean;
  const childBeforeFinal = value.childCompletedBeforeParentFinal as boolean;
  const transcriptValidated = value.transcriptValidated as boolean;
  if (
    (value.parentStopReason === 'final' || value.parentStopReason === 'max_steps') &&
    parentModelRequests === 0
  ) return false;
  const completeTuple = parents === PARENT_MODEL_REQUESTS && children === CHILD_MODEL_REQUESTS &&
    aggregateModelRequests === MAX_SENTINEL_REQUESTS &&
    externalRequests === MAX_SENTINEL_REQUESTS &&
    delegationCalls === 1 && delegationResults === 1 && requestOrder.length === 3 &&
    requestOrder.every((item, index) => item === REQUEST_ORDER[index]) &&
    parentToolOrder.length === 1 && parentToolOrder[0] === PARENT_TOOL_ORDER[0] &&
    value.parentStopReason === 'final';
  const childCompletedTuple = children === CHILD_MODEL_REQUESTS && delegationCalls === 1 &&
    requestOrder.length >= 2 && requestOrder[0] === REQUEST_ORDER[0] &&
    requestOrder[1] === REQUEST_ORDER[1];
  const parentSecondPhaseTuple = childCompletedTuple && parents === PARENT_MODEL_REQUESTS &&
    requestOrder.length === REQUEST_ORDER.length &&
    requestOrder.every((item, index) => item === REQUEST_ORDER[index]);
  return parents === parentModelRequests && children === childModelRequests &&
    (children === 0 || delegationCalls === 1) &&
    (!plannerFinalValidated || childCompletedTuple) &&
    (!childBeforeFinal || (parentSecondPhaseTuple && plannerFinalValidated)) &&
    (!transcriptValidated || completeTuple) &&
    value.plannerNonMutating === true && value.plannerNonRecursive === true;
};

/** Strictly validate the child report without retaining any child-provided free text. */
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
    !validCount(value.parentModelRequests, PARENT_MODEL_REQUESTS) ||
    !validCount(value.childModelRequests, CHILD_MODEL_REQUESTS) ||
    !validCount(value.aggregateModelRequests, MAX_SENTINEL_REQUESTS) ||
    !validCount(value.externalRequests, MAX_SENTINEL_REQUESTS) ||
    !validCount(value.delegationCalls, 1) || !validCount(value.delegationResults, 1) ||
    !validPrefix(value.requestOrder, REQUEST_ORDER) ||
    !validPrefix(value.parentToolOrder, PARENT_TOOL_ORDER) ||
    (value.parentStopReason !== 'final' && value.parentStopReason !== 'contract_failure' &&
      value.parentStopReason !== 'max_steps' && value.parentStopReason !== null) ||
    typeof value.plannerFinalValidated !== 'boolean' ||
    typeof value.childCompletedBeforeParentFinal !== 'boolean' ||
    typeof value.plannerNonMutating !== 'boolean' ||
    typeof value.plannerNonRecursive !== 'boolean' ||
    typeof value.transcriptValidated !== 'boolean' || typeof value.workspaceValidated !== 'boolean'
  ) {
    return undefined;
  }
  if (value.ok && value.outcome === 'passed') {
    if (
      !exactKeys(value, [
        'schemaVersion',
        'taskId',
        'profile',
        'ok',
        'outcome',
        'parentModelRequests',
        'childModelRequests',
        'aggregateModelRequests',
        'externalRequests',
        'delegationCalls',
        'delegationResults',
        'requestOrder',
        'parentToolOrder',
        'parentStopReason',
        'plannerFinalValidated',
        'childCompletedBeforeParentFinal',
        'plannerNonMutating',
        'plannerNonRecursive',
        'transcriptValidated',
        'workspaceValidated',
      ]) || value.parentModelRequests !== 2 || value.childModelRequests !== 1 ||
      value.aggregateModelRequests !== 3 || value.externalRequests !== 3 ||
      value.delegationCalls !== 1 || value.delegationResults !== 1 ||
      !validPrefix(value.requestOrder, REQUEST_ORDER) || value.requestOrder.length !== 3 ||
      !validPrefix(value.parentToolOrder, PARENT_TOOL_ORDER) ||
      value.parentToolOrder.length !== 1 ||
      value.parentStopReason !== 'final' || value.plannerFinalValidated !== true ||
      value.childCompletedBeforeParentFinal !== true || value.plannerNonMutating !== true ||
      value.plannerNonRecursive !== true || value.transcriptValidated !== true ||
      value.workspaceValidated !== true
    ) return undefined;
    return value as unknown as SentinelSuccessReport;
  }
  if (
    value.ok || value.outcome !== 'aborted' || !exactKeys(value, [
      'schemaVersion',
      'taskId',
      'profile',
      'ok',
      'outcome',
      'code',
      'parentModelRequests',
      'childModelRequests',
      'aggregateModelRequests',
      'externalRequests',
      'delegationCalls',
      'delegationResults',
      'requestOrder',
      'parentToolOrder',
      'parentStopReason',
      'plannerFinalValidated',
      'childCompletedBeforeParentFinal',
      'plannerNonMutating',
      'plannerNonRecursive',
      'transcriptValidated',
      'workspaceValidated',
    ]) || !validFailureCode(value.code) || !validFailureTuple(value)
  ) return undefined;
  return value as unknown as SentinelReport;
};

const validateFreshWorkspace = async (path: string): Promise<boolean> => {
  try {
    const info = await Deno.lstat(path);
    if (
      !info.isDirectory || info.isSymlink || info.mode === null || (info.mode & 0o7777) !== 0o700
    ) {
      return false;
    }
    for await (const _entry of Deno.readDir(path)) return false;
    return true;
  } catch {
    return false;
  }
};

interface WorkspaceCreationDependencies {
  readonly makeTempDir: () => Promise<string>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly realPath: (path: string) => Promise<string>;
  readonly validate: (path: string) => Promise<boolean>;
  readonly remove: (path: string) => Promise<void>;
}

/** Create the owned workspace and remove the partial directory on every failed step. */
export const createSentinelWorkspace = async (
  dependencies: WorkspaceCreationDependencies = {
    makeTempDir: () => Deno.makeTempDir({ dir: WORKSPACE_PARENT, prefix: WORKSPACE_PREFIX }),
    chmod: (path, mode) => Deno.chmod(path, mode),
    realPath: (path) => Deno.realPath(path),
    validate: validateFreshWorkspace,
    remove: (path) => Deno.remove(path, { recursive: true }),
  },
): Promise<string> => {
  let created: string | undefined;
  try {
    created = await dependencies.makeTempDir();
    await dependencies.chmod(created, 0o700);
    const canonical = await dependencies.realPath(created);
    if (!(await dependencies.validate(canonical))) {
      throw new LauncherError('workspace', 'workspace_invalid');
    }
    return canonical;
  } catch (error) {
    if (created !== undefined) {
      try {
        await dependencies.remove(created);
      } catch { /* preserve the original bounded failure */ }
    }
    if (error instanceof LauncherError) throw error;
    throw new LauncherError('workspace', 'workspace_create_failed');
  }
};

const defaultMakeWorkspace = (): Promise<string> => createSentinelWorkspace();
const defaultValidateWorkspace = validateFreshWorkspace;
const defaultRealPath = (path: string): Promise<string> => Deno.realPath(path);
const defaultRemoveWorkspace = (path: string): Promise<void> =>
  Deno.remove(path, { recursive: true });

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
    '--allow-env=HENJI_OPENROUTER_API_KEY',
    '--allow-net=openrouter.ai',
    `--allow-read=${workspace}`,
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
  const waitBounded = (): Promise<SentinelChildStatus | undefined> =>
    Promise.race([
      statusPromise.catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), graceMs)),
    ]);
  try {
    child.kill('SIGTERM');
  } catch { /* best effort */ }
  const grace = await waitBounded();
  if (grace !== undefined) return grace;
  try {
    child.kill('SIGKILL');
  } catch { /* best effort */ }
  return await waitBounded();
};

interface ChildRun {
  readonly status?: SentinelChildStatus;
  readonly stdout: Captured;
  readonly stderr: Captured;
  readonly failure?: 'deadline_exceeded' | 'stdout_overflow' | 'stderr_overflow';
}

const runChild = async (
  child: SentinelChild,
  deadlineMs: number,
  graceMs: number,
  signalPromise: Promise<void>,
): Promise<ChildRun> => {
  const statusPromise = child.status;
  let overflowCode: 'stdout_overflow' | 'stderr_overflow' | undefined;
  let terminatePromise: Promise<SentinelChildStatus | undefined> | undefined;
  let releaseCapture!: () => void;
  const captureStop = new Promise<void>((resolve) => releaseCapture = resolve);
  let signalOverflow!: (code: 'stdout_overflow' | 'stderr_overflow') => void;
  const overflowSignal = new Promise<'stdout_overflow' | 'stderr_overflow'>((resolve) => {
    signalOverflow = resolve;
  });
  const requestTermination = (code: 'stdout_overflow' | 'stderr_overflow'): void => {
    if (overflowCode === undefined) overflowCode = code;
    signalOverflow(code);
    releaseCapture();
    if (terminatePromise === undefined) {
      terminatePromise = terminateAndReap(child, statusPromise, graceMs);
    }
  };
  const stdoutPromise = capture(child.stdout, () => requestTermination('stdout_overflow'));
  const stderrPromise = capture(child.stderr, () => requestTermination('stderr_overflow'));
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline = false;
  const deadlinePromise = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      deadline = true;
      releaseCapture();
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
  if (first !== 'status') {
    releaseCapture();
    if (terminatePromise === undefined) {
      terminatePromise = terminateAndReap(child, statusPromise, graceMs);
    }
  }
  let status: SentinelChildStatus | undefined;
  if (first === 'status') {
    try {
      status = await statusPromise;
    } catch {
      status = undefined;
    }
  } else {
    status = await terminatePromise;
  }
  const expiredCapture = captureStop.then(() => ({ text: '', overflow: false } as Captured));
  const [stdout, stderr] = await Promise.all([
    Promise.race([stdoutPromise, expiredCapture]),
    Promise.race([stderrPromise, expiredCapture]),
  ]);
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  if (deadline) return { status, stdout, stderr, failure: 'deadline_exceeded' };
  if (overflowCode !== undefined) return { status, stdout, stderr, failure: overflowCode };
  if (status === undefined) return { stdout, stderr };
  return { status, stdout, stderr };
};

const defaultWrite = async (
  stream: { write(bytes: Uint8Array): Promise<number> },
  text: string,
): Promise<void> => {
  const bytes = encoder.encode(text);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await stream.write(bytes.subarray(offset));
    if (!Number.isSafeInteger(written) || written <= 0) return;
    offset += written;
  }
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

const writeFailure = async (
  report: LauncherFailure,
  writer: (text: string) => void | PromiseLike<void>,
): Promise<void> => {
  try {
    await writer(`${JSON.stringify(report)}\n`);
  } catch { /* best effort */ }
};

const stageForChildCode = (code: SentinelFailureCode): LauncherFailureStage => {
  if (code === 'workspace_mismatch') return 'execution';
  return 'execution';
};

const removeSignalHandlers = (handlers: readonly (() => void)[]): void => {
  for (const remove of handlers) {
    try {
      remove();
    } catch { /* best effort */ }
  }
};

const writeSuccess = async (
  report: LauncherSuccess,
  writer: (text: string) => void | PromiseLike<void>,
): Promise<void> => {
  await writer(`${JSON.stringify(report)}\n`);
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
    try {
      workspace = await (dependencies.makeWorkspace ?? defaultMakeWorkspace)();
      const canonical = await (dependencies.realPath ?? defaultRealPath)(workspace);
      if (canonical !== workspace || !(await validateFreshWorkspace(canonical))) {
        throw new LauncherError('workspace', 'workspace_invalid');
      }
      workspace = canonical;
    } catch (error) {
      if (error instanceof LauncherError) throw error;
      throw new LauncherError('workspace', 'workspace_create_failed');
    }
    const stopOnSignal = (): void => {
      if (handledSignal) return;
      handledSignal = true;
      resolveHandledSignal();
    };
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
      try {
        if (dependencies.addSignalListener !== undefined) {
          signalHandlers.push(dependencies.addSignalListener(signal, stopOnSignal));
        } else {
          Deno.addSignalListener(signal, stopOnSignal);
          signalHandlers.push(() => Deno.removeSignalListener(signal, stopOnSignal));
        }
      } catch { /* unavailable in restricted test hosts */ }
    }
    if (handledSignal) throw new LauncherError('process', 'child_signal');
    let child: SentinelChild;
    try {
      child = (dependencies.spawn ?? defaultSpawn)(
        DENO_COMMAND,
        childOptions(workspace, credential),
      );
      childCount = 1;
    } catch {
      throw new LauncherError('process', 'child_spawn_failed');
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
    if (!childRun.status.success && childRun.stdout.text === '') {
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
    if (!(await (dependencies.validateWorkspace ?? defaultValidateWorkspace)(workspace))) {
      throw new LauncherError('execution', 'workspace_mismatch');
    }
    result = {
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
