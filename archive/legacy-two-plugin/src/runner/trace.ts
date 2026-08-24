export interface TraceEvent {
  readonly name: string;
  readonly durationMs?: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly plugin?: { readonly id: string; readonly version: string; readonly sourceHash: string };
  readonly failureCode?: string;
  readonly payloadHash?: string;
}

export interface RunTrace {
  readonly runId: string;
  readonly events: readonly TraceEvent[];
}

export const hashPayload = async (payload: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
};
