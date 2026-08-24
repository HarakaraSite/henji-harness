import { assert, assertEquals } from './test_helpers.ts';
import { failure, parseManifest, parsePlan, parseState } from '../../v0/domain.ts';
import {
  contentDigest,
  installedPath,
  manifestBytes,
  prepareExtension,
  scanSelfContained,
} from '../../v0/extensions.ts';
import {
  basicOpenRouterModel,
  fixtureModel,
  openRouterModel,
  parseModelPlan,
  PROFILE,
  validateProfileBudget,
} from '../../v0/model.ts';
import { decodeJsonl, encodeJsonl } from '../../v0/protocol.ts';
import { type LimitOverrides, LIMITS, probeArgv, runExtension } from '../../v0/runner.ts';
import {
  activateExtension,
  authorizeAttempt,
  installExtension,
  readState,
  rollbackExtension,
  startAttempt,
  statePaths,
  switchExtension,
  updateAttempt,
  withExclusiveLock,
} from '../../v0/state.ts';
import { defaultStateDirFor, main } from '../../v0/cli/main.ts';

const deno = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const root = Deno.cwd();
const r1 = `${root}/v0/extensions-src/task-planner/r1`;
const r2 = `${root}/v0/extensions-src/task-planner/r2`;

const writeChild = async (body: string): Promise<{ dir: string; entrypoint: string }> => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-child-' });
  const entrypoint = `${dir}/main.ts`;
  await Deno.writeTextFile(entrypoint, body);
  return { dir, entrypoint };
};

const childPreamble = `
const e = new TextEncoder();
const d = new TextDecoder();
const b = new Uint8Array(4096);
let p = '';
const readLine = async () => { for (;;) { const n = p.indexOf('\\n'); if (n >= 0) { const x = p.slice(0, n); p = p.slice(n + 1); return x; } const c = await Deno.stdin.read(b); if (c === null) return p; p += d.decode(b.slice(0, c), { stream: true }); } };
const write = async (value) => await Deno.stdout.write(e.encode(JSON.stringify(value) + '\\n'));
`;

const captureCli = async (invoke: () => Promise<number>) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '));
  try {
    return { code: await invoke(), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
};

const writePlanExtension = async (planText: string): Promise<string> => {
  const source = await Deno.makeTempDir({ prefix: 'henji-v0-raw-extension-' });
  await Deno.writeTextFile(
    `${source}/manifest.json`,
    JSON.stringify({
      schemaVersion: 1,
      id: 'raw-response-test',
      version: '0.1.0',
      revision: 'r1',
      entrypoint: 'main.ts',
    }),
  );
  await Deno.writeTextFile(
    `${source}/main.ts`,
    `${childPreamble}
const input = JSON.parse((await readLine()).trim());
await write({ v: 1, id: 'model', kind: 'request', parentId: input.id, method: 'host.model.generate', payload: { messages: [{ role: 'user', content: 'task' }] } });
await readLine();
await write({ v: 1, id: 'final', kind: 'response', replyTo: input.id, ok: true, payload: { type: 'plan', planText: ${
      JSON.stringify(planText)
    } } });
`,
  );
  return source;
};

const runChild = (
  entrypoint: string,
  modelProfile = 'host-profile',
  limits?: LimitOverrides,
) =>
  runExtension({
    denoCommand: deno,
    entrypoint,
    cwd: entrypoint.slice(0, entrypoint.lastIndexOf('/')),
    requestPayload: { task: 'child task', context: '', constraints: [] },
    modelGenerate: fixtureModel('child'),
    modelProfile,
    limits,
  });

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

Deno.test('manifest and digest are deterministic and checkout independent', async () => {
  const first = await prepareExtension(r1);
  assert(!('code' in first));
  const second = await prepareExtension(r1);
  assert(!('code' in second));
  assertEquals(first.digest, second.digest);
  const altered = await contentDigest(first.manifest, new TextEncoder().encode('different'));
  assert(first.digest !== altered);
  const manifest = parseManifest({
    schemaVersion: 1,
    id: 'x',
    version: '1',
    revision: 'r',
    entrypoint: 'main.ts',
  });
  assert(!('code' in manifest));
  assertEquals(manifest.id, 'x');
});

Deno.test('source scanner ignores bounded comments and strings but rejects loaders', () => {
  assertEquals(scanSelfContained('const text = "import export require"; // Worker'), undefined);
  assert(scanSelfContained('import x from "x"')?.code === 'source_rejected');
  assert(scanSelfContained('const x = import("x")')?.code === 'source_rejected');
  assert(scanSelfContained('export const x = 1')?.code === 'source_rejected');
  assert(scanSelfContained('/// <reference path="x" />')?.code === 'source_rejected');
  assert(scanSelfContained('const x = `${import("x")}`')?.code === 'source_rejected');
});

Deno.test('protocol is bounded and rejects malformed frames', () => {
  const line = encodeJsonl({
    v: 1,
    id: 'x',
    kind: 'request',
    method: 'extension.execute',
    payload: {},
  });
  assert(typeof line === 'string');
  const frame = decodeJsonl(line as string);
  assert(!('code' in frame));
  assertEquals(frame.kind, 'request');
  const limited = encodeJsonl({ value: 'x'.repeat(300) }, 32);
  assert(typeof limited !== 'string' && limited.code === 'limit_exceeded');
  const malformed = decodeJsonl('{bad');
  assert('code' in malformed && malformed.code === 'protocol_violation');
});

Deno.test('plan parser is strict and bounded', () => {
  const plan = parsePlan({ title: 't', summary: 's', steps: [{ id: '1', description: 'd' }] });
  assert(!('code' in plan));
  const invalidStep = parsePlan({
    title: 't',
    summary: 's',
    steps: [{ id: '1', description: '' }],
  });
  assert('code' in invalidStep && invalidStep.code === 'invalid_input');
  const tooMany = parsePlan({
    title: 't',
    summary: 's',
    steps: new Array(33).fill({ id: '1', description: 'd' }),
  });
  assert('code' in tooMany && tooMany.code === 'invalid_input');
});

Deno.test('human explicit management keeps install inactive and supports switch rollback', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-state-' });
  const one = await installExtension(dir, r1);
  assert(!('code' in one));
  assertEquals(one.state.active, undefined);
  const active = await activateExtension(dir, 'task-planner', one.installed.digest);
  assert(!('code' in active));
  const two = await installExtension(dir, r2);
  assert(!('code' in two));
  assertEquals(two.state.active?.digest, one.installed.digest);
  const switched = await switchExtension(dir, 'task-planner', two.installed.digest);
  assert(!('code' in switched));
  assertEquals(switched.active?.digest, two.installed.digest);
  const rolled = await rollbackExtension(dir, 'task-planner', one.installed.digest);
  assert(!('code' in rolled));
  assertEquals(rolled.active?.digest, one.installed.digest);
  const reread = await readState(dir);
  assert(!('code' in reread));
  assertEquals(reread.actions.map((item) => item.kind), [
    'install',
    'activate',
    'install',
    'switch',
    'rollback',
  ]);
});

Deno.test('CLI management and offline run keep active identity through terminal output', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-cli-' });
  assertEquals(await main(['extension', 'install', '--source', r1, '--state-dir', dir]), 0);
  const installed = await readState(dir);
  assert(!('code' in installed));
  const digest = installed.installed[0].digest;
  assertEquals(
    await main([
      'extension',
      'activate',
      '--id',
      'task-planner',
      '--digest',
      digest,
      '--state-dir',
      dir,
    ]),
    0,
  );
  const captured = await captureCli(() => main(['run', '--task', 'cli task', '--state-dir', dir]));
  assertEquals(captured.code, 0);
  assertEquals(captured.stderr, '');
  const terminal = JSON.parse(captured.stdout) as Record<string, unknown>;
  const responseText = JSON.stringify({
    title: 'Plan for {"task":"cli task","context":"","constraints":[]}',
    summary: 'Fixture model response for offline validation.',
    steps: [
      { id: 'step-1', description: 'Review the task and constraints.' },
      { id: 'step-2', description: 'Perform the smallest reversible next action.' },
    ],
    risks: ['Fixture output is not a provider observation.'],
  });
  assertEquals(terminal.responseText, responseText);
  assertEquals(terminal.plan, JSON.parse(responseText));
  assertEquals(terminal.requestCount, 1);
  assert(typeof terminal.durationMs === 'number' && terminal.durationMs >= 0);
  assertEquals(terminal.outcome, { ok: true });
  const afterRun = await readState(dir);
  assert(!('code' in afterRun));
  assertEquals(afterRun.active?.digest, digest);
  assertEquals(await main(['status', '--state-dir', dir]), 0);
});

Deno.test('CLI preserves a non-Plan response alongside the parse error', async () => {
  const source = await writePlanExtension('not a Plan response');
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-raw-cli-' });
  const installed = await installExtension(dir, source);
  assert(!('code' in installed));
  const active = await activateExtension(dir, 'raw-response-test', installed.installed.digest);
  assert(!('code' in active));
  const captured = await captureCli(() => main(['run', '--task', 'raw task', '--state-dir', dir]));
  assertEquals(captured.code, 1);
  assertEquals(captured.stderr, '');
  const terminal = JSON.parse(captured.stdout) as Record<string, unknown>;
  assertEquals(terminal.responseText, 'not a Plan response');
  assertEquals(terminal.plan, {
    code: 'invalid_input',
    message: 'model output was not valid Plan JSON',
  });
  assertEquals(terminal.requestCount, 1);
  assert(typeof terminal.durationMs === 'number' && terminal.durationMs >= 0);
  assertEquals(terminal.outcome, { ok: false, code: 'invalid_input' });
});

Deno.test('install adopts only byte-verified orphan packages and rejects tampering', async () => {
  const prepared = await prepareExtension(r1);
  assert(!('code' in prepared));
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-orphan-' });
  const orphan = {
    ...prepared.manifest,
    digest: prepared.digest,
    sourceOrigin: r1,
    installedAt: new Date().toISOString(),
  };
  const packageDir = installedPath(dir, orphan);
  await Deno.mkdir(packageDir, { recursive: true });
  await Deno.writeFile(`${packageDir}/manifest.json`, manifestBytes(orphan));
  await Deno.writeFile(`${packageDir}/main.ts`, prepared.main);
  const adopted = await installExtension(dir, r1);
  assert(!('code' in adopted));
  assertEquals(adopted.state.installed.length, 1);

  const badDir = await Deno.makeTempDir({ prefix: 'henji-v0-orphan-bad-' });
  const badPackage = installedPath(badDir, orphan);
  await Deno.mkdir(badPackage, { recursive: true });
  await Deno.writeFile(`${badPackage}/manifest.json`, manifestBytes(orphan));
  await Deno.writeTextFile(`${badPackage}/main.ts`, 'tampered');
  const rejected = await installExtension(badDir, r1);
  assert('code' in rejected && rejected.code === 'digest_mismatch');
});

Deno.test('unknown state schema fails closed and action limit is bounded', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-state-' });
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/state.json`, JSON.stringify({ schemaVersion: 99 }));
  const state = await readState(dir);
  assert('code' in state && state.code === 'state_invalid');
  const invalidState = parseState({
    schemaVersion: 1,
    sequence: 0,
    installed: [],
    actions: new Array(257).fill({}),
    attempts: [],
  });
  assert('code' in invalidState && invalidState.code === 'state_invalid');
});

Deno.test('cross-process lock serializes state callbacks', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-lock-' });
  let entered = false;
  let second = false;
  const first = withExclusiveLock(statePaths(dir).lock, async () => {
    entered = true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondRun = withExclusiveLock(statePaths(dir).lock, () =>
    Promise.resolve().then(() => {
      second = entered;
    }));
  await Promise.all([first, secondRun]);
  assert(second);
});

Deno.test('separate Deno processes serialize the same lock file', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-cross-lock-' });
  const lock = `${dir}/lock`;
  const marker = `${dir}/locked`;
  const worker = await writeChild(`
const lock = await Deno.open(Deno.args[0], { create: true, read: true, write: true });
await lock.lock(true);
await Deno.writeTextFile(Deno.args[1], 'locked');
await new Promise((resolve) => setTimeout(resolve, 100));
await lock.unlock();
lock.close();
`);
  const child = new Deno.Command(deno, {
    args: ['run', '--no-prompt', '--allow-read', '--allow-write', worker.entrypoint, lock, marker],
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  for (let i = 0; i < 100 && !(await exists(marker)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const started = performance.now();
  await withExclusiveLock(lock, async () => {});
  const waited = performance.now() - started;
  assert(waited >= 50);
  const status = await child.status;
  assert(status.success);
});

Deno.test('offline E2E runs exact active revision in a separate denied process', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-run-' });
  const installed = await installExtension(dir, r1);
  assert(!('code' in installed));
  const active = await activateExtension(dir, 'task-planner', installed.installed.digest);
  assert(!('code' in active));
  const result = await runExtension({
    denoCommand: deno,
    entrypoint: `${dir}/extensions/task-planner/${installed.installed.digest}/main.ts`,
    cwd: `${dir}/extensions/task-planner/${installed.installed.digest}`,
    requestPayload: { task: 'offline task', context: '', constraints: [] },
    modelGenerate: fixtureModel('r1'),
    modelProfile: 'fixture-r1',
  });
  assert(!result.failure);
  assert(result.hostCalls === 1);
  const payload = result.payload as { type: string; revision: string; profile?: string };
  assertEquals(payload.type, 'plan');
  assertEquals(payload.revision, 'r1');
  assertEquals(payload.profile, undefined);
  assertEquals(result.profile, 'fixture-r1');
  assert(probeArgv('/tmp/main.ts').includes('--deny-import'));
  assert(probeArgv('/tmp/main.ts').includes('--no-remote'));
  assert(probeArgv('/tmp/main.ts').includes('--deny-env'));
  assertEquals(LIMITS.sessionMs, 45_000);
});

Deno.test('runner rejects zero-call final plans and ignores spoofed extension profiles', async () => {
  const noCall = await writeChild(`${childPreamble}
const input = JSON.parse((await readLine()).trim());
await write({ v: 1, id: 'final', kind: 'response', replyTo: input.id, ok: true, payload: { type: 'plan', planText: JSON.stringify({ title: 't', summary: 's', steps: [{ id: '1', description: 'd' }] }), profile: 'spoofed-profile' } });
`);
  const noCallResult = await runChild(noCall.entrypoint);
  assert(noCallResult.failure?.code === 'protocol_violation');
  assertEquals(noCallResult.hostCalls, 0);

  const spoof = await writeChild(`${childPreamble}
const input = JSON.parse((await readLine()).trim());
await write({ v: 1, id: 'model', kind: 'request', parentId: input.id, method: 'host.model.generate', payload: { messages: [{ role: 'user', content: 'task' }] } });
const reply = JSON.parse((await readLine()).trim());
await write({ v: 1, id: 'final', kind: 'response', replyTo: input.id, ok: true, payload: { type: 'plan', planText: reply.payload.text, profile: 'spoofed-profile' } });
`);
  const spoofResult = await runChild(spoof.entrypoint, 'host-owned-profile');
  assert(!spoofResult.failure);
  assertEquals(spoofResult.hostCalls, 1);
  assertEquals(spoofResult.profile, 'host-owned-profile');
});

Deno.test('fixture model never exposes a credential and exact profile is static', async () => {
  const model = fixtureModel('r1');
  const result = await model({ messages: [{ role: 'user', content: 'task' }] });
  assert(!('code' in result));
  assert(!result.text.includes('HENJI_OPENROUTER_API_KEY'));
  assertEquals(PROFILE.model, 'google/gemini-3.7-flash');
  assertEquals(PROFILE.retry, 0);
  assertEquals(PROFILE.maxUsd, 0.064);
  assertEquals(PROFILE.worstCaseUsd, 0.062208);
});

Deno.test('local HTTP model gate fixes request body, profile, and redaction', async () => {
  let seenBody: Record<string, unknown> | undefined;
  let seenAuthorization: string | null = null;
  let requestCount = 0;
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      requestCount++;
      seenBody = await request.json() as Record<string, unknown>;
      seenAuthorization = request.headers.get('authorization');
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    },
  );
  try {
    const address = server.addr as Deno.NetAddr;
    const result = await openRouterModel(
      { messages: [{ role: 'user', content: 'task' }] },
      PROFILE.maxUsd,
      fetch,
      `http://127.0.0.1:${address.port}/api/v1/chat/completions`,
      'dummy-secret-for-local-test',
    );
    assert(!('code' in result));
    assertEquals(result.profile, PROFILE.id);
    assertEquals(requestCount, 1);
    assertEquals(seenAuthorization, 'Bearer dummy-secret-for-local-test');
    assertEquals(seenBody?.model, PROFILE.model);
    assertEquals(seenBody?.stream, false);
    assert(!('temperature' in (seenBody ?? {})));
    assertEquals(seenBody?.max_completion_tokens, 1024);
    assert(!('max_tokens' in (seenBody ?? {})));
    assert(!('provider' in (seenBody ?? {})));
    assert(!('models' in (seenBody ?? {})));
    assertEquals(
      JSON.stringify(result).includes('dummy-secret-for-local-test'),
      false,
    );
    const serializedReadback = JSON.stringify({
      responseText: result.text,
      parse: parseModelPlan(result.text),
      requestCount: 1,
      durationMs: 0,
      outcome: { ok: false, code: 'invalid_input' },
    });
    assert(!serializedReadback.includes('dummy-secret-for-local-test'));
    assert(!serializedReadback.includes('authorization'));
    assertEquals(seenAuthorization, 'Bearer dummy-secret-for-local-test');
  } finally {
    server.shutdown();
    await server.finished;
  }
});

Deno.test('local HTTP response is bounded and cancelled before retaining the body', async () => {
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
      ),
  );
  try {
    const address = server.addr as Deno.NetAddr;
    const result = await openRouterModel(
      { messages: [{ role: 'user', content: 'task' }] },
      PROFILE.maxUsd,
      fetch,
      `http://127.0.0.1:${address.port}/oversized`,
      'dummy-secret-for-local-test',
    );
    assert('code' in result && result.code === 'limit_exceeded');
  } finally {
    server.shutdown();
    await server.finished;
  }
});

Deno.test('local HTTP body stall keeps the deadline armed after headers', async () => {
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"choices":['));
            // Headers and a partial body are available, but the body never ends.
          },
        }),
      ),
  );
  const started = performance.now();
  try {
    const address = server.addr as Deno.NetAddr;
    const result = await openRouterModel(
      { messages: [{ role: 'user', content: 'task' }] },
      PROFILE.maxUsd,
      fetch,
      `http://127.0.0.1:${address.port}/stall`,
      'dummy-secret-for-local-test',
      undefined,
      40,
    );
    assert('code' in result && result.code === 'model_error');
    assert(performance.now() - started < 1000);
  } finally {
    server.shutdown();
    await server.finished;
  }
});

Deno.test('basic provider primitive is one-shot and has no budget or tool fields', async () => {
  let seenBody: Record<string, unknown> | undefined;
  let seenAuthorization: string | null = null;
  let requestCount = 0;
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      requestCount++;
      seenBody = await request.json() as Record<string, unknown>;
      seenAuthorization = request.headers.get('authorization');
      return Response.json({
        choices: [{ message: { content: '{"title":"t","summary":"s","steps":[]}' } }],
      });
    },
  );
  try {
    const address = server.addr as Deno.NetAddr;
    const result = await basicOpenRouterModel(
      {
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: '{"task":"basic"}' },
        ],
      },
      fetch,
      `http://127.0.0.1:${address.port}/api/v1/chat/completions`,
      'dummy-basic-secret',
    );
    assert(!('code' in result));
    assertEquals(requestCount, 1);
    assertEquals(seenAuthorization, 'Bearer dummy-basic-secret');
    assertEquals(Object.keys(seenBody ?? {}).sort(), [
      'max_completion_tokens',
      'messages',
      'model',
      'stream',
    ]);
    assertEquals(seenBody?.model, PROFILE.model);
    assertEquals(seenBody?.stream, false);
    assertEquals(seenBody?.max_completion_tokens, 1024);
    assert(!('provider' in (seenBody ?? {})));
    assert(!('tools' in (seenBody ?? {})));
    assert(!JSON.stringify(result).includes('dummy-basic-secret'));
  } finally {
    server.shutdown();
    await server.finished;
  }
});

Deno.test('basic default provider boundary is fixed and sanitizes fetch failures', async () => {
  let requestCount = 0;
  let seenInput: unknown;
  let seenInit: RequestInit | undefined;
  const fetchSpy: typeof fetch = (input, init) => {
    requestCount++;
    seenInput = input;
    seenInit = init;
    return Promise.resolve(new Response('provider-secret-body', { status: 503 }));
  };
  const credential = 'dummy-basic-secret';
  const result = await basicOpenRouterModel(
    { messages: [{ role: 'user', content: 'task' }] },
    fetchSpy,
    undefined,
    credential,
  );
  assert('code' in result && result.code === 'model_error');
  assertEquals(requestCount, 1);
  assertEquals(String(seenInput), `${PROFILE.origin}${PROFILE.path}`);
  assertEquals(seenInit?.redirect, 'error');
  const headers = new Headers(seenInit?.headers);
  assertEquals(headers.get('authorization'), `Bearer ${credential}`);
  assertEquals([...headers.keys()].sort(), ['authorization', 'content-type']);
  const body = typeof seenInit?.body === 'string' ? seenInit.body : '';
  assert(!body.includes(credential));
  const serialized = JSON.stringify(result);
  assert(!serialized.includes(credential));
  assert(!serialized.includes('provider-secret-body'));
});

Deno.test('basic run is state-free, repeats independently, and returns exact raw text', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-basic-cli-' });
  const planText = JSON.stringify({
    title: 'Basic task',
    summary: 'summary',
    steps: [{ id: 'step-1', description: 'do it' }],
  });
  let calls = 0;
  const requests: string[] = [];
  const model = (request: { messages: readonly { role: string; content: string }[] }) => {
    calls++;
    requests.push(request.messages[1].content);
    return Promise.resolve({ text: planText, profile: 'local-basic' });
  };
  const first = await captureCli(() =>
    main([
      'basic',
      'run',
      '--task',
      'first task',
      '--context',
      'first context',
      '--constraints',
      JSON.stringify(['one']),
      '--confirm-external-call',
      '--state-dir',
      `${dir}/state`,
    ], { basicModel: model })
  );
  const second = await captureCli(() =>
    main([
      'basic',
      'run',
      '--task',
      'second task',
      '--confirm-external-call',
      '--state-dir',
      `${dir}/state`,
    ], { basicModel: model })
  );
  assertEquals(first.code, 0);
  assertEquals(second.code, 0);
  assertEquals(calls, 2);
  const firstTerminal = JSON.parse(first.stdout) as Record<string, unknown>;
  const secondTerminal = JSON.parse(second.stdout) as Record<string, unknown>;
  assertEquals(firstTerminal.responseText, planText);
  assert(!('parse' in firstTerminal));
  assert(!('plan' in firstTerminal));
  assert(!('validation' in firstTerminal));
  assertEquals(firstTerminal.requestCount, 1);
  assertEquals(firstTerminal.outcome, { ok: true });
  assertEquals(secondTerminal.requestCount, 1);
  assert(requests[0].includes('first task'));
  assert(requests[1].includes('second task'));
  assert(!(await exists(`${dir}/state`)));
});

Deno.test('basic run treats non-Plan response as passive success without retry or dispatch', async () => {
  let calls = 0;
  const model = () => {
    calls++;
    return Promise.resolve({
      text: '{"tool":"shell","arguments":{"command":"touch"}}',
      profile: 'local',
    });
  };
  const captured = await captureCli(() =>
    main([
      'basic',
      'run',
      '--task',
      'passive task',
      '--confirm-external-call',
    ], { basicModel: model })
  );
  assertEquals(captured.code, 0);
  assertEquals(calls, 1);
  const terminal = JSON.parse(captured.stdout) as Record<string, unknown>;
  assertEquals(terminal.responseText, '{"tool":"shell","arguments":{"command":"touch"}}');
  assert(!('parse' in terminal));
  assert(!('plan' in terminal));
  assert(!('validation' in terminal));
  assertEquals(terminal.requestCount, 1);
  assertEquals(terminal.outcome, { ok: true });
});

Deno.test('basic run returns exact raw text for representative response forms', async () => {
  const cases = [
    { label: 'json', text: '{"title":"t","summary":"s","steps":[]}' },
    { label: 'markdown', text: '# Heading\n\n- item' },
    { label: 'plain', text: 'plain response' },
    { label: 'invalid structured-looking', text: '{"title":42}' },
  ];
  for (const { label, text } of cases) {
    let calls = 0;
    const captured = await captureCli(() =>
      main([
        'basic',
        'run',
        '--task',
        `${label} task`,
        '--confirm-external-call',
      ], {
        basicModel: () => {
          calls++;
          return Promise.resolve({ text, profile: `local-${label}` });
        },
      })
    );
    assertEquals(captured.code, 0);
    assertEquals(calls, 1);
    const terminal = JSON.parse(captured.stdout) as Record<string, unknown>;
    assertEquals(terminal.responseText, text);
    assertEquals(terminal.requestCount, 1);
    assert(typeof terminal.durationMs === 'number' && terminal.durationMs >= 0);
    assertEquals(terminal.outcome, { ok: true });
    assert(!('parse' in terminal));
    assert(!('plan' in terminal));
    assert(!('validation' in terminal));
  }
});
Deno.test('basic run rejects byte limits and confirmation before model request', async () => {
  let calls = 0;
  const model = () => {
    calls++;
    return Promise.resolve({ text: '{}', profile: 'unexpected' });
  };
  const oversized = await captureCli(() =>
    main([
      'basic',
      'run',
      '--task',
      'あ'.repeat(4097),
      '--confirm-external-call',
    ], { basicModel: model })
  );
  assertEquals(oversized.code, 1);
  assertEquals(calls, 0);
  assertEquals((JSON.parse(oversized.stdout) as Record<string, unknown>).requestCount, 0);
  const noConfirmation = await captureCli(() =>
    main([
      'basic',
      'run',
      '--task',
      'task',
    ], { basicModel: model })
  );
  assertEquals(noConfirmation.code, 1);
  assertEquals(calls, 0);
  const noConfirmationTerminal = JSON.parse(noConfirmation.stdout) as Record<string, unknown>;
  assertEquals(noConfirmationTerminal.error, {
    code: 'external_not_authorized',
    message: 'external call confirmation is required',
  });
  assertEquals(noConfirmationTerminal.requestCount, 0);
});

Deno.test('basic run rejects missing option values instead of consuming flags', async () => {
  let calls = 0;
  const model = () => {
    calls++;
    return Promise.resolve({ text: '{}', profile: 'unexpected' });
  };
  const cases = [
    { option: '--task', suffix: ['--task', '--confirm-external-call'] },
    {
      option: '--context',
      suffix: ['--task', 'task', '--context', '--confirm-external-call'],
    },
    {
      option: '--constraints',
      suffix: ['--task', 'task', '--constraints', '--confirm-external-call'],
    },
  ];
  for (const { option, suffix } of cases) {
    const captured = await captureCli(() =>
      main([
        'basic',
        'run',
        ...suffix,
      ], { basicModel: model })
    );
    assertEquals(captured.code, 1);
    const terminal = JSON.parse(captured.stdout) as Record<string, unknown>;
    assertEquals(terminal.error, {
      code: 'invalid_input',
      message: `${option} requires a value`,
    });
    assertEquals(terminal.requestCount, 0);
  }
  assertEquals(calls, 0);
});

Deno.test('basic provider failure has no application retry and next command starts cleanly', async () => {
  let calls = 0;
  const model = () => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(
        failure('model_error', 'provider transport failed', { requestCount: 1 }),
      );
    }
    return Promise.resolve({ text: '{"title":"ok","summary":"s","steps":[]}', profile: 'local' });
  };
  const failed = await captureCli(() =>
    main([
      'basic',
      'run',
      '--task',
      'failed task',
      '--confirm-external-call',
    ], { basicModel: model })
  );
  const recovered = await captureCli(() =>
    main([
      'basic',
      'run',
      '--task',
      'recovered task',
      '--confirm-external-call',
    ], { basicModel: model })
  );
  assertEquals(failed.code, 1);
  assertEquals(recovered.code, 0);
  assertEquals(calls, 2);
  const failedTerminal = JSON.parse(failed.stdout) as Record<string, unknown>;
  assertEquals(failedTerminal.error, {
    code: 'model_error',
    message: 'provider transport failed',
  });
  assertEquals(failedTerminal.requestCount, 1);
  assertEquals(failedTerminal.outcome, { ok: false, code: 'model_error' });
});

Deno.test('external attempt authorization is one-shot and budget bounded', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-attempt-' });
  const attempt = await authorizeAttempt(dir, 'attempt-1', 0.064);
  assert(!('code' in attempt));
  assertEquals(attempt.status, 'authorized');
  const again = await authorizeAttempt(dir, 'attempt-1', 0.064);
  assert('code' in again && again.code === 'state_conflict');
});

Deno.test('attempt budget is bound before a model request and retained after start', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-budget-' });
  assertEquals(PROFILE.worstCaseUsd, 0.062208);
  const low = await authorizeAttempt(dir, 'low-budget', 0.032);
  assert(!('code' in low));
  const lowStart = await startAttempt(dir, low.id);
  assert('code' in lowStart && lowStart.code === 'limit_exceeded');
  const lowState = await readState(dir);
  assert(!('code' in lowState));
  assertEquals(lowState.attempts[0].status, 'authorized');
  assert(validateProfileBudget(0.032)?.code === 'limit_exceeded');

  const high = await authorizeAttempt(dir, 'approved-budget', 0.064);
  assert(!('code' in high));
  const started = await startAttempt(dir, high.id);
  assert(!('code' in started));
  assertEquals(started.maxUsd, 0.064);
  assertEquals(started.requestCount, 1);
  assert(validateProfileBudget(started.maxUsd) === undefined);
});

Deno.test('attempt terminal transitions are one-shot', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'henji-v0-terminal-' });
  const authorized = await authorizeAttempt(dir, 'terminal', PROFILE.maxUsd);
  assert(!('code' in authorized));
  const started = await startAttempt(dir, authorized.id, PROFILE.worstCaseUsd);
  assert(!('code' in started));
  const failed = await updateAttempt(dir, started.id, 'failed', 'local_test');
  assert(!('code' in failed));
  const terminal = await updateAttempt(dir, started.id, 'succeeded');
  assert('code' in terminal && terminal.code === 'state_conflict');
  const retry = await startAttempt(dir, started.id, PROFILE.worstCaseUsd);
  assert('code' in retry && retry.code === 'external_attempt_used');
});

Deno.test('timeout, output overflow, and denied permissions kill and reap the child', async () => {
  const timeout = await writeChild(`${childPreamble}
await readLine();
setInterval(() => {}, 1000);
await new Promise((resolve) => setTimeout(resolve, 100000));
`);
  const timeoutResult = await runChild(timeout.entrypoint, 'host-profile', { sessionMs: 40 });
  assert(timeoutResult.failure?.code === 'process_timeout');

  const output = await writeChild(`${childPreamble}
await readLine();
await Deno.stdout.write(new Uint8Array(513 * 1024));
`);
  const outputResult = await runChild(output.entrypoint);
  assert(outputResult.failure?.code === 'process_output_limit');

  const denied = await writeChild(`${childPreamble}
await readLine();
Deno.env.get('DENIED_PROBE');
`);
  const deniedResult = await runChild(denied.entrypoint);
  assert(deniedResult.failure?.code === 'plugin_exit');
});

Deno.test('session deadline returns while a host model handler remains pending', async () => {
  const child = await writeChild(`${childPreamble}
const input = JSON.parse((await readLine()).trim());
await write({ v: 1, id: 'model', kind: 'request', parentId: input.id, method: 'host.model.generate', payload: { messages: [{ role: 'user', content: 'task' }] } });
setInterval(() => {}, 1000);
await new Promise((resolve) => setTimeout(resolve, 100000));
`);
  const started = performance.now();
  const result = await runExtension({
    denoCommand: deno,
    entrypoint: child.entrypoint,
    cwd: child.dir,
    requestPayload: { task: 'pending host', context: '', constraints: [] },
    modelGenerate: () => new Promise<{ text: string; profile: string }>(() => {}),
    modelProfile: 'host-profile',
    limits: { sessionMs: 40 },
  });
  assert(result.failure?.code === 'process_timeout');
  assert(performance.now() - started < 1000);
});

Deno.test('permission probe source is rejected by self-contained guard', () => {
  assert(scanSelfContained('const x = Deno.env.get("X");') === undefined);
  assert(scanSelfContained('const x = new Worker("x");')?.code === 'source_rejected');
});

Deno.test('default state follows XDG or platform user-local convention, never cwd', () => {
  assertEquals(
    defaultStateDirFor({ XDG_STATE_HOME: '/tmp/user-state', HOME: '/home/user' }, 'linux'),
    '/tmp/user-state/henji-harness/v0',
  );
  assertEquals(
    defaultStateDirFor({ HOME: '/home/user' }, 'linux'),
    '/home/user/.local/state/henji-harness/v0',
  );
  assertEquals(
    defaultStateDirFor({ HOME: '/Users/user' }, 'darwin'),
    '/Users/user/Library/Application Support/henji-harness/v0',
  );
  assert(!defaultStateDirFor({ HOME: '/home/user' }, 'linux').includes(Deno.cwd()));
});
