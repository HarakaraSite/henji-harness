import type { Message } from '../core/contracts.ts';
import type { AgentReplayEnvelopeV1 } from '../session/replay_envelope.ts';

export const EXECUTION_RECORD_SCHEMA_VERSION = 1 as const;
export const MAX_EXECUTION_MODEL_CALLS = 16;
export const MAX_EXECUTION_TOOL_CALLS = 512;
export const MAX_EXECUTION_TOOL_RESULTS = 512;
export const MAX_EXECUTION_TRANSCRIPT_MESSAGES = 512;
export const MAX_EXECUTION_TRANSCRIPT_BYTES = 524_288;
export const MAX_EXECUTION_RECORD_BYTES = 1_048_576;

export const TOOL_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const STOP_REASONS = [
  'final',
  'tool_terminal',
  'max_steps',
  'contract_failure',
  'cancelled',
] as const;
export const RESULT_KINDS = ['final', 'tool_calls', 'error', 'cancelled'] as const;
export const TOOL_OUTCOMES = ['success', 'error'] as const;
export const encoder = new TextEncoder();

export type ExecutionRole = 'parent' | 'planner';
export type ExecutionResultKind = typeof RESULT_KINDS[number];
export type ExecutionStopReason = typeof STOP_REASONS[number];

export interface AgentExecutionModelCall {
  readonly ordinal: number;
  readonly role: ExecutionRole;
  readonly roleOrdinal: number;
  readonly resultKind: ExecutionResultKind;
}

export interface AgentExecutionToolCall {
  readonly ordinal: number;
  readonly role: ExecutionRole;
  readonly roleOrdinal: number;
  readonly modelCallOrdinal: number;
  readonly callId: string;
  readonly name: string;
  readonly arguments: import('../core/contracts.ts').JsonValue;
}

export interface AgentExecutionToolResult {
  readonly ordinal: number;
  readonly role: ExecutionRole;
  readonly roleOrdinal: number;
  readonly callOrdinal: number;
  readonly callId: string;
  readonly name: string;
  readonly outcome: 'success' | 'error';
  readonly terminal: 'none' | 'json_result';
  readonly result: import('../core/contracts.ts').JsonValue;
}

export interface AgentExecutionOutcome {
  readonly ok: boolean;
  readonly stopReason: ExecutionStopReason;
  readonly committed: boolean;
  readonly terminalKind: 'none' | 'json_result';
}

export interface AgentExecutionRoleCounts {
  readonly parent: number;
  readonly planner: number;
  readonly aggregate: number;
}

export interface AgentExecutionUsage {
  readonly steps: number;
  readonly modelRequests: AgentExecutionRoleCounts;
  readonly externalRequests: number;
  readonly toolCalls: AgentExecutionRoleCounts;
  readonly toolResults: AgentExecutionRoleCounts;
  readonly providerTokenUsage: 'unsupported';
  readonly cost: 'unsupported';
}

export interface AgentExecutionRecordV1 {
  readonly schemaVersion: 1;
  readonly runOrdinal: number;
  readonly envelopeIdentity: string;
  readonly manifestIdentity: string;
  readonly durationMicros: number;
  readonly outcome: AgentExecutionOutcome;
  readonly usage: AgentExecutionUsage;
  readonly modelCalls: readonly AgentExecutionModelCall[];
  readonly toolCalls: readonly AgentExecutionToolCall[];
  readonly toolResults: readonly AgentExecutionToolResult[];
  readonly transcript: readonly Message[];
}

export class AgentExecutionRecordError extends Error {
  constructor() {
    super('invalid agent execution record');
    this.name = 'AgentExecutionRecordError';
  }
}

export interface AgentExecutionModelCallInput {
  readonly role: ExecutionRole;
  readonly resultKind: ExecutionResultKind;
}
export interface AgentExecutionToolCallInput {
  readonly role: ExecutionRole;
  readonly modelCallOrdinal?: number;
  readonly callId: string;
  readonly name: string;
  readonly arguments: import('../core/contracts.ts').JsonValue;
}
export interface AgentExecutionToolResultInput {
  readonly role: ExecutionRole;
  readonly callOrdinal?: number;
  readonly callId: string;
  readonly name: string;
  readonly outcome: 'success' | 'error';
  readonly terminal?: 'none' | 'json_result';
  readonly result: import('../core/contracts.ts').JsonValue;
}
export interface AgentExecutionRecorderFinish {
  readonly outcome: AgentExecutionOutcome;
  readonly externalRequests: number;
  readonly transcript: readonly Message[];
}
export interface AgentExecutionRecorderOptions {
  readonly envelope: AgentReplayEnvelopeV1;
  readonly runOrdinal: number;
  readonly clock: () => number;
}
