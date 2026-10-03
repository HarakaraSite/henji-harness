import { readSync } from 'node:fs';
import { createWorkerSession } from '../../../v0/agent/worker/worker_tui_session.ts';
const [stateRoot, workspaceRoot, task, barrier] = Deno.args;
const created = await createWorkerSession({
  stateRoot,
  workspaceRoot,
  persistence: 'new',
  physicalIoMode: 'provider-free',
});
try {
  if (barrier === 'barrier') {
    console.log('ready');
    if (readSync(0, new Uint8Array(1), 0, 1, null) !== 1) throw new Error('missing gate');
  }
  const outcome = await created.session.submit(task);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  console.log(JSON.stringify({ sessionId: created.session.sessionId }));
} finally {
  await created.close();
}
