import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type {
  ProcessCommand,
  ProcessExecutor,
  ProcessOperation,
  ProcessRunnerLaunch,
  ProcessStatus,
} from './process_contract.ts';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ProcessMember {
  readonly pid: number;
  readonly state: string;
  readonly group: number;
}

/** Linux proc metadata describes group membership independently of PID parentage. */
const groupMembers = async (group: number): Promise<ProcessMember[]> => {
  // Deno protects /proc even with --allow-read. Use the already-permitted bash
  // builtins and return only the owned group's metadata.
  const result = await new Deno.Command('/bin/bash', {
    args: [
      '--noprofile',
      '--norc',
      '-c',
      'target=$1; for path in /proc/[0-9]*/stat; do ' +
      'IFS= read -r stat 2>/dev/null < "$path" || continue; ' +
      'fields=${stat##*) }; set -- $fields; ' +
      'if [ "$3" = "$target" ]; then pid=${path#/proc/}; ' +
      'printf "%s %s\\n" "${pid%/stat}" "$1"; fi; done',
      'henji-owned-group',
      String(group),
    ],
    clearEnv: true,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'null',
  }).output();
  if (!result.success) throw new Error('owned process group metadata failed');
  return new TextDecoder().decode(result.stdout).trim().split('\n').filter(Boolean).map((line) => {
    const [pid, state] = line.split(' ');
    return { pid: Number(pid), state, group };
  });
};

const live = (member: ProcessMember): boolean => member.state !== 'Z' && member.state !== 'X';

/** Cancelling capture leaves the physical pipe draining, so retained writers can finish. */
const capturePipe = (pipe: Readable): {
  stream: ReadableStream<Uint8Array>;
  finish(): void;
} => {
  let capturing = true;
  let finish = (): void => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = () => {
        if (capturing) {
          capturing = false;
          controller.close();
        }
        pipe.resume();
      };
      pipe.on('data', (bytes: Uint8Array) => {
        if (!capturing) return;
        controller.enqueue(new Uint8Array(bytes));
        if ((controller.desiredSize ?? 0) <= 0) pipe.pause();
      });
      pipe.once('end', () => {
        if (capturing) {
          capturing = false;
          controller.close();
        }
      });
      pipe.once('error', (error) => {
        if (capturing) {
          capturing = false;
          controller.error(error);
        }
      });
    },
    pull() {
      pipe.resume();
    },
    cancel() {
      capturing = false;
      pipe.resume();
    },
  });
  return { stream, finish: () => finish() };
};

const pendingPipe = (
  operation: Promise<ProcessOperation>,
  stream: 'stdout' | 'stderr',
): ReadableStream<Uint8Array> => {
  const reader = operation.then((value) => value[stream].getReader());
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await (await reader).read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await (await reader).cancel(reason);
    },
  });
};

const signalGroup = async (
  group: number,
  signal: 'TERM' | 'KILL',
): Promise<void> => {
  const result = await new Deno.Command('/bin/bash', {
    args: [
      '--noprofile',
      '--norc',
      '-c',
      'kill -"$1" -- "-$2"',
      'henji-owned-group',
      signal,
      String(group),
    ],
    clearEnv: true,
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  }).output();
  if (!result.success && (await groupMembers(group)).some(live)) {
    throw new Error('owned process group signal failed');
  }
};

class OwnedProcess implements ProcessOperation {
  readonly id = crypto.randomUUID();
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<ProcessStatus>;
  readonly closed: Promise<void>;
  private child: ChildProcess;
  private readonly spawned: Promise<number>;
  private readonly runnerReady: Promise<void>;
  private readonly runnerExit: Promise<void>;
  private readonly pipesClosed: Promise<void>;
  private readonly finishCapture: () => void;
  private stopping: Promise<void> | undefined;
  private releaseAnchor = false;

  constructor(
    command: ProcessCommand,
    launch: ProcessRunnerLaunch,
    pollMs: number,
  ) {
    this.child = spawn(launch.executable, [...launch.args], {
      detached: true,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const child = this.child;
    this.spawned = new Promise((resolve, reject) => {
      child.once('spawn', () => resolve(child.pid!));
      child.once('error', reject);
    });
    this.runnerExit = new Promise((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
    this.pipesClosed = new Promise((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });
    const stdout = capturePipe(child.stdout!);
    const stderr = capturePipe(child.stderr!);
    this.stdout = stdout.stream;
    this.stderr = stderr.stream;
    this.finishCapture = () => {
      stdout.finish();
      stderr.finish();
    };
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    this.runnerReady = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void this.runnerReady.catch(() => {});
    this.status = new Promise((resolve, reject) => {
      let pending = '';
      const control = child.stdio[3] as Readable;
      control.on('data', (bytes: Uint8Array) => {
        pending += new TextDecoder().decode(bytes, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const message = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          if (message.kind === 'started') readyResolve();
          else if (message.kind === 'status') {
            resolve({ exitCode: message.exitCode, signal: message.signal });
          }
        }
      });
      control.once(
        'end',
        () => {
          const error = new Error('process runner ended before command status');
          readyReject(error);
          reject(error);
        },
      );
      child.once('error', (error) => {
        readyReject(error);
        reject(error);
      });
    });
    child.stdin!.on(
      'error',
      () => {/* Runner failure is observed through status/exit. */},
    );
    child.stdin!.write(JSON.stringify(command) + '\n');
    this.closed = this.manageLifetime(pollMs);
  }

  private async remaining(group: number): Promise<ProcessMember[]> {
    return (await groupMembers(group)).filter((member) => member.pid !== group && live(member));
  }

  private async manageLifetime(pollMs: number): Promise<void> {
    const group = await this.spawned;
    try {
      await this.status;
      while (!this.releaseAnchor && (await this.remaining(group)).length > 0) {
        await delay(pollMs);
      }
      if (this.stopping !== undefined) await this.stopping;
      this.releaseAnchor = true;
      this.child.stdin!.end();
      await this.runnerExit;
      await this.pipesClosed;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  release(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopping = (async () => {
      const group = await this.spawned;
      // OS spawn precedes the runner's TERM handler and command observer. The
      // started message confirms both are installed before stopping the group.
      await this.runnerReady;
      this.finishCapture();
      if (this.releaseAnchor) {
        await this.runnerExit;
        return;
      }
      await signalGroup(group, 'TERM');
      const deadline = Date.now() + 100;
      while (
        (await this.remaining(group)).length > 0 && Date.now() < deadline
      ) await delay(10);
      if ((await this.remaining(group)).length > 0) {
        // Reap and report the command while its runner still anchors the group; group KILL
        // would otherwise destroy the observer before it could report the real wait status.
        this.child.stdin!.write(
          JSON.stringify({ kind: 'kill-command' }) + '\n',
        );
        await this.status;
        await signalGroup(group, 'KILL');
      } else this.child.stdin!.end();
      await this.runnerExit;
      while ((await groupMembers(group)).some(live)) await delay(10);
      await this.pipesClosed;
      this.releaseAnchor = true;
    })();
    return this.stopping;
  }
}

/** A Host/generation owner; registration precedes the operation's physical spawn. */
export class LinuxProcessExecutor implements ProcessExecutor {
  private readonly operations = new Map<string, ProcessOperation>();
  private closing: Promise<void> | undefined;

  constructor(
    private readonly launch: ProcessRunnerLaunch,
    private readonly pollMs = 50,
  ) {}

  get activeOperations(): number {
    return this.operations.size;
  }

  start(command: ProcessCommand): ProcessOperation {
    if (this.closing !== undefined) throw new Error('process owner closed');
    // Install the ownership slot before constructing/spawning its physical process.
    const slot = crypto.randomUUID();
    const pending = Promise.resolve().then(() =>
      new OwnedProcess(command, this.launch, this.pollMs)
    );
    const result: ProcessOperation = {
      id: slot,
      stdout: pendingPipe(pending, 'stdout'),
      stderr: pendingPipe(pending, 'stderr'),
      status: pending.then((operation) => operation.status),
      closed: pending.then((operation) => operation.closed),
      release: () => Promise.resolve(),
      stop: async () => {
        const operation = await pending;
        await operation.stop();
        await operation.closed;
      },
    };
    this.operations.set(slot, result);
    void result.closed.then(
      () => this.operations.delete(slot),
      () => this.operations.delete(slot),
    );
    return result;
  }

  close(): Promise<void> {
    return this.closing ??= Promise.allSettled(
      [...this.operations.values()].map((operation) => operation.stop()),
    ).then((results) => {
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
  }
}

/** Exec the runtime through the already-permitted bash, without adding an external dependency. */
export const runtimeProcessRunnerLaunch = (
  executable: string,
  args: readonly string[] = [],
): ProcessRunnerLaunch => ({
  executable: '/bin/bash',
  // Deno's Node compatibility layer rewrites arguments after its own executable,
  // even through bash in a standalone binary. Keep the runtime path in the shell
  // program so the internal entry's application arguments reach it unchanged.
  args: [
    '--noprofile',
    '--norc',
    '-c',
    `exec '${executable.replaceAll("'", "'\\''")}' "$@"`,
    'henji-process-runner',
    ...args,
  ],
});

export const sourceProcessRunnerLaunch = (): ProcessRunnerLaunch =>
  runtimeProcessRunnerLaunch(
    Deno.execPath(),
    [
      'run',
      '--no-prompt',
      '--cached-only',
      '--allow-run=/bin/bash',
      '--allow-env=NODE_V8_COVERAGE',
      new URL('./process_runner.ts', import.meta.url).pathname,
    ],
  );
