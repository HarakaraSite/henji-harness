/** One synchronous resolve request sent from the code Worker to its acquisition Worker. */
export interface ModuleRequest {
  readonly specifier: string;
  readonly parentURL?: string;
  readonly cache: string;
  readonly replyPath: string;
  readonly signal: Int32Array<SharedArrayBuffer>;
}

export type ModuleReply =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };
