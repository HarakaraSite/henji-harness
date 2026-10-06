import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { decodeSessionSnapshot, decodeSessionStreamFrame } from '../../v0/api/codec.ts';
import { reduceSessionStreamFrame, type SessionClientState } from '../../v0/api/reducer.ts';
import type { SessionStreamFrame } from '../../v0/api/contract.ts';

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for subscribed Session');
};

/** Delay a real Data reply after SQLite captured its snapshot; all later notifications continue. */
const observeDataReplies = () => {
  const NativeWorker = globalThis.Worker;
  const onmessage = Object.getOwnPropertyDescriptor(NativeWorker.prototype, 'onmessage')!;
  const requests: string[] = [];
  let holdKind: string | undefined;
  let heldId: number | undefined;
  let release: (() => void) | undefined;
  globalThis.Worker = class extends NativeWorker {
    readonly dataWorker: boolean;
    constructor(specifier: string | URL, options?: WorkerOptions) {
      super(specifier, options);
      this.dataWorker = String(specifier).endsWith('/data_bootstrap.ts');
      if (!this.dataWorker) return;
      let handler: ((this: Worker, event: MessageEvent) => unknown) | null = null;
      Object.defineProperty(this, 'onmessage', {
        get: () => handler,
        set: (listener: typeof handler) => {
          handler = listener;
          onmessage.set!.call(this, (event: MessageEvent<{ id?: number }>) => {
            if (heldId !== undefined && event.data.id === heldId) {
              heldId = undefined;
              release = () => listener?.call(this, event);
            } else listener?.call(this, event);
          });
        },
      });
    }
    override postMessage(
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ): void {
      if (this.dataWorker) {
        const request = message as { kind: string; id: number };
        requests.push(request.kind);
        if (request.kind === holdKind) {
          holdKind = undefined;
          heldId = request.id;
        }
      }
      if (Array.isArray(transfer)) super.postMessage(message, transfer);
      else super.postMessage(message, transfer);
    }
  };
  return {
    count: (kind: string) => requests.filter((value) => value === kind).length,
    hold: (kind: string) => {
      holdKind = kind;
      release = undefined;
    },
    held: () => release !== undefined,
    release: () => {
      const deliver = release;
      release = undefined;
      deliver?.();
    },
    restore: () => {
      release?.();
      globalThis.Worker = NativeWorker;
    },
  };
};

Deno.test('Increment 199 initial and reconnect snapshots hand off concurrent updates without retaining a read subscription', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i199-core-subscription-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const replies = observeDataReplies();
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  const unsubscribe: Array<() => void> = [];
  const firstFrames: SessionStreamFrame[] = [];
  const secondFrames: SessionStreamFrame[] = [];
  let firstState: SessionClientState | undefined;
  let secondState: SessionClientState | undefined;
  try {
    core = await createCoreService({
      workspaceRoot,
      stateRoot: `${root}/state`,
      configRoot: `${root}/config`,
      physicalIoMode: 'provider-free',
      initialSession: { kind: 'new' },
    });
    const sessionId = core.coreRead().activeSessionId!;
    await core.sessionRead(sessionId);
    strictEqual(replies.count('watch_conversation'), 0);
    const submit = async (text: string) => {
      const result = await core!.taskSubmit(sessionId, { commandId: crypto.randomUUID(), text });
      strictEqual(result.kind, 'accepted');
      if (result.kind !== 'accepted') throw new Error('task rejected');
      await waitFor(async () =>
        (await core!.executionRead(result.value.executionId)).execution.processSettlement ===
          'complete'
      );
    };
    replies.hold('watch_conversation');
    const first = core.subscribeSession(sessionId, (bytes) => {
      if (bytes === undefined) return;
      const frame = decodeSessionStreamFrame(JSON.parse(new TextDecoder().decode(bytes)));
      firstFrames.push(frame);
      firstState = reduceSessionStreamFrame(firstState, frame);
    });
    await waitFor(replies.held);
    await submit('saved while first subscription reply was pending');
    replies.release();
    unsubscribe.push((await first).unsubscribe);
    const read = async () =>
      decodeSessionSnapshot(
        JSON.parse(new TextDecoder().decode((await core!.sessionRead(sessionId)).bytes)),
      );
    await waitFor(async () =>
      firstState?.snapshot.conversation.cut === (await read()).conversation.cut
    );
    strictEqual(firstFrames[0]?.kind, 'session.snapshot');
    strictEqual(firstFrames.filter((frame) => frame.kind === 'session.snapshot').length, 1);
    deepStrictEqual(firstState!.snapshot.conversation, (await read()).conversation);

    replies.hold('conversation_snapshot');
    const second = core.subscribeSession(sessionId, (bytes) => {
      if (bytes === undefined) return;
      const frame = decodeSessionStreamFrame(JSON.parse(new TextDecoder().decode(bytes)));
      secondFrames.push(frame);
      secondState = reduceSessionStreamFrame(secondState, frame);
    });
    await waitFor(replies.held);
    const priorCut = firstState!.snapshot.conversation.cut;
    await submit('saved while reconnect snapshot reply was pending');
    await waitFor(() => firstState!.snapshot.conversation.cut > priorCut);
    strictEqual(secondFrames.length, 0);
    replies.release();
    unsubscribe.push((await second).unsubscribe);
    const saved = await read();
    await waitFor(() =>
      firstState!.snapshot.conversation.cut === saved.conversation.cut &&
      secondState?.snapshot.conversation.cut === saved.conversation.cut
    );
    strictEqual(secondFrames[0]?.kind, 'session.snapshot');
    strictEqual(firstFrames.filter((frame) => frame.kind === 'session.snapshot').length, 1);
    deepStrictEqual(firstState!.snapshot.conversation, saved.conversation);
    deepStrictEqual(secondState!.snapshot.conversation, saved.conversation);
    ok(
      Object.values(saved.conversation.entities).some((entity) =>
        entity.kind === 'message' && entity.role === 'user' &&
        entity.text === 'saved while reconnect snapshot reply was pending'
      ),
    );
    strictEqual(replies.count('watch_conversation'), 1);
    for (const release of unsubscribe.splice(0)) release();
    await core.sessionRead(sessionId);
    strictEqual(replies.count('unwatch_conversation'), 1);
    strictEqual(replies.count('watch_conversation'), 1);
  } finally {
    replies.release();
    for (const release of unsubscribe) release();
    await core?.close();
    replies.restore();
    await Deno.remove(root, { recursive: true });
  }
});
