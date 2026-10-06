#!/usr/bin/env python3
"""Measure the installed Pi interactive CLI using one real provider turn.

Requires explicit authorization for the provider call. Copies only the selected
provider credential/catalog into an isolated configuration; never prints them.
Samples Linux smaps_rollup for Pi and its descendants without injecting code or GC.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pi', type=Path, default=Path('/home/agent/.local/bin/pi'))
    parser.add_argument('--auth-dir', type=Path, default=Path('/home/agent/.pi/agent'))
    parser.add_argument('--provider', default='openai-codex')
    parser.add_argument('--model', default='gpt-6.1-sol')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = output / 'isolated'
    root.mkdir(exist_ok=False)
    home, agent, sessions, workspace = [root / name for name in ('home', 'agent', 'sessions', 'workspace')]
    for directory in (home, agent, sessions, workspace):
        directory.mkdir()
    auth_path = agent / 'auth.json'
    auth = json.loads((args.auth_dir / 'auth.json').read_text())
    fd = os.open(auth_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump({args.provider: auth[args.provider]}, file)
    del auth
    catalog = json.loads((args.auth_dir / 'models-store.json').read_text())
    (agent / 'models-store.json').write_text(json.dumps({args.provider: catalog[args.provider]}))
    (agent / 'settings.json').write_text(json.dumps({'quietStartup': True}))
    prompt = ('TUIのメモリ使用量を調査しています。表示本文が数KBなのにプロセスが100MB以上になる理由を、'
              '常駐データ、短命な割当、GC後のヒープ予約、ネイティブ領域、RSSとPSSの違いの5点から考察してください。'
              'どの測定で原因を区別できるかも説明してください。ツールは使わず、日本語で約1200文字。'
              '実測値を捏造せず、説明の末尾に PI_MEMORY_PROBE_DONE と記してください。')
    (output / 'prompt.txt').write_text(prompt)
    socket = f'a28-pi-{uuid.uuid4().hex[:12]}'
    env = dict(os.environ, HOME=str(home), PI_CODING_AGENT_DIR=str(agent),
               XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'data'),
               XDG_CACHE_HOME=str(root / 'cache'), PI_TELEMETRY='0', TERM='xterm-256color')
    node = shutil.which('node')
    env['PATH'] = str(Path(node).parent) + ':' + os.environ['PATH']
    flags = ['--provider', args.provider, '--model', args.model, '--thinking', 'medium',
             '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates',
             '--no-context-files', '--no-themes', '--no-approve', '--offline',
             '--tui-mode', 'fullscreen', '--session-dir', str(sessions)]
    result = dict(piVersion=subprocess.check_output([str(args.pi), '--version'], env=env, text=True).strip(),
                  nodeVersion=subprocess.check_output([node, '--version'], env=env, text=True).strip(),
                  piExecutable=str(args.pi), nodeExecutable=node,
                  cliSha256=hashlib.sha256(args.pi.resolve().read_bytes()).hexdigest(),
                  provider=args.provider, model=args.model, flags=flags, screen=[110, 36],
                  inferenceTurnsSubmitted=0, sampleIntervalSeconds=0.2,
                  startedAtUtc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  samples=[], checkpoints=[], completed=False)
    started = time.monotonic()

    def tmux(*arguments, capture=False):
        return subprocess.run(['tmux', '-L', socket, *arguments], env=env, check=True,
                              capture_output=capture, text=True)

    def sample(phase, pid):
        ids = [pid]
        for current in ids:
            try:
                ids.extend(int(value) for value in Path(f'/proc/{current}/task/{current}/children').read_text().split())
            except FileNotFoundError:
                pass
        processes = []
        for current in ids:
            values = {}
            try:
                for line in Path(f'/proc/{current}/smaps_rollup').read_text().splitlines():
                    fields = line.split()
                    if len(fields) == 3 and fields[2] == 'kB':
                        values[fields[0].rstrip(':')] = int(fields[1])
                processes.append(dict(pid=current, comm=Path(f'/proc/{current}/comm').read_text().strip(),
                                      memoryKiB=values))
            except FileNotFoundError:
                pass
        total = {key: sum(p['memoryKiB'].get(key, 0) for p in processes)
                 for key in ('Rss', 'Pss', 'Pss_Anon', 'Pss_File', 'Private_Dirty')}
        row = dict(elapsedSeconds=round(time.monotonic() - started, 3), phase=phase,
                   processes=processes, memoryKiB=total)
        result['samples'].append(row)
        return row

    def checkpoint(label, row):
        result['checkpoints'].append(dict(label=label, **row))
        print(json.dumps(dict(label=label, pssMiB=round(row['memoryKiB']['Pss'] / 1024, 2),
                              rssMiB=round(row['memoryKiB']['Rss'] / 1024, 2))), flush=True)

    def assistant_message():
        for path in sessions.rglob('*.jsonl'):
            for line in path.read_text().splitlines():
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                message = entry.get('message', {})
                if message.get('role') == 'assistant':
                    return message
        return None

    try:
        command = 'exec ' + shlex.join([str(args.pi), *flags])
        tmux('new-session', '-d', '-s', 'probe', '-x', '110', '-y', '36', '-c', str(workspace), command)
        pid = int(tmux('display-message', '-p', '-t', 'probe:0.0', '#{pane_pid}', capture=True).stdout.strip())
        result['pid'] = pid
        # Allow the interactive UI to initialize and observe an empty idle session.
        until = time.monotonic() + 10
        while time.monotonic() < until:
            sample('startup', pid)
            time.sleep(0.2)
        checkpoint('empty_idle_10s', sample('empty_idle', pid))
        (output / 'screen-before.txt').write_text(tmux('capture-pane', '-p', '-t', 'probe:0.0', capture=True).stdout)
        tmux('send-keys', '-l', '-t', 'probe:0.0', prompt)
        tmux('send-keys', '-t', 'probe:0.0', 'Enter')
        result['inferenceTurnsSubmitted'] = 1
        submitted = time.monotonic()
        message = None
        last_progress = submitted
        while time.monotonic() - submitted < 300:
            row = sample('response', pid)
            message = assistant_message()
            if message:
                break
            if time.monotonic() - last_progress >= 10:
                checkpoint('responding', row)
                last_progress = time.monotonic()
            time.sleep(0.2)
        if message is None:
            raise RuntimeError('No completed assistant message within 300 seconds; see isolated session and screen')
        result['responseSeconds'] = round(time.monotonic() - submitted, 3)
        result['assistant'] = {key: message.get(key) for key in ('provider', 'model', 'api', 'stopReason', 'usage')}
        result['assistant']['content'] = [dict(type=part.get('type'),
                                             characters=len(part.get('text', part.get('thinking', ''))),
                                             utf8Bytes=len(part.get('text', part.get('thinking', '')).encode()))
                                          for part in message.get('content', [])]
        result['completed'] = message.get('stopReason') not in ('error', 'aborted')
        finished = time.monotonic()
        for seconds in (0, 10, 30, 60):
            while time.monotonic() - finished < seconds:
                sample('idle_after', pid)
                time.sleep(0.2)
            checkpoint(f'completed_plus_{seconds}s', sample('idle_after', pid))
            (output / f'screen-after-{seconds}s.txt').write_text(
                tmux('capture-pane', '-p', '-t', 'probe:0.0', capture=True).stdout)
        for phase in ('startup', 'response', 'idle_after'):
            rows = [row for row in result['samples'] if row['phase'] == phase]
            if rows:
                peak = max(rows, key=lambda row: row['memoryKiB']['Pss'])
                result.setdefault('peaks', {})[phase] = peak
        print(json.dumps({key: result[key] for key in ('completed', 'responseSeconds', 'assistant')}), flush=True)
    finally:
        (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        subprocess.run(['tmux', '-L', socket, 'kill-server'], env=env, capture_output=True)
        auth_path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
