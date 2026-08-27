import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import {
  CHILD_MODEL_REQUESTS,
  createGuardedFetch,
  EXPECTED_CHILD_FINAL,
  EXPECTED_PARENT_FINAL,
  FIXED_DELEGATED_TASK,
  MAX_SENTINEL_REQUESTS,
  PARENT_MODEL_REQUESTS,
  PARENT_TOOL_ORDER,
  REQUEST_ORDER,
  runSentinel,
  validateSentinelWorkspace,
} from '../../v0/agent/planner_delegation_sentinel.ts';
import {
  CHILD_ENTRYPOINT,
  createSentinelWorkspace,
  DENO_COMMAND,
  main as launcherMain,
  parseChildReport,
  SECRET_ENV,
  type SentinelChild,
  type SentinelChildStatus,
} from '../../v0/agent/planner_delegation_sentinel_launcher.ts';
import {
  CREDENTIAL_PATH,
  type CredentialFileHandle,
  type CredentialFileMetadata,
  type CredentialFileSystem,
} from '../../v0/eval/live_corpus_credential_launcher.ts';

const DUMMY_CREDENTIAL = 'dummy-planner-sentinel-secret';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toolCallPayload = (
  id = 'planner-delegate-1',
  name = 'delegate_to_planner',
  task = FIXED_DELEGATED_TASK,
): Response =>
  new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify({ task }) },
          }],
        },
      }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const finalPayload = (text: string): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const workspace = async (): Promise<string> => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-planner-sentinel-test-' });
  await Deno.chmod(root, 0o700);
  return root;
};

const successResponses = (): readonly Response[] => [
  toolCallPayload(),
  finalPayload(EXPECTED_CHILD_FINAL),
  finalPayload(EXPECTED_PARENT_FINAL),
];

const runWithResponses = async (
  responses: readonly Response[],
  options: { readonly workspaceRoot?: string } = {},
) => {
  let index = 0;
  const requests: Record<string, unknown>[] = [];
  const root = options.workspaceRoot ?? await workspace();
  const result = await runSentinel({
    workspaceRoot: root,
    credential: DUMMY_CREDENTIAL,
    fetcher: (_input, init) => {
      assert(typeof init?.body === 'string');
      requests.push(JSON.parse(init.body));
      const response = responses[index++];
      if (response === undefined) throw new Error('unexpected provider request');
      return Promise.resolve(response);
    },
  });
  return { result, requests, root };
};

Deno.test('fixed planner sentinel proves parent/child/parent causal success with fake provider', async () => {
  const { result, requests, root } = await runWithResponses(successResponses());
  try {
    assert(result.report.ok);
    assertEquals(result.externalRequests, 3);
    assertEquals(result.report.parentModelRequests, PARENT_MODEL_REQUESTS);
    assertEquals(result.report.childModelRequests, CHILD_MODEL_REQUESTS);
    assertEquals(result.report.aggregateModelRequests, MAX_SENTINEL_REQUESTS);
    assertEquals(result.report.delegationCalls, 1);
    assertEquals(result.report.delegationResults, 1);
    assertEquals(result.report.requestOrder, REQUEST_ORDER);
    assertEquals(result.report.parentToolOrder, PARENT_TOOL_ORDER);
    assertEquals(result.report.parentStopReason, 'final');
    assertEquals(result.report.childCompletedBeforeParentFinal, true);
    assertEquals(requests.length, 3);
    assertEquals((requests[0].messages as unknown[]).length, 1);
    assertEquals(requests[1].messages as unknown[], [
      {
        role: 'system',
        content:
          'You are the built-in planner agent. Inspect the available workspace context needed for the task and produce a clear implementation plan. Do not mutate the workspace.',
      },
      { role: 'user', content: FIXED_DELEGATED_TASK },
    ]);
    assertEquals((requests[2].messages as unknown[]).length, 3);
    assertEquals(await validateSentinelWorkspace({ root }), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('guarded requests expose exact parent six-tool and child two-tool registries', async () => {
  const { result, requests, root } = await runWithResponses(successResponses());
  try {
    assert(result.report.ok);
    assertEquals((requests[0].tools as unknown[]).length, 6);
    assertEquals((requests[1].tools as unknown[]).length, 2);
    assertEquals((requests[2].tools as unknown[]).length, 6);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('provider failure is bounded and does not expose provider markers', async () => {
  const root = await workspace();
  try {
    const result = await runSentinel({
      workspaceRoot: root,
      credential: DUMMY_CREDENTIAL,
      fetcher: () => Promise.reject(new Error('provider-secret-marker')),
    });
    assert(!result.report.ok);
    assertEquals(result.report.code, 'provider_failure');
    assertEquals(result.externalRequests, 1);
    assert(!JSON.stringify(result.report).includes('provider-secret-marker'));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('wrong provider tool, early final, and wrong parent final fail before later fetches', async () => {
  for (
    const responses of [
      [
        toolCallPayload('wrong', 'read'),
        finalPayload(EXPECTED_CHILD_FINAL),
        finalPayload(EXPECTED_PARENT_FINAL),
      ],
      [
        finalPayload('early'),
        finalPayload(EXPECTED_CHILD_FINAL),
        finalPayload(EXPECTED_PARENT_FINAL),
      ],
      [toolCallPayload(), finalPayload(EXPECTED_CHILD_FINAL), finalPayload('wrong-final')],
    ] as const
  ) {
    const { result, requests, root } = await runWithResponses(responses);
    try {
      assert(!result.report.ok);
      assertEquals(requests.length, result.externalRequests);
      assert(result.externalRequests <= 3);
      assert(['model_adherence_failure', 'parent_final_mismatch'].includes(result.report.code));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test('request contract rejects a fourth request before the underlying fetch', async () => {
  const root = await workspace();
  try {
    const validRequests: Array<{ input: RequestInfo; init: RequestInit }> = [];
    let seedCalls = 0;
    const seed = await runSentinel({
      workspaceRoot: root,
      credential: DUMMY_CREDENTIAL,
      fetcher: (input, init) => {
        assert(typeof init?.body === 'string');
        validRequests.push({
          input: String(input),
          init: {
            method: init.method,
            headers: new Headers(init.headers),
            body: init.body,
            redirect: init.redirect,
          },
        });
        const response = successResponses()[seedCalls++];
        assert(response !== undefined);
        return Promise.resolve(response);
      },
    });
    assert(seed.report.ok);
    assertEquals(validRequests.length, 3);
    let calls = 0;
    const guarded = createGuardedFetch({ root }, () => {
      calls += 1;
      const response = successResponses()[calls - 1];
      assert(response !== undefined);
      return Promise.resolve(response);
    });
    for (const request of validRequests) await guarded.fetch(request.input, request.init);
    assertEquals(calls, 3);
    // A fourth valid-shaped request is rejected by the bound before the delegated fetch.
    await assertRejects(() => guarded.fetch(validRequests[2].input, validRequests[2].init));
    assertEquals(calls, 3);
    assertEquals(guarded.state.requestCount, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('workspace mismatch and argument rejection occur before provider access', async () => {
  const root = await workspace();
  await Deno.writeTextFile(`${root}/unexpected.txt`, 'marker');
  try {
    let calls = 0;
    const result = await runSentinel({
      workspaceRoot: root,
      credential: DUMMY_CREDENTIAL,
      fetcher: () => {
        calls += 1;
        return Promise.reject(new Error('must not fetch'));
      },
    });
    assert(!result.report.ok);
    assertEquals(result.report.code, 'workspace_mismatch');
    assertEquals(calls, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
  // Argument rejection is covered by the launcher boundary, whose child has no application args.
});

const credentialFilesystem = (credential = DUMMY_CREDENTIAL): CredentialFileSystem => {
  const bytes = encoder.encode(`${credential}\n`);
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
      assertEquals(path, CREDENTIAL_PATH);
      return Promise.resolve(metadata);
    },
    open: (path) => {
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

const childStream = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

const child = (
  stdout: string,
  stderr = '',
  status: Partial<SentinelChildStatus> = {},
): SentinelChild => ({
  stdout: childStream(stdout),
  stderr: childStream(stderr),
  status: Promise.resolve({ success: true, code: 0, signal: null, ...status }),
  kill: () => {},
});

const childSuccess = JSON.stringify({
  schemaVersion: 1,
  taskId: 'v1.planner-delegation.fixed',
  profile: 'openrouter-google-gemini-3.7-flash-vertex-v0',
  ok: true,
  outcome: 'passed',
  parentModelRequests: 2,
  childModelRequests: 1,
  aggregateModelRequests: 3,
  externalRequests: 3,
  delegationCalls: 1,
  delegationResults: 1,
  requestOrder: ['parent', 'child', 'parent'],
  parentToolOrder: ['delegate_to_planner'],
  parentStopReason: 'final',
  plannerFinalValidated: true,
  childCompletedBeforeParentFinal: true,
  plannerNonMutating: true,
  plannerNonRecursive: true,
  transcriptValidated: true,
  workspaceValidated: true,
}) + '\n';

Deno.test('launcher reads one dummy credential and starts one exact isolated child', async () => {
  let path: string | undefined;
  let invocation: { command: string; options: unknown } | undefined;
  const signalRegistrations: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await launcherMain([], {
    filesystem: credentialFilesystem(),
    makeWorkspace: async () => {
      path = await workspace();
      return path;
    },
    spawn: (command, options) => {
      assertEquals(signalRegistrations, ['SIGHUP', 'SIGINT', 'SIGTERM']);
      invocation = { command, options };
      return child(childSuccess);
    },
    addSignalListener: (signal) => {
      signalRegistrations.push(signal);
      return () => {};
    },
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  });
  assertEquals(exit, 0);
  assertEquals(signalRegistrations, ['SIGHUP', 'SIGINT', 'SIGTERM']);
  assertEquals(stderr, []);
  assertEquals(stdout.length, 1);
  const report = JSON.parse(stdout[0]);
  assertEquals(report.externalRequests, 3);
  assert(invocation !== undefined);
  assertEquals(invocation.command, DENO_COMMAND);
  assertEquals(invocation.options, {
    args: [
      'run',
      '--no-prompt',
      '--no-remote',
      `--allow-env=${SECRET_ENV}`,
      '--allow-net=openrouter.ai',
      `--allow-read=${path}`,
      CHILD_ENTRYPOINT,
    ],
    cwd: path,
    clearEnv: true,
    env: { [SECRET_ENV]: DUMMY_CREDENTIAL },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  });
  assert(path !== undefined);
  try {
    await Deno.stat(path);
    throw new Error('workspace was not removed');
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
});

Deno.test('launcher rejects arguments before credential read and sanitizes child evidence failures', async () => {
  let reads = 0;
  const filesystem = credentialFilesystem();
  const wrapped: CredentialFileSystem = {
    ...filesystem,
    lstat: (path) => {
      reads += 1;
      return filesystem.lstat(path);
    },
  };
  const errors: string[] = [];
  assertEquals(
    await launcherMain(['bad'], {
      filesystem: wrapped,
      writeStderr: (text) => {
        errors.push(text);
      },
    }),
    1,
  );
  assertEquals(reads, 0);
  assertEquals(errors.length, 1);
  assertEquals(JSON.parse(errors[0]).code, 'arguments_invalid');
  const childErrors: string[] = [];
  const exit = await launcherMain([], {
    filesystem: credentialFilesystem(),
    makeWorkspace: workspace,
    spawn: () => child('', 'raw-child-secret-marker'),
    writeStderr: (text) => {
      childErrors.push(text);
    },
  });
  assertEquals(exit, 1);
  assertEquals(JSON.parse(childErrors[0]).code, 'child_report_invalid');
  assert(!childErrors.join('').includes('raw-child-secret-marker'));
});

Deno.test('child report parser is strict and rejects extra or malformed evidence', () => {
  assert(parseChildReport(childSuccess)?.ok === true);
  assertEquals(parseChildReport(`${childSuccess}extra`), undefined);
  assertEquals(parseChildReport('not-json\n'), undefined);
  const malformed = JSON.stringify({ ...JSON.parse(childSuccess), externalRequests: 4 }) + '\n';
  assertEquals(parseChildReport(malformed), undefined);
  const failureBase = {
    ...JSON.parse(childSuccess),
    ok: false,
    outcome: 'aborted',
    code: 'provider_failure',
  };
  const impossibleTranscript = JSON.stringify({
    ...failureBase,
    parentModelRequests: 0,
    childModelRequests: 0,
    aggregateModelRequests: 0,
    externalRequests: 0,
    delegationCalls: 0,
    delegationResults: 0,
    requestOrder: [],
    parentToolOrder: [],
    parentStopReason: 'final',
    transcriptValidated: true,
  });
  assertEquals(parseChildReport(`${impossibleTranscript}\n`), undefined);
  const impossibleSafety = JSON.stringify({
    ...failureBase,
    plannerNonMutating: false,
  });
  assertEquals(parseChildReport(`${impossibleSafety}\n`), undefined);
  assert(!decoder.decode(encoder.encode(childSuccess)).includes(DUMMY_CREDENTIAL));
});

Deno.test('launcher child failures preserve only the allowlisted code and bounded count', async () => {
  const childFailure = JSON.stringify({
    schemaVersion: 1,
    taskId: 'v1.planner-delegation.fixed',
    profile: 'openrouter-google-gemini-3.7-flash-vertex-v0',
    ok: false,
    outcome: 'aborted',
    code: 'provider_failure',
    parentModelRequests: 1,
    childModelRequests: 0,
    aggregateModelRequests: 1,
    externalRequests: 1,
    delegationCalls: 1,
    delegationResults: 0,
    requestOrder: ['parent'],
    parentToolOrder: ['delegate_to_planner'],
    parentStopReason: 'contract_failure',
    plannerFinalValidated: false,
    childCompletedBeforeParentFinal: false,
    plannerNonMutating: true,
    plannerNonRecursive: true,
    transcriptValidated: false,
    workspaceValidated: true,
  }) + '\n';
  const errors: string[] = [];
  const exit = await launcherMain([], {
    filesystem: credentialFilesystem(),
    makeWorkspace: workspace,
    spawn: () => child(childFailure, '', { success: false, code: 1 }),
    writeStderr: (text) => {
      errors.push(text);
    },
  });
  assertEquals(exit, 1);
  assertEquals(JSON.parse(errors[0]).code, 'provider_failure');
  assertEquals(JSON.parse(errors[0]).externalRequests, 1);
});

Deno.test('parser and launcher preserve third-phase failures with all three requests observed', async () => {
  for (const code of ['provider_failure', 'parent_final_mismatch'] as const) {
    const thirdPhaseFailure = JSON.stringify({
      schemaVersion: 1,
      taskId: 'v1.planner-delegation.fixed',
      profile: 'openrouter-google-gemini-3.7-flash-vertex-v0',
      ok: false,
      outcome: 'aborted',
      code,
      parentModelRequests: 2,
      childModelRequests: 1,
      aggregateModelRequests: 3,
      externalRequests: 3,
      delegationCalls: 1,
      delegationResults: 0,
      requestOrder: ['parent', 'child', 'parent'],
      parentToolOrder: ['delegate_to_planner'],
      parentStopReason: 'contract_failure',
      plannerFinalValidated: true,
      childCompletedBeforeParentFinal: true,
      plannerNonMutating: true,
      plannerNonRecursive: true,
      transcriptValidated: false,
      workspaceValidated: true,
    }) + '\n';
    const parsed = parseChildReport(thirdPhaseFailure);
    assert(parsed !== undefined && !parsed.ok);
    assertEquals(parsed.code, code);
    const errors: string[] = [];
    const exit = await launcherMain([], {
      filesystem: credentialFilesystem(),
      makeWorkspace: workspace,
      spawn: () => child(thirdPhaseFailure, '', { success: false, code: 1 }),
      writeStderr: (text) => {
        errors.push(text);
      },
    });
    assertEquals(exit, 1);
    const report = JSON.parse(errors[0]) as Record<string, unknown>;
    assertEquals(report.code, code);
    assertEquals(report.externalRequests, 3);
  }
});

Deno.test('launcher cleanup failure overrides a child success report', async () => {
  const errors: string[] = [];
  const exit = await launcherMain([], {
    filesystem: credentialFilesystem(),
    makeWorkspace: workspace,
    spawn: () => child(childSuccess),
    removeWorkspace: () => {
      throw new Error('cleanup-secret-marker');
    },
    writeStderr: (text) => {
      errors.push(text);
    },
  });
  assertEquals(exit, 1);
  assertEquals(JSON.parse(errors[0]).code, 'cleanup_failed');
  assert(!errors.join('').includes('cleanup-secret-marker'));
});

Deno.test('launcher bounds a pending child status after TERM and KILL', async () => {
  const errors: string[] = [];
  const signals: Deno.Signal[] = [];
  const pendingStatus = new Promise<SentinelChildStatus>(() => {});
  const pendingChild: SentinelChild = {
    stdout: childStream(''),
    stderr: childStream(''),
    status: pendingStatus,
    kill: (signal = 'SIGTERM') => signals.push(signal),
  };
  const started = performance.now();
  const exit = await launcherMain([], {
    filesystem: credentialFilesystem(),
    makeWorkspace: workspace,
    spawn: () => pendingChild,
    childDeadlineMs: 1,
    childGraceMs: 1,
    writeStderr: (text) => {
      errors.push(text);
    },
  });
  assert(performance.now() - started < 1_000);
  assertEquals(exit, 1);
  assertEquals(JSON.parse(errors[0]).code, 'deadline_exceeded');
  assertEquals(signals, ['SIGTERM', 'SIGKILL']);
});

Deno.test('workspace creation removes partial directories on setup failure', async () => {
  for (const failedStep of ['chmod', 'realPath', 'validate'] as const) {
    const path = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-planner-partial-' });
    let removed = false;
    await assertRejects(() =>
      createSentinelWorkspace({
        makeTempDir: () => Promise.resolve(path),
        chmod: () =>
          failedStep === 'chmod' ? Promise.reject(new Error('chmod failure')) : Promise.resolve(),
        realPath: (target) =>
          failedStep === 'realPath'
            ? Promise.reject(new Error('realpath failure'))
            : Promise.resolve(target),
        validate: () => Promise.resolve(failedStep !== 'validate'),
        remove: async (target) => {
          removed = true;
          await Deno.remove(target, { recursive: true });
        },
      })
    );
    assert(removed);
    try {
      await Deno.stat(path);
      throw new Error('partial workspace was not removed');
    } catch (error) {
      assert(error instanceof Deno.errors.NotFound);
    }
  }
});

Deno.test('launcher rejects malformed child UTF-8 without relaying bytes', async () => {
  const errors: string[] = [];
  const malformed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xc3, 0x28]));
      controller.close();
    },
  });
  const malformedChild: SentinelChild = {
    stdout: malformed,
    stderr: childStream(''),
    status: Promise.resolve({ success: true, code: 0, signal: null }),
    kill: () => {},
  };
  const exit = await launcherMain([], {
    filesystem: credentialFilesystem(),
    makeWorkspace: workspace,
    spawn: () => malformedChild,
    writeStderr: (text) => {
      errors.push(text);
    },
  });
  assertEquals(exit, 1);
  assertEquals(JSON.parse(errors[0]).code, 'child_report_invalid');
});
