import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import {
  FIXED_TASK,
  GuardedModel,
  MAX_SENTINEL_REQUESTS,
  runSentinel,
  TASK_ID,
  TOOL_ORDER,
} from '../../v0/agent/work_tools_sentinel.ts';
import { createWorkToolsRegistry } from '../../v0/agent/registries.ts';
import { type Message, type ModelRequest, type ModelResult } from '../../v0/agent/contracts.ts';
import {
  CHILD_ENTRYPOINT,
  DENO_COMMAND,
  main as launcherMain,
  SECRET_ENV,
  type SentinelChild,
  type SentinelCommandOptions,
} from '../../v0/agent/work_tools_sentinel_launcher.ts';
import {
  CREDENTIAL_PATH,
  type CredentialFileHandle,
  type CredentialFileMetadata,
  type CredentialFileSystem,
} from '../../v0/eval/live_corpus_credential_launcher.ts';

const DUMMY_CREDENTIAL = 'dummy-work-tools-sentinel-secret';
const encoder = new TextEncoder();

const calls: readonly { name: string; arguments: unknown }[] = [
  { name: 'write', arguments: { path: 'work/item.txt', content: 'alpha\n' } },
  { name: 'read', arguments: { path: 'work/item.txt' } },
  {
    name: 'edit',
    arguments: { path: 'work/item.txt', edits: [{ oldText: 'alpha\n', newText: 'beta\n' }] },
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

const resultTexts = [
  '{"path":"work/item.txt","bytes":6}',
  'alpha\n',
  '{"path":"work/item.txt","edits":1,"bytes":5}',
  '{"stdout":"verified:5","stderr":"","exitCode":0,"signal":null,"timedOut":false,"stdoutTruncated":false,"stderrTruncated":false}',
  'json result submitted',
] as const;

const providerResponse = (ordinal: number): Response =>
  new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `dummy-call-${ordinal + 1}`,
            type: 'function',
            function: {
              name: calls[ordinal].name,
              arguments: JSON.stringify(calls[ordinal].arguments),
            },
          }],
        },
      }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const workspace = (): Promise<string> => Deno.makeTempDir({ prefix: 'henji-sentinel-test-' });

Deno.test('fixed sentinel runs the exact five causal work calls with fake provider only', async () => {
  const root = await workspace();
  let requests = 0;
  try {
    const result = await runSentinel({
      workspaceRoot: root,
      credential: DUMMY_CREDENTIAL,
      fetcher: (_input, init) => {
        requests += 1;
        assert(typeof init?.body === 'string');
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        assertEquals(body.model, 'google/gemini-3.7-flash');
        assertEquals((body.messages as Array<{ content?: string }>)[0].content, FIXED_TASK);
        return Promise.resolve(providerResponse(requests - 1));
      },
    });
    assertEquals(requests, 5);
    assertEquals(result.externalRequests, 5);
    assert(result.report.ok);
    assertEquals(result.report.taskId, TASK_ID);
    assertEquals(result.report.modelRequests, MAX_SENTINEL_REQUESTS);
    assertEquals(result.report.toolOrder, TOOL_ORDER);
    assertEquals(result.report.result, {
      path: 'work/item.txt',
      content: 'beta\n',
      bytes: 5,
      bash: 'verified:5',
    });
    assertEquals(await Deno.readTextFile(`${root}/work/item.txt`), 'beta\n');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('sentinel provider/adherence failures are bounded and sanitized', async () => {
  const root = await workspace();
  try {
    const result = await runSentinel({
      workspaceRoot: root,
      credential: DUMMY_CREDENTIAL,
      fetcher: () => Promise.reject(new Error('secret-provider-marker')),
    });
    assert(!result.report.ok);
    assertEquals(result.report.code, 'provider_failure');
    assertEquals(result.externalRequests, 1);
    assert(!JSON.stringify(result.report).includes('secret-provider-marker'));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('guard rejects early final, wrong calls, changed results, and sixth request before delegate', async () => {
  const registry = createWorkToolsRegistry({ root: '/tmp' });
  let delegateCalls = 0;
  const delegate = {
    generate: (request: ModelRequest): ModelResult => {
      delegateCalls += 1;
      const ordinal = (request.transcript.length - 1) / 2;
      return {
        kind: 'tool_calls',
        calls: [{
          callId: `guard-call-${ordinal + 1}`,
          name: calls[ordinal].name,
          arguments: calls[ordinal].arguments as never,
        }],
      };
    },
  };
  const guarded = new GuardedModel(delegate, registry.definitions());
  const transcript: Message[] = [{ role: 'user', content: { kind: 'text', text: FIXED_TASK } }];
  for (let ordinal = 0; ordinal < MAX_SENTINEL_REQUESTS; ordinal += 1) {
    const request = { transcript, tools: registry.definitions() };
    const result = await guarded.generate(request);
    assert(result.kind === 'tool_calls');
    const call = result.calls[0];
    transcript.push({ role: 'assistant', content: [{ kind: 'tool_call', ...call }] });
    transcript.push({
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: call.callId,
        name: call.name,
        text: resultTexts[ordinal],
        outcome: 'success',
        ...(ordinal === MAX_SENTINEL_REQUESTS - 1 ? { terminal: 'json_result' as const } : {}),
      }],
    });
  }
  assertEquals(delegateCalls, 5);
  await assertRejects(() => guarded.generate({ transcript, tools: registry.definitions() }));
  assertEquals(delegateCalls, 5);

  const wrong = new GuardedModel(
    { generate: () => ({ kind: 'final', text: 'early-final' }) },
    registry.definitions(),
  );
  await assertRejects(() =>
    wrong.generate({
      transcript: [{ role: 'user', content: { kind: 'text', text: FIXED_TASK } }],
      tools: registry.definitions(),
    })
  );
  assertEquals(delegateCalls, 5);
  const wrongCall = new GuardedModel({
    generate: () => ({
      kind: 'tool_calls',
      calls: [{ callId: 'wrong', name: 'read', arguments: { path: 'work/item.txt', extra: true } }],
    }),
  }, registry.definitions());
  await assertRejects(() =>
    wrongCall.generate({
      transcript: [{ role: 'user', content: { kind: 'text', text: FIXED_TASK } }],
      tools: registry.definitions(),
    })
  );
  const changed = new GuardedModel(delegate, registry.definitions());
  const first = await changed.generate({
    transcript: [{ role: 'user', content: { kind: 'text', text: FIXED_TASK } }],
    tools: registry.definitions(),
  });
  assert(first.kind === 'tool_calls');
  const changedCall = first.calls[0];
  await assertRejects(() =>
    changed.generate({
      transcript: [
        { role: 'user', content: { kind: 'text', text: FIXED_TASK } },
        { role: 'assistant', content: [{ kind: 'tool_call', ...changedCall }] },
        {
          role: 'tool',
          content: [{
            kind: 'tool_result',
            callId: changedCall.callId,
            name: changedCall.name,
            text: 'tampered',
            outcome: 'success',
          }],
        },
      ],
      tools: registry.definitions(),
    })
  );
  assert(encoder.encode(DUMMY_CREDENTIAL).byteLength > 0);
});

Deno.test('guard classifies an expected correlated tool error before the next fetch', async () => {
  const registry = createWorkToolsRegistry({ root: '/tmp' });
  let delegateCalls = 0;
  const guarded = new GuardedModel({
    generate: (request: ModelRequest): ModelResult => {
      delegateCalls += 1;
      const ordinal = (request.transcript.length - 1) / 2;
      return {
        kind: 'tool_calls',
        calls: [{
          callId: `failed-write-${ordinal + 1}`,
          name: calls[ordinal].name,
          arguments: calls[ordinal].arguments as never,
        }],
      };
    },
  }, registry.definitions());
  const firstTranscript: Message[] = [{
    role: 'user',
    content: { kind: 'text', text: FIXED_TASK },
  }];
  const first = await guarded.generate({
    transcript: firstTranscript,
    tools: registry.definitions(),
  });
  assert(first.kind === 'tool_calls');
  const firstCall = first.calls[0];
  const nextTranscript: Message[] = [
    ...firstTranscript,
    { role: 'assistant', content: [{ kind: 'tool_call', ...firstCall }] },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: firstCall.callId,
        name: firstCall.name,
        text: 'tool execution error: failed write',
        outcome: 'error',
      }],
    },
  ];
  await assertRejects(() =>
    guarded.generate({
      transcript: nextTranscript,
      tools: registry.definitions(),
    })
  );
  assertEquals(guarded.failureCode, 'tool_execution_failure');
  assertEquals(delegateCalls, 1);
});

const launcherCredentialFilesystem = (
  calls: { lstat: number; open: number },
): CredentialFileSystem => {
  const bytes = encoder.encode(`${DUMMY_CREDENTIAL}\n`);
  const metadata: CredentialFileMetadata = {
    isFile: true,
    isSymlink: false,
    mode: 0o600,
    size: bytes.byteLength,
    uid: 1000,
    dev: 1,
    ino: 2,
  };
  return {
    effectiveUid: () => 1000,
    lstat: (path) => {
      calls.lstat += 1;
      assertEquals(path, CREDENTIAL_PATH);
      return Promise.resolve(metadata);
    },
    open: (path) => {
      calls.open += 1;
      assertEquals(path, CREDENTIAL_PATH);
      let offset = 0;
      const file: CredentialFileHandle = {
        stat: () => Promise.resolve(metadata),
        read: (buffer) => {
          if (offset >= bytes.byteLength) return Promise.resolve(null);
          const count = Math.min(buffer.byteLength, bytes.byteLength - offset);
          buffer.set(bytes.subarray(offset, offset + count));
          offset += count;
          return Promise.resolve(count);
        },
        close: () => {},
      };
      return Promise.resolve(file);
    },
  };
};

type CredentialFailureKind =
  | 'credential_metadata_invalid'
  | 'credential_metadata_changed'
  | 'credential_open_failed'
  | 'credential_read_failed'
  | 'credential_oversize'
  | 'credential_invalid';

const credentialFailureFilesystem = (kind: CredentialFailureKind): CredentialFileSystem => {
  const normalBytes = encoder.encode(`${DUMMY_CREDENTIAL}\n`);
  const invalidBytes = encoder.encode('invalid token\n');
  const oversizedBytes = new Uint8Array(4097);
  const bytes = kind === 'credential_invalid'
    ? invalidBytes
    : kind === 'credential_oversize'
    ? oversizedBytes
    : normalBytes;
  const metadata: CredentialFileMetadata = {
    isFile: true,
    isSymlink: false,
    mode: kind === 'credential_metadata_invalid' ? 0o644 : 0o600,
    size: kind === 'credential_oversize' ? 4096 : bytes.byteLength,
    uid: 1000,
    dev: 1,
    ino: 2,
  };
  return {
    effectiveUid: () => 1000,
    lstat: (path) => {
      assertEquals(path, CREDENTIAL_PATH);
      return Promise.resolve(metadata);
    },
    open: (path) => {
      assertEquals(path, CREDENTIAL_PATH);
      if (kind === 'credential_open_failed') return Promise.reject(new Error('open marker'));
      let offset = 0;
      const file: CredentialFileHandle = {
        stat: () => {
          if (kind === 'credential_read_failed') return Promise.reject(new Error('stat marker'));
          if (kind === 'credential_metadata_changed') {
            return Promise.resolve({ ...metadata, size: metadata.size + 1 });
          }
          return Promise.resolve(metadata);
        },
        read: (buffer) => {
          if (kind === 'credential_read_failed') return Promise.reject(new Error('read marker'));
          if (kind === 'credential_oversize') return Promise.resolve(buffer.byteLength);
          if (offset >= bytes.byteLength) return Promise.resolve(null);
          const count = Math.min(buffer.byteLength, bytes.byteLength - offset);
          buffer.set(bytes.subarray(offset, offset + count));
          offset += count;
          return Promise.resolve(count);
        },
        close: () => {},
      };
      return Promise.resolve(file);
    },
  };
};

Deno.test('launcher maps every existing credential failure code without child or workspace access', async () => {
  const kinds: readonly CredentialFailureKind[] = [
    'credential_metadata_invalid',
    'credential_metadata_changed',
    'credential_open_failed',
    'credential_read_failed',
    'credential_oversize',
    'credential_invalid',
  ];
  for (const kind of kinds) {
    const stderr: string[] = [];
    let spawned = 0;
    const exit = await launcherMain([], {
      filesystem: credentialFailureFilesystem(kind),
      makeWorkspace: () => {
        spawned += 1;
        throw new Error('workspace must not be created');
      },
      spawn: () => {
        spawned += 1;
        return fakeChild('');
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
    });
    assertEquals(exit, 1);
    const report = JSON.parse(stderr[0]) as Record<string, unknown>;
    assertEquals(report.stage, 'credential');
    assertEquals(report.code, kind);
    assertEquals(report.childCount, 0);
    assertEquals(report.externalRequests, 0);
    assertEquals(report.workspaceRemoved, null);
    assertEquals(spawned, 0);
  }
});

const readable = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

const childReport = (): string =>
  JSON.stringify({
    schemaVersion: 1,
    taskId: TASK_ID,
    profile: 'openrouter-google-gemini-3.7-flash-vertex-v0',
    ok: true,
    outcome: 'passed',
    modelRequests: 5,
    externalRequests: 5,
    steps: 5,
    toolCalls: 5,
    toolResults: 5,
    toolOrder: [...TOOL_ORDER],
    stopReason: 'tool_terminal',
    terminalKind: 'json_result',
    transcriptValidated: true,
    workspaceValidated: true,
    result: { path: 'work/item.txt', content: 'beta\n', bytes: 5, bash: 'verified:5' },
  }) + '\n';

const childFailureReport = (code: 'provider_failure' | 'tool_execution_failure'): string =>
  JSON.stringify({
    schemaVersion: 1,
    taskId: TASK_ID,
    profile: 'openrouter-google-gemini-3.7-flash-vertex-v0',
    ok: false,
    outcome: 'aborted',
    code,
    modelRequests: 1,
    externalRequests: 1,
    steps: 1,
    toolCalls: 0,
    toolResults: 0,
    toolOrder: [],
    stopReason: 'contract_failure',
    terminalKind: null,
    transcriptValidated: false,
    workspaceValidated: false,
  }) + '\n';

const fakeChild = (stdout: string, stderr = ''): SentinelChild => ({
  stdout: readable(stdout),
  stderr: readable(stderr),
  status: Promise.resolve({ success: true, code: 0, signal: null }),
  kill: () => {},
});

const controlledChild = (
  output: 'quiet' | 'ignore-term' | 'stdout-overflow' | 'stderr-overflow',
): {
  child: SentinelChild;
  signals: Deno.Signal[];
} => {
  let resolveStatus!: (
    status: { success: boolean; code: number | null; signal: string | null },
  ) => void;
  let closeStdout!: () => void;
  let closeStderr!: () => void;
  const status = new Promise<{ success: boolean; code: number | null; signal: string | null }>(
    (resolve) => resolveStatus = resolve,
  );
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStdout = () => controller.close();
      if (output === 'stdout-overflow') controller.enqueue(new Uint8Array(8 * 1024 + 1));
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStderr = () => controller.close();
      if (output === 'stderr-overflow') controller.enqueue(new Uint8Array(8 * 1024 + 1));
    },
  });
  const signals: Deno.Signal[] = [];
  return {
    child: {
      stdout,
      stderr,
      status,
      kill: (signal = 'SIGTERM') => {
        signals.push(signal);
        if (output === 'ignore-term' && signal !== 'SIGKILL') return;
        closeStdout();
        closeStderr();
        resolveStatus({ success: false, code: null, signal });
      },
    },
    signals,
  };
};

Deno.test('launcher validates arguments before one credential read and one child', async () => {
  const calls = { lstat: 0, open: 0 };
  let spawned = 0;
  const stderr: string[] = [];
  const exit = await launcherMain(['unexpected'], {
    filesystem: launcherCredentialFilesystem(calls),
    spawn: () => {
      spawned += 1;
      return fakeChild(childReport());
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  });
  assertEquals(exit, 1);
  assertEquals(calls, { lstat: 0, open: 0 });
  assertEquals(spawned, 0);
  assertEquals(stderr.length, 1);
  assert(stderr[0].includes('arguments_invalid'));
  assert(!stderr[0].includes(DUMMY_CREDENTIAL));
});

Deno.test('launcher accepts only the sanitized child tuple and removes its one workspace', async () => {
  const calls = { lstat: 0, open: 0 };
  let invocation: { command: string; options: SentinelCommandOptions } | undefined;
  let path: string | undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await launcherMain([], {
    filesystem: launcherCredentialFilesystem(calls),
    makeWorkspace: async () => {
      path = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-launcher-test-' });
      await Deno.chmod(path, 0o700);
      return path;
    },
    validateWorkspace: () => Promise.resolve(true),
    spawn: (command, options) => {
      invocation = { command, options };
      return fakeChild(childReport());
    },
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  });
  assertEquals(exit, 0);
  assertEquals(calls.lstat, 1);
  assertEquals(calls.open, 1);
  assertEquals(stderr, []);
  assertEquals(stdout.length, 1);
  assert(JSON.parse(stdout[0]).workspaceRemoved === true);
  assert(invocation !== undefined);
  assertEquals(invocation.command, DENO_COMMAND);
  assertEquals(invocation.options.clearEnv, true);
  assertEquals(invocation.options.env, { [SECRET_ENV]: DUMMY_CREDENTIAL });
  assertEquals(invocation.options.stdin, 'null');
  assertEquals(invocation.options.args, [
    'run',
    '--no-prompt',
    '--no-remote',
    `--allow-env=${SECRET_ENV}`,
    '--allow-net=openrouter.ai',
    `--allow-read=${path}`,
    `--allow-write=${path}`,
    '--allow-run=/bin/bash',
    CHILD_ENTRYPOINT,
  ]);
  assert(!invocation.options.args.some((arg) => arg.includes(DUMMY_CREDENTIAL)));
  assert(path !== undefined);
  try {
    await Deno.stat(path);
    throw new Error('workspace should be removed');
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
});

Deno.test('launcher rejects raw child output and still cleans up without redaction leaks', async () => {
  const calls = { lstat: 0, open: 0 };
  let path: string | undefined;
  const stderr: string[] = [];
  const exit = await launcherMain([], {
    filesystem: launcherCredentialFilesystem(calls),
    makeWorkspace: async () => {
      path = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-launcher-invalid-' });
      return path;
    },
    spawn: () => fakeChild('raw-secret-provider-marker\n'),
    writeStderr: (text) => {
      stderr.push(text);
    },
  });
  assertEquals(exit, 1);
  assert(stderr[0].includes('child_report_invalid'));
  assert(!stderr[0].includes('raw-secret-provider-marker'));
  assert(path !== undefined);
  try {
    await Deno.stat(path);
    throw new Error('workspace should be removed');
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
});

Deno.test('launcher preserves a valid nonzero child failure report and observed requests', async () => {
  const calls = { lstat: 0, open: 0 };
  let path: string | undefined;
  const stderr: string[] = [];
  const exit = await launcherMain([], {
    filesystem: launcherCredentialFilesystem(calls),
    makeWorkspace: async () => {
      path = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-launcher-child-failure-' });
      await Deno.chmod(path, 0o700);
      return path;
    },
    spawn: () => ({
      ...fakeChild(childFailureReport('provider_failure')),
      status: Promise.resolve({ success: false, code: 1, signal: null }),
    }),
    writeStderr: (text) => {
      stderr.push(text);
    },
  });
  assertEquals(exit, 1);
  const report = JSON.parse(stderr[0]) as Record<string, unknown>;
  assertEquals(report.stage, 'execution');
  assertEquals(report.code, 'provider_failure');
  assertEquals(report.externalRequests, 1);
  assertEquals(report.childCount, 1);
  assert(path !== undefined);
  try {
    await Deno.stat(path);
    throw new Error('child-failure workspace should be removed');
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
});

Deno.test('launcher maps spawn, child-status, and cleanup failures to static outcomes', async () => {
  const cases: readonly ['spawn' | 'status' | 'wait' | 'cleanup', string][] = [
    ['spawn', 'child_spawn_failed'],
    ['status', 'child_exit_failed'],
    ['wait', 'child_wait_failed'],
    ['cleanup', 'cleanup_failed'],
  ];
  const createdPaths: string[] = [];
  let cleanupError: unknown;
  try {
    for (const [kind, expected] of cases) {
      const calls = { lstat: 0, open: 0 };
      let path: string | undefined;
      const stderr: string[] = [];
      const exit = await launcherMain([], {
        filesystem: launcherCredentialFilesystem(calls),
        makeWorkspace: async () => {
          path = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-launcher-failure-' });
          createdPaths.push(path);
          return path;
        },
        spawn: () => {
          if (kind === 'spawn') throw new Error('raw-spawn-marker');
          if (kind === 'status') {
            return {
              ...fakeChild(''),
              status: Promise.resolve({ success: false, code: 23, signal: null }),
            };
          }
          if (kind === 'wait') {
            return {
              ...fakeChild(''),
              status: Promise.reject(new Error('raw-wait-marker')),
            };
          }
          return fakeChild(childReport());
        },
        validateWorkspace: () => Promise.resolve(true),
        removeWorkspace: async (target) => {
          if (kind === 'cleanup') throw new Error(`raw-cleanup-marker-${target}`);
          await Deno.remove(target, { recursive: true });
        },
        writeStderr: (text) => {
          stderr.push(text);
        },
      });
      assertEquals(exit, 1);
      assert(stderr[0].includes(expected));
      assert(!stderr[0].includes('raw-'));
      const report = JSON.parse(stderr[0]) as Record<string, unknown>;
      if (kind === 'status' || kind === 'wait') assertEquals(report.externalRequests, null);
      if (kind === 'cleanup') {
        assert(path !== undefined);
        await Deno.stat(path);
      }
      if (kind !== 'cleanup') {
        assert(path !== undefined);
        try {
          await Deno.stat(path);
        } catch (error) {
          assert(error instanceof Deno.errors.NotFound);
        }
      }
    }
  } finally {
    let removed = 0;
    for (const target of createdPaths) {
      assert(target.startsWith('/tmp/henji-launcher-failure-'));
      try {
        await Deno.remove(target, { recursive: true });
        removed += 1;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) cleanupError = error;
      }
    }
    assertEquals(removed, 1);
  }
  if (cleanupError !== undefined) throw cleanupError;
});

Deno.test('launcher bounds deadline and channel overflow with kill, reap, and cleanup', async () => {
  const cases: readonly ['deadline' | 'stdout' | 'stderr', string][] = [
    ['deadline', 'deadline_exceeded'],
    ['stdout', 'stdout_overflow'],
    ['stderr', 'stderr_overflow'],
  ];
  for (const [kind, expected] of cases) {
    const calls = { lstat: 0, open: 0 };
    let path: string | undefined;
    const stderr: string[] = [];
    const controlled = controlledChild(kind === 'deadline' ? 'quiet' : `${kind}-overflow` as const);
    const exit = await launcherMain([], {
      filesystem: launcherCredentialFilesystem(calls),
      makeWorkspace: async () => {
        path = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-launcher-bounds-' });
        await Deno.chmod(path, 0o700);
        return path;
      },
      spawn: () => controlled.child,
      childDeadlineMs: kind === 'deadline' ? 1 : 1_000,
      childGraceMs: 1,
      writeStderr: (text) => {
        stderr.push(text);
      },
    });
    assertEquals(exit, 1);
    assert(stderr[0].includes(expected));
    assertEquals(controlled.signals[0], 'SIGTERM');
    assert(path !== undefined);
    try {
      await Deno.stat(path);
      throw new Error('bounded workspace should be removed');
    } catch (error) {
      assert(error instanceof Deno.errors.NotFound);
    }
  }
});

Deno.test('launcher maps a handled signal separately and still cleans up', async () => {
  const calls = { lstat: 0, open: 0 };
  let path: string | undefined;
  const stderr: string[] = [];
  const controlled = controlledChild('ignore-term');
  const started = performance.now();
  const exit = await launcherMain([], {
    filesystem: launcherCredentialFilesystem(calls),
    makeWorkspace: async () => {
      path = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-launcher-signal-' });
      await Deno.chmod(path, 0o700);
      return path;
    },
    spawn: () => controlled.child,
    childGraceMs: 5,
    addSignalListener: (_signal, handler) => {
      setTimeout(handler, 0);
      return () => {};
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  });
  assert(performance.now() - started < 1_000);
  assertEquals(exit, 1);
  assert(stderr[0].includes('child_signal'));
  assertEquals(controlled.signals, ['SIGTERM', 'SIGKILL']);
  assert(path !== undefined);
  try {
    await Deno.stat(path);
    throw new Error('signaled workspace should be removed');
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
});
