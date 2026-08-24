import { parseArgs } from '@std/cli';
import { runTask } from '../runner/run.ts';
import type { RunTrace, TraceEvent } from '../runner/trace.ts';

const args = parseArgs(Deno.args, {
  string: ['task', 'context', 'trace'],
  collect: ['constraint'],
});
if (!args.task) throw new Error('--task is required');
const apiKey = Deno.env.get('HENJI_OPENROUTER_API_KEY');
if (!apiKey) throw new Error('HENJI_OPENROUTER_API_KEY is required');
const constraints = Array.isArray(args.constraint)
  ? args.constraint.filter((value): value is string => typeof value === 'string')
  : undefined;
const traceEvents: TraceEvent[] = [];
const result = await runTask(
  { task: args.task, context: args.context, constraints },
  apiKey,
  Deno.execPath(),
  undefined,
  args.trace
    ? (event) => {
      traceEvents.push(event);
    }
    : undefined,
);
if (args.trace) {
  const trace: RunTrace = { runId: crypto.randomUUID(), events: traceEvents };
  await Deno.writeTextFile(args.trace, `${JSON.stringify(trace)}\n`);
}
if (typeof result === 'object' && result !== null && 'code' in result) {
  console.error(JSON.stringify(result));
  Deno.exitCode = 1;
} else {
  console.log(JSON.stringify(result));
}
