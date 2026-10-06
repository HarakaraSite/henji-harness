#!/usr/bin/env python3
"""A28 causal TUI memory probe. Requires deno, tmux and existing saved replay inputs.

Archives --source-commit into --output; changes only those diagnostic copies.
Replays frames over loopback HTTP into isolated HOME/XDG TUI processes, without
provider calls. Compare normal thinking layout against empty thinking layout.
Neither variant is a usable product replacement; do not install these binaries.

Example:
  python3 scripts/diagnostics/a28_tui_memory.py \
    --input .tools/a28-tui-investigation --output .tools/a28-tui-causal \
    --source-commit da251e56 --repetitions 2
"""
from pathlib import Path
import argparse
import copy
import hashlib
import http.server
import json
import os
import shlex
import shutil
import subprocess
import threading
import time
import uuid


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)


def memory(pid):
    fields = {}
    for line in (Path('/proc') / str(pid) / 'smaps_rollup').read_text().splitlines():
        parts = line.split()
        key = parts[0].rstrip(':')
        if key in ['Pss', 'Pss_Anon', 'Pss_File', 'Rss', 'Swap']:
            fields[key] = int(parts[1])
    return fields


def wait(test, label, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = test()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError('Timeout: ' + label)


def prepare(repo, source, output, commit, manifest):
    if source.exists():
        raise RuntimeError('Use a new output directory; archived source already exists')
    source.mkdir(parents=True)
    env = dict(os.environ)
    archive = subprocess.run(
        ['git', 'archive', commit, 'v0', 'vendor', 'deno.v0.json', 'deno.lock', 'jsr.json'],
        cwd=repo, env=env, check=True, capture_output=True,
    ).stdout
    subprocess.run(['tar', '-x', '-C', str(source)], input=archive, check=True)
    diagnostic = repo / 'scripts/diagnostics'
    shutil.copyfile(diagnostic / 'a28_thinking_allocation.ts', source / 'thinking_allocation.ts')
    allocation = source / 'thinking_allocation.ts'
    allocation.write_text(allocation.read_text().replace('../../v0/', './v0/'))
    shutil.copyfile(diagnostic / 'a28_tui_observer.ts', source / 'a28_tui_observer.ts')
    remote = source / 'v0/tui/remote_session.ts'
    text = remote.read_text()
    anchor = '  const snapshot = (): SessionSnapshot => state!.snapshot;'
    assert text.count(anchor) == 1
    remote.write_text(
        "import { registerTuiProbeState } from '../../a28_tui_observer.ts';\n" +
        text.replace(anchor, anchor + '\n  registerTuiProbeState(() => snapshot());')
    )
    layout = source / 'v0/tui/layout.ts'
    text = layout.read_text()
    start = text.index('const layoutLogEntry = (')
    pos = text.index('  const result: LayoutRow[] = [];', start)
    text = text[:pos] + '  countEntryLayout(entry.kind, entry.text.length);\n' + text[pos:]
    layout.write_text("import { countEntryLayout } from '../../a28_tui_observer.ts';\n" + text)
    entry = source / 'probe_entry.ts'
    entry.write_text(
        "import { installBuildManifest } from './v0/agent/runtime/build_manifest.ts';\n" +
        'installBuildManifest(' + json.dumps(manifest) + ');\n' +
        "await import('./a28_tui_observer.ts');\n" +
        "const { main } = await import('./v0/agent/cli/henji_cli.ts');\n" +
        'Deno.exit(await main(Deno.args));\n'
    )
    for variant in ['full', 'skip-thinking-wrap']:
        current = source if variant == 'full' else output / 'source-skip'
        if variant != 'full':
            shutil.copytree(source, current)
            assistant = current / 'v0/tui/assistant_layout.ts'
            text = assistant.read_text()
            start = text.index('export const thinkingBodyRenderer:')
            # Replace only thinking renderer; keep reducer, conversation and other layout paths.
            text = text[:start] + '''export const thinkingBodyRenderer: AssistantContentRenderer = Object.freeze({
  render: (_text: string, _phase: 'streaming' | 'settled', _width: number): readonly AssistantLine[] =>
    Object.freeze([line('', [], 0, 0)]),
});
'''
            assistant.write_text(text)
        command = ['deno', 'compile', '--allow-all', '--v8-flags=--expose-gc',
                   '--unstable-worker-options', '--config', str(current / 'deno.v0.json'),
                   '--include', str(current / 'v0'), '--output', str(output / ('henji.' + variant)),
                   str(current / 'probe_entry.ts')]
        with (output / ('compile-' + variant + '.log')).open('w') as log:
            subprocess.run(command, cwd=repo, env=env, stdout=log, stderr=log, check=True)
    return env


def replay(repo, inputs, output, saved, manifest, variant, ordinal):
    runtime = output / f'run-{ordinal}-{variant}'
    runtime.mkdir()
    for name in ['home', 'config', 'state', 'data', 'cache']:
        (runtime / name).mkdir(mode=0o700)
    socket = 'henji-a28-causal-' + uuid.uuid4().hex[:8]
    begin, finished, stop = threading.Event(), threading.Event(), threading.Event()
    requests = []
    initial = copy.deepcopy(saved)
    initial['cursor']['coreEpoch'] = 'tui-history-probe'
    initial['cursor']['revision'] = 0
    initial['conversation'] = dict(schemaVersion=2, sessionId=saved['session']['id'],
                                   cut=0, storeRevision=0, entities={}, order=[])
    metadata = dict(apiVersion=1, coreEpoch='tui-history-probe', build=manifest,
                    workspace=str(repo), activeSessionId=saved['session']['id'], phase='running',
                    implementedOperations=saved['runtime']['operations'])

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            requests.append('GET')
            if self.path.endswith('/events'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                try:
                    self.wfile.write(('data: ' + json.dumps(dict(kind='session.snapshot', snapshot=initial)) + '\n\n').encode())
                    self.wfile.flush()
                    begin.wait(30)
                    with (inputs / 'frames.jsonl').open('rb') as frames:
                        for frame in frames:
                            if stop.is_set():
                                break
                            self.wfile.write(b'data: ' + frame.rstrip(b'\n') + b'\n\n')
                            self.wfile.flush()
                            time.sleep(.01)
                    finished.set()
                    stop.wait(60)
                except (BrokenPipeError, ConnectionResetError):
                    finished.set()
                return
            value = metadata if self.path == '/api/v1/core' else initial if self.path == '/api/v1/sessions/' + saved['session']['id'] else None
            self.send_response(200 if value is not None else 404)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(value).encode())

        def do_POST(self):
            requests.append('POST')
            self.send_response(405)
            self.end_headers()

    def tmux(*args, check=True):
        return subprocess.run(['tmux', '-L', socket, *args], check=check, capture_output=True, text=True)

    def sample(pid, action):
        ident = uuid.uuid4().hex
        (runtime / 'command.json').write_text(json.dumps(dict(id=ident, action=action)))
        wait(lambda: (runtime / 'ack').exists() and (runtime / 'ack').read_text() == ident, action)
        data = json.loads((runtime / ('sample-' + ident + '.json')).read_text())
        data['memoryKiB'] = memory(pid)
        return data

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = dict(HOME=str(runtime / 'home'), TERM='xterm-256color', HENJI_TUI_MEMORY_PROBE=str(runtime))
    env.update({f'XDG_{name.upper()}_HOME': str(runtime / name) for name in ['config', 'state', 'data', 'cache']})
    observed = variant != 'production-control'
    binary = output / ('henji.' + variant) if observed else inputs / 'henji.production'
    command = 'exec ' + shlex.join(['env', *[f'{key}={value}' for key, value in env.items()],
                                     str(binary), 'tui', '--connect', f'http://127.0.0.1:{server.server_port}',
                                     '--session', saved['session']['id']])
    record = dict(variant=variant, ordinal=ordinal, samples=[], idle=[])
    try:
        tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'probe', '-x', '110', '-y', '36', '-c', str(repo), command)
        wait(lambda: 'Enter submit' in tmux('capture-pane', '-p', '-t', 'probe', check=False).stdout, 'TUI ready')
        pid = int(tmux('display-message', '-p', '-t', 'probe', '#{pane_pid}').stdout)
        time.sleep(1)
        record['beforeMemoryKiB'] = memory(pid)
        if observed:
            record['start'] = sample(pid, 'reset')
        begin.set()
        started = time.monotonic()
        while not finished.is_set():
            record['samples'].append(memory(pid))
            time.sleep(.2)
            assert time.monotonic() - started < 80, 'Replay timeout'
        record['replaySeconds'] = time.monotonic() - started
        ended = time.monotonic()
        for seconds in [0, 10, 30]:
            delay = ended + seconds - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            value = sample(pid, 'sample') if observed else dict(memoryKiB=memory(pid))
            record['idle'].append(dict(seconds=seconds, **value))
        (runtime / 'screen.txt').write_text(tmux('capture-pane', '-p', '-t', 'probe').stdout)
        if observed:
            record['gc'] = sample(pid, 'gc')
            record['state'] = sample(pid, 'describe')
        assert all(method == 'GET' for method in requests), requests
        record['requestMethods'] = sorted(set(requests))
        tmux('send-keys', '-t', 'probe', 'C-d')
        wait(lambda: tmux('has-session', '-t', 'probe', check=False).returncode != 0, 'TUI detach')
        return record
    finally:
        stop.set()
        begin.set()
        tmux('kill-server', check=False)
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        (runtime / 'record.json').write_text(json.dumps(record, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--repetitions', type=int, default=2)
    args = parser.parse_args()
    repo, inputs, output = Path.cwd(), args.input.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    saved = json.loads((inputs / 'session-snapshot.json').read_text())
    manifest = json.loads((inputs / 'manifest.json').read_text())
    commit = run('git', 'rev-parse', args.source_commit, env=dict(os.environ)).stdout.strip()
    assert commit == manifest['sourceRevision'], 'Source commit differs from input build manifest'
    result = dict(sourceCommit=commit, diagnosticCopies=True, originalManifest=manifest,
                  input=json.loads((inputs / 'replay-input.json').read_text()), frameDelayMs=10,
                  frameSha256=hashlib.sha256((inputs / 'frames.jsonl').read_bytes()).hexdigest(),
                  idleSeconds=[0, 10, 30], realProviderCalls=0, tasksSubmitted=0, runs=[], passed=False)
    try:
        env = prepare(repo, output / 'source-full', output, commit, manifest)
        result['binarySha256'] = {variant: hashlib.sha256((output / ('henji.' + variant)).read_bytes()).hexdigest()
                                  for variant in ['full', 'skip-thinking-wrap']}
        single = run('deno', 'run', '--allow-read', '--v8-flags=--expose-gc', '--config',
                     str(output / 'source-full/deno.v0.json'), str(output / 'source-full/thinking_allocation.ts'),
                     str(inputs / 'session-snapshot.json'), '90', env=env)
        (output / 'single-allocation.json').write_text(single.stdout)
        print('Single-call allocation measured; binaries ready', flush=True)
        variants = []
        for index in range(args.repetitions):
            variants.extend(['full', 'skip-thinking-wrap'] if index % 2 == 0 else ['skip-thinking-wrap', 'full'])
        variants.append('production-control')
        for ordinal, variant in enumerate(variants):
            record = replay(repo, inputs, output, saved, manifest, variant, ordinal)
            if 'state' in record:
                assert record['state']['cursorRevision'] == result['input']['frames'], record['state']
                assert record['state']['entities'] == result['input']['finalEntities'], record['state']
            result['runs'].append(record)
            print(json.dumps(dict(variant=variant, ordinal=ordinal,
                                  peakPssMiB=round(max(value['Pss'] for value in record['samples']) / 1024, 1),
                                  idlePssMiB=[round(value['memoryKiB']['Pss'] / 1024, 1) for value in record['idle']])), flush=True)
            (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        hashes = {record['state']['stateSha256'] for record in result['runs'] if 'state' in record}
        assert len(hashes) == 1, 'Final semantic snapshot differs between variants'
        result['passed'] = True
    finally:
        (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
