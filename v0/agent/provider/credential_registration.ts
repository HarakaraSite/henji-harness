/**
 * Host-local credential registration for the production TUI.
 *
 * The registration catalog is derived from the effective Provider declarations and the value is
 * written to the same fixed request-time credential file the resolver already reads. This module
 * never returns, logs, or embeds the value in an error; the dedicated dialog is the only input
 * surface and the fixed path is never caller-selected.
 */

import {
  CredentialFileError,
  credentialFileFor,
  MAX_CREDENTIAL_BYTES,
  parseCredentialBytes,
} from './credential_file.ts';
import { type AuthProfileId, isAuthProfileId, type ProviderId } from './model_selection.ts';
import { providerIdsForSelection } from './model_catalog.ts';
import { effectiveDeclarationFor } from './provider_runtime.ts';

/** One registration row per auth profile; shared profiles register once for every provider. */
export interface CredentialRegistrationTarget {
  readonly authProfile: AuthProfileId;
  readonly providers: readonly ProviderId[];
}

export interface CredentialRegistration {
  targets(): readonly CredentialRegistrationTarget[];
  save(authProfile: AuthProfileId, value: string): Promise<void>;
}

export type CredentialRegistrationFailureCode =
  | 'credential_registration_profile_invalid'
  | 'credential_registration_value_invalid'
  | 'credential_registration_write_failed';

export class CredentialRegistrationError extends Error {
  readonly code: CredentialRegistrationFailureCode;

  constructor(code: CredentialRegistrationFailureCode) {
    super(code);
    this.name = 'CredentialRegistrationError';
    this.code = code;
  }
}

const encoder = new TextEncoder();

const fail = (code: CredentialRegistrationFailureCode): never => {
  throw new CredentialRegistrationError(code);
};

/** Short value-free reason for one failed save, safe to show in the dialog and status line. */
export const credentialRegistrationFailureNotice = (error: unknown): string =>
  error instanceof CredentialRegistrationError
    ? error.code === 'credential_registration_value_invalid'
      ? 'credential input invalid'
      : error.code === 'credential_registration_profile_invalid'
      ? 'credential profile invalid'
      : 'credential write failed'
    : 'credential save failed';

/**
 * Encode and validate the value exactly as it will be stored, so a value the current reader
 * rejects can never be reported as a successful registration.
 */
const credentialBytesOf = (value: string): Uint8Array => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CREDENTIAL_BYTES) {
    fail('credential_registration_value_invalid');
  }
  try {
    parseCredentialBytes(bytes);
  } catch (error) {
    if (error instanceof CredentialFileError) {
      fail('credential_registration_value_invalid');
    }
    throw error;
  }
  return bytes;
};

/**
 * Write one unique same-directory temporary file, then replace the fixed path. New and updated
 * credentials take the same route, so an existing file is never truncated or chmodded in place and
 * a write failure leaves it readable.
 */
const replaceCredentialFile = async (path: string, bytes: Uint8Array): Promise<void> => {
  const separator = path.lastIndexOf('/');
  const directory = path.slice(0, separator);
  const name = path.slice(separator + 1);
  const temporary = `${directory}/.${name}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.mkdir(directory, { recursive: true });
  } catch {
    fail('credential_registration_write_failed');
  }
  let temporaryOwned = false;
  try {
    const file = await Deno.open(temporary, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    temporaryOwned = true;
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await file.write(bytes.subarray(offset));
        if (!Number.isSafeInteger(written) || written <= 0) {
          fail('credential_registration_write_failed');
        }
        offset += written;
      }
    } catch (error) {
      try {
        file.close();
      } catch {
        // The write failure below stays authoritative.
      }
      throw error;
    }
    file.close();
    await Deno.chmod(temporary, 0o600);
    await Deno.rename(temporary, path);
    temporaryOwned = false;
  } catch (error) {
    if (error instanceof CredentialRegistrationError) throw error;
    fail('credential_registration_write_failed');
  } finally {
    if (temporaryOwned) {
      try {
        await Deno.remove(temporary);
      } catch {
        // Only this save's own temporary file is ever considered for cleanup.
      }
    }
  }
};

/** Group effective Provider declarations into one registration row per auth profile. */
export const credentialRegistrationTargets = (): readonly CredentialRegistrationTarget[] => {
  const providersByProfile = new Map<AuthProfileId, ProviderId[]>();
  for (const provider of providerIdsForSelection()) {
    const declaration = effectiveDeclarationFor(provider);
    if (declaration === undefined) continue;
    const providers = providersByProfile.get(declaration.authProfile);
    if (providers === undefined) {
      providersByProfile.set(declaration.authProfile, [provider]);
    } else providers.push(provider);
  }
  return Object.freeze(
    [...providersByProfile].map(([authProfile, providers]) =>
      Object.freeze({
        authProfile,
        providers: Object.freeze([...providers]),
      })
    ),
  );
};

export const createCredentialRegistration = (): CredentialRegistration =>
  Object.freeze({
    targets: credentialRegistrationTargets,
    save: async (authProfile: AuthProfileId, value: string): Promise<void> => {
      if (!isAuthProfileId(authProfile)) {
        fail('credential_registration_profile_invalid');
      }
      const bytes = credentialBytesOf(value);
      await replaceCredentialFile(credentialFileFor(authProfile), bytes);
    },
  });
