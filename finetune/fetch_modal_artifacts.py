"""Download only this experiment's artifacts. No compute starts here."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath

import modal
from modal.types import FileEntryType

RUN = 'qwen7b-20261010-v2'
VOLUME = 'unzap-qwen7b-20261010-v1'
ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reports-only', action='store_true')
    args = parser.parse_args()
    volume = modal.Volume.from_name(VOLUME)
    destination = (ROOT/'.data/finetune/runs'/RUN).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    downloaded = []
    entries = list(volume.iterdir(RUN, recursive=True))
    for entry in entries:
        if entry.type != FileEntryType.FILE:
            continue
        remote = PurePosixPath(entry.path.lstrip('/'))
        relative = remote.relative_to(RUN)
        if '..' in relative.parts:
            raise RuntimeError('Unexpected artifact path')
        if args.reports_only and relative.as_posix() not in ['report.json','generations.json']:
            continue
        target = (destination/Path(*relative.parts)).resolve()
        if not target.is_relative_to(destination):
            raise RuntimeError('Artifact escapes run directory')
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('wb') as handle:
            for chunk in volume.read_file(remote.as_posix()):
                handle.write(chunk)
        downloaded.append({'path': relative.as_posix(), 'bytes': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    if not args.reports_only:
        report = json.loads((destination/'report.json').read_text())
        checkpoint = destination/'adapter/adapter_model.safetensors'
        if not checkpoint.exists() or hashlib.sha256(checkpoint.read_bytes()).hexdigest() != report['adapter_sha256']:
            raise RuntimeError('Adapter absent or hash mismatch. Preserve remote volume.')
        (destination/'download-manifest.json').write_text(json.dumps(downloaded, indent=2))
    print(json.dumps({'downloaded': len(downloaded), 'mode': 'reports' if args.reports_only else 'all', 'run': RUN}))

if __name__ == '__main__':
    main()
