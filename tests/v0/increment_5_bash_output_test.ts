import {
  BASH_OUTPUT_COMMAND_LIMIT_BYTES,
  BASH_OUTPUT_DEFAULT_WINDOW_BYTES,
  BASH_OUTPUT_MAX_WINDOW_BYTES,
  BASH_OUTPUT_MIN_WINDOW_BYTES,
  BASH_OUTPUT_REGISTRY_LIMIT_BYTES,
  BASH_OUTPUT_RETAINED_STREAM_LIMIT,
  BASH_OUTPUT_SEGMENT_BYTES,
  BashOutputPersistenceError,
  createBashOutputStoreForTest,
  createBashOutputTool,
} from '../../v0/agent/tools/bash_output.ts';
import { Registry, ToolInputError } from '../../v0/agent/tools/tools.ts';
import { TurnCancelledError } from '../../v0/agent/core/cancellation.ts';
import { createBashTool } from '../../v0/agent/tools/work_tools.ts';
import { createDeclaredRegistry } from '../../v0/agent/tools/registries.ts';
import { createAgentResourceIdentity } from '../../v0/agent/definitions/resource_identity.ts';
import { emptySkillCatalog } from '../../v0/agent/definitions/skills.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const assertRejects = async (
  operation: () => PromiseLike<unknown>,
  errorClass: new (...args: never[]) => Error,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    if (error instanceof errorClass) return;
    throw error;
  }
  throw new Error('expected rejection');
};

const parsed = async (
  value: PromiseLike<string> | string,
): Promise<Record<string, unknown>> => JSON.parse(await value) as Record<string, unknown>;

const tempMissing = async (path: string): Promise<boolean> => {
  try {
    await Deno.lstat(path);
    return false;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
};

Deno.test('increment 5 production storage and readback bounds are fixed', () => {
  assertEquals({
    command: BASH_OUTPUT_COMMAND_LIMIT_BYTES,
    registry: BASH_OUTPUT_REGISTRY_LIMIT_BYTES,
    streams: BASH_OUTPUT_RETAINED_STREAM_LIMIT,
    segment: BASH_OUTPUT_SEGMENT_BYTES,
    defaultWindow: BASH_OUTPUT_DEFAULT_WINDOW_BYTES,
    minimumWindow: BASH_OUTPUT_MIN_WINDOW_BYTES,
    maximumWindow: BASH_OUTPUT_MAX_WINDOW_BYTES,
    maximumExtents: BASH_OUTPUT_REGISTRY_LIMIT_BYTES / BASH_OUTPUT_SEGMENT_BYTES +
      BASH_OUTPUT_RETAINED_STREAM_LIMIT,
  }, {
    command: 32 * 1024 * 1024,
    registry: 128 * 1024 * 1024,
    streams: 4_096,
    segment: 64 * 1024,
    defaultWindow: 49_152,
    minimumWindow: 4,
    maximumWindow: 49_152,
    maximumExtents: 6_144,
  });
});

Deno.test('single unlinked spool preserves identities, extents, and UTF-8 windows', async () => {
  const opened: string[] = [];
  const store = createBashOutputStoreForTest({
    limits: {
      commandBytes: 128,
      registryBytes: 256,
      retainedStreams: 8,
      segmentBytes: 8,
    },
    onSpoolOpened: async (path) => {
      const info = await Deno.lstat(path);
      assert(info.isFile);
      assertEquals((info.mode ?? 0) & 0o777, 0o600);
      opened.push(path);
    },
  });
  try {
    const first = store.beginCommand();
    await first.append('stdout', 'alpha😀beta');
    const firstSummary = await first.finish();
    assert(firstSummary.outputId !== undefined);
    assertEquals(firstSummary.streams, { stdout: 13 });
    assertEquals(opened.length, 1);
    assert(await tempMissing(opened[0]));

    const emoji = await store.read(first.outputId, 'stdout', 5, 4);
    assertEquals(emoji, {
      outputId: first.outputId,
      stream: 'stdout',
      offset: 5,
      text: '😀',
      nextOffset: 9,
      complete: false,
      totalBytes: 13,
    });
    await assertRejects(
      () => store.read(first.outputId, 'stdout', 6, 4),
      Error,
    );

    const second = store.beginCommand();
    await Promise.all([
      second.append('stdout', 'left-one-left-two'),
      second.append('stderr', 'right-one-right-two'),
    ]);
    const secondSummary = await second.finish();
    assert(secondSummary.outputId !== undefined);
    assertEquals(opened.length, 1);
    assertEquals(
      (await store.read(first.outputId, 'stdout', 0, 64)).text,
      'alpha😀beta',
    );
    assertEquals(
      (await store.read(second.outputId, 'stdout', 0, 64)).text,
      'left-one-left-two',
    );
    assertEquals(
      (await store.read(second.outputId, 'stderr', 0, 64)).text,
      'right-one-right-two',
    );
    const diagnostics = await store.diagnostics();
    assertEquals(diagnostics.openHandles, 1);
    assert(diagnostics.extents >= 5);
  } finally {
    await store.close();
  }
});

Deno.test('store stops at scalar-safe command, Registry, and stream limits', async () => {
  const commandStore = createBashOutputStoreForTest({
    limits: {
      commandBytes: 12,
      registryBytes: 64,
      retainedStreams: 4,
      segmentBytes: 8,
    },
  });
  try {
    const command = commandStore.beginCommand();
    assertEquals(
      (await command.append('stdout', '0123456789')).storedBytes,
      10,
    );
    const stopped = await command.append('stdout', '😀');
    assertEquals(stopped.storedBytes, 0);
    assertEquals(stopped.limit?.reason, 'command_bytes');
    const summary = await command.finish();
    assertEquals(summary.streams, { stdout: 10 });
    assertEquals(summary.limit?.commandLimitBytes, 12);
  } finally {
    await commandStore.close();
  }

  const registryStore = createBashOutputStoreForTest({
    limits: {
      commandBytes: 20,
      registryBytes: 15,
      retainedStreams: 4,
      segmentBytes: 8,
    },
  });
  try {
    const first = registryStore.beginCommand();
    await first.append('stdout', '0123456789');
    await first.finish();
    const second = registryStore.beginCommand();
    const stopped = await second.append('stdout', 'abcdefghij');
    assertEquals(stopped.storedBytes, 5);
    assertEquals(stopped.limit?.reason, 'registry_bytes');
    assertEquals((await second.finish()).streams, { stdout: 5 });
  } finally {
    await registryStore.close();
  }

  const streamStore = createBashOutputStoreForTest({
    limits: {
      commandBytes: 64,
      registryBytes: 64,
      retainedStreams: 1,
      segmentBytes: 8,
    },
  });
  try {
    const command = streamStore.beginCommand();
    await command.append('stdout', 'stdout-data');
    const stopped = await command.append('stderr', 'stderr-data');
    assertEquals(stopped.storedBytes, 0);
    assertEquals(stopped.limit?.reason, 'retained_streams');
    assertEquals((await command.finish()).streams, { stdout: 11 });
  } finally {
    await streamStore.close();
  }
});

Deno.test('bash keeps short JSON stable and exposes complete stdout and stderr readback', async () => {
  const workspace = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-bash-output-test-',
  });
  const store = createBashOutputStoreForTest({
    limits: {
      commandBytes: 32 * 1024,
      registryBytes: 64 * 1024,
      retainedStreams: 8,
      segmentBytes: 1024,
    },
  });
  try {
    const bash = createBashTool({ root: workspace }, store);
    const startingDirectory = await parsed(
      bash.execute({ command: 'pwd' }) as PromiseLike<string>,
    );
    assertEquals(startingDirectory.stdout, workspace + '\n');
    assertEquals(startingDirectory.exitCode, 0);

    const short = await bash.execute({ command: "printf 'short'" });
    assertEquals(
      short,
      JSON.stringify({
        stdout: 'short',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    );

    const result = await parsed(
      bash.execute({
        command: "printf '%05000d' 0; printf '%05000d' 0 >&2",
        timeoutMs: 5_000,
      }) as PromiseLike<string>,
    );
    assertEquals(result.stdoutTruncated, true);
    assertEquals(result.stderrTruncated, true);
    assertEquals(result.outputComplete, true);
    assert(typeof result.outputId === 'string');
    assertEquals(result.savedStreams, { stdout: 5_000, stderr: 5_000 });
    assertEquals(
      (result.readback as Record<string, unknown>).tool,
      'bash_output',
    );
    const outputId = result.outputId as string;
    assertEquals(
      (await store.read(outputId, 'stdout', 0, 5_000)).text.length,
      5_000,
    );
    assertEquals(
      (await store.read(outputId, 'stderr', 0, 5_000)).text.length,
      5_000,
    );
  } finally {
    await store.close();
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test('declared bash components share one output store for readback', async () => {
  const workspace = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-bash-component-test-',
  });
  const store = createBashOutputStoreForTest({
    limits: {
      commandBytes: 32 * 1024,
      registryBytes: 64 * 1024,
      retainedStreams: 8,
      segmentBytes: 1024,
    },
  });
  try {
    const registry = createDeclaredRegistry({
      instructions: [],
      skills: [],
      tools: ['tool:bash', 'tool:bash_output'].map(createAgentResourceIdentity),
      subagents: [],
    }, {
      workspace: { root: workspace },
      skillCatalog: emptySkillCatalog(),
      bashOutputStore: store,
      toolDefinitions: [
        {
          identity: createAgentResourceIdentity('tool:bash'),
          materialize: (bindings) =>
            createBashTool(
              bindings.workspace,
              bindings.bashOutputStore,
              bindings.workTools.bash ?? {},
            ),
        },
        {
          identity: createAgentResourceIdentity('tool:bash_output'),
          materialize: (bindings) => createBashOutputTool(bindings.bashOutputStore),
        },
      ],
    });
    const execution = await registry.dispatch({
      callId: 'bash-component',
      name: 'bash',
      arguments: { command: "printf '%05000d' 0" },
    });
    const result = JSON.parse(execution.content.text) as Record<string, unknown>;
    assertEquals(result.stdoutTruncated, true);
    assert(typeof result.outputId === 'string');
    const readback = await registry.dispatch({
      callId: 'bash-output-component',
      name: 'bash_output',
      arguments: { outputId: result.outputId, stream: 'stdout', offset: 4096 },
    });
    const window = JSON.parse(readback.content.text) as Record<string, unknown>;
    assertEquals(window.offset, 4096);
    assertEquals(window.complete, true);
    assertEquals(typeof window.text === 'string' ? window.text.length : -1, 904);
  } finally {
    await store.close();
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test('bash output limit stops the command and keeps its saved prefix readable', async () => {
  const workspace = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-bash-limit-test-',
  });
  const store = createBashOutputStoreForTest({
    limits: {
      commandBytes: 8_192,
      registryBytes: 32_768,
      retainedStreams: 8,
      segmentBytes: 1024,
    },
  });
  try {
    const bash = createBashTool({ root: workspace }, store);
    const result = await parsed(
      bash.execute({
        command: "while :; do printf '0123456789abcdef'; done",
        timeoutMs: 5_000,
      }) as PromiseLike<string>,
    );
    assertEquals(result.outputLimitExceeded, true);
    assertEquals(result.outputComplete, false);
    assertEquals(
      (result.outputLimit as Record<string, unknown>).reason,
      'command_bytes',
    );
    assertEquals(
      (result.savedStreams as Record<string, unknown>).stdout,
      8_192,
    );
    assert(typeof result.outputId === 'string');
    const outputId = result.outputId as string;
    let offset = 0;
    let rebuilt = '';
    for (;;) {
      const window = await store.read(outputId, 'stdout', offset, 1024);
      rebuilt += window.text;
      if (window.nextOffset === null) break;
      offset = window.nextOffset;
    }
    assertEquals(rebuilt.length, 8_192);
    assert(/^0123456789abcdef/.test(rebuilt));
  } finally {
    await store.close();
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test('cancelled truncated bash reclaims its saved quota and file extents', async () => {
  const workspace = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-bash-cancel-test-',
  });
  const store = createBashOutputStoreForTest({
    limits: {
      commandBytes: 12 * 1024,
      registryBytes: 16 * 1024,
      retainedStreams: 8,
      segmentBytes: 1024,
    },
  });
  try {
    const baseline = store.beginCommand();
    await baseline.append('stdout', 'b'.repeat(3_000));
    const baselineSummary = await baseline.finish();
    assert(baselineSummary.outputId !== undefined);

    const bash = createBashTool({ root: workspace }, store);
    const controller = new AbortController();
    const cancelled = Promise.resolve(bash.execute({
      command: "printf '%010000d' 0; sleep 5",
      timeoutMs: 10_000,
    }, { signal: controller.signal }));
    let captured = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await store.diagnostics()).registryBytes > 3_000) {
        captured = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(captured, 'cancelled command did not reach saved output');
    controller.abort();
    await assertRejects(() => cancelled, TurnCancelledError);

    assertEquals(await store.diagnostics(), {
      registryBytes: 3_000,
      retainedStreams: 1,
      extents: 3,
      openHandles: 1,
    });
    assertEquals(
      (await store.read(baseline.outputId, 'stdout', 0, 3_000)).text,
      'b'.repeat(3_000),
    );

    const next = await parsed(
      bash.execute({
        command: "printf '%010000d' 0",
        timeoutMs: 5_000,
      }) as PromiseLike<string>,
    );
    assertEquals(next.outputComplete, true);
    assertEquals((next.savedStreams as Record<string, unknown>).stdout, 10_000);
    assertEquals(next.outputLimitExceeded, undefined);
  } finally {
    await store.close();
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test('cancellation during final output flush abandons the uncommitted identity', async () => {
  const workspace = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-bash-flush-cancel-',
  });
  const controller = new AbortController();
  let abortDuringWrite = false;
  const store = createBashOutputStoreForTest({
    limits: {
      commandBytes: 12 * 1024,
      registryBytes: 16 * 1024,
      retainedStreams: 8,
      segmentBytes: 8 * 1024,
    },
    beforeWrite: () => {
      if (abortDuringWrite) {
        abortDuringWrite = false;
        controller.abort();
      }
    },
  });
  try {
    const baseline = store.beginCommand();
    await baseline.append('stdout', 'b'.repeat(3_000));
    const baselineSummary = await baseline.finish();
    assert(baselineSummary.outputId !== undefined);

    const bash = createBashTool({ root: workspace }, store);
    abortDuringWrite = true;
    await assertRejects(
      () =>
        Promise.resolve(bash.execute({
          command: "printf '%05000d' 0",
          timeoutMs: 5_000,
        }, { signal: controller.signal })),
      TurnCancelledError,
    );

    assertEquals(await store.diagnostics(), {
      registryBytes: 3_000,
      retainedStreams: 1,
      extents: 1,
      openHandles: 1,
    });
    assertEquals(
      (await store.read(baseline.outputId, 'stdout', 0, 3_000)).text,
      'b'.repeat(3_000),
    );

    const next = await parsed(
      bash.execute({
        command: "printf '%010000d' 0",
        timeoutMs: 5_000,
      }) as PromiseLike<string>,
    );
    assertEquals(next.outputComplete, true);
    assertEquals((next.savedStreams as Record<string, unknown>).stdout, 10_000);
    assertEquals(next.outputLimitExceeded, undefined);
  } finally {
    await store.close();
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test('bash_output validates identity, stream, byte offset, and window size', async () => {
  const store = createBashOutputStoreForTest({
    limits: {
      commandBytes: 128,
      registryBytes: 256,
      retainedStreams: 4,
      segmentBytes: 8,
    },
  });
  try {
    const command = store.beginCommand();
    await command.append('stdout', '😀tail');
    const summary = await command.finish();
    assert(summary.outputId !== undefined);
    const tool = createBashOutputTool(store);
    const first = await parsed(tool.execute({
      outputId: summary.outputId,
      stream: 'stdout',
      offset: 0,
      limit: 4,
    }) as PromiseLike<string>);
    assertEquals(first.text, '😀');
    assertEquals(first.nextOffset, 4);
    await assertRejects(
      () =>
        Promise.resolve(tool.execute({
          outputId: summary.outputId!,
          stream: 'stdout',
          offset: 1,
          limit: 4,
        })),
      ToolInputError,
    );
    for (const limit of [1, 3, 49_153]) {
      const dispatched = await new Registry([tool]).dispatch({
        callId: `invalid-${limit}`,
        name: 'bash_output',
        arguments: { outputId: summary.outputId, stream: 'stdout', limit },
      });
      assertEquals(dispatched.content.outcome, 'error');
      assert(dispatched.content.text.startsWith('invalid arguments:'));
    }
  } finally {
    await store.close();
  }
});

Deno.test('persistence failure is explicit and does not expose readback identity', async () => {
  let failed = false;
  const store = createBashOutputStoreForTest({
    limits: {
      commandBytes: 128,
      registryBytes: 256,
      retainedStreams: 4,
      segmentBytes: 8,
    },
    beforeWrite: () => {
      if (!failed) {
        failed = true;
        throw new Error('injected write failure');
      }
    },
  });
  try {
    const command = store.beginCommand();
    await assertRejects(
      () => command.append('stdout', '0123456789'),
      BashOutputPersistenceError,
    );
    const summary = await command.summary();
    assertEquals(summary.available, false);
    assertEquals(summary.outputId, undefined);
  } finally {
    await store.close();
  }
});

Deno.test('bash persistence failure returns bounded status without a false identity', async () => {
  const workspace = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-bash-failure-test-',
  });
  let failed = false;
  const store = createBashOutputStoreForTest({
    limits: {
      commandBytes: 32 * 1024,
      registryBytes: 64 * 1024,
      retainedStreams: 8,
      segmentBytes: 1024,
    },
    beforeWrite: () => {
      if (!failed) {
        failed = true;
        throw new Error('injected write failure');
      }
    },
  });
  try {
    const bash = createBashTool({ root: workspace }, store);
    try {
      await bash.execute({ command: "printf '%05000d' 0", timeoutMs: 5_000 });
      throw new Error('expected bash persistence failure');
    } catch (error) {
      assert(error instanceof Error);
      const result = JSON.parse(error.message) as Record<string, unknown>;
      assertEquals(result.error, 'bash output persistence failed');
      assertEquals(result.stdoutTruncated, true);
      assertEquals(result.outputComplete, false);
      assertEquals(result.outputId, undefined);
      assertEquals(result.readback, undefined);
    }
  } finally {
    await store.close();
    await Deno.remove(workspace, { recursive: true });
  }
});
