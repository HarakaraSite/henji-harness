import { type Failure, failure, type Plan } from '../domain.ts';
import { prepareExtension, sha256 } from '../extensions.ts';
import {
  basicModel,
  fixtureModel,
  type ModelGenerate,
  openRouterModel,
  parseModelPlan,
  PROFILE,
} from '../model.ts';
import { runExtension } from '../runner.ts';
import {
  activateExtension,
  activeExtension,
  authorizeAttempt,
  installExtension,
  packageEntrypoint,
  readState,
  rollbackExtension,
  startAttempt,
  statePaths,
  switchExtension,
  updateAttempt,
  withExclusiveLock,
} from '../state.ts';

const DENO_COMMAND = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const encoder = new TextEncoder();

export const defaultStateDirFor = (
  env: Readonly<Record<string, string | undefined>>,
  platform: typeof Deno.build.os,
): string => {
  const xdg = env.XDG_STATE_HOME;
  if (xdg && xdg.startsWith('/')) return `${xdg}/henji-harness/v0`;
  if (platform === 'windows') {
    const local = env.LOCALAPPDATA ?? env.APPDATA ?? env.USERPROFILE;
    if (local) return `${local}/henji-harness/v0`;
  }
  if (platform === 'darwin' && env.HOME) {
    return `${env.HOME}/Library/Application Support/henji-harness/v0`;
  }
  if (env.HOME) return `${env.HOME}/.local/state/henji-harness/v0`;
  if (env.USERPROFILE) return `${env.USERPROFILE}/.local/state/henji-harness/v0`;
  // A missing home directory is an unusable user-local configuration, not a
  // reason to put mutable state in the repository's current working directory.
  return '/var/empty/henji-harness/v0';
};

const defaultStateDir = (): string =>
  defaultStateDirFor({
    XDG_STATE_HOME: Deno.env.get('XDG_STATE_HOME'),
    HOME: Deno.env.get('HOME'),
    USERPROFILE: Deno.env.get('USERPROFILE'),
    LOCALAPPDATA: Deno.env.get('LOCALAPPDATA'),
    APPDATA: Deno.env.get('APPDATA'),
  }, Deno.build.os);

const help = `Henji Harness trusted-local v0

Usage:
  basic run --task TEXT [--context TEXT] [--constraints JSON] --confirm-external-call
  extension inspect --source DIR [--state-dir DIR]
  extension install --source DIR [--state-dir DIR]
  extension activate --id ID --digest SHA256 [--state-dir DIR]
  extension switch --id ID --digest SHA256 [--state-dir DIR]
  extension rollback --id ID --digest SHA256 [--state-dir DIR]
  status [--state-dir DIR]
  run --task TEXT [--context TEXT] [--constraints JSON] [--state-dir DIR]
  acceptance authorize --attempt-id ID --max-usd 0.064 [--state-dir DIR]
  acceptance run --attempt-id ID --task TEXT --confirm-external-call [--state-dir DIR]

Only a human may explicitly install, activate, switch, or roll back an exact digest.
trusted-local is not a complete sandbox or supply-chain guarantee; same-user source replacement
and public-distribution hardening are outside v0. External calls are one human-authorized attempt.
`;

const VALUE_OPTIONS = new Set([
  '--task',
  '--context',
  '--constraints',
  '--state-dir',
  '--source',
  '--id',
  '--digest',
  '--attempt-id',
  '--max-usd',
]);
const FLAG_OPTIONS = new Set(['--confirm-external-call', '--help', '-h']);
const KNOWN_OPTIONS = new Set([...VALUE_OPTIONS, ...FLAG_OPTIONS]);

interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

/** Parse option structure once so a flag cannot be consumed as a value. */
const parseArgs = (args: readonly string[]): ParsedArgs | Failure => {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (VALUE_OPTIONS.has(arg)) {
      const value = args[index + 1];
      if (
        value === undefined || KNOWN_OPTIONS.has(value)
      ) return failure('invalid_input', `${arg} requires a value`);
      if (!values.has(arg)) values.set(arg, value);
      index++;
    } else if (FLAG_OPTIONS.has(arg)) {
      flags.add(arg);
    } else if (arg.startsWith('-')) {
      return failure('invalid_input', `unknown option ${arg}`);
    }
  }
  return { values, flags };
};

const option = (args: readonly string[], name: string): string | undefined => {
  const parsed = parseArgs(args);
  return 'code' in parsed ? undefined : parsed.values.get(name);
};
const required = (args: readonly string[], name: string): string | Failure =>
  option(args, name) ?? failure('invalid_input', `${name} is required`);
const stateDir = (args: readonly string[]): string =>
  option(args, '--state-dir') ?? defaultStateDir();
const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
const fail = (value: Failure): number => {
  console.error(JSON.stringify({ error: value.code, message: value.message }));
  return 1;
};

const inspect = async (args: readonly string[]): Promise<number> => {
  const source = required(args, '--source');
  if (typeof source !== 'string') return fail(source);
  const prepared = await prepareExtension(source);
  if ('code' in prepared) return fail(prepared);
  print({
    id: prepared.manifest.id,
    version: prepared.manifest.version,
    revision: prepared.manifest.revision,
    digest: prepared.digest,
    entrypoint: prepared.manifest.entrypoint,
    sourceOrigin: prepared.sourceOrigin,
  });
  return 0;
};

const management = async (
  args: readonly string[],
  kind: 'install' | 'activate' | 'switch' | 'rollback',
): Promise<number> => {
  const dir = stateDir(args);
  if (kind === 'install') {
    const source = required(args, '--source');
    if (typeof source !== 'string') return fail(source);
    const result = await installExtension(dir, source);
    if ('code' in result) return fail(result);
    print({ action: 'install', active: result.state.active ?? null, installed: result.installed });
    return 0;
  }
  const id = required(args, '--id');
  const digest = required(args, '--digest');
  if (typeof id !== 'string') return fail(id);
  if (typeof digest !== 'string') return fail(digest);
  const result = kind === 'activate'
    ? await activateExtension(dir, id, digest)
    : kind === 'switch'
    ? await switchExtension(dir, id, digest)
    : await rollbackExtension(dir, id, digest);
  if ('code' in result) return fail(result);
  print({ action: kind, active: result.active, sequence: result.sequence });
  return 0;
};

const status = async (args: readonly string[]): Promise<number> => {
  const result = await readState(stateDir(args));
  if ('code' in result) return fail(result);
  print(result);
  return 0;
};

const parseConstraints = (raw: string | undefined): string[] | Failure => {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (
      !Array.isArray(value) || value.length > 32 ||
      value.some((item) => typeof item !== 'string' || encoder.encode(item).byteLength > 1024)
    ) return failure('invalid_input', 'constraints must be at most 32 short strings');
    return value;
  } catch {
    return failure('invalid_input', 'constraints must be JSON array');
  }
};

const constraints = (args: readonly string[]): string[] | Failure =>
  parseConstraints(option(args, '--constraints'));

const saveTrace = async (dir: string, trace: Record<string, unknown>): Promise<void> => {
  await Deno.mkdir(statePaths(dir).runs, { recursive: true });
  const id = String(trace.runId);
  const temp = `${statePaths(dir).runs}/.${id}.tmp`;
  const file = await Deno.open(temp, { create: true, write: true, truncate: true });
  try {
    await file.write(encoder.encode(`${JSON.stringify(trace)}\n`));
    await file.sync();
  } finally {
    file.close();
  }
  await Deno.rename(temp, `${statePaths(dir).runs}/${id}.json`);
};

const BASIC_SYSTEM_INSTRUCTION =
  'Return a concise, actionable JSON plan with title, summary, steps, and optional risks.';

const requestCountFrom = (result: Failure): 0 | 1 => result.details?.requestCount === 1 ? 1 : 0;

const printBasicFailure = (result: Failure, requestCount: 0 | 1, started: number): number => {
  print({
    error: { code: result.code, message: result.message },
    requestCount,
    durationMs: Math.round(performance.now() - started),
    outcome: { ok: false, code: result.code },
  });
  return 1;
};

const basicRun = async (
  args: readonly string[],
  model: ModelGenerate,
): Promise<number> => {
  const started = performance.now();
  const parsedArgs = parseArgs(args);
  if ('code' in parsedArgs) return printBasicFailure(parsedArgs, 0, started);
  const task = parsedArgs.values.get('--task') ?? failure('invalid_input', '--task is required');
  if (typeof task !== 'string') return printBasicFailure(task, 0, started);
  if (encoder.encode(task).byteLength > 8 * 1024) {
    return printBasicFailure(failure('limit_exceeded', 'task exceeds 8 KiB'), 0, started);
  }
  const context = parsedArgs.values.get('--context') ?? '';
  if (encoder.encode(context).byteLength > 32 * 1024) {
    return printBasicFailure(failure('limit_exceeded', 'context exceeds 32 KiB'), 0, started);
  }
  const parsedConstraints = parseConstraints(parsedArgs.values.get('--constraints'));
  if ('code' in parsedConstraints) return printBasicFailure(parsedConstraints, 0, started);
  if (!parsedArgs.flags.has('--confirm-external-call')) {
    return printBasicFailure(
      failure('external_not_authorized', 'external call confirmation is required'),
      0,
      started,
    );
  }
  const request = {
    messages: [
      { role: 'system' as const, content: BASIC_SYSTEM_INSTRUCTION },
      {
        role: 'user' as const,
        content: JSON.stringify({ task, context, constraints: parsedConstraints }),
      },
    ],
  };
  let result: Awaited<ReturnType<ModelGenerate>>;
  try {
    result = await model(request);
  } catch {
    return printBasicFailure(failure('model_error', 'provider transport failed'), 0, started);
  }
  if ('code' in result) return printBasicFailure(result, requestCountFrom(result), started);
  print({
    responseText: result.text,
    requestCount: 1,
    durationMs: Math.round(performance.now() - started),
    outcome: { ok: true },
  });
  return 0;
};

const run = async (args: readonly string[], external = false): Promise<number> => {
  const dir = stateDir(args);
  const task = required(args, '--task');
  if (typeof task !== 'string') return fail(task);
  if (task.length > 8 * 1024) return fail(failure('limit_exceeded', 'task exceeds 8 KiB'));
  const context = option(args, '--context') ?? '';
  if (context.length > 32 * 1024) return fail(failure('limit_exceeded', 'context exceeds 32 KiB'));
  const parsedConstraints = constraints(args);
  if ('code' in parsedConstraints) return fail(parsedConstraints);
  let attemptId: string | undefined;
  let approvedBudget: number | undefined;
  if (external) {
    const requestedAttempt = required(args, '--attempt-id');
    if (typeof requestedAttempt !== 'string') return fail(requestedAttempt);
    attemptId = requestedAttempt;
    if (!args.includes('--confirm-external-call')) {
      return fail(failure('external_not_authorized', 'external call confirmation is required'));
    }
    const started = await startAttempt(dir, attemptId, PROFILE.worstCaseUsd);
    if ('code' in started) return fail(started);
    approvedBudget = started.maxUsd;
  }
  return withExclusiveLock(statePaths(dir).runLock, async () => {
    const state = await readState(dir);
    if ('code' in state) return fail(state);
    const extension = activeExtension(state);
    if ('code' in extension) return fail(extension);
    const runId = `run-${crypto.randomUUID()}`;
    const model = external
      ? (request: Parameters<typeof openRouterModel>[0], signal?: AbortSignal) =>
        openRouterModel(
          request,
          approvedBudget ?? 0,
          fetch,
          undefined,
          undefined,
          signal,
        )
      : fixtureModel(extension.revision);
    const result = await runExtension({
      denoCommand: DENO_COMMAND,
      entrypoint: packageEntrypoint(dir, extension),
      cwd: `${dir}/extensions/${extension.id}/${extension.digest}`,
      requestPayload: { task, context, constraints: parsedConstraints },
      modelGenerate: model,
      modelProfile: external ? PROFILE.id : `fixture-${extension.revision}`,
    });
    const payload = result.payload as {
      type?: unknown;
      planText?: unknown;
      profile?: unknown;
      revision?: unknown;
    } | undefined;
    let plan: Plan | Failure | undefined;
    let responseText: string | undefined;
    if (result.failure) plan = result.failure;
    else if (
      !payload || payload.type !== 'plan' || typeof payload.planText !== 'string'
    ) plan = failure('protocol_violation', 'extension result was not a Plan payload');
    else {
      responseText = payload.planText;
      plan = parseModelPlan(responseText);
    }
    const resultDigest = typeof payload?.planText === 'string'
      ? await sha256(encoder.encode(payload.planText))
      : undefined;
    const trace = {
      runId,
      extension: {
        id: extension.id,
        version: extension.version,
        revision: extension.revision,
        digest: extension.digest,
      },
      profile: result.profile,
      durationMs: Math.round(result.durationMs),
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      hostCalls: result.hostCalls,
      ...(resultDigest ? { resultDigest } : {}),
      outcome: 'code' in (plan ?? {}) ? { ok: false, code: (plan as Failure).code } : { ok: true },
    };
    await saveTrace(dir, trace);
    if (external && attemptId) {
      await updateAttempt(
        dir,
        attemptId,
        'code' in (plan ?? {}) ? 'failed' : 'succeeded',
        'code' in (plan ?? {}) ? (plan as Failure).code : undefined,
      );
    }
    const terminal = {
      runId,
      extension: trace.extension,
      profile: trace.profile,
      ...(responseText !== undefined ? { responseText } : {}),
      plan,
      requestCount: trace.hostCalls,
      durationMs: trace.durationMs,
      outcome: trace.outcome,
    };
    if ('code' in (plan ?? {})) {
      if (responseText === undefined) return fail(plan as Failure);
      print(terminal);
      return 1;
    }
    print(terminal);
    return 0;
  });
};

const authorize = async (args: readonly string[]): Promise<number> => {
  const id = required(args, '--attempt-id');
  if (typeof id !== 'string') return fail(id);
  const raw = required(args, '--max-usd');
  if (typeof raw !== 'string') return fail(raw);
  const amount = Number(raw);
  const result = await authorizeAttempt(stateDir(args), id, amount);
  if ('code' in result) return fail(result);
  print({
    authorized: true,
    attemptId: result.id,
    maxRequests: result.maxRequests,
    maxUsd: result.maxUsd,
  });
  return 0;
};

export interface MainOptions {
  readonly basicModel?: ModelGenerate;
}

export const main = (
  args: readonly string[] = Deno.args,
  options: MainOptions = {},
): Promise<number> => {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(help);
    return Promise.resolve(0);
  }
  if (args[0] === 'basic' && args[1] === 'run') {
    return basicRun(args, options.basicModel ?? basicModel);
  }
  if (args[0] === 'status') return status(args);
  if (args[0] === 'run') return run(args);
  if (args[0] === 'acceptance' && args[1] === 'authorize') return authorize(args);
  if (args[0] === 'acceptance' && args[1] === 'run') return run(args, true);
  if (args[0] === 'extension' && args[1] === 'inspect') return inspect(args);
  if (args[0] === 'extension' && args[1] === 'install') return management(args, 'install');
  if (args[0] === 'extension' && args[1] === 'activate') return management(args, 'activate');
  if (args[0] === 'extension' && args[1] === 'switch') return management(args, 'switch');
  if (args[0] === 'extension' && args[1] === 'rollback') return management(args, 'rollback');
  return Promise.resolve(fail(failure('invalid_input', 'unknown command; use --help')));
};

if (import.meta.main) Deno.exit(await main());
