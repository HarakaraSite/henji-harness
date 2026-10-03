import { type AuthProfileId, isAuthProfileId } from './model_selection.ts';

/** Non-secret registration metadata supplied by an external tool or service. */
export interface CredentialDeclarationV1 {
  readonly schemaVersion: 1;
  readonly authProfile: AuthProfileId;
  readonly label: string;
  readonly purpose: string;
  readonly method: 'api-key';
  readonly consumers: readonly string[];
}

const CREDENTIAL_DECLARATION_DIRECTORY = 'credentials';

export class CredentialDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialDeclarationError';
  }
}

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const validateCredentialDeclaration = (value: unknown): CredentialDeclarationV1 => {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value)
  ) throw new CredentialDeclarationError('credential declaration must be an object');
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 || !isAuthProfileId(row.authProfile) ||
    !nonBlank(row.label) || !nonBlank(row.purpose) || row.method !== 'api-key' ||
    !Array.isArray(row.consumers) || !row.consumers.every(nonBlank)
  ) throw new CredentialDeclarationError('credential declaration fields are invalid');
  // Only metadata enters the catalog; no source object or unknown field is retained.
  return Object.freeze({
    schemaVersion: 1,
    authProfile: row.authProfile,
    label: row.label,
    purpose: row.purpose,
    method: 'api-key',
    consumers: Object.freeze([...row.consumers]),
  });
};

const bundled = Object.freeze([validateCredentialDeclaration({
  schemaVersion: 1,
  authProfile: 'exa-api-key',
  label: 'Exa — API key',
  purpose: 'Web search',
  method: 'api-key',
  consumers: ['tool:web_search'],
})]);

export const builtinCredentialDeclarations = (): readonly CredentialDeclarationV1[] => bundled;

/** Load external declarations at Core startup, alongside provider declarations. */
export const loadCredentialDeclarations = async (
  options: { readonly configRoot: string },
): Promise<readonly CredentialDeclarationV1[]> => {
  const directory = `${options.configRoot}/${CREDENTIAL_DECLARATION_DIRECTORY}`;
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.isDirectory && entry.name.endsWith('.json')) names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return Object.freeze([]);
    throw new CredentialDeclarationError('credential declaration directory could not be listed');
  }
  names.sort();
  const declarations: CredentialDeclarationV1[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = await Deno.readTextFile(`${directory}/${name}`);
    } catch {
      throw new CredentialDeclarationError('credential declaration could not be read');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new CredentialDeclarationError('credential declaration was not valid JSON');
    }
    declarations.push(validateCredentialDeclaration(value));
  }
  return Object.freeze(declarations);
};
