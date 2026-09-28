/** Serialize initial schema opening without creating state for a read-only viewer. */
export const withHistorySchemaOpen = async <T>(
  databaseDirectory: string,
  open: () => T,
): Promise<T> => {
  const directory = await Deno.open(databaseDirectory, { read: true });
  try {
    await directory.lock(true);
    return open();
  } finally {
    directory.close();
  }
};
