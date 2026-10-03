import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { parseRemoteTuiInvocation } from '../../v0/agent/cli/remote_tui_cli.ts';
import {
  presentationPositionFromSnapshot,
  presentationStartupFromSnapshot,
} from '../../v0/tui/snapshot_presentation.ts';
import { startupHeaderLines } from '../../v0/tui/startup_render.ts';
import { sessionSnapshotFixture } from './session_snapshot_fixture.ts';
Deno.test('Increment 153 Core selection and Session selection remain independent CLI targets', () => {
  deepStrictEqual(parseRemoteTuiInvocation(['--core', 'abc123']), {
    coreId: 'abc123',
    target: { kind: 'implicit' },
  });
  deepStrictEqual(parseRemoteTuiInvocation(['--core', 'abc123', '--new']), {
    coreId: 'abc123',
    target: { kind: 'new' },
  });
  const id = '15300000-0000-4000-8000-000000000001';
  deepStrictEqual(parseRemoteTuiInvocation(['--session', id]), {
    target: { kind: 'session', sessionId: id },
  });
  throws(
    () => parseRemoteTuiInvocation(['--core', 'abc', '--connect', 'http://127.0.0.1:1']),
    /mutually exclusive/,
  );
});
Deno.test('Increment 153 snapshot Core identity stays visible alongside Session in normal and compact headers', () => {
  const base = sessionSnapshotFixture({
    schemaVersion: 2,
    sessionId: '14600000-0000-4000-8000-000000000001',
    cut: 0,
    storeRevision: 0,
    entities: {},
    order: [],
  });
  const epoch = '153abcde-0000-4000-8000-000000000002';
  const snapshot = { ...base, cursor: { ...base.cursor, coreEpoch: epoch } };
  const startup = presentationStartupFromSnapshot(snapshot, '/server/workspace');
  strictEqual(startup.coreEpoch, epoch);
  strictEqual(startup.workspace, '/server/workspace');
  for (const [columns, rows] of [[100, 35], [60, 14]]) {
    const text = startupHeaderLines(
      startup,
      presentationPositionFromSnapshot(snapshot),
      columns,
      rows,
    ).join('\n');
    strictEqual(text.includes('Core 153abcde'), true);
    strictEqual(text.includes(base.session.id.slice(0, 8)), true);
  }
  const other = {
    ...snapshot,
    session: {
      ...snapshot.session,
      position: { ...snapshot.session.position, sessionId: '15300000-0000-4000-8000-000000000003' },
    },
  };
  const changed = startupHeaderLines(
    presentationStartupFromSnapshot(other, '/server/workspace'),
    presentationPositionFromSnapshot(other),
  ).join('\n');
  strictEqual(changed.includes('Core 153abcde'), true);
});
