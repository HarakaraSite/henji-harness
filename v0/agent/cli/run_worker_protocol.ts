import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import type { ConfigurationRejection } from '../configuration/agent_configuration.ts';
import type { BuildManifestV1 } from '../runtime/build_manifest.ts';
import type { AgentEvent } from '../core/events.ts';
import type { HeadlessWorkerRun } from '../worker/worker_headless_runner.ts';

export interface RunWorkerRuntimePaths {
  readonly dataRoot: string;
  readonly configRoot: string;
}

export interface CliAgentSelectionInfo {
  readonly choice: AgentConfigurationChoice;
}

export interface CliRunOptions {
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
}

export interface ConfigurationStartupErrorValue {
  readonly code: string;
  readonly message: string;
  readonly stage: string;
  readonly reason: string;
  readonly rejections?: readonly ConfigurationRejection[];
}

export interface HenjiInstructionErrorValue {
  readonly code: string;
  readonly message: string;
}

export type RunWorkerErrorData =
  | { readonly kind: 'configuration'; readonly value: ConfigurationStartupErrorValue }
  | { readonly kind: 'instruction'; readonly value: HenjiInstructionErrorValue }
  | { readonly kind: 'invalid_configuration' }
  | { readonly kind: 'agent_failure' };

/** Reconstituted on the CLI side from public error data sent by the Host. */
export class RunWorkerPortError extends Error {
  constructor(readonly data: RunWorkerErrorData) {
    super(data.kind);
    this.name = 'RunWorkerPortError';
  }
}

export interface RunWorkerStart {
  readonly kind: 'start';
  readonly args: readonly string[];
  readonly build: BuildManifestV1;
  readonly runtimePaths: RunWorkerRuntimePaths;
}

export type RunWorkerToMain =
  | {
    readonly kind: 'resolve.request';
    readonly id: number;
    readonly rawAgentName: string | undefined;
    readonly rawAgentFile: string | undefined;
  }
  | {
    readonly kind: 'run.request';
    readonly id: number;
    readonly task: string;
    readonly events: boolean;
    readonly options: CliRunOptions;
  }
  | { readonly kind: 'done'; readonly exitCode: number };

export type MainToRunWorker =
  | RunWorkerStart
  | {
    readonly kind: 'resolve.result';
    readonly id: number;
    readonly selection: CliAgentSelectionInfo;
  }
  | {
    readonly kind: 'resolve.error';
    readonly id: number;
    readonly error: RunWorkerErrorData;
  }
  | { readonly kind: 'run.event'; readonly event: AgentEvent }
  | {
    readonly kind: 'run.result';
    readonly id: number;
    readonly result: HeadlessWorkerRun;
  }
  | {
    readonly kind: 'run.error';
    readonly id: number;
    readonly error: RunWorkerErrorData;
  };
