interface InfoModule {
  readonly specifier: string;
  readonly local?: string;
}

interface InfoOutput {
  readonly modules: readonly InfoModule[];
}

const repositoryRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const deno = `${repositoryRoot}/.tools/deno/2.9.4/deno`;
const cache = `${repositoryRoot}/.tools/deno-cache/spike2`;
const roots = [
  'spike2/src/admission_service.ts',
  'spike2/src/subset_checker.ts',
  'spike2/src/admission_profile.ts',
  'spike2/src/admission_policy.ts',
  'spike2/src/runtime_schema.ts',
  'spike2/builder/main.ts',
] as const;

for (const root of roots) {
  const output = await new Deno.Command(deno, {
    args: [
      'info',
      '--json',
      '--config',
      `${repositoryRoot}/deno.spike2.json`,
      '--lock',
      `${repositoryRoot}/deno.spike2.lock`,
      '--frozen',
      '--no-remote',
      '--deny-import',
      `${repositoryRoot}/${root}`,
    ],
    clearEnv: true,
    env: { DENO_DIR: cache },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!output.success) throw new Error(`deno info failed for ${root}`);
  const info = JSON.parse(new TextDecoder().decode(output.stdout)) as InfoOutput;
  for (const module of info.modules) {
    if (module.specifier === 'npm:/typescript@6.0.3') continue;
    if (module.specifier.startsWith('file://')) {
      const path = new URL(module.specifier).pathname;
      if (
        path.startsWith(`${repositoryRoot}/spike0/src/`) ||
        path.startsWith(`${repositoryRoot}/spike1/src/`) ||
        path.startsWith(`${repositoryRoot}/spike2/src/`) ||
        path.startsWith(`${repositoryRoot}/spike2/builder/`)
      ) continue;
    }
    throw new Error(`unapproved module in ${root}: ${module.specifier}`);
  }
}
