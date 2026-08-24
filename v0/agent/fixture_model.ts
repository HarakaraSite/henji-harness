import { type Model, type ModelRequest, type ModelResult } from './contracts.ts';

export type FixtureStep =
  | ModelResult
  | ((request: ModelRequest, callCount: number) => ModelResult | PromiseLike<ModelResult>);

const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class FixtureModelContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureModelContractError';
  }
}

export class FixtureModel implements Model {
  private readonly steps: readonly FixtureStep[];
  private readonly requests: ModelRequest[] = [];
  private nextStep = 0;

  constructor(steps: readonly FixtureStep[]) {
    this.steps = [...steps];
  }

  get callCount(): number {
    return this.requests.length;
  }

  requestsSnapshot(): readonly ModelRequest[] {
    return snapshot(this.requests);
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(snapshot(request));
    const step = this.steps[this.nextStep++];
    if (!step) throw new FixtureModelContractError('fixture script exhausted');
    return typeof step === 'function'
      ? await step(snapshot(request), this.callCount)
      : snapshot(step);
  }
}
