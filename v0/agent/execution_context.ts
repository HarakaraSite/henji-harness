import { type TurnCancellation } from './cancellation.ts';

/** The two independently bounded request lanes in one accepted turn. */
export type RequestLane = 'parent' | 'child';

export interface TurnRequestBudgetSnapshot {
  readonly parent: number;
  readonly child: number;
  readonly aggregate: number;
}

export const REQUEST_LIMITS = Object.freeze({
  parent: 8,
  child: 8,
  aggregate: 16,
});

/**
 * Synchronous provider-neutral request admission for one accepted turn.
 * A successful claim is consumed even when the model subsequently fails.
 */
export class TurnRequestBudget {
  private parent = 0;
  private child = 0;

  claim(lane: RequestLane): boolean {
    const used = lane === 'parent' ? this.parent : this.child;
    if (used >= REQUEST_LIMITS[lane] || this.aggregate >= REQUEST_LIMITS.aggregate) return false;
    if (lane === 'parent') this.parent += 1;
    else this.child += 1;
    return true;
  }

  get aggregate(): number {
    return this.parent + this.child;
  }

  snapshot(): TurnRequestBudgetSnapshot {
    return Object.freeze({
      parent: this.parent,
      child: this.child,
      aggregate: this.aggregate,
    });
  }
}

/** Internal loop seam shared by parent and child lanes. */
export interface ModelExecutionContext {
  readonly lane: RequestLane;
  readonly signal?: AbortSignal;
  readonly cancellation?: TurnCancellation;
  claimModelRequest(): boolean;
  snapshot(): TurnRequestBudgetSnapshot;
}

/** The restricted context visible to one synchronously delegated planner child. */
export class ChildTurnExecutionContext implements ModelExecutionContext {
  readonly lane = 'child' as const;
  constructor(
    private readonly budget: TurnRequestBudget,
    readonly signal?: AbortSignal,
    readonly cancellation?: TurnCancellation,
  ) {}

  claimModelRequest(): boolean {
    return this.budget.claim('child');
  }

  snapshot(): TurnRequestBudgetSnapshot {
    return this.budget.snapshot();
  }
}

/**
 * Per-accepted-parent-turn state. The admission flag is set before returning a child view, so
 * direct concurrent dispatches cannot start two children while the first one is awaiting.
 */
export class ParentTurnExecutionContext implements ModelExecutionContext {
  readonly lane = 'parent' as const;
  private plannerAdmitted = false;
  private readonly child: ChildTurnExecutionContext;

  constructor(
    readonly turn: number,
    private readonly budget = new TurnRequestBudget(),
    readonly signal?: AbortSignal,
    readonly cancellation?: TurnCancellation,
  ) {
    if (!Number.isSafeInteger(turn) || turn <= 0) {
      throw new RangeError('turn must be a positive integer');
    }
    this.child = new ChildTurnExecutionContext(budget, signal, cancellation);
  }

  claimModelRequest(): boolean {
    return this.budget.claim('parent');
  }

  snapshot(): TurnRequestBudgetSnapshot {
    return this.budget.snapshot();
  }

  /** Admit at most one child and return its restricted child-lane view. */
  admitPlannerExecution(): ChildTurnExecutionContext | undefined {
    if (this.plannerAdmitted) return undefined;
    this.plannerAdmitted = true;
    return this.child;
  }

  get hasAdmittedPlannerExecution(): boolean {
    return this.plannerAdmitted;
  }
}

export const createTurnExecutionContext = (
  turn: number,
  signal?: AbortSignal,
  cancellation?: TurnCancellation,
): ParentTurnExecutionContext =>
  new ParentTurnExecutionContext(turn, undefined, signal, cancellation);

/** The execution-only wrapper passed to tools; request admission remains nested separately. */
export interface ToolExecutionContext {
  readonly modelExecution?: ModelExecutionContext;
  readonly signal?: AbortSignal;
  readonly cancellation?: TurnCancellation;
}
