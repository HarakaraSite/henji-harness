const [selected, lock, sibling, sessions, contexts, other] = Deno.args;
if (
  [selected, lock, sibling, sessions, contexts, other].some((value) => value === undefined)
) {
  Deno.exit(2);
}

const canOpenForWrite = async (path: string): Promise<boolean> => {
  try {
    const file = await Deno.open(path, { write: true });
    file.close();
    return true;
  } catch {
    return false;
  }
};

const canCreateForWrite = async (path: string): Promise<boolean> => {
  try {
    const file = await Deno.open(path, { write: true, createNew: true });
    file.close();
    await Deno.remove(path);
    return true;
  } catch {
    return false;
  }
};

console.log(JSON.stringify({
  selected: await canOpenForWrite(selected),
  lock: await canOpenForWrite(lock),
  sibling: await canOpenForWrite(sibling),
  sessions: await canCreateForWrite(sessions + '/probe'),
  contexts: await canCreateForWrite(contexts + '/probe'),
  other: await canCreateForWrite(other + '/probe'),
}));
