export type ErrorCode =
  | 'invalid_envelope'
  | 'invalid_jsonl'
  | 'message_limit_exceeded'
  | 'invalid_model_request'
  | 'invalid_model_response'
  | 'invalid_plan'
  | 'planner_output_invalid'
  | 'process_timeout'
  | 'process_output_limit'
  | 'host_handler_failed'
  | 'plugin_response_failed'
  | 'plugin_exit'
  | 'protocol_violation';

export interface HarnessError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly cause?: { readonly code: string; readonly message: string };
}

export const error = (
  code: ErrorCode,
  message: string,
  cause?: HarnessError['cause'],
): HarnessError => (cause === undefined ? { code, message } : { code, message, cause });
