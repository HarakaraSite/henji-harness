/** Write a named JSON Agent used by provider-free child integration tests. */
export const writeProbeAgentConfiguration = async (
  configRoot: string,
  name = 'probe-child',
  configuration: unknown = {
    name,
    revision: 'test-label',
    instruction: 'Complete the assigned child task.',
    tools: [],
    agents: [],
  },
): Promise<string> => {
  const agentFile = `${configRoot}/agents/${name}.json`;
  await Deno.mkdir(`${configRoot}/agents`, { recursive: true });
  await Deno.writeTextFile(
    `${configRoot}/agents.json`,
    JSON.stringify({
      schemaVersion: 1,
      agents: { [name]: `agents/${name}.json` },
    }),
  );
  await Deno.writeTextFile(agentFile, JSON.stringify(configuration));
  return agentFile;
};
