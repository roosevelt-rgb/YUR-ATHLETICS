"""Reviewed local desktop distribution inputs; no installation or execution.

Runtime digests come from the publishers' release metadata. Wheel digests are
operator-reviewed inputs, not a claim that an installed environment is portable.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from urllib.parse import urlsplit

SCHEMA = 'yur.desktop-distribution-inputs.v1'
ARCHIVES = {
    'electron': {'name': 'electron-v44.3.0-win32-x64.zip', 'version': '44.3.0',
                 'sha256': '26bf9a617d58d81772b3d68305d59ee48272969c15083c06db634a77358a8d9d',
                 'source_url': 'https://github.com/electron/electron/releases/download/v44.3.0/electron-v44.3.0-win32-x64.zip'},
    'python': {'name': 'python-3.14.7-embed-amd64.zip', 'version': '3.14.7',
               'bytes': 12673227,
               'sha256': 'd297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15',
               'source_url': 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip'},
}
BASE_WHEELS = {'pypdf': '5.9.0', 'pillow': '12.1.0'}
# Additional voice dependencies require an explicitly reviewed complete set.
MAX_INPUT_BYTES = 128 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_FILES = 30000
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
PYTHON_MAX_FILES = 10000
PYTHON_MAX_BYTES = 512 * 1024 * 1024
HASH = re.compile(r'^[0-9a-f]{64}$')
NATIVE_COMPONENTS = {'intelliflow': 'src/glider-rc6-binding.json',
                     'construction-v1': 'src/construction-v1-binding.json'}
_RESERVED = re.compile(r'^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', re.I)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def relative_path(value):
    if (type(value) is not str or not value or len(value) > 240 or any(c in value for c in '\\:<>"|?*')
            or value.startswith('/') or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError('Unsafe distribution path')
    parts = value.split('/')
    if any(not p or p in {'.', '..'} or p.endswith((' ', '.')) or _RESERVED.match(p) for p in parts):
        raise ValueError('Unsafe distribution path component')
    if len(PurePosixPath(value).parts) > 24:
        raise ValueError('Distribution path is too deep')
    return value


def normalized_name(value):
    if type(value) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', value):
        raise ValueError('Invalid wheel distribution name')
    return re.sub(r'[-_.]+', '-', value).lower()


def _https(value, hosts):
    if type(value) is not str or len(value) > 2000:
        raise ValueError('Invalid official input URL')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.username or parsed.password
            or parsed.port not in {None, 443} or parsed.query or parsed.fragment or '\\' in value
            or any(ord(c) < 33 for c in value)):
        raise ValueError('Input provenance must use an admitted publisher URL')


def _file(value, extra=()):
    if type(value) is not dict or set(value) != {'path', 'sha256', 'bytes', 'source_url'} | set(extra):
        raise ValueError('Invalid archive input fields')
    if (type(value['path']) is not str or not value['path'] or len(value['path']) > 4096
            or '\x00' in value['path'] or not Path(value['path']).is_absolute()):
        raise ValueError('Invalid local archive path')
    if type(value['bytes']) is not int or not 0 < value['bytes'] <= MAX_ARCHIVE_BYTES:
        raise ValueError('Invalid archive byte bound')
    if type(value['sha256']) is not str or not HASH.fullmatch(value['sha256']):
        raise ValueError('Invalid archive digest')


def validate_inputs(value):
    required = {'schema', 'electron', 'python', 'wheels', 'node'}
    if (type(value) is not dict or not required <= set(value) or set(value) - required - {'components'}
            or value['schema'] != SCHEMA):
        raise ValueError('Invalid distribution input document')
    if len(canonical(value)) > MAX_INPUT_BYTES:
        raise ValueError('Distribution input document is too large')
    for kind, pin in ARCHIVES.items():
        item = value[kind]
        _file(item)
        if item['sha256'] != pin['sha256'] or item['source_url'] != pin['source_url'] or ('bytes' in pin and item['bytes'] != pin['bytes']):
            raise ValueError('Runtime input differs from the reviewed official release')
    wheels = value['wheels']
    if type(wheels) is not list or not 2 <= len(wheels) <= 32:
        raise ValueError('Invalid reviewed wheel set')
    admitted = BASE_WHEELS
    names = set()
    for wheel in wheels:
        _file(wheel, ('filename', 'name', 'version', 'tags'))
        name = normalized_name(wheel['name'])
        if name in names or admitted.get(name) != wheel['version']:
            raise ValueError('Wheel name/version is not an admitted dependency')
        names.add(name)
        relative_path(wheel['filename'])
        if '/' in wheel['filename'] or not wheel['filename'].endswith('.whl'):
            raise ValueError('Invalid wheel filename')
        parts = wheel['filename'][:-4].split('-')
        if (len(parts) not in {5, 6} or normalized_name(parts[0]) != name or parts[1] != wheel['version']
                or (len(parts) == 6 and not re.fullmatch(r'[0-9][A-Za-z0-9_]*', parts[2]))):
            raise ValueError('Wheel filename differs from the reviewed distribution')
        if (type(wheel['tags']) is not list or not wheel['tags'] or len(wheel['tags']) > 16
                or any(type(tag) is not str or not re.fullmatch(r'[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+', tag) for tag in wheel['tags'])
                or len(set(wheel['tags'])) != len(wheel['tags'])):
            raise ValueError('Invalid wheel platform tags')
        _https(wheel['source_url'], {'files.pythonhosted.org'})
        if urlsplit(wheel['source_url']).path.rsplit('/', 1)[-1] != wheel['filename']:
            raise ValueError('Wheel provenance URL filename differs from reviewed input')
    if not set(BASE_WHEELS) <= names or (names - set(BASE_WHEELS) and names != set(admitted)):
        raise ValueError('Partial optional dependency closures are not supported')
    node = value['node']
    if (type(node) is not dict or set(node) != {'root', 'inventory_sha256'}
            or type(node['root']) is not str or not node['root'] or len(node['root']) > 4096
            or '\x00' in node['root'] or not Path(node['root']).is_absolute()
            or type(node['inventory_sha256']) is not str or not HASH.fullmatch(node['inventory_sha256'])):
        raise ValueError('Invalid reviewed Node inventory input')
    if 'components' in value:
        components = value['components']
        if type(components) is not dict or set(components) != set(NATIVE_COMPONENTS):
            raise ValueError('Native components require both reviewed IntelliFlow gateway bundles')
        for component in components.values():
            if (type(component) is not dict or set(component) !=
                    {'root', 'manifest_path', 'manifest_sha256', 'manifest_bytes', 'source_identity'}):
                raise ValueError('Invalid native component input fields')
            for name in ('root', 'manifest_path'):
                path = component[name]
                if (type(path) is not str or not path or len(path) > 4096
                        or any(ord(char) < 32 for char in path) or not Path(path).is_absolute()):
                    raise ValueError('Native component paths must be absolute local paths')
            if (type(component['manifest_sha256']) is not str or not HASH.fullmatch(component['manifest_sha256'])
                    or type(component['manifest_bytes']) is not int or not 0 < component['manifest_bytes'] <= 4 * 1024 * 1024
                    or type(component['source_identity']) is not str or not component['source_identity'].strip()
                    or len(component['source_identity']) > 500
                    or any(ord(char) < 32 for char in component['source_identity'])):
                raise ValueError('Invalid reviewed native component manifest or donor identity')
    return deepcopy(value)
