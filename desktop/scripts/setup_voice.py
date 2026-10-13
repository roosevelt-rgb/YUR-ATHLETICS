"""Explicit offline voice model setup from the publisher's HTTPS release."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import tempfile
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'vosk-model-small-en-us-0.15'
URL = f'https://alphacephei.com/vosk/models/{NAME}.zip'
EXPECTED_SHA256 = '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498'


def main():
    target = ROOT / '.desktop-models' / NAME
    if (target / 'yur-model-source.json').is_file():
        print(json.dumps({'ready': True, 'path': str(target)})); return
    if target.exists():
        raise ValueError('Model directory exists without a completed installation receipt; inspect it before setup')
    with tempfile.TemporaryDirectory(prefix='yur-voice-setup-') as stage:
        archive_path = Path(stage) / 'model.zip'
        digest = hashlib.sha256(); total = 0
        with urlopen(URL, timeout=30) as response, archive_path.open('wb') as output:
            if response.geturl() != URL:
                raise ValueError('Model publisher redirected the download; review the new source before installing')
            while data := response.read(1024 * 1024):
                total += len(data)
                if total > 80 * 1024 * 1024: raise ValueError('Model archive exceeds setup budget')
                digest.update(data); output.write(data)
        if digest.hexdigest() != EXPECTED_SHA256:
            raise ValueError('Model download differs from the reviewed source fingerprint')
        with ZipFile(archive_path) as archive:
            entries = archive.infolist()
            if len(entries) > 200 or sum(item.file_size for item in entries) > 200 * 1024 * 1024: raise ValueError('Model archive exceeds expansion budget')
            for item in entries:
                path = PurePosixPath(item.filename)
                if path.is_absolute() or not path.parts or path.parts[0] != NAME or '..' in path.parts or '\\' in item.filename or ':' in item.filename or (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Unsafe model archive entry')
            extracted = Path(stage) / 'extracted'; extracted.mkdir()
            archive.extractall(extracted)
        model = extracted / NAME
        if not (model / 'am/final.mdl').is_file() or not (model / 'conf/model.conf').is_file(): raise ValueError('Incomplete model release')
        receipt = {'source_url': URL, 'publisher': 'Alpha Cephei', 'license': 'Apache-2.0', 'archive_sha256': digest.hexdigest(), 'archive_bytes': total,
                   'integrity': 'Observed HTTPS download hash, not a publisher signature',
                   'files': {str(path.relative_to(model)).replace('\\', '/'): hashlib.sha256(path.read_bytes()).hexdigest() for path in model.rglob('*') if path.is_file()}}
        (model / 'yur-model-source.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
        target.parent.mkdir(exist_ok=True)
        # Same-volume move is preferred; copying remains explicit installer work.
        import shutil
        shutil.copytree(model, target)
        print(json.dumps({'ready': True, 'path': str(target), 'sha256': digest.hexdigest()}))


if __name__ == '__main__': main()
