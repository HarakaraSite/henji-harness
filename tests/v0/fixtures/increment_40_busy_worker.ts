/// <reference lib="webworker" />
import { DatabaseSync } from 'node:sqlite';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<{ readonly database: string; readonly holdMs: number }>) => {
  const db = new DatabaseSync(event.data.database);
  db.exec('PRAGMA busy_timeout = 250; BEGIN IMMEDIATE');
  scope.postMessage('locked');
  setTimeout(() => {
    db.exec('COMMIT');
    db.close();
    scope.postMessage('released');
    scope.close();
  }, event.data.holdMs);
};
