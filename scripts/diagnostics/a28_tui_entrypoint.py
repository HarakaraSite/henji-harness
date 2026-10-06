#!/usr/bin/env python3
"""Compare common CLI and dedicated TUI entry using identical compiled binary bytes.

Run after a28_tui_memory.py has prepared an observed archived source:
  python3 scripts/diagnostics/a28_tui_entrypoint.py \
    --input .tools/a28-tui-investigation --source .tools/a28-tui-causal/source-full \
    --output .tools/a28-tui-entrypoint

Uses an empty conversation and loopback fake Core, no events/tasks/provider calls.
Only diagnostic copies are changed. Bypassing the common CLI is not a product fix.
"""
from pathlib import Path
import argparse
import copy
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
    output.mkdir(parents=True, exist_ok=True)
    source = output / 'source'
    shutil.copytree(args.source.resolve(), source)
    manifest = json.loads((inputs / 'manifest.json').read_text())
    saved = copy.deepcopy(json.loads((inputs / 'session-snapshot.json').read_text()))
    saved['runtime'].update(active=False, execution=None, phase='idle')
    empty_input = output / 'empty-input'
    empty_input.mkdir()
    (empty_input / 'frames.jsonl').write_text('')
    entry = source / 'probe_entry.ts'
    entry.write_text(
        "import { installBuildManifest } from './v0/agent/runtime/build_manifest.ts';\n" +
        'installBuildManifest(' + json.dumps(manifest) + ');\n' +
        "await import('./a28_tui_observer.ts');\n" +
        "const dedicated = Deno.execPath().endsWith('henji.tui-entry');\n" +
        "if (dedicated) {\n" +
        "  const { main } = await import('./v0/agent/cli/tui_cli.ts');\n" +
        "  Deno.exit(await main(Deno.args.slice(1)));\n" +
        "} else {\n" +
        "  const { main } = await import('./v0/agent/cli/henji_cli.ts');\n" +
        "  Deno.exit(await main(Deno.args));\n" +
        "}\n"
    )
    binary = output / 'henji.common-entry'
    with (output / 'compile.log').open('w') as log:
        subprocess.run(['deno', 'compile', '--allow-all', '--v8-flags=--expose-gc',
                        '--unstable-worker-options', '--config', str(source / 'deno.v0.json'),
                        '--include', str(source / 'v0'), '--output', str(binary), str(entry)],
                       stdout=log, stderr=log, check=True)
    # Hard links preserve binary bytes and file-page identity between the two variants.
    os.link(binary, output / 'henji.tui-entry')
    result = dict(sourceCommit=manifest['sourceRevision'], diagnosticCopies=True,
                  identicalBinarySha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                  conversationEntities=0, updates=0, providerCalls=0, tasksSubmitted=0,
                  idleSeconds=[0, 10, 30], runs=[], passed=False)
    try:
        for ordinal, variant in enumerate(['common-entry', 'tui-entry', 'tui-entry', 'common-entry']):
            record = replay(repo, empty_input, output, saved, manifest, variant, ordinal)
            assert record['state']['entities'] == 0 and record['state']['cursorRevision'] == 0
            result['runs'].append(record)
            print(json.dumps(dict(variant=variant, ordinal=ordinal,
                                  beforePssMiB=round(record['beforeMemoryKiB']['Pss'] / 1024, 1),
                                  idlePssMiB=[round(row['memoryKiB']['Pss'] / 1024, 1) for row in record['idle']],
                                  gcHeapUsedMiB=round(record['gc']['heap']['used_heap_size'] / 1048576, 2))), flush=True)
            (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        assert len({record['state']['stateSha256'] for record in result['runs']}) == 1
        result['passed'] = True
    finally:
        (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
