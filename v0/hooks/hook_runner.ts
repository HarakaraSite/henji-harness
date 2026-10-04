import {
  type HookHandler,
  type HookInputByPhase,
  type HookPhase,
  type HookResultByPhase,
} from '../agent/hook_api.ts';
import type { LoadedWorkerHook } from './hook_loader.ts';

export interface HookPhaseOutcome<P extends HookPhase> {
  readonly name: string;
  readonly path?: string;
  readonly phase: P;
  readonly result: HookResultByPhase[P] | void;
}

/** Run one phase in registration order, awaiting each handler before preparing the next input. */
export const runHookPhase = async <P extends HookPhase>(
  hooks: readonly LoadedWorkerHook[],
  phase: P,
  inputFor: (hook: LoadedWorkerHook) => HookInputByPhase[P],
  onResult: (outcome: HookPhaseOutcome<P>) => void | PromiseLike<void>,
): Promise<readonly HookPhaseOutcome<P>[]> => {
  const outcomes: HookPhaseOutcome<P>[] = [];
  for (const hook of hooks) {
    const handler = hook.handlers[phase] as
      | HookHandler<HookInputByPhase[P], HookResultByPhase[P]>
      | undefined;
    if (handler === undefined) continue;
    const result = await handler(inputFor(hook));
    const outcome = Object.freeze({
      name: hook.selection.name,
      ...(hook.selection.path === undefined ? {} : { path: hook.selection.path }),
      phase,
      result,
    });
    outcomes.push(outcome);
    await onResult(outcome);
  }
  return Object.freeze(outcomes);
};
