import { assert, assertEquals } from './test_helpers.ts';

const DENO = '/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno';
const LAUNCHER = `${Deno.cwd()}/v0/agent/henji_machine_launcher.sh`;
const wrapper = await Deno.readTextFile('v0/agent/henji_machine_launcher.sh');
const installer = await Deno.readTextFile(
  'v0/agent/install_henji_machine_launcher.sh',
);
const session = await Deno.readTextFile('v0/agent/session_launcher.sh');
const decoder = new TextDecoder();

const runInvalid = async (
  launcher: string,
  cwd: string,
): Promise<Deno.CommandOutput> => {
  const child = new Deno.Command('/bin/sh', {
    args: [launcher, '--invalid'],
    cwd,
    stdout: 'piped',
    stderr: 'piped',
    env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
  });
  return await child.output();
};

Deno.test('machine launcher resolves fixed sources, preserves cwd, and forwards failure safely', async () => {
  assert(
    wrapper.includes(
      'deno=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno',
    ),
  );
  assert(wrapper.includes('exec "$session_launcher" "$@"'));
  assert(wrapper.includes('PATH=$deno_dir${PATH:+:$PATH}'));
  assert(!wrapper.includes('cd -- "$repo_root"'));
  assert(wrapper.includes('config=$repo_root/deno.v0.json'));
  assert(
    wrapper.includes(
      'session_launcher=$repo_root/v0/agent/session_launcher.sh',
    ),
  );

  for (const cwd of ['/tmp', Deno.cwd()]) {
    const result = await runInvalid(LAUNCHER, cwd);
    assert(!result.success);
    assertEquals(
      decoder.decode(result.stderr),
      '{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}\n',
    );
    assert(!decoder.decode(result.stdout).includes('/home/masat.guest'));
  }

  const installedRoot = await Deno.makeTempDir({ prefix: 'henji-installed-shaped-' });
  try {
    const installed = installedRoot + '/.local/bin/henji';
    await Deno.mkdir(installedRoot + '/.local/bin', { recursive: true });
    await Deno.copyFile(LAUNCHER, installed);
    await Deno.chmod(installed, 0o755);
    const result = await runInvalid(installed, '/tmp');
    assert(!result.success);
    assertEquals(
      decoder.decode(result.stderr),
      '{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}\n',
    );
    assert(!decoder.decode(result.stdout).includes(installedRoot));
  } finally {
    await Deno.remove(installedRoot, { recursive: true });
  }
});

Deno.test('machine launcher and installer keep fixed permission and recovery boundaries', () => {
  assert(
    wrapper.includes('[ -f "$deno" ] && [ ! -L "$deno" ] && [ -x "$deno" ]'),
  );
  assert(wrapper.includes('[ -f "$config" ] && [ ! -L "$config" ]'));
  assert(
    wrapper.includes(
      '[ -f "$session_launcher" ] && [ ! -L "$session_launcher" ] && [ -x "$session_launcher" ]',
    ),
  );
  assert(installer.includes('target=/home/masat.guest/.local/bin/henji'));
  assert(
    installer.includes(
      'backup=/home/masat.guest/.local/bin/henji.pre-step83-continuation',
    ),
  );
  assert(installer.includes('check|install|rollback'));
  assert(installer.includes('cmp -s -- "$source" "$target"'));
  assert(installer.includes('cmp -s -- "$target" "$backup_temp"'));
  assert(installer.includes('mv -- "$candidate" "$target"'));
  assert(installer.includes('henji.rollback-recovery'));
  assert(!session.includes('--allow-env=HENJI_OPENROUTER_API_KEY'));
  assert(!session.includes('--allow-write="$repo_root"'));
  assert(
    session.includes(
      '--allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key',
    ),
  );
});

Deno.test('installer preserves the target across injected backup and candidate failures', async () => {
  const cases = [
    ['id', 1],
    ['stat', 1],
    ['stat', 2],
    ['stat', 3],
    ['stat', 4],
    ['stat', 5],
    ['mktemp', 1],
    ['mktemp', 2],
    ['cp', 1],
    ['cp', 2],
    ['chmod', 1],
    ['chmod', 2],
    ['cmp', 1],
    ['cmp', 2],
    ['cmp', 3],
    ['cmp', 4],
    ['mv', 1],
    ['mv', 2],
  ] as const;
  const oldEntry = '#!/bin/sh\nprintf old\n';
  const newEntry = '#!/bin/sh\nprintf new\n';

  const successRoot = await Deno.makeTempDir({ prefix: 'henji-installer-success-' });
  try {
    const agentDir = successRoot + '/v0/agent';
    const targetDir = successRoot + '/bin';
    await Deno.mkdir(agentDir, { recursive: true });
    await Deno.mkdir(targetDir);
    const sourcePath = agentDir + '/henji_machine_launcher.sh';
    const installerPath = agentDir + '/install_henji_machine_launcher.sh';
    await Deno.writeTextFile(sourcePath, newEntry);
    await Deno.chmod(sourcePath, 0o755);
    const installerSource = installer
      .replace(
        'target=/home/masat.guest/.local/bin/henji',
        'target=$repo_root/bin/henji',
      )
      .replace(
        'backup=/home/masat.guest/.local/bin/henji.pre-step83-continuation',
        'backup=$repo_root/bin/henji.pre-step83-continuation',
      )
      .replace(
        'target_dir=/home/masat.guest/.local/bin',
        'target_dir=$repo_root/bin',
      );
    await Deno.writeTextFile(installerPath, installerSource);
    await Deno.chmod(installerPath, 0o755);
    await Deno.writeTextFile(targetDir + '/henji', oldEntry);
    await Deno.chmod(targetDir + '/henji', 0o755);
    const success = await new Deno.Command('/bin/sh', {
      args: [installerPath, 'install'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(success.success);
    assert(
      (await Deno.readTextFile(targetDir + '/henji')) === newEntry,
    );
    assert(
      (await Deno.readTextFile(targetDir + '/henji.pre-step83-continuation')) === oldEntry,
    );
    const checked = await new Deno.Command('/bin/sh', {
      args: [installerPath, 'check'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(checked.success);
    const rolledBack = await new Deno.Command('/bin/sh', {
      args: [installerPath, 'rollback'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(rolledBack.success);
    assert((await Deno.readTextFile(targetDir + '/henji')) === oldEntry);
    assert(
      (await Deno.readTextFile(targetDir + '/henji.rollback-recovery')) === newEntry,
    );
  } finally {
    await Deno.remove(successRoot, { recursive: true });
  }

  for (const [command, ordinal] of cases) {
    const root = await Deno.makeTempDir({ prefix: 'henji-installer-failure-' });
    try {
      const agentDir = root + '/v0/agent';
      const targetDir = root + '/bin';
      const fakeBin = root + '/fake-bin';
      await Deno.mkdir(agentDir, { recursive: true });
      await Deno.mkdir(targetDir);
      await Deno.mkdir(fakeBin);
      const sourcePath = agentDir + '/henji_machine_launcher.sh';
      const installerPath = agentDir + '/install_henji_machine_launcher.sh';
      await Deno.writeTextFile(sourcePath, newEntry);
      await Deno.chmod(sourcePath, 0o755);
      const installerSource = installer
        .replace(
          'target=/home/masat.guest/.local/bin/henji',
          'target=$repo_root/bin/henji',
        )
        .replace(
          'backup=/home/masat.guest/.local/bin/henji.pre-step83-continuation',
          'backup=$repo_root/bin/henji.pre-step83-continuation',
        )
        .replace(
          'target_dir=/home/masat.guest/.local/bin',
          'target_dir=$repo_root/bin',
        );
      await Deno.writeTextFile(installerPath, installerSource);
      await Deno.chmod(installerPath, 0o755);
      await Deno.writeTextFile(targetDir + '/henji', oldEntry);
      await Deno.chmod(targetDir + '/henji', 0o755);
      const countPath = root + '/count';
      await Deno.writeTextFile(countPath, '0\n');
      const wrapper = [
        '#!/bin/sh',
        'set -eu',
        'if [ "$HENJI_FAIL_COMMAND" = "' + command + '" ]; then',
        '  count=$(cat "$HENJI_FAIL_COUNT" 2>/dev/null || printf "0")',
        '  count=$((count + 1))',
        '  printf "%s\\n" "$count" > "$HENJI_FAIL_COUNT"',
        '  if [ "$count" -eq "$HENJI_FAIL_ORDINAL" ]; then exit 73; fi',
        'fi',
        'exec /usr/bin/' + command + ' "$@"',
        '',
      ].join('\n');
      await Deno.writeTextFile(fakeBin + '/' + command, wrapper);
      await Deno.chmod(fakeBin + '/' + command, 0o755);
      const result = await new Deno.Command('/bin/sh', {
        args: [installerPath, 'install'],
        cwd: '/tmp',
        env: {
          PATH: fakeBin + ':/usr/bin:/bin',
          HENJI_FAIL_COMMAND: command,
          HENJI_FAIL_COUNT: countPath,
          HENJI_FAIL_ORDINAL: String(ordinal),
        },
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      assert(!result.success, command + ' #' + ordinal + ' unexpectedly succeeded');
      const target = targetDir + '/henji';
      const info = await Deno.lstat(target);
      assert(info.isFile);
      assert(!info.isSymlink);
      assertEquals(info.mode! & 0o7777, 0o755);
      const bytes = await Deno.readFile(target);
      const text = decoder.decode(bytes);
      assert(
        text === oldEntry || text === newEntry,
        command + ' #' + ordinal + ' left an incomplete target',
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }

  const rollbackCases = [
    ['id', 1],
    ['stat', 1],
    ['mktemp', 1],
    ['cp', 1],
    ['chmod', 1],
    ['cmp', 1],
    ['mv', 1],
  ] as const;
  for (const [command, ordinal] of rollbackCases) {
    const root = await Deno.makeTempDir({ prefix: 'henji-rollback-failure-' });
    try {
      const agentDir = root + '/v0/agent';
      const targetDir = root + '/bin';
      const fakeBin = root + '/fake-bin';
      await Deno.mkdir(agentDir, { recursive: true });
      await Deno.mkdir(targetDir);
      await Deno.mkdir(fakeBin);
      await Deno.writeTextFile(agentDir + '/henji_machine_launcher.sh', newEntry);
      await Deno.chmod(agentDir + '/henji_machine_launcher.sh', 0o755);
      const installerPath = agentDir + '/install_henji_machine_launcher.sh';
      const installerSource = installer
        .replace(
          'target=/home/masat.guest/.local/bin/henji',
          'target=$repo_root/bin/henji',
        )
        .replace(
          'backup=/home/masat.guest/.local/bin/henji.pre-step83-continuation',
          'backup=$repo_root/bin/henji.pre-step83-continuation',
        )
        .replace(
          'target_dir=/home/masat.guest/.local/bin',
          'target_dir=$repo_root/bin',
        );
      await Deno.writeTextFile(installerPath, installerSource);
      await Deno.chmod(installerPath, 0o755);
      await Deno.writeTextFile(targetDir + '/henji', oldEntry);
      await Deno.chmod(targetDir + '/henji', 0o755);
      const installed = await new Deno.Command('/bin/sh', {
        args: [installerPath, 'install'],
        cwd: '/tmp',
        env: { PATH: '/usr/bin:/bin' },
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      assert(installed.success);
      const countPath = root + '/count';
      await Deno.writeTextFile(countPath, '0\n');
      const commandWrapper = [
        '#!/bin/sh',
        'set -eu',
        'if [ "$HENJI_FAIL_COMMAND" = "' + command + '" ]; then',
        '  count=$(cat "$HENJI_FAIL_COUNT" 2>/dev/null || printf "0")',
        '  count=$((count + 1))',
        '  printf "%s\\n" "$count" > "$HENJI_FAIL_COUNT"',
        '  if [ "$count" -eq "$HENJI_FAIL_ORDINAL" ]; then exit 73; fi',
        'fi',
        'exec /usr/bin/' + command + ' "$@"',
        '',
      ].join('\n');
      await Deno.writeTextFile(fakeBin + '/' + command, commandWrapper);
      await Deno.chmod(fakeBin + '/' + command, 0o755);
      const result = await new Deno.Command('/bin/sh', {
        args: [installerPath, 'rollback'],
        cwd: '/tmp',
        env: {
          PATH: fakeBin + ':/usr/bin:/bin',
          HENJI_FAIL_COMMAND: command,
          HENJI_FAIL_COUNT: countPath,
          HENJI_FAIL_ORDINAL: String(ordinal),
        },
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      assert(!result.success, 'rollback ' + command + ' unexpectedly succeeded');
      assertEquals(await Deno.readTextFile(targetDir + '/henji'), newEntry);
      assertEquals(
        await Deno.readTextFile(targetDir + '/henji.pre-step83-continuation'),
        oldEntry,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }

  const cleanupRoot = await Deno.makeTempDir({ prefix: 'henji-rollback-cleanup-' });
  try {
    const agentDir = cleanupRoot + '/v0/agent';
    const targetDir = cleanupRoot + '/bin';
    const fakeBin = cleanupRoot + '/fake-bin';
    await Deno.mkdir(agentDir, { recursive: true });
    await Deno.mkdir(targetDir);
    await Deno.mkdir(fakeBin);
    await Deno.writeTextFile(agentDir + '/henji_machine_launcher.sh', newEntry);
    await Deno.chmod(agentDir + '/henji_machine_launcher.sh', 0o755);
    const installerPath = agentDir + '/install_henji_machine_launcher.sh';
    const installerSource = installer
      .replace(
        'target=/home/masat.guest/.local/bin/henji',
        'target=$repo_root/bin/henji',
      )
      .replace(
        'backup=/home/masat.guest/.local/bin/henji.pre-step83-continuation',
        'backup=$repo_root/bin/henji.pre-step83-continuation',
      )
      .replace(
        'target_dir=/home/masat.guest/.local/bin',
        'target_dir=$repo_root/bin',
      );
    await Deno.writeTextFile(installerPath, installerSource);
    await Deno.chmod(installerPath, 0o755);
    await Deno.writeTextFile(targetDir + '/henji', oldEntry);
    await Deno.chmod(targetDir + '/henji', 0o755);
    const installed = await new Deno.Command('/bin/sh', {
      args: [installerPath, 'install'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(installed.success);
    await Deno.writeTextFile(targetDir + '/henji.rollback-recovery', oldEntry);
    await Deno.writeTextFile(fakeBin + '/rm', '#!/bin/sh\nexit 73\n');
    await Deno.chmod(fakeBin + '/rm', 0o755);
    const result = await new Deno.Command('/bin/sh', {
      args: [installerPath, 'rollback'],
      cwd: '/tmp',
      env: { PATH: fakeBin + ':/usr/bin:/bin' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(!result.success);
    assertEquals(await Deno.readTextFile(targetDir + '/henji'), newEntry);
  } finally {
    await Deno.remove(cleanupRoot, { recursive: true });
  }
});

Deno.test('full-capability package keeps the real three-task bounded contract', async () => {
  const gate = await Deno.readTextFile(
    'docs/plans/step-83-full-capability-human-acceptance-gate.md',
  );
  const readme = await Deno.readTextFile('README.md');
  assert(readme.includes('henji\n'));
  assert(readme.includes('Full-capability production acceptance (separate Human Gate)'));
  assert(readme.includes(
    'docs/plans/step-83-full-capability-human-acceptance-gate.md',
  ));
  assert(!readme.includes('agent:tui --no-session'));
  assert(gate.includes('installed `/home/masat.guest/.local/bin/henji`'));
  assert(gate.includes('accepted turns: exactly 3'));
  assert(gate.includes('total model/provider requests: at most 48'));
  assert(gate.includes('retry, fallback, rerun, and additional follow-up: 0'));
  assertEquals((gate.match(/^## (?:Turn 1|Turn 2|Continue and Turn 3)$/gm) ?? []).length, 3);
  assert(gate.includes('henji --continue'));
  assert(gate.includes('henji_accept_entries=$(find -- "$henji_accept_workspace"'));
  assert(gate.includes('cat > "$henji_accept_expected" <<\'EOF\''));
  assert(gate.includes('diff -u -- "$henji_accept_expected"'));
  assert(gate.includes("-name '*.lock' -o -name '*.tmp*'"));
  assert(gate.includes('case "$henji_accept_workspace" in'));
  assert(gate.includes('test ! -e "$henji_accept_workspace"'));
  assert(!gate.includes('ui_retained_acceptance_launcher'));
  assert(!gate.includes('detached_ui_acceptance_fixture'));
  assert(!gate.includes('agent:ui-retained:acceptance'));
});

void DENO;
