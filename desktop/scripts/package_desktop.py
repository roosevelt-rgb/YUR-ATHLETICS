"""Deterministic local Windows folder assembly; never downloads or executes.

The output and sibling .zip must not exist. A failed build may leave an
incomplete fresh folder for inspection; no previous release is overwritten.
The default build ships the YUR AI Desktop only. A product edition (build
--edition athletics) adds its own files from scripts/edition-files.json and
its launcher; they hold that edition's personal details, such as an athlete's
name and class year, so no other build carries them.
Installed native Node artifacts are inventory-attested observations, not a claim
that their source build is reproducible. Runtime authentication is a separate
input acquisition step; this assembler checks the reviewed archive digests.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import csv
from email.parser import BytesParser
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import unicodedata
from urllib.parse import urlsplit
import zipfile

if __package__ in {None, ''}:
    from desktop_distribution_contract import (ARCHIVES, BASE_WHEELS, MAX_ARCHIVE_BYTES, MAX_FILE_BYTES, MAX_FILES,
        MAX_TOTAL_BYTES, PYTHON_MAX_BYTES, PYTHON_MAX_FILES, NATIVE_COMPONENTS, canonical, digest, normalized_name, relative_path, validate_inputs)
    from package_source import collect_sources, read_source, reject_reparse
else:
    from .desktop_distribution_contract import (ARCHIVES, BASE_WHEELS, MAX_ARCHIVE_BYTES, MAX_FILE_BYTES, MAX_FILES,
        MAX_TOTAL_BYTES, PYTHON_MAX_BYTES, PYTHON_MAX_FILES, NATIVE_COMPONENTS, canonical, digest, normalized_name, relative_path, validate_inputs)
    from .package_source import collect_sources, read_source, reject_reparse

ROOT = Path(__file__).resolve().parents[1]
PTH = b'python314.zip\n.\nLib/site-packages\n../app\n'
ATTESTATION = 'DISTRIBUTION_ATTESTATION.json'
_FIXED_TIME = 315532800
_FORBIDDEN = {'.git', '.keys', 'secrets', 'credentials', '__pycache__'}
NATIVE_MARKER = '.desktop-native-components.json'
NATIVE_MAX_FILES = 10000
NATIVE_MAX_BYTES = 512 * 1024 * 1024
_NATIVE_STATE = {'_secrets', '_memory', '_state', '.cache', 'cache', 'caches', 'logs', 'state', 'profiles', 'user-data'}
# Franklin's default in an Athletics build (as in the source "Start YUR AI Athletics.cmd"): an Ollama
# Cloud model with tool calling, never a local one. A user's YUR_FRANKLIN_MODEL still wins.
ATHLETICS_FRANKLIN_MODEL = 'ollama:deepseek-v4-pro:cloud'


def _json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


def _key(path):
    return unicodedata.normalize('NFC', path).casefold()


def _safe_payload(path):
    relative_path(path)
    if any(part.lower() in _FORBIDDEN or part.lower().startswith('.env') or '.local.' in part.lower()
           for part in path.split('/')):
        raise ValueError('Excluded state or credential path in distribution input')
    return path


def _claim_spelling(name, spellings):
    parts = name.split('/')
    for i in range(1, len(parts) + 1):
        prefix = '/'.join(parts[:i])
        key = _key(prefix)
        if key in spellings and spellings[key] != prefix:
            raise ValueError('Case/Unicode path component alias')
        spellings[key] = prefix


@contextmanager
def _checked_file(path, *, maximum=MAX_FILE_BYTES, expected=None):
    path = Path(path)
    reject_reparse(path)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
            raise ValueError('Input must be a bounded regular unlinked file')
        reject_reparse(path)
        current = path.stat()
        if (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError('Input changed during acquisition')
        if expected:
            h = hashlib.sha256()
            count = 0
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                count += len(chunk)
                if count > before.st_size or count > maximum:
                    raise ValueError('Input grew beyond its reviewed byte bound')
                h.update(chunk)
            if before.st_size != expected['bytes'] or h.hexdigest() != expected['sha256']:
                raise ValueError('Input byte count or SHA256 differs from review')
            stream.seek(0)
        yield stream
        after = os.fstat(stream.fileno())
        reject_reparse(path)
        current = path.stat()
        if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                or (after.st_dev, after.st_ino) != (current.st_dev, current.st_ino)):
            raise ValueError('Input changed while being read')


def _bytes(path, maximum=MAX_FILE_BYTES, expected=None):
    with _checked_file(path, maximum=maximum, expected=expected) as stream:
        # The ceiling bounds acceptance, not the allocation for every tiny file.
        # Keep one extra byte plus _checked_file's final identity/size checks so
        # a concurrent growth still fails rather than accepting a short prefix.
        result = stream.read(min(maximum, os.fstat(stream.fileno()).st_size) + 1)
        if len(result) > maximum:
            raise ValueError('Input exceeds byte bound')
        return result


def _record(path, data):
    return {'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def _native_path(name):
    _safe_payload(name)
    if (any(part.casefold() in _NATIVE_STATE for part in name.split('/'))
            or name.casefold().endswith(('.db', '.sqlite', '.sqlite3', '.log', '.pyc', '.keys'))
            or name in {'runtime.json', 'donor-manifest.json'}):
        raise ValueError('Native component contains excluded state or reserved metadata')
    return name


def _native_tree(root):
    root = Path(root)
    reject_reparse(root)
    if not root.is_dir():
        raise ValueError('Native component root must be a directory')
    found, spellings, directories, nodes = {}, {}, [root], 0
    while directories:
        directory = directories.pop()
        reject_reparse(directory)
        for child in sorted(directory.iterdir(), key=lambda item: item.name):
            nodes += 1
            if nodes > NATIVE_MAX_FILES * 3:
                raise ValueError('Native component inventory exceeds entry bounds')
            reject_reparse(child)
            name = _native_path(child.relative_to(root).as_posix())
            _claim_spelling(name, spellings)
            if child.is_dir():
                directories.append(child)
            elif child.is_file():
                key = _key(name)
                if key in found or len(found) >= NATIVE_MAX_FILES:
                    raise ValueError('Native component inventory duplicates or exceeds file bounds')
                found[key] = name
            else:
                raise ValueError('Native component contains a nonregular payload')
    return found


def inventory_native_component(app_root, name, component):
    """Verify only the exact manifest-listed, state-free installed engine bundle."""
    manifest_bytes = _bytes(component['manifest_path'], 4 * 1024 * 1024,
                            {'bytes': component['manifest_bytes'], 'sha256': component['manifest_sha256']})
    # Installed donor metadata may carry a UTF-8 BOM; retain/hash the exact donor bytes.
    manifest = _json(manifest_bytes.removeprefix(b'\xef\xbb\xbf'))
    rows = manifest.get('files') if type(manifest) is dict else None
    if (type(rows) is not list or not rows or len(rows) >= NATIVE_MAX_FILES
            or type(manifest.get('file_count')) is not int or manifest.get('file_count') != len(rows)):
        raise ValueError('Native donor manifest lacks a bounded complete file inventory')
    if name == 'intelliflow':
        core = manifest.get('self_contained_core')
        if (manifest.get('packaging_mode') != 'pyinstaller-one-directory'
                or type(core) is not dict or core.get('external_python_required') is not False
                or core.get('external_yur_runtime_root_required') is not False):
            raise ValueError('IntelliFlow donor manifest does not identify the admitted standalone core')
    elif (manifest.get('schema') != 'intelliflow/gateway-runtime-manifest/v1'
            or manifest.get('external_python_required') is not False
            or manifest.get('external_runtime_root_required') is not False):
        raise ValueError('Construction donor manifest does not identify the admitted standalone core')
    expected = _json(read_source(Path(app_root), NATIVE_COMPONENTS[name])).get('sha256')
    files, keys, spellings, total = [], set(), {}, 0
    for row in rows:
        size_key = 'size' if name == 'intelliflow' else 'bytes'
        if (type(row) is not dict or set(row) != {'path', size_key, 'sha256'}
                or type(row[size_key]) is not int or not 0 <= row[size_key] <= MAX_FILE_BYTES
                or type(row['sha256']) is not str or not re.fullmatch(r'[0-9a-f]{64}', row['sha256'])):
            raise ValueError('Invalid native donor file declaration')
        path = _native_path(row['path'])
        _claim_spelling(path, spellings)
        key = _key(path)
        if key in keys:
            raise ValueError('Duplicate native donor file declaration')
        keys.add(key)
        total += row[size_key]
        if total > NATIVE_MAX_BYTES:
            raise ValueError('Native component exceeds byte bound')
        files.append({'path': path, 'bytes': row[size_key], 'sha256': row['sha256']})
    gateway = next((row for row in files if row['path'] == 'yur-gateway.exe'), None)
    if not gateway or gateway['sha256'] != expected or not any(row['path'].startswith('_internal/') for row in files):
        raise ValueError('Native donor gateway differs from source binding or omits its internal payload')
    declared_executable = manifest.get('executable')
    declared_digest = (declared_executable.get('sha256') if type(declared_executable) is dict
                       else manifest.get('executable_sha256'))
    declared_path = declared_executable.get('path') if type(declared_executable) is dict else declared_executable
    if declared_digest != expected or declared_path != 'yur-gateway.exe':
        raise ValueError('Native donor executable identity differs from source binding')
    actual = _native_tree(component['root'])
    if actual != {_key(row['path']): row['path'] for row in files}:
        raise ValueError('Native component inventory differs from reviewed donor manifest')
    for row in files:
        _bytes(Path(component['root']) / row['path'], expected=row)
    if (_native_tree(component['root']) != actual
            or _bytes(component['manifest_path'], 4 * 1024 * 1024) != manifest_bytes):
        raise ValueError('Native component changed during verification')
    return {'component': name, 'files': sorted(files, key=lambda row: row['path']),
            'executable_sha256': expected, 'manifest_bytes': manifest_bytes,
            'donor': {'source_identity': component['source_identity'],
                      'manifest_sha256': component['manifest_sha256'], 'manifest_bytes': component['manifest_bytes']}}


def _resolve_package(packages, owner, dependency, optional=False):
    if not re.fullmatch(r'(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+', dependency):
        raise ValueError('Invalid Node dependency name')
    prefix = owner
    candidates = []
    while prefix:
        candidates.append(prefix + '/node_modules/' + dependency)
        if '/node_modules/' in prefix:
            prefix = prefix.rsplit('/node_modules/', 1)[0]
        else:
            prefix = ''
    candidates.append('node_modules/' + dependency)
    for candidate in candidates:
        if candidate in packages:
            entry = packages[candidate]
            for field, desired in (('os', 'win32'), ('cpu', 'x64')):
                selectors = entry.get(field, [])
                if selectors and (('!' + desired) in selectors or (any(not s.startswith('!') for s in selectors) and desired not in selectors)):
                    if optional:
                        return None
                    raise ValueError('Required Node dependency excludes Windows x64')
            return candidate
    if optional:
        return None
    raise ValueError('Lockfile lacks a required production dependency: ' + dependency)


def inventory_node_dependencies(app_root, node_root):
    """Return a deterministic read-only inventory for operator review/pinning.

Only the package-lock production dependency closure is read. Nested node_modules
directories are visited through dependency resolution, never copied implicitly.
"""
    app_root, node_root = Path(app_root), Path(node_root)
    reject_reparse(node_root)
    package = _json(read_source(app_root, 'package.json'))
    lock = _json(read_source(app_root, 'package-lock.json'))
    packages = lock.get('packages')
    if lock.get('lockfileVersion') not in {2, 3} or type(packages) is not dict or '' not in packages:
        raise ValueError('A package-lock v2/v3 production graph is required')
    top = package.get('dependencies', {})
    if type(top) is not dict or top != packages[''].get('dependencies', {}):
        raise ValueError('Package and lockfile production dependencies differ')
    pending = [_resolve_package(packages, '', name) for name in sorted(top)]
    visited, all_files, summaries = set(), [], []
    all_keys, total, nodes, spellings = set(), 0, 0, {}
    while pending:
        location = pending.pop()
        if location in visited:
            continue
        visited.add(location)
        if len(visited) > 1000:
            raise ValueError('Node dependency graph exceeds bound')
        entry = packages[location]
        if entry.get('link') or entry.get('dev') or not isinstance(entry.get('version'), str):
            raise ValueError('Linked/development/unversioned package in production closure')
        source = entry.get('resolved')
        if (type(source) is not str or len(source) > 2000 or urlsplit(source).scheme != 'https'
                or urlsplit(source).hostname != 'registry.npmjs.org' or urlsplit(source).username
                or urlsplit(source).port not in {None, 443}
                or urlsplit(source).password or urlsplit(source).query or urlsplit(source).fragment
                or not re.fullmatch(r'sha512-[A-Za-z0-9+/]+={0,2}', entry.get('integrity', ''))):
            raise ValueError('Node dependency lacks admitted npm provenance/integrity')
        relative = location.removeprefix('node_modules/')
        _safe_payload(relative)
        module_root = node_root / relative
        metadata = _json(_bytes(module_root / 'package.json', 1024 * 1024))
        if metadata.get('version') != entry['version']:
            raise ValueError('Installed Node package version differs from lockfile')
        name = metadata.get('name')
        if not isinstance(name, str) or not location.endswith('/' + name):
            raise ValueError('Installed Node package name differs from lockfile location')
        for field in ('dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'):
            if metadata.get(field, {}) != entry.get(field, {}):
                raise ValueError('Installed dependency declarations differ from lockfile')
        dependencies = dict(entry.get('dependencies', {}))
        optional = entry.get('optionalDependencies', {})
        dependencies.update(optional)
        peers = entry.get('peerDependencies', {})
        for dependency in sorted(set(dependencies) | set(peers)):
            peer_optional = entry.get('peerDependenciesMeta', {}).get(dependency, {}).get('optional', False)
            resolved = _resolve_package(packages, location, dependency, dependency in optional or peer_optional)
            if resolved:
                pending.append(resolved)
        files = []
        directories = [module_root]
        while directories:
            directory = directories.pop()
            reject_reparse(directory)
            for candidate in sorted(directory.iterdir(), key=lambda p: p.name):
                nodes += 1
                if nodes > MAX_FILES * 2:
                    raise ValueError('Node package tree exceeds node bound')
                reject_reparse(candidate)
                info = candidate.lstat()
                if stat.S_ISDIR(info.st_mode):
                    if candidate.name != 'node_modules':
                        directory_path = _safe_payload(candidate.relative_to(node_root).as_posix())
                        _claim_spelling(directory_path, spellings)
                        directories.append(candidate)
                    continue
                path = _safe_payload(candidate.relative_to(node_root).as_posix())
                key = _key(path)
                _claim_spelling(path, spellings)
                if key in all_keys:
                    raise ValueError('Case/Unicode collision in Node inventory')
                all_keys.add(key)
                data = _bytes(candidate)
                row = _record(path, data)
                files.append(row)
                all_files.append(row)
                total += row['bytes']
                if len(all_files) > MAX_FILES or total > MAX_TOTAL_BYTES:
                    raise ValueError('Production Node inventory exceeds bounds')
        summaries.append({'name': name, 'version': entry['version'], 'install_path': relative,
                          'license': metadata.get('license') if isinstance(metadata.get('license'), str) else None,
                          'npm_integrity': entry.get('integrity'), 'npm_source_url': entry.get('resolved'),
                          'files_sha256': digest(sorted(files, key=lambda r: r['path'])),
                          'native_artifacts': [r for r in sorted(files, key=lambda r: r['path']) if r['path'].lower().endswith(('.node', '.exe', '.dll'))]})
    result = {'schema': 'yur.node-production-inventory.v1',
              'packages': sorted(summaries, key=lambda r: r['install_path']),
              'files': sorted(all_files, key=lambda r: r['path'])}
    return {**result, 'sha256': digest(result)}


def _zip_members(archive, *, maximum=MAX_TOTAL_BYTES):
    members = archive.infolist()
    if len(members) > MAX_FILES:
        raise ValueError('Archive has too many entries')
    files, keys, directories, total, spellings = {}, set(), set(), 0, {}
    for info in members:
        if info.orig_filename != info.filename:
            raise ValueError('Archive entry was normalized or truncated by ZIP parser')
        path = _safe_payload(info.filename.rstrip('/'))
        if info.filename != path + ('/' if info.is_dir() else ''):
            raise ValueError('Archive entry has noncanonical separators')
        key = _key(path)
        _claim_spelling(path, spellings)
        if key in keys:
            raise ValueError('Duplicate/case/Unicode archive entry')
        keys.add(key)
        mode = info.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if kind not in {0, stat.S_IFREG, stat.S_IFDIR} or (info.external_attr & 0x400):
            raise ValueError('Archive links/devices/reparse entries are forbidden')
        if info.flag_bits & 1 or info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            raise ValueError('Unsupported encrypted/compressed archive entry')
        if info.is_dir():
            directories.add(key)
            continue
        if kind == stat.S_IFDIR or info.file_size > MAX_FILE_BYTES or info.file_size > max(1024 * 1024, info.compress_size * 1000):
            raise ValueError('Archive entry expansion exceeds bounds')
        total += info.file_size
        if total > maximum:
            raise ValueError('Archive total expansion exceeds bounds')
        files[path] = info
    file_keys = {_key(path) for path in files}
    for path in files:
        if any(_key(str(p)) in file_keys for p in PurePosixPath(path).parents if str(p) != '.'):
            raise ValueError('Archive file/directory collision')
    if file_keys & directories:
        raise ValueError('Archive file/directory collision')
    return files


def _wheel_payload(archive, wheel):
    members = _zip_members(archive, maximum=PYTHON_MAX_BYTES)
    metadata_paths = [p for p in members if p.endswith('.dist-info/METADATA') and p.count('/') == 1]
    if len(metadata_paths) != 1:
        raise ValueError('Wheel must have exactly one distribution metadata directory')
    prefix = metadata_paths[0].split('/')[0]
    if any(p.split('/')[0].endswith('.dist-info') and p.split('/')[0] != prefix for p in members):
        raise ValueError('Wheel contains foreign distribution metadata')
    for name, limit in ((metadata_paths[0], 1024 * 1024), (prefix + '/WHEEL', 65536), (prefix + '/RECORD', 8 * 1024 * 1024)):
        if name not in members or members[name].file_size > limit:
            raise ValueError('Wheel metadata is missing or exceeds bounds')
    metadata = BytesParser().parsebytes(archive.read(metadata_paths[0]))
    if normalized_name(metadata.get('Name', '')) != normalized_name(wheel['name']) or metadata.get('Version') != wheel['version']:
        raise ValueError('Wheel metadata differs from reviewed dependency')
    wheel_metadata = BytesParser().parsebytes(archive.read(prefix + '/WHEEL'))
    tags = wheel_metadata.get_all('Tag', [])
    if set(tags) != set(wheel['tags']) or wheel_metadata.get('Wheel-Version') != '1.0':
        raise ValueError('Wheel tags/version differ from reviewed input')
    filename_tags = wheel['filename'][:-4].split('-')[-3:]
    declared = {f'{py}-{abi}-{platform}' for py in filename_tags[0].split('.') for abi in filename_tags[1].split('.') for platform in filename_tags[2].split('.')}
    expanded = {f'{py}-{abi}-{platform}' for tag in tags for py in tag.split('-')[0].split('.') for abi in tag.split('-')[1].split('.') for platform in tag.split('-')[2].split('.')}
    if declared != expanded:
        raise ValueError('Wheel filename tags differ from metadata')
    def compatible(tag):
        py, abi, platform = tag.split('-')
        return (platform == 'any' and abi == 'none' and ('py3' in py.split('.') or py == 'cp314')) or (
            platform == 'win_amd64' and ((py == 'cp314' and abi == 'cp314') or
                (abi == 'abi3' and re.fullmatch(r'cp3[0-9]{1,2}', py) and 32 <= int(py[2:]) <= 314)))
    if not any(compatible(tag) for tag in tags):
        raise ValueError('Wheel has no admitted Windows CPython 3.14 tag')
    record_path = prefix + '/RECORD'
    if record_path not in members:
        raise ValueError('Wheel RECORD is required')
    records = {}
    for row in csv.reader(io.StringIO(archive.read(record_path).decode('utf-8'))):
        if len(row) != 3 or row[0] in records:
            raise ValueError('Invalid/duplicate wheel RECORD row')
        records[row[0]] = row[1:]
    if set(records) != set(members):
        raise ValueError('Wheel RECORD does not cover exactly its payload')
    payload = {}
    for name in sorted(members):
        data = archive.read(name)
        expected_hash, expected_bytes = records[name]
        if name == record_path:
            if expected_hash or expected_bytes:
                raise ValueError('Wheel RECORD must not hash itself')
        else:
            actual = 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode('ascii')
            if expected_hash != actual or expected_bytes != str(len(data)):
                raise ValueError('Wheel RECORD hash/size mismatch')
        parts = name.split('/')
        if parts[0].endswith('.data'):
            raise ValueError('Wheel .data relocation is not admitted for the base dependency set')
        else:
            destination = name
        if destination.lower().endswith(('.pth', '.pyc')) or destination.lower() in {'sitecustomize.py', 'usercustomize.py'}:
            raise ValueError('Wheel startup hooks/compiled caches are not admitted')
        _safe_payload(destination)
        if _key(destination) in {_key(p) for p in payload}:
            raise ValueError('Wheel destination collision')
        payload[destination] = data
    if not any('license' in p.lower() or 'copying' in p.lower() for p in payload):
        raise ValueError('Wheel lacks a retained license payload')
    return payload


class _Writer:
    def __init__(self, root):
        self.root, self.files, self.keys, self.total = root, {}, set(), 0
        self.spellings = {}

    def put(self, name, data):
        _safe_payload(name)
        key = _key(name)
        _claim_spelling(name, self.spellings)
        if key in self.keys or any(_key(str(p)) in self.keys for p in PurePosixPath(name).parents if str(p) != '.'):
            raise ValueError('Distribution payload collision')
        if any(existing.startswith(key + '/') for existing in self.keys):
            raise ValueError('Distribution payload directory collision')
        self.total += len(data)
        if len(self.files) >= MAX_FILES or self.total > MAX_TOTAL_BYTES or len(data) > MAX_FILE_BYTES:
            raise ValueError('Distribution payload exceeds bounds')
        target = self.root / name
        reject_reparse(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        reject_reparse(target)
        with target.open('xb') as output:
            output.write(data)
        os.utime(target, (_FIXED_TIME, _FIXED_TIME))
        self.keys.add(key)
        self.files[name] = _record(name, data)

    def json(self, name, value):
        self.put(name, canonical(value) + b'\n')


def _archive_public(kind, item):
    return {'name': ARCHIVES[kind]['name'], **{k: item[k] for k in ('bytes', 'sha256', 'source_url')}}


def _verify_output_inventory(writer):
    actual, directories, nodes = set(), [writer.root], 0
    while directories:
        directory = directories.pop()
        reject_reparse(directory)
        for child in directory.iterdir():
            nodes += 1
            if nodes > MAX_FILES * 2:
                raise ValueError('Output inventory exceeds node bound')
            reject_reparse(child)
            if child.is_dir():
                directories.append(child)
            else:
                name = child.relative_to(writer.root).as_posix()
                if name not in writer.files:
                    raise ValueError('Unexpected unlisted output file')
                _bytes(child, expected=writer.files[name])
                actual.add(name)
    if actual != set(writer.files):
        raise ValueError('Output file inventory changed during assembly')


def build_desktop(app_root, inputs, output_path, editions=()):
    """Assemble a new local folder and deterministic sibling ZIP from local inputs."""
    inputs = validate_inputs(inputs)
    app_root, output = Path(app_root).absolute(), Path(output_path).absolute()
    zip_path = output.with_name(output.name + '.zip')
    reject_reparse(app_root)
    reject_reparse(output)
    reject_reparse(zip_path)
    if output.exists() or zip_path.exists() or not output.parent.is_dir():
        raise ValueError('Distribution folder and ZIP must be fresh paths under an existing parent')
    sources, version = collect_sources(app_root, editions)
    if 'Start IntelliFlow Unified.cmd' not in sources:
        raise ValueError('Source release is missing the reviewed IntelliFlow Unified launcher')
    node = inventory_node_dependencies(app_root, inputs['node']['root'])
    if node['sha256'] != inputs['node']['inventory_sha256']:
        raise ValueError('Production Node inventory differs from operator review')
    components = {name: inventory_native_component(app_root, name, item)
                  for name, item in sorted(inputs.get('components', {}).items())}
    # Verify all archive hashes before creating the output. No dependency code runs.
    for item in [inputs['electron'], inputs['python'], *inputs['wheels']]:
        with _checked_file(item['path'], maximum=MAX_ARCHIVE_BYTES, expected=item):
            pass
    output.mkdir()
    writer = _Writer(output)
    for kind, destination in (('electron', ''), ('python', 'resources/python/')):
        item = inputs[kind]
        with _checked_file(item['path'], maximum=MAX_ARCHIVE_BYTES, expected=item) as stream, zipfile.ZipFile(stream) as archive:
            members = _zip_members(archive, maximum=PYTHON_MAX_BYTES if kind == 'python' else MAX_TOTAL_BYTES)
            required = {'electron.exe', 'LICENSE', 'LICENSES.chromium.html'} if kind == 'electron' else {'python.exe', 'python314.dll', 'python314.zip', 'python314._pth', 'LICENSE.txt'}
            if not required <= members.keys():
                raise ValueError('Runtime archive lacks required binaries/license files')
            if kind == 'python' and any('/' in name for name in members):
                raise ValueError('Unexpected embedded Python archive layout')
            for name in sorted(members):
                if kind == 'electron' and (name == ATTESTATION or _key(name).startswith(('resources/app/', 'resources/python/'))):
                    raise ValueError('Electron archive collides with application resources')
                data = PTH if kind == 'python' and name == 'python314._pth' else archive.read(name)
                writer.put(destination + name, data)
    for name, data in sorted(sources.items()):
        if name in {'.desktop-distribution.json', NATIVE_MARKER, 'DISTRIBUTION_ATTESTATION.json'} or name.startswith(('.desktop-python/', '.desktop-models/')):
            raise ValueError('Source allowlist contains runtime configuration or machine resources')
        writer.put('resources/app/' + name, data)
    for row in node['files']:
        writer.put('resources/app/node_modules/' + row['path'], _bytes(Path(inputs['node']['root']) / row['path'], expected=row))
    wheel_public = []
    for wheel in sorted(inputs['wheels'], key=lambda item: normalized_name(item['name'])):
        with _checked_file(wheel['path'], maximum=MAX_ARCHIVE_BYTES, expected=wheel) as stream, zipfile.ZipFile(stream) as archive:
            payload = _wheel_payload(archive, wheel)
            for name, data in sorted(payload.items()):
                writer.put('resources/python/Lib/site-packages/' + name, data)
        wheel_public.append({k: v for k, v in wheel.items() if k != 'path'})
    python_files = [{**row, 'path': name.removeprefix('resources/python/')} for name, row in sorted(writer.files.items()) if name.startswith('resources/python/')]
    if len(python_files) > PYTHON_MAX_FILES or sum(r['bytes'] for r in python_files) > PYTHON_MAX_BYTES or any(r['bytes'] > 128 * 1024 * 1024 for r in python_files):
        raise ValueError('Python inventory exceeds runtime verification bounds')
    runtime = {'schema': 'yur.embedded-python.v1', 'version': '3.14.7', 'platform': 'win32', 'arch': 'x64',
               'entrypoint': 'python.exe', 'files': python_files, 'archive': _archive_public('python', inputs['python'])}
    if len(canonical(runtime)) + 1 > 4 * 1024 * 1024:
        raise ValueError('Python manifest exceeds runtime verification bound')
    writer.json('resources/python/runtime.json', runtime)
    writer.json('resources/app/.desktop-distribution.json', {'schema': 'yur.desktop-distribution.v1', 'platform': 'win32', 'arch': 'x64',
                'python_resource': '../python', 'python_manifest_sha256': writer.files['resources/python/runtime.json']['sha256']})
    native_marker = {'schema': 'yur.desktop-native-components.v1', 'platform': 'win32', 'arch': 'x64', 'components': {}}
    native_public = []
    for name, component in sorted(components.items()):
        prefix = 'resources/native/' + name + '/'
        item = inputs['components'][name]
        for row in component['files']:
            writer.put(prefix + row['path'], _bytes(Path(item['root']) / row['path'], expected=row))
        writer.put(prefix + 'donor-manifest.json', component['manifest_bytes'])
        payload = component['files'] + [_record('donor-manifest.json', component['manifest_bytes'])]
        native_runtime = {'schema': 'yur.native-gateway.v1', 'component': name, 'platform': 'win32', 'arch': 'x64',
                          'entrypoint': 'yur-gateway.exe', 'executable_sha256': component['executable_sha256'],
                          'files': sorted(payload, key=lambda row: row['path']), 'donor': component['donor']}
        writer.json(prefix + 'runtime.json', native_runtime)
        native_marker['components'][name] = {'resource': '../native/' + name,
                                            'manifest_sha256': writer.files[prefix + 'runtime.json']['sha256']}
        native_public.append({'component': name, **component['donor'], 'executable_sha256': component['executable_sha256'],
                              'files': len(payload), 'bytes': sum(row['bytes'] for row in payload),
                              'runtime_manifest_sha256': writer.files[prefix + 'runtime.json']['sha256']})
    if components:
        writer.json('resources/app/' + NATIVE_MARKER, native_marker)
    # Generated root entry points target the packaged layout, never source wrappers.
    launcher = ('@echo off\r\nsetlocal\r\nset "YUR_GLIDER_RC6=1"\r\nset "YUR_HARNESS_AUTOSTART=0"\r\n'
                'set "YUR_UNIFIED_ROOT=%~dp0"\r\n'
                'set "YUR_DESKTOP_HOME=%APPDATA%\\yur-intelliflow-glider-rc6\\conversations"\r\n'
                'set "YUR_FACTORY_HOME=%APPDATA%\\yur-intelliflow-glider-rc6\\factory"\r\n'
                'set "ELECTRON_RUN_AS_NODE="\r\n'
                'if not exist "%~dp0electron.exe" exit /b 1\r\n'
                'if not exist "%~dp0resources\\app\\package.json" exit /b 1\r\n'
                'pushd "%~dp0" || exit /b 1\r\n'
                'start "YUR AI Desktop" "%~dp0electron.exe" %*\r\n'
                'set "YUR_DESKTOP_EXIT=%errorlevel%"\r\npopd\r\nexit /b %YUR_DESKTOP_EXIT%\r\n')
    writer.put('Start YUR AI Desktop.cmd', launcher.encode('ascii'))
    writer.put('Start IntelliFlow Unified.cmd', b'@echo off\r\nsetlocal\r\ncall "%~dp0Start YUR AI Desktop.cmd" %*\r\nexit /b %errorlevel%\r\n')
    # The Athletics edition has its own entry point only when its manifest ships (build
    # --edition athletics): the packaged Desktop launcher plus the edition, its own profile and
    # Franklin's default model, unless a dedicated endpoint names its own. That default is an
    # Ollama Cloud model reached through the local daemon's :cloud proxy (ATHLETICS_FRANKLIN_MODEL),
    # so no model runs on the computer. Coding, terminal and files stay on the IntelliFlow (RC6) path.
    if 'editions/athletics.json' in sources:
        athletics = ('@echo off\r\nsetlocal\r\ntitle YUR Athletics\r\nset "YUR_EDITION=athletics"\r\nset "YUR_GLIDER_RC6=1"\r\nset "YUR_HARNESS_AUTOSTART=0"\r\n'
                     'set "YUR_UNIFIED_ROOT=%~dp0"\r\n'
                     'set "YUR_DESKTOP_HOME=%APPDATA%\\yur-ai-athletics\\conversations"\r\n'
                     'set "YUR_FACTORY_HOME=%APPDATA%\\yur-ai-athletics\\factory"\r\n'
                     'if not defined YUR_FRANKLIN_MODEL if not defined YUR_FRANKLIN_OPENAI_URL set "YUR_FRANKLIN_MODEL=' + ATHLETICS_FRANKLIN_MODEL + '"\r\n'
                     'set "ELECTRON_RUN_AS_NODE="\r\n'
                     'if not exist "%~dp0electron.exe" exit /b 1\r\n'
                     'if not exist "%~dp0resources\\app\\package.json" exit /b 1\r\n'
                     'if not exist "%~dp0resources\\app\\editions\\athletics.json" exit /b 1\r\n'
                     'pushd "%~dp0" || exit /b 1\r\n'
                     'start "YUR Athletics" "%~dp0electron.exe" %*\r\n'
                     'set "YUR_DESKTOP_EXIT=%errorlevel%"\r\npopd\r\nexit /b %YUR_DESKTOP_EXIT%\r\n')
        writer.put('Start YUR AI Athletics.cmd', athletics.encode('ascii'))
    notices = [row for name, row in sorted(writer.files.items()) if re.search(r'(license|notice|copying)', PurePosixPath(name).name, re.I)]
    voice_included = any(normalized_name(w['name']) == 'vosk' for w in inputs['wheels'])
    manifest = {'schema': 'yur.desktop-distribution-attestation.v1', 'platform': 'win32', 'arch': 'x64', 'release_version': version,
                'signed': False, 'release_status': 'local-unsigned-candidate', 'first_party_license': 'unset',
                'files': [row for _, row in sorted(writer.files.items())],
                'source': {'allowlist_sha256': hashlib.sha256(sources['scripts/source-files.json']).hexdigest(),
                           'files': [_record(name, data) for name, data in sorted(sources.items())]},
                'npm_lock_sha256': hashlib.sha256(sources['package-lock.json']).hexdigest(),
                'node_inventory': node, 'native_node_provenance': 'observed installed artifacts; upstream reproducible build not established',
                'input_archives': {kind: _archive_public(kind, inputs[kind]) for kind in ARCHIVES}, 'wheels': wheel_public,
                'native_components': native_public,
                'notices': notices, 'python_configuration': {'modified': 'python314._pth', 'site_initialization': False},
                'resources': {'included': ['electron', 'embedded-python', 'pdf-image-intake'] + (['voice-python-dependencies'] if voice_included else [])
                                          + [name + '-gateway' for name in sorted(components)],
                              'external': ['model-provider', 'selected-repositories', 'reviewed-wsl2-execution-runtime', 'voice-recognition-model',
                                           'marketplace-engine', 'marketplace-python-environment',
                                           'music-application', 'workforce-sources', 'construction-department-transport']
                                          + ([] if components else ['intelliflow-installed-runtime', 'construction-v1-installed-runtime']),
                              'missing_optional': [] if voice_included else ['voice-python-dependencies']}}
    # A second acquisition catches source/node changes during assembly. The ZIP
    # is emitted only after all exact output bytes are checked again.
    if collect_sources(app_root, editions)[0] != sources or inventory_node_dependencies(app_root, inputs['node']['root']) != node:
        raise ValueError('Source or dependency inventory changed during assembly')
    for name, component in components.items():
        if inventory_native_component(app_root, name, inputs['components'][name]) != component:
            raise ValueError('Native component changed during assembly')
    _verify_output_inventory(writer)
    writer.json(ATTESTATION, manifest)
    with zipfile.ZipFile(zip_path, 'x', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for name, row in sorted(writer.files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system, info.external_attr = 3, 0o100644 << 16
            data = _bytes(output / name, expected=row)
            archive.writestr(info, data)
    _verify_output_inventory(writer)
    with _checked_file(zip_path, maximum=MAX_TOTAL_BYTES + 32 * 1024 * 1024) as stream:
        h = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return {'path': str(output), 'zip_path': str(zip_path), 'sha256': h.hexdigest(),
            'manifest_sha256': writer.files[ATTESTATION]['sha256'], 'files': len(writer.files), 'signed': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-root', type=Path, default=ROOT)
    sub = parser.add_subparsers(dest='command', required=True)
    inventory = sub.add_parser('inventory-node')
    inventory.add_argument('--node-root', type=Path, required=True)
    build = sub.add_parser('build')
    build.add_argument('--inputs', type=Path, required=True)
    build.add_argument('--output', type=Path, required=True)
    build.add_argument('--edition', action='append', default=[], help='add a product edition (scripts/edition-files.json)')
    args = parser.parse_args(argv)
    if args.command == 'inventory-node':
        result = inventory_node_dependencies(args.app_root, args.node_root)
    else:
        result = build_desktop(args.app_root, _json(_bytes(args.inputs, 128 * 1024)), args.output, tuple(args.edition))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
