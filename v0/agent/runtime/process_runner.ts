import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import process from 'node:process';
import type { ProcessCommand } from './process_contract.ts';

/** Called by the executable's internal entry, or directly during source execution. */
export const runProcessRunner = async (): Promise<void> => {
  // Stay alive as the group's anchor while TERM is delivered to its command and descendants.
  // The command's exec resets this handler to the default disposition.
  const onTerm = (): void => {};
  Deno.addSignalListener('SIGTERM', onTerm);
  const input = createInterface({ input: process.stdin });
  const lines = input[Symbol.asyncIterator]();
  try {
    const first = await lines.next();
    if (first.done) return;
    const command: ProcessCommand = JSON.parse(first.value);
    // Deno's Node spawn can leave FD 3 open despite the stdio declaration. Close it
    // explicitly before exec; exec preserves the observed command PID and wait status.
    const child = spawn('/bin/bash', [
      '--noprofile',
      '--norc',
      '-c',
      'exec 3>&-; exec "$@"',
      'henji-process-command',
      command.executable,
      ...command.args,
    ], {
      cwd: command.cwd,
      env: { ...command.env },
      // Only these descriptors enter the user's command; FD 3 is runner control output.
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const commandDone = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        writeSync(
          3,
          JSON.stringify({ kind: 'started', pid: child.pid }) + '\n',
        );
      });
      child.once('exit', (exitCode, signal) => {
        writeSync(
          3,
          JSON.stringify({ kind: 'status', exitCode, signal }) + '\n',
        );
        resolve();
      });
    });
    const controlDone = (async () => {
      for (;;) {
        const line = await lines.next();
        if (line.done) return;
        if (
          JSON.parse(line.value).kind === 'kill-command' &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          child.kill('SIGKILL');
        }
      }
    })();
    // Keep the anchor alive until the owner ends input, including after command completion.
    await Promise.all([commandDone, controlDone]);
  } finally {
    input.close();
    Deno.removeSignalListener('SIGTERM', onTerm);
  }
};

if (import.meta.main) await runProcessRunner();
