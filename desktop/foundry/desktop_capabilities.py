"""Source-owned Desktop description; metadata never grants executable tools."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re

from .sources import read_checked

MAX_MANIFEST_BYTES = 24 * 1024
MAX_FEATURES = 24
MAX_CONTEXT_BYTES = 32 * 1024
MANIFEST_PATH = Path(__file__).resolve().parents[1] / 'desktop-capabilities.json'
_FIELDS = {'schema', 'identity', 'explanation_policy', 'availability_policy', 'features', 'boundaries'}
_FEATURE_FIELDS = {'id', 'label', 'surface', 'summary', 'access', 'requirements', 'limitations', 'sources'}
_ACCESS = {'desktop_ui', 'model_tools', 'reference_catalog', 'conditional'}
_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def _text(value, maximum):
    if type(value) is not str or not value.strip() or len(value) > maximum or _CONTROL.search(value):
        raise ValueError('Desktop capability text is empty, invalid or exceeds its bound')
    return value


def _strings(value, maximum_items, maximum_characters, *, required=False):
    if type(value) is not list or len(value) > maximum_items or (required and not value):
        raise ValueError('Desktop capability list is invalid or exceeds its bound')
    for item in value:
        _text(item, maximum_characters)


def _source(value):
    _text(value, 240)
    if ('\\' in value or ':' in value or value.startswith('/')
            or any(part in {'', '.', '..'} or part.endswith((' ', '.')) for part in value.split('/'))
            or any(character in value for character in '\t\r\n<>"|?*')):
        raise ValueError('Desktop capability source must be a bounded relative source path')


def _validate(manifest):
    if type(manifest) is not dict or set(manifest) != _FIELDS or manifest['schema'] != 'yur.desktop-capabilities.v1':
        raise ValueError('Invalid Desktop capability manifest schema or fields')
    for field in ('identity', 'explanation_policy', 'availability_policy'):
        _text(manifest[field], 2048)
    if type(manifest['features']) is not list or not 1 <= len(manifest['features']) <= MAX_FEATURES:
        raise ValueError('Desktop capability manifest requires 1..24 features')
    seen = set()
    for feature in manifest['features']:
        if type(feature) is not dict or set(feature) != _FEATURE_FIELDS:
            raise ValueError('Invalid Desktop feature fields')
        if type(feature['id']) is not str or not re.fullmatch(r'[a-z][a-z0-9_.-]{0,63}', feature['id']) or feature['id'] in seen:
            raise ValueError('Desktop feature IDs must be bounded and unique')
        seen.add(feature['id'])
        _text(feature['label'], 160); _text(feature['surface'], 160); _text(feature['summary'], 1500)
        if type(feature['access']) is not str or feature['access'] not in _ACCESS:
            raise ValueError('Invalid Desktop feature access classification')
        for field in ('requirements', 'limitations'):
            _strings(feature[field], 12, 800)
        _strings(feature['sources'], 12, 240, required=True)
        if len(set(feature['sources'])) != len(feature['sources']):
            raise ValueError('Desktop feature source references must be unique')
        for source in feature['sources']:
            _source(source)
    _strings(manifest['boundaries'], 24, 1200, required=True)
    if len(json.dumps(manifest, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')) > MAX_MANIFEST_BYTES:
        raise ValueError('Desktop capability manifest exceeds 24 KiB')
    return deepcopy(manifest)


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Desktop capability manifest has duplicate JSON fields')
        result[key] = value
    return result


def load_capabilities(path=None):
    """Read only the fixed app manifest; an explicit path is for host tests."""
    target = MANIFEST_PATH if path is None else Path(path)
    try:
        raw = read_checked(target.parent, target.name, MAX_MANIFEST_BYTES)
    except (ValueError, OSError) as error:
        raise ValueError('Desktop capability manifest is unavailable or exceeds its safe read boundary') from error
    try:
        manifest = _validate(json.loads(raw.decode('utf-8'), object_pairs_hook=_object))
    except (ValueError, RecursionError, UnicodeError) as error:
        raise ValueError('Desktop capability manifest is invalid: ' + str(error)[:240]) from error
    return {'manifest': manifest, 'sha256': hashlib.sha256(raw).hexdigest()}


def compile_capabilities(loaded, mode):
    """Describe the whole Desktop without probing services or extending tools."""
    if type(mode) is not str or mode not in {'work', 'code'}:
        raise ValueError('Desktop Work framing requires work or code mode')
    if (type(loaded) is not dict or set(loaded) != {'manifest', 'sha256'}
            or type(loaded['sha256']) is not str or not re.fullmatch(r'[a-f0-9]{64}', loaded['sha256'])):
        raise ValueError('Desktop capability context requires its source-file digest')
    manifest = _validate(loaded['manifest'])
    lines = ['YUR AI Desktop — source-owned capability overview',
             'Manifest schema: yur.desktop-capabilities.v1',
             f"Manifest SHA-256: {loaded['sha256']}", manifest['identity'],
             'Explanation policy: ' + manifest['explanation_policy'],
             'Availability policy: ' + manifest['availability_policy'],
             f"This conversation uses {mode.title()} mode inside the broader Desktop. The overview includes UI features, reference catalogs and conditional capabilities; it is not a runtime health check or a permission grant.",
             'Desktop features:']
    for feature in manifest['features']:
        lines.append(f"- {feature['label']} ({feature['id']}; {feature['access']}; {feature['surface']}): {feature['summary']}")
        for field, label in (('requirements', 'Requires'), ('limitations', 'Limits'), ('sources', 'Source references')):
            if feature[field]:
                lines.append('  ' + label + ': ' + '; '.join(feature[field]))
    lines.extend(['Desktop boundaries:', *('- ' + item for item in manifest['boundaries']),
                  'For this task, only the supplied typed tool catalog and the existing authority checks permit execution. Describing a Desktop feature cannot invoke it or grant access; explain UI actions and unmet requirements honestly.'])
    context = '\n'.join(lines)
    if len(context.encode('utf-8')) > MAX_CONTEXT_BYTES:
        raise ValueError('Desktop capability context exceeds its 32 KiB bound')
    return context
