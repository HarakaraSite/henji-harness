import { measureV5History } from '../v0/agent/history/v5_history_metrics.ts';

const [databasePath] = Deno.args;
if (databasePath === undefined || !databasePath.startsWith('/')) {
  throw new Error(
    'usage: deno run --allow-read scripts/measure_history_v5.ts /absolute/history-v5.sqlite3',
  );
}
console.log(JSON.stringify(await measureV5History(databasePath), null, 2));
