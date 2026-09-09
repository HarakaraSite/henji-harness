/**
 * The bounded, secret-free projection used by the normal TUI startup orientation.
 *
 * This module deliberately accepts only already-resolved primitive startup values.  It does not
 * retain a Definition, resource selection, model, registry, filesystem snapshot, or credential
 * source, and therefore cannot trigger a second runtime composition while rendering.
 */

const encoder = new TextEncoder();

export const MAX_RUNTIME_DISPLAY_STATE_BYTES = 1_024;
export const MAX_WORKSPACE_DISPLAY_BYTES = 96;
export const MAX_DISPLAY_SKILL_NAMES = 5;
export const CREDENTIAL_VERIFICATION_POLICY = 'before_each_provider_request' as const;

export type RuntimeDisplayAgentId = 'default' | 'planner';
export type RuntimeDisplayInstructionSource = 'AGENTS.md' | 'AGENTS.MD' | 'none';
export type RuntimeDisplaySessionMode = 'new' | 'continue' | 'session' | 'none';

export interface RuntimeDisplayState {
  readonly workspace: string;
  readonly agentId: RuntimeDisplayAgentId;
  readonly model: {
    readonly provider: 'openrouter' | 'openai';
    readonly profileId: string;
    readonly modelId: string;
    readonly effort: string;
  };
  readonly sessionMode:
    | { readonly kind: 'new' }
    | { readonly kind: 'continue' }
    | { readonly kind: 'exact' }
    | { readonly kind: 'none' };
  readonly instructions: {
    readonly loaded: boolean;
    readonly source: RuntimeDisplayInstructionSource;
  };
  readonly skills: {
    readonly count: number;
    readonly names: readonly string[];
    readonly omitted: number;
  };
  readonly trust: {
    readonly hardSandbox: false;
    readonly osUserTools: readonly ('bash' | 'edit' | 'write')[];
  };
  readonly credentialVerification: typeof CREDENTIAL_VERIFICATION_POLICY;
}

export interface RuntimeDisplayProjectionInput {
  readonly workspaceRoot: string;
  readonly agentId: RuntimeDisplayAgentId;
  readonly profileId: string;
  readonly provider?: 'openrouter' | 'openai';
  readonly modelId?: string;
  readonly effort?: string;
  readonly sessionMode: RuntimeDisplaySessionMode;
  readonly instructionSource?: RuntimeDisplayInstructionSource;
  readonly skillNames: readonly string[];
}

const hasForbiddenDisplayCodePoint = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (
      code === 0x061c || (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
    ) return true;
  }
  return false;
};

const wellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const isSafeDisplayText = (value: string): boolean =>
  wellFormed(value) && !hasForbiddenDisplayCodePoint(value);

const suffixWithinBytes = (value: string, maxBytes: number): string => {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const marker = '…';
  const markerBytes = encoder.encode(marker).byteLength;
  let suffix = '';
  let used = markerBytes;
  const characters = [...value];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    const size = encoder.encode(character).byteLength;
    if (used + size > maxBytes) break;
    suffix = character + suffix;
    used += size;
  }
  return `${marker}${suffix}`;
};

/** Make a bounded human-readable label without changing the canonical workspace identity. */
export const displayWorkspaceLabel = (workspaceRoot: string): string => {
  if (!isSafeDisplayText(workspaceRoot) || !workspaceRoot.startsWith('/')) return 'workspace';
  const components = workspaceRoot.split('/').filter((component) => component.length > 0);
  if (components.length === 0) return '/';
  return suffixWithinBytes(workspaceRoot, MAX_WORKSPACE_DISPLAY_BYTES);
};

const boundedProfileId = (profileId: string): string => {
  if (!isSafeDisplayText(profileId) || profileId.length === 0) return 'profile';
  // Resource identities already enforce a 128-byte component bound. Keep a defensive bound for
  // direct callers so the display state remains bounded even when fed malformed test input.
  return suffixWithinBytes(profileId, 128);
};

const sessionMode = (
  value: RuntimeDisplaySessionMode,
): RuntimeDisplayState['sessionMode'] => {
  switch (value) {
    case 'new':
      return Object.freeze({ kind: 'new' });
    case 'continue':
      return Object.freeze({ kind: 'continue' });
    case 'session':
      return Object.freeze({ kind: 'exact' });
    case 'none':
      return Object.freeze({ kind: 'none' });
    default:
      return Object.freeze({ kind: 'none' });
  }
};

const instructionSource = (
  value: RuntimeDisplayInstructionSource | undefined,
): RuntimeDisplayInstructionSource =>
  value === 'AGENTS.md' || value === 'AGENTS.MD' ? value : 'none';

const frozenSkills = (skillNames: readonly string[]): RuntimeDisplayState['skills'] => {
  const count = Array.isArray(skillNames) ? skillNames.length : 0;
  const names = (Array.isArray(skillNames) ? skillNames : [])
    .slice(0, MAX_DISPLAY_SKILL_NAMES)
    .map((name) =>
      typeof name === 'string' && isSafeDisplayText(name) ? suffixWithinBytes(name, 64) : 'skill'
    );
  return Object.freeze({
    count,
    names: Object.freeze(names),
    omitted: Math.max(0, count - names.length),
  });
};

const canonicalBytes = (state: RuntimeDisplayState): number =>
  encoder.encode(JSON.stringify(state)).byteLength;

/** Project one deeply immutable display state from validated startup primitives. */
export const projectRuntimeDisplayState = (
  input: RuntimeDisplayProjectionInput,
): RuntimeDisplayState => {
  const agentId: RuntimeDisplayAgentId = input.agentId === 'planner' ? 'planner' : 'default';
  const trustTools = agentId === 'default'
    ? Object.freeze(['bash', 'edit', 'write'] as const)
    : Object.freeze([] as const);
  const instructions = Object.freeze({
    loaded: input.instructionSource === 'AGENTS.md' || input.instructionSource === 'AGENTS.MD',
    source: instructionSource(input.instructionSource),
  });
  const state = Object.freeze({
    workspace: displayWorkspaceLabel(input.workspaceRoot),
    agentId,
    model: Object.freeze({
      provider: input.provider === 'openai' ? 'openai' as const : 'openrouter' as const,
      profileId: boundedProfileId(input.profileId),
      modelId: boundedProfileId(input.modelId ?? input.profileId),
      effort: boundedProfileId(input.effort ?? 'auto'),
    }),
    sessionMode: sessionMode(input.sessionMode),
    instructions,
    skills: frozenSkills(input.skillNames),
    trust: Object.freeze({ hardSandbox: false as const, osUserTools: trustTools }),
    credentialVerification: CREDENTIAL_VERIFICATION_POLICY,
  });
  if (canonicalBytes(state) > MAX_RUNTIME_DISPLAY_STATE_BYTES) {
    // This should be unreachable with the fixed projection bounds. Retain a deterministic
    // fallback instead of allowing malformed direct input to create an unbounded state.
    const fallback = Object.freeze({
      ...state,
      model: Object.freeze({
        provider: input.provider === 'openai' ? 'openai' as const : 'openrouter' as const,
        profileId: 'profile',
        modelId: 'model',
        effort: 'auto',
      }),
      skills: Object.freeze({ count: 0, names: Object.freeze([] as string[]), omitted: 0 }),
    });
    if (canonicalBytes(fallback) > MAX_RUNTIME_DISPLAY_STATE_BYTES) {
      throw new Error('runtime display state exceeds bound');
    }
    return fallback;
  }
  return state;
};

/** Descriptive alias for callers that prefer the construction verb. */
export const buildRuntimeDisplayState = projectRuntimeDisplayState;
