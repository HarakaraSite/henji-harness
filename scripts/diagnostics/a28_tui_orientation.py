#!/usr/bin/env python3
"""Compare repeated orientation updates with one-time orientation on unchanged metadata.

  python3 scripts/diagnostics/a28_tui_orientation.py \
    --input .tools/a28-tui-investigation --source .tools/a28-tui-causal/source-full \
    --output .tools/a28-tui-orientation

Requires replay frames with no control changes. Uses identical binary bytes and
original thinking layout in both variants. The one-time branch is a diagnostic
ablation only: it cannot handle changing Session/runtime metadata in real use.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
from a28_tui_memory import replay


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo, inputs, output = Path.cwd(), args.input.resolve(), args.output.resolve()
    frames = [json.loads(line) for line in (inputs / 'frames.jsonl').read_text().splitlines()]
    assert all(not frame.get('changes') for frame in frames), 'Probe only supports unchanged metadata'
    output.mkdir(parents=True, exist_ok=True)
    source = output / 'source'
    shutil.copytree(args.source.resolve(), source)
    remote = source / 'v0/tui/remote_session.ts'
    text = remote.read_text()
    anchor = '  renderSessionOrientation(renderer, snapshot, workspace, cancellingExecutionId);'
    assert text.count(anchor) == 1
    declarations = "const probeOnceOrientation = Deno.execPath().endsWith('henji.stable-orientation');\nconst probeOriented = new WeakSet<TuiRenderer>();\n"
    text = text.replace('const renderSnapshot = (', declarations + '\nconst renderSnapshot = (')
    text = text.replace(anchor, '''  if (!probeOnceOrientation || !probeOriented.has(renderer)) {
    renderSessionOrientation(renderer, snapshot, workspace, cancellingExecutionId);
    probeOriented.add(renderer);
  }''')
    remote.write_text(text)
    binary = output / 'henji.normal-orientation'
    with (output / 'compile.log').open('w') as log:
        subprocess.run(['deno', 'compile', '--allow-all', '--v8-flags=--expose-gc',
                        '--unstable-worker-options', '--config', str(source / 'deno.v0.json'),
                        '--include', str(source / 'v0'), '--output', str(binary), str(source / 'probe_entry.ts')],
                       stdout=log, stderr=log, check=True)
    os.link(binary, output / 'henji.stable-orientation')
    manifest = json.loads((inputs / 'manifest.json').read_text())
    saved = json.loads((inputs / 'session-snapshot.json').read_text())
    result = dict(sourceCommit=manifest['sourceRevision'], diagnosticCopies=True,
                  identicalBinarySha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                  input=json.loads((inputs / 'replay-input.json').read_text()), frameDelayMs=10,
                  providerCalls=0, tasksSubmitted=0, idleSeconds=[0, 10, 30], runs=[], passed=False)
    try:
        for ordinal, variant in enumerate(['normal-orientation', 'stable-orientation',
                                            'stable-orientation', 'normal-orientation']):
            record = replay(repo, inputs, output, saved, manifest, variant, ordinal)
            assert record['state']['cursorRevision'] == len(frames)
            assert record['state']['entities'] == result['input']['finalEntities']
            screen = (output / f'run-{ordinal}-{variant}/screen.txt').read_bytes()
            record['screenSha256'] = hashlib.sha256(screen).hexdigest()
            result['runs'].append(record)
            print(json.dumps(dict(variant=variant, ordinal=ordinal,
                                  peakPssMiB=round(max(row['Pss'] for row in record['samples']) / 1024, 1),
                                  idlePssMiB=[round(row['memoryKiB']['Pss'] / 1024, 1) for row in record['idle']],
                                  allocatedMiB=round(record['idle'][-1]['allocatedSinceReset'] / 1048576, 1))), flush=True)
            (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        assert len({record['state']['stateSha256'] for record in result['runs']}) == 1
        assert len({record['screenSha256'] for record in result['runs']}) == 1
        result['passed'] = True
    finally:
        (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
