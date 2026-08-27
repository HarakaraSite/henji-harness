import { DenoSessionStore, SessionStoreError } from '../../../v0/agent/session_store.ts';

const [stateRoot, workspaceRoot, sessionId] = Deno.args;
if (stateRoot === undefined || workspaceRoot === undefined || sessionId === undefined) {
  Deno.exit(2);
}
try {
  const store = new DenoSessionStore(stateRoot, workspaceRoot);
  const handle = await store.openExisting(sessionId);
  console.log('opened');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await handle.close();
} catch (error) {
  console.log(error instanceof SessionStoreError ? error.code : 'error');
  Deno.exit(1);
}
