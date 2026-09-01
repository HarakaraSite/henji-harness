import { assert, assertEquals } from './test_helpers.ts';
import { main, parseFailureDiagnosticArgs } from '../../v0/agent/failure_diagnostic_cli.ts';
import {
  createFailureDiagnostic,
  type FailureDiagnosticV1,
} from '../../v0/agent/failure_diagnostic.ts';
import {
  DenoFailureDiagnosticStore,
  failureDiagnosticPaths,
  FailureDiagnosticStoreError,
} from '../../v0/agent/failure_diagnostic_store.ts';

const IDS = [
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000022',
] as const;
const TIME = '2026-09-02T00:00:00.000Z';

const diagnostic = (id: string, occurredAt: string): FailureDiagnosticV1 =>
  createFailureDiagnostic({
    stage: 'response_parse',
    code: 'response_error',
    lane: 'parent',
    providerRequestCount: 1,
    httpStatus: 200,
    parseReason: 'invalid_sse_json',
    turnNumber: 1,
    modelStep: 1,
    occurredAt,
  }, { uuid: () => id, now: () => occurredAt });

const capture = () => {
  let stdout = '';
  let stderr = '';
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    writeStdout: (value: string) => {
      stdout += value;
    },
    writeStderr: (value: string) => {
      stderr += value;
    },
  };
};

const fixture = async (): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
}> => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-diagnostic-cli-',
  });
  const workspace = `${root}/workspace`;
  await Deno.mkdir(workspace);
  return { root, workspace, state: `${root}/state` };
};

Deno.test('diagnostic CLI accepts only exact readback and confirmed-delete argv', () => {
  assertEquals(parseFailureDiagnosticArgs(['list']), { kind: 'list' });
  assertEquals(parseFailureDiagnosticArgs(['latest']), { kind: 'latest' });
  assertEquals(parseFailureDiagnosticArgs(['show', '--id', IDS[0]]), {
    kind: 'show',
    id: IDS[0],
  });
  assertEquals(
    parseFailureDiagnosticArgs(['delete', '--id', IDS[0], '--yes']),
    {
      kind: 'delete',
      id: IDS[0],
    },
  );
  for (
    const args of [
      [],
      ['list', '--yes'],
      ['show', '--id', IDS[0], '--yes'],
      ['delete', '--id', IDS[0]],
      ['delete', '--id', IDS[0], '--yes', '--extra'],
      ['show', '--id', 'not-an-id'],
    ]
  ) {
    let rejected = false;
    try {
      parseFailureDiagnosticArgs(args);
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});

Deno.test('diagnostic CLI lists, shows, selects latest, and deletes one exact record', async () => {
  const value = await fixture();
  try {
    const store = new DenoFailureDiagnosticStore(value.state, value.workspace);
    const older = diagnostic(IDS[0], TIME);
    const newer = diagnostic(IDS[1], '2026-09-02T00:00:01.000Z');
    await store.write(newer);
    await store.write(older);

    const listed = capture();
    assertEquals(
      await main(['list'], {
        workspaceRoot: value.workspace,
        stateRoot: value.state,
        writeStdout: listed.writeStdout,
        writeStderr: listed.writeStderr,
      }),
      0,
    );
    assertEquals(listed.stderr, '');
    assertEquals(
      listed.stdout,
      `${JSON.stringify({ schemaVersion: 1, diagnostics: [older, newer] })}\n`,
    );

    const latest = capture();
    assertEquals(
      await main(['latest'], {
        workspaceRoot: value.workspace,
        stateRoot: value.state,
        writeStdout: latest.writeStdout,
        writeStderr: latest.writeStderr,
      }),
      0,
    );
    assertEquals(latest.stdout, `${JSON.stringify(newer)}\n`);

    const shown = capture();
    assertEquals(
      await main(['show', '--id', older.diagnosticId], {
        workspaceRoot: value.workspace,
        stateRoot: value.state,
        writeStdout: shown.writeStdout,
        writeStderr: shown.writeStderr,
      }),
      0,
    );
    assertEquals(shown.stdout, `${JSON.stringify(older)}\n`);

    const deleted = capture();
    assertEquals(
      await main(['delete', '--id', older.diagnosticId, '--yes'], {
        workspaceRoot: value.workspace,
        stateRoot: value.state,
        writeStdout: deleted.writeStdout,
        writeStderr: deleted.writeStderr,
      }),
      0,
    );
    assertEquals(
      deleted.stdout,
      `{"ok":true,"deleted":"${older.diagnosticId}"}\n`,
    );
    await assertRejectsNotFound(() => store.read(older.diagnosticId));
    assertEquals(await store.read(newer.diagnosticId), newer);
    const paths = await failureDiagnosticPaths(value.state, value.workspace);
    assert((await Deno.lstat(paths.diagnostics)).isDirectory);
    assert((await Deno.lstat(paths.locks)).isDirectory);
  } finally {
    await Deno.remove(value.root, { recursive: true });
  }
});

const assertRejectsNotFound = async (
  operation: () => Promise<unknown>,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof FailureDiagnosticStoreError);
    assertEquals(error.code, 'diagnostic_not_found');
    return;
  }
  throw new Error('expected diagnostic_not_found');
};

Deno.test('readback does not initialize a missing state root and stays workspace-partitioned', async () => {
  const value = await fixture();
  try {
    const otherWorkspace = `${value.root}/other-workspace`;
    await Deno.mkdir(otherWorkspace);
    const output = capture();
    assertEquals(
      await main(['list'], {
        workspaceRoot: value.workspace,
        stateRoot: value.state,
        writeStdout: output.writeStdout,
        writeStderr: output.writeStderr,
      }),
      0,
    );
    assertEquals(output.stdout, '{"schemaVersion":1,"diagnostics":[]}\n');
    assert(!(await Deno.lstat(value.state).catch(() => undefined)));

    const store = new DenoFailureDiagnosticStore(value.state, otherWorkspace);
    const other = diagnostic(IDS[0], TIME);
    await store.write(other);
    const first = capture();
    assertEquals(
      await main(['list'], {
        workspaceRoot: value.workspace,
        stateRoot: value.state,
        writeStdout: first.writeStdout,
        writeStderr: first.writeStderr,
      }),
      0,
    );
    assertEquals(first.stdout, '{"schemaVersion":1,"diagnostics":[]}\n');
    const second = capture();
    assertEquals(
      await main(['list'], {
        workspaceRoot: otherWorkspace,
        stateRoot: value.state,
        writeStdout: second.writeStdout,
        writeStderr: second.writeStderr,
      }),
      0,
    );
    assertEquals(
      second.stdout,
      `${JSON.stringify({ schemaVersion: 1, diagnostics: [other] })}\n`,
    );
  } finally {
    await Deno.remove(value.root, { recursive: true });
  }
});

Deno.test('diagnostic CLI emits fixed errors without arbitrary store or path text', async () => {
  const value = await fixture();
  try {
    const output = capture();
    assertEquals(
      await main(['show', '--id', IDS[0]], {
        workspaceRoot: value.workspace,
        stateRoot: value.state,
        writeStdout: output.writeStdout,
        writeStderr: output.writeStderr,
      }),
      1,
    );
    assertEquals(
      output.stderr,
      '{"ok":false,"error":{"code":"diagnostic_not_found","message":"diagnostic not found"}}\n',
    );
    assert(!output.stderr.includes(value.root));
    assertEquals(output.stdout, '');
  } finally {
    await Deno.remove(value.root, { recursive: true });
  }
});
