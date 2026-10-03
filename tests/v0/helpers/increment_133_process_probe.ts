export const processProbeChoice = { name: 'process-probe' } as const;

export const processProbeCall = (mode: string): string =>
  `process-tool-call:${JSON.stringify({ name: 'process_probe', arguments: { mode } })}`;

export const writeProcessProbeConfiguration = async (
  configRoot: string,
): Promise<void> => {
  const entry = new URL('../fixtures/increment_133_process_tool.ts', import.meta.url)
    .pathname;
  await Deno.mkdir(`${configRoot}/agents`, { recursive: true });
  await Deno.mkdir(`${configRoot}/tools/process_probe`, { recursive: true });
  await Deno.writeTextFile(
    `${configRoot}/agents.json`,
    JSON.stringify({
      schemaVersion: 1,
      agents: { 'process-probe': 'agents/process-probe.json' },
    }),
  );
  await Deno.writeTextFile(
    `${configRoot}/agents/process-probe.json`,
    JSON.stringify({
      name: 'process-probe',
      revision: 'increment-133-process-probe',
      instruction: 'Run the assigned process lifetime probe.',
      tools: ['process_probe'],
      agents: [],
    }),
  );
  await Deno.writeTextFile(
    `${configRoot}/tools.json`,
    JSON.stringify({
      schemaVersion: 1,
      tools: { process_probe: 'tools/process_probe' },
    }),
  );
  await Deno.writeTextFile(
    `${configRoot}/tools/process_probe/tool.json`,
    JSON.stringify({
      name: 'process_probe',
      apiContract: 'henji-tool/v1',
      revision: 'increment-133-process-probe',
      entry,
    }),
  );
};
