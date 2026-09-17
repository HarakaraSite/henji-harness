import { isStoredModelSelection, type ModelSelection } from './model_selection.ts';

export const DEFAULT_SELECTION_FILE = 'default-selection.json';

export const defaultSelectionPath = (configRoot: string): string =>
  `${configRoot}/${DEFAULT_SELECTION_FILE}`;

/** Read the Host-owned default selection for new sessions; missing or invalid means none. */
export const readDefaultSelection = async (
  configRoot: string,
): Promise<ModelSelection | undefined> => {
  let text: string;
  try {
    text = await Deno.readTextFile(defaultSelectionPath(configRoot));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isStoredModelSelection(parsed) ? parsed : undefined;
};

/** Atomically replace the Host-owned default selection. */
export const writeDefaultSelection = async (
  configRoot: string,
  selection: ModelSelection,
): Promise<void> => {
  await Deno.mkdir(configRoot, { recursive: true });
  const path = defaultSelectionPath(configRoot);
  const staging = `${path}.staging-${crypto.randomUUID().toLowerCase()}`;
  try {
    await Deno.writeTextFile(staging, `${JSON.stringify(selection)}\n`);
    await Deno.rename(staging, path);
  } finally {
    try {
      await Deno.remove(staging);
    } catch {
      // A successful rename already published the complete file.
    }
  }
};
