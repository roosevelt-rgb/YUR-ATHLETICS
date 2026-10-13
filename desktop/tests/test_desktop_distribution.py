"""Synthetic archive assembly only: no Electron/Python payload execution.

The published runtime pins are patched only inside fixtures to allow tiny inert
archives. Real release authentication/relocated native acceptance is separate.
"""
import base64
from copy import deepcopy
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

from scripts import desktop_distribution_contract as contract
from scripts import package_desktop as package


def sha(data):
    return hashlib.sha256(data).hexdigest()


class DesktopDistributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='yur-distribution-contract-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / 'source'
        self.app.mkdir()
        (self.app / 'scripts').mkdir()
        (self.app / 'src').mkdir()
        (self.app / 'src/main.js').write_text('// inert source fixture\n', encoding='utf-8')
        for binding in contract.NATIVE_COMPONENTS.values():
            (self.app / binding).write_bytes(contract.canonical({'sha256': sha(b'inert native gateway')}))
        self.node = self.root / 'node_modules'
        self.node.mkdir()
        top = {'alpha': '1.0.0'}
        self.pkg = {'name': 'synthetic-desktop', 'version': '1.0.0', 'main': 'src/main.js', 'dependencies': top}
        self.lock = {'lockfileVersion': 3, 'packages': {'': {'dependencies': top},
            'node_modules/alpha': self.module('alpha', dependencies={'beta': '1.0.0'}),
            'node_modules/beta': self.module('beta'),
            'node_modules/dev-only': {**self.module('dev-only'), 'dev': True}}}
        self.write_source()
        for name in ('alpha', 'beta', 'dev-only'):
            directory = self.node / name
            directory.mkdir()
            entry = self.lock['packages']['node_modules/' + name]
            metadata = {'name': name, 'version': '1.0.0', 'license': 'MIT'}
            if entry.get('dependencies'):
                metadata['dependencies'] = entry['dependencies']
            (directory / 'package.json').write_bytes(contract.canonical(metadata))
            (directory / 'index.js').write_text('// synthetic never executed\n', encoding='utf-8')
            (directory / 'LICENSE').write_text('Synthetic license fixture', encoding='utf-8')
        (self.node / 'alpha/native.node').write_bytes(b'inert native bytes')
        self.electron_entries = {'electron.exe': b'inert electron', 'LICENSE': b'MIT fixture',
                                 'LICENSES.chromium.html': b'<p>fixture notices</p>',
                                 'resources/default_app.asar': b'inert asar'}
        self.python_entries = {'python.exe': b'inert python', 'python314.dll': b'inert dll',
                               'python314.zip': b'inert stdlib', 'python314._pth': b'old paths\n',
                               'LICENSE.txt': b'PSF fixture'}
        self.pins = deepcopy(contract.ARCHIVES)
        self.pin_patch = patch.dict(contract.ARCHIVES, self.pins, clear=True)
        self.pin_patch.start()
        self.addCleanup(self.pin_patch.stop)
        self.inputs = {'schema': contract.SCHEMA, 'electron': self.runtime('electron', self.electron_entries),
                       'python': self.runtime('python', self.python_entries),
                       'wheels': [self.wheel('pypdf', '5.9.0', 'py3-none-any'), self.wheel('pillow', '12.1.0', 'cp314-cp314-win_amd64')],
                       'node': {'root': str(self.node), 'inventory_sha256': package.inventory_node_dependencies(self.app, self.node)['sha256']}}

    @staticmethod
    def module(name, **extra):
        return {'version': '1.0.0', 'resolved': f'https://registry.npmjs.org/{name}/-/{name}-1.0.0.tgz',
                'integrity': 'sha512-' + base64.b64encode(b'x' * 64).decode(), **extra}

    def write_source(self):
        (self.app / 'package.json').write_bytes(contract.canonical(self.pkg))
        (self.app / 'package-lock.json').write_bytes(contract.canonical(self.lock))
        (self.app / 'Start IntelliFlow Unified.cmd').write_bytes(
            (Path(__file__).resolve().parents[1] / 'Start IntelliFlow Unified.cmd').read_bytes())
        allowlist = {'format': 'yur.source-allowlist.v1', 'release_version': '0.2.0',
                     'required': ['package.json', 'package-lock.json', 'scripts/source-files.json', 'src/main.js', 'Start IntelliFlow Unified.cmd',
                                  *contract.NATIVE_COMPONENTS.values()]}
        (self.app / 'scripts/source-files.json').write_bytes(contract.canonical(allowlist))

    def archive(self, name, entries, compression=zipfile.ZIP_STORED):
        target = self.root / name
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(target, 'w', compression=compression) as archive:
                for key, value in entries.items() if isinstance(entries, dict) else entries:
                    archive.writestr(key, value)
        data = target.read_bytes()
        return target, len(data), sha(data)

    def runtime(self, kind, entries):
        target, size, digest = self.archive(kind + '.zip', entries)
        contract.ARCHIVES[kind]['sha256'] = digest
        contract.ARCHIVES[kind]['bytes'] = size
        return {'path': str(target), 'bytes': size, 'sha256': digest, 'source_url': contract.ARCHIVES[kind]['source_url']}

    def wheel(self, name, version, tag, *, extra=None, mutate_record=None, metadata_tag=None):
        prefix = f'{name}-{version}.dist-info'
        entries = {f'{name}/__init__.py': b'# synthetic never imported\n',
                   prefix + '/METADATA': f'Metadata-Version: 2.3\nName: {name}\nVersion: {version}\n'.encode(),
                   prefix + '/WHEEL': f'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: {metadata_tag or tag}\n'.encode(),
                   prefix + '/licenses/LICENSE': b'Synthetic license fixture'}
        entries.update(extra or {})
        rows = [[path, 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode(), str(len(data))]
                for path, data in sorted(entries.items())]
        rows.append([prefix + '/RECORD', '', ''])
        if mutate_record:
            mutate_record(rows)
        output = io.StringIO(newline='')
        csv.writer(output, lineterminator='\n').writerows(rows)
        entries[prefix + '/RECORD'] = output.getvalue().encode()
        filename = f'{name}-{version}-{tag}.whl'
        target, size, digest = self.archive(filename, entries)
        return {'path': str(target), 'filename': filename, 'name': name, 'version': version,
                'bytes': size, 'sha256': digest, 'source_url': f'https://files.pythonhosted.org/packages/synthetic/{filename}',
                'tags': [metadata_tag or tag]}

    def build(self, name='assembled', inputs=None):
        return package.build_desktop(self.app, inputs or self.inputs, self.root / name)

    def native_components(self):
        components = {}
        for name in contract.NATIVE_COMPONENTS:
            root = self.root / name
            (root / '_internal').mkdir(parents=True)
            payload = {'yur-gateway.exe': b'inert native gateway', '_internal/core.dll': b'inert required dependency'}
            rows = []
            for relative, data in sorted(payload.items()):
                (root / relative).write_bytes(data)
                rows.append({'path': relative, 'size' if name == 'intelliflow' else 'bytes': len(data), 'sha256': sha(data)})
            manifest = {'file_count': len(rows), 'files': rows}
            if name == 'intelliflow':
                manifest.update({'packaging_mode': 'pyinstaller-one-directory',
                                 'self_contained_core': {'external_python_required': False, 'external_yur_runtime_root_required': False},
                                 'executable': {'path': 'yur-gateway.exe', 'sha256': sha(payload['yur-gateway.exe']), 'size': len(payload['yur-gateway.exe'])}})
            else:
                manifest.update({'schema': 'intelliflow/gateway-runtime-manifest/v1', 'external_python_required': False,
                                 'external_runtime_root_required': False, 'executable': 'yur-gateway.exe',
                                 'executable_sha256': sha(payload['yur-gateway.exe'])})
            data = contract.canonical(manifest)
            path = self.root / (name + '-manifest.json')
            path.write_bytes(data)
            components[name] = {'root': str(root), 'manifest_path': str(path), 'manifest_sha256': sha(data),
                                'manifest_bytes': len(data), 'source_identity': 'synthetic reviewed ' + name + ' bundle'}
        self.inputs['components'] = components
        return components

    def test_two_relocated_builds_identical_full_inventory_and_notices(self):
        first, second = self.build('Folder one α'), self.build('Folder two β')
        self.assertEqual(first['sha256'], second['sha256'])
        self.assertEqual(Path(first['zip_path']).read_bytes(), Path(second['zip_path']).read_bytes())
        output = Path(first['path'])
        attestation = json.loads((output / package.ATTESTATION).read_text())
        self.assertEqual(attestation['schema'], 'yur.desktop-distribution-attestation.v1')
        self.assertFalse(attestation['signed'])
        self.assertEqual(attestation['first_party_license'], 'unset')
        self.assertIn('voice-python-dependencies', attestation['resources']['missing_optional'])
        self.assertIn('voice-recognition-model', attestation['resources']['external'])
        self.assertIn('marketplace-engine', attestation['resources']['external'])
        self.assertIn('marketplace-python-environment', attestation['resources']['external'])
        self.assertNotIn(str(self.root), json.dumps(attestation))
        actual_names = sorted(p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file())
        listed_names = [r['path'] for r in attestation['files']]
        self.assertEqual(actual_names, sorted(listed_names + [package.ATTESTATION]))
        for row in attestation['files']:
            data = (output / row['path']).read_bytes()
            self.assertEqual((len(data), sha(data)), (row['bytes'], row['sha256']))
        self.assertTrue(any(r['path'] == 'LICENSES.chromium.html' for r in attestation['notices']))
        marker = json.loads((output / 'resources/app/.desktop-distribution.json').read_text())
        runtime_bytes = (output / 'resources/python/runtime.json').read_bytes()
        self.assertEqual(marker['python_manifest_sha256'], sha(runtime_bytes))
        runtime = json.loads(runtime_bytes)
        python_names = sorted(p.relative_to(output / 'resources/python').as_posix() for p in (output / 'resources/python').rglob('*') if p.is_file())
        self.assertEqual(python_names, sorted([r['path'] for r in runtime['files']] + ['runtime.json']))
        self.assertEqual((output / 'resources/python/python314._pth').read_bytes(), package.PTH)
        self.assertEqual((output / 'resources/app/src/main.js').read_bytes(), (self.app / 'src/main.js').read_bytes())
        self.assertFalse((output / 'resources/app/node_modules/dev-only').exists())
        with zipfile.ZipFile(first['zip_path']) as archive:
            self.assertTrue(all(i.date_time == (1980, 1, 1, 0, 0, 0) and i.compress_type == zipfile.ZIP_STORED for i in archive.infolist()))

    def test_packaged_launchers_use_glider_profile_and_fixed_packaged_root(self):
        output = Path(self.build()['path'])
        unified = (output / 'Start IntelliFlow Unified.cmd').read_bytes()
        self.assertEqual((self.app / 'Start IntelliFlow Unified.cmd').read_bytes(),
                         (output / 'resources/app/Start IntelliFlow Unified.cmd').read_bytes())
        standalone = (output / 'Start YUR AI Desktop.cmd').read_text()
        self.assertIn('"%~dp0electron.exe"', standalone)
        self.assertIn('set "YUR_GLIDER_RC6=1"', standalone)
        self.assertIn('set "YUR_HARNESS_AUTOSTART=0"', standalone)
        self.assertIn('set "YUR_UNIFIED_ROOT=%~dp0"', standalone)
        self.assertIn('%APPDATA%\\yur-intelliflow-glider-rc6\\conversations', standalone)
        self.assertIn('%APPDATA%\\yur-intelliflow-glider-rc6\\factory', standalone)
        self.assertIn('set "ELECTRON_RUN_AS_NODE="', standalone)
        self.assertIn('"%~dp0electron.exe" %*', standalone)
        self.assertNotIn('..', standalone)
        self.assertNotIn('node_modules', unified.decode())
        self.assertNotIn('YUR_FACTORY_PYTHON', unified.decode())
        marker = json.loads((output / 'resources/app/.desktop-distribution.json').read_text())
        self.assertEqual(marker['python_resource'], '../python')
        self.assertIn('call "%~dp0Start YUR AI Desktop.cmd"', unified.decode())
        self.assertIn('%*', unified.decode())

    def test_athletics_edition_and_launcher_ship_only_in_an_athletics_build(self):
        # The edition files hold an athlete's personal details; the default Desktop build never carries them.
        (self.app / 'editions').mkdir()
        # The committed sample stands in for the owner's own manifest (editions/athletics.json, never committed).
        manifest = (Path(__file__).resolve().parent / 'fixtures' / 'athletics.sample.json').read_bytes()
        (self.app / 'editions/athletics.json').write_bytes(manifest)
        (self.app / 'scripts/edition-files.json').write_bytes(contract.canonical(
            {'format': 'yur.edition-allowlist.v1', 'editions': {'athletics': ['editions/athletics.json']}}))
        default = Path(self.build('without edition')['path'])
        self.assertFalse((default / 'Start YUR AI Athletics.cmd').exists())
        self.assertFalse((default / 'resources/app/editions').exists())
        self.assertFalse((default / 'resources/app/scripts/edition-files.json').exists())
        output = Path(package.build_desktop(self.app, self.inputs, self.root / 'with edition', ('athletics',))['path'])
        self.assertEqual((output / 'Start YUR AI Desktop.cmd').read_bytes(), (default / 'Start YUR AI Desktop.cmd').read_bytes())
        self.assertEqual((output / 'resources/app/editions/athletics.json').read_bytes(), manifest)
        athletics = (output / 'Start YUR AI Athletics.cmd').read_text()
        for line in ('title YUR Athletics', 'set "YUR_EDITION=athletics"', 'set "YUR_GLIDER_RC6=1"', 'set "YUR_HARNESS_AUTOSTART=0"',
                     'set "YUR_UNIFIED_ROOT=%~dp0"', 'set "YUR_DESKTOP_HOME=%APPDATA%\\yur-ai-athletics\\conversations"',
                     'set "YUR_FACTORY_HOME=%APPDATA%\\yur-ai-athletics\\factory"',
                     'if not defined YUR_FRANKLIN_MODEL if not defined YUR_FRANKLIN_OPENAI_URL set "YUR_FRANKLIN_MODEL=' + package.ATHLETICS_FRANKLIN_MODEL + '"',
                     'set "ELECTRON_RUN_AS_NODE="',
                     'if not exist "%~dp0resources\\app\\editions\\athletics.json" exit /b 1',
                     'start "YUR Athletics" "%~dp0electron.exe" %*'):
            self.assertIn(line, athletics)
        # Franklin's default is an Ollama Cloud model; the packaged Desktop launcher sets none.
        self.assertRegex(package.ATHLETICS_FRANKLIN_MODEL, r'^ollama:[a-z0-9][a-z0-9.\-]*:cloud$')
        self.assertNotIn('qwen3.5:9b', athletics)
        self.assertNotIn('YUR AI Athletics', athletics)
        self.assertNotIn('YUR_FRANKLIN_MODEL', (output / 'Start YUR AI Desktop.cmd').read_text())
        self.assertNotIn('yur-intelliflow-glider-rc6', athletics)
        self.assertNotIn('..', athletics)
        attestation = json.loads((output / package.ATTESTATION).read_text())
        self.assertIn('Start YUR AI Athletics.cmd', [row['path'] for row in attestation['files']])
        self.assertIn('scripts/edition-files.json', [row['path'] for row in attestation['source']['files']])
        default_attestation = json.loads((default / package.ATTESTATION).read_text())
        self.assertFalse([row['path'] for row in default_attestation['files'] if 'athletics' in row['path'].lower()])

    def test_native_components_preserve_full_donor_payload_and_attestation(self):
        components = self.native_components()
        first, second = self.build('Managed one'), self.build('Managed two')
        self.assertEqual(first['sha256'], second['sha256'])
        output = Path(first['path'])
        marker = json.loads((output / 'resources/app/.desktop-native-components.json').read_text())
        self.assertEqual(set(marker['components']), set(contract.NATIVE_COMPONENTS))
        attestation = json.loads((output / package.ATTESTATION).read_text())
        self.assertEqual(len(attestation['native_components']), 2)
        self.assertIn('music-application', attestation['resources']['external'])
        self.assertIn('workforce-sources', attestation['resources']['external'])
        for name, reviewed in components.items():
            root = output / 'resources/native' / name
            manifest_bytes = (root / 'runtime.json').read_bytes()
            self.assertEqual(sha(manifest_bytes), marker['components'][name]['manifest_sha256'])
            self.assertEqual((root / 'donor-manifest.json').read_bytes(), Path(reviewed['manifest_path']).read_bytes())
            self.assertEqual((root / '_internal/core.dll').read_bytes(), b'inert required dependency')
            runtime = json.loads(manifest_bytes)
            self.assertEqual(runtime['donor']['manifest_sha256'], reviewed['manifest_sha256'])
            self.assertEqual(runtime['executable_sha256'], sha(b'inert native gateway'))

    def test_partial_or_unknown_native_components_are_rejected(self):
        components = self.native_components()
        for invalid in ({'intelliflow': components['intelliflow']}, {**components, 'other': components['intelliflow']}):
            inputs = deepcopy(self.inputs)
            inputs['components'] = invalid
            with self.assertRaisesRegex(ValueError, 'both reviewed'):
                self.build(inputs=inputs)
        self.assertFalse((self.root / 'assembled').exists())

    def test_native_component_drift_unlisted_state_and_missing_internal_payload_fail_before_output(self):
        components = self.native_components()
        selected = components['intelliflow']
        root = Path(selected['root'])
        internal = root / '_internal/core.dll'
        original = internal.read_bytes()
        internal.write_bytes(b'drifted native dependency')
        with self.assertRaisesRegex(ValueError, 'byte count or SHA256'):
            self.build()
        internal.write_bytes(original)
        (root / 'session.sqlite3').write_bytes(b'private state fixture')
        with self.assertRaisesRegex(ValueError, 'excluded state'):
            self.build()
        (root / 'session.sqlite3').unlink()
        internal.unlink()
        with self.assertRaisesRegex(ValueError, 'inventory differs'):
            self.build()
        self.assertFalse((self.root / 'assembled').exists())

    def test_native_manifest_and_source_binding_digests_are_independent(self):
        components = self.native_components()
        selected = components['construction-v1']
        Path(selected['manifest_path']).write_bytes(b'changed donor manifest')
        with self.assertRaisesRegex(ValueError, 'SHA256 differs'):
            self.build()
        self.assertFalse((self.root / 'assembled').exists())

    def test_native_component_source_binding_mismatch_is_rejected(self):
        self.native_components()
        (self.app / contract.NATIVE_COMPONENTS['intelliflow']).write_bytes(contract.canonical({'sha256': '0' * 64}))
        with self.assertRaisesRegex(ValueError, 'differs from source binding'):
            self.build()
        self.assertFalse((self.root / 'assembled').exists())

    def test_native_donor_utf8_bom_is_preserved_and_independently_hashed(self):
        components = self.native_components()
        for component in components.values():
            path = Path(component['manifest_path'])
            data = b'\xef\xbb\xbf' + path.read_bytes()
            path.write_bytes(data)
            component.update({'manifest_sha256': sha(data), 'manifest_bytes': len(data)})
        output = Path(self.build()['path'])
        for name, component in components.items():
            self.assertEqual((output / 'resources/native' / name / 'donor-manifest.json').read_bytes(),
                             Path(component['manifest_path']).read_bytes())

    def test_missing_unified_launcher_is_rejected_before_output_creation(self):
        target = self.app / 'scripts/source-files.json'
        allowlist = json.loads(target.read_text())
        allowlist['required'].remove('Start IntelliFlow Unified.cmd')
        target.write_bytes(contract.canonical(allowlist))
        with self.assertRaisesRegex(ValueError, 'missing.*Unified launcher'):
            self.build()
        self.assertFalse((self.root / 'assembled').exists())

    def test_node_inventory_exact_dependency_closure_and_changed_native_file(self):
        before = package.inventory_node_dependencies(self.app, self.node)
        self.assertEqual([p['name'] for p in before['packages']], ['alpha', 'beta'])
        self.assertTrue(before['packages'][0]['native_artifacts'])
        (self.node / 'alpha/native.node').write_bytes(b'changed installed binary')
        self.assertNotEqual(before['sha256'], package.inventory_node_dependencies(self.app, self.node)['sha256'])
        with self.assertRaisesRegex(ValueError, 'inventory differs'):
            self.build()
        self.assertFalse((self.root / 'assembled').exists())

    def test_wrong_archive_digest_rejected_before_output_creation(self):
        Path(self.inputs['electron']['path']).write_bytes(b'changed bytes')
        with self.assertRaisesRegex(ValueError, 'SHA256 differs'):
            self.build()
        self.assertFalse((self.root / 'assembled').exists())

    def test_runtime_pin_and_optional_voice_fail_closed(self):
        bad = deepcopy(self.inputs)
        bad['python']['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'reviewed official'):
            contract.validate_inputs(bad)
        bad = deepcopy(self.inputs)
        bad['wheels'].append({**bad['wheels'][0], 'name': 'vosk', 'version': '0.3.45'})
        with self.assertRaisesRegex(ValueError, 'not an admitted'):
            contract.validate_inputs(bad)

    def test_input_exact_fields_absolute_paths_and_publisher_filename(self):
        mutations = [lambda x: x.update(extra=True), lambda x: x['node'].update(root='relative'),
                     lambda x: x['python'].update(path='relative.zip'),
                     lambda x: x['wheels'][0].update(source_url='https://files.pythonhosted.org/not-the-wheel.whl'),
                     lambda x: x['wheels'][0].update(filename='other-5.9.0-py3-none-any.whl')]
        for mutation in mutations:
            bad = deepcopy(self.inputs)
            mutation(bad)
            with self.subTest(bad=mutation), self.assertRaises(ValueError):
                contract.validate_inputs(bad)

    def test_existing_folder_or_zip_never_overwritten(self):
        target = self.root / 'occupied'
        target.mkdir()
        sentinel = target / 'keep.txt'
        sentinel.write_text('keep')
        with self.assertRaises(ValueError):
            self.build('occupied')
        self.assertEqual(sentinel.read_text(), 'keep')
        zip_target = self.root / 'other.zip'
        zip_target.write_bytes(b'preserved')
        with self.assertRaises(ValueError):
            self.build('other')
        self.assertEqual(zip_target.read_bytes(), b'preserved')

    def test_zip_traversal_reserved_names_ads_and_state_paths(self):
        for index, name in enumerate(('../escape', '/escape', 'C:/escape', 'a\\b', 'a:stream', 'CON.txt', 'a.', 'x?y', '.env', 'cache/.keys/key')):
            with self.subTest(name=name):
                path, _, _ = self.archive(f'unsafe-{index}.zip', {name: b'x'})
                if name == 'a\\b':
                    # ZipInfo normalizes Windows separators when constructing a
                    # fixture; patch both member headers to represent raw input.
                    path.write_bytes(path.read_bytes().replace(b'a/b', b'a\\b'))
                with zipfile.ZipFile(path) as archive, self.assertRaises(ValueError):
                    package._zip_members(archive)
        self.assertFalse((self.root.parent / 'escape').exists())

    def test_zip_duplicates_component_alias_and_file_directory_collisions(self):
        for entries in ([('x', b'a'), ('x', b'b')], [('Foo/a', b'a'), ('foo/b', b'b')],
                        [('é/a', b'a'), ('e\u0301/b', b'b')], [('a', b'a'), ('a/b', b'b')], [('x/', b''), ('x', b'b')]):
            with self.subTest(entries=entries):
                path, _, _ = self.archive('collisions.zip', entries)
                with zipfile.ZipFile(path) as archive, self.assertRaises(ValueError):
                    package._zip_members(archive)

    def test_zip_symlink_and_expansion_budgets(self):
        link = zipfile.ZipInfo('link')
        link.create_system, link.external_attr = 3, (stat.S_IFLNK | 0o777) << 16
        path, _, _ = self.archive('link.zip', [(link, b'outside')])
        with zipfile.ZipFile(path) as archive, self.assertRaises(ValueError):
            package._zip_members(archive)
        path, _, _ = self.archive('budget.zip', {'large': b'x' * 50})
        with zipfile.ZipFile(path) as archive, self.assertRaisesRegex(ValueError, 'total expansion'):
            package._zip_members(archive, maximum=49)
        path, _, _ = self.archive('bomb.zip', {'large': b'\x00' * (3 * 1024 * 1024)}, zipfile.ZIP_DEFLATED)
        with zipfile.ZipFile(path) as archive, self.assertRaisesRegex(ValueError, 'expansion'):
            package._zip_members(archive)
        with zipfile.ZipFile(self.inputs['electron']['path']) as archive, patch.object(package, 'MAX_FILES', 1), self.assertRaises(ValueError):
            package._zip_members(archive)

    def test_wheel_record_tamper_and_unlisted_payload_rejected(self):
        item = self.wheel('pypdf', '5.9.0', 'py3-none-any', mutate_record=lambda rows: rows[0].__setitem__(1, 'sha256=wrong'))
        with zipfile.ZipFile(item['path']) as archive, self.assertRaisesRegex(ValueError, 'RECORD hash'):
            package._wheel_payload(archive, item)
        item = self.wheel('pypdf', '5.9.0', 'py3-none-any', mutate_record=lambda rows: rows.pop(0))
        with zipfile.ZipFile(item['path']) as archive, self.assertRaisesRegex(ValueError, 'cover exactly'):
            package._wheel_payload(archive, item)

    def test_wheel_wrong_platform_startup_hooks_and_data_schemes_rejected(self):
        for tag, extra in [('cp314-cp314-linux_x86_64', {}), ('py3-none-any', {'evil.pth': b'import evil'}),
                           ('py3-none-any', {'sitecustomize.py': b'pass'}),
                           ('py3-none-any', {'pypdf-5.9.0.data/scripts/start': b'inert'}),
                           ('py3-none-any', {'foreign-1.0.dist-info/WHEEL': b'foreign'})]:
            item = self.wheel('pypdf', '5.9.0', tag, extra=extra)
            with self.subTest(tag=tag, extra=extra), zipfile.ZipFile(item['path']) as archive, self.assertRaises(ValueError):
                package._wheel_payload(archive, item)
        item = self.wheel('pypdf', '5.9.0', 'py3-none-any', metadata_tag='cp314-cp314-win_amd64')
        with zipfile.ZipFile(item['path']) as archive, self.assertRaisesRegex(ValueError, 'filename tags'):
            package._wheel_payload(archive, item)

    def test_runtime_required_files_and_resource_overlap_rejected(self):
        for entries in ({k: v for k, v in self.electron_entries.items() if k != 'LICENSE'},
                        {**self.electron_entries, 'resources/app/foreign.js': b'bad'}):
            self.inputs['electron'] = self.runtime('electron', entries)
            with self.assertRaises(ValueError):
                self.build('bad-' + str(len(entries)))

    def test_node_version_dependency_metadata_and_local_sources_rejected(self):
        metadata_path = self.node / 'alpha/package.json'
        original = metadata_path.read_bytes()
        for changes in ({'version': '2.0.0'}, {'dependencies': {'foreign': '1.0.0'}}):
            value = json.loads(original)
            value.update(changes)
            metadata_path.write_bytes(contract.canonical(value))
            with self.assertRaises(ValueError):
                package.inventory_node_dependencies(self.app, self.node)
        metadata_path.write_bytes(original)
        self.lock['packages']['node_modules/alpha']['resolved'] = 'file:///host/package'
        self.write_source()
        with self.assertRaisesRegex(ValueError, 'provenance'):
            package.inventory_node_dependencies(self.app, self.node)

    def test_hardlinks_and_reparse_inputs_fail_closed(self):
        original = self.node / 'alpha/index.js'
        linked = self.root / 'hardlink'
        os.link(original, linked)
        with self.assertRaisesRegex(ValueError, 'unlinked'):
            package.inventory_node_dependencies(self.app, self.node)
        # Exercise the Win32 reparse attribute independently of symlink privileges.
        from types import SimpleNamespace
        info = SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=0x400)
        with patch.object(Path, 'lstat', return_value=info), self.assertRaisesRegex(ValueError, 'reparse'):
            package.reject_reparse(self.root / 'reparse')

    def test_source_changed_during_build_never_emits_success_zip(self):
        original = package.collect_sources
        calls = 0
        def change(root, editions=()):
            nonlocal calls
            calls += 1
            if calls == 2:
                (self.app / 'src/main.js').write_text('// changed during build\n')
            return original(root, editions)
        with patch.object(package, 'collect_sources', side_effect=change), self.assertRaisesRegex(ValueError, 'changed during assembly'):
            self.build()
        self.assertFalse((self.root / 'assembled.zip').exists())
        self.assertFalse((self.root / 'assembled' / package.ATTESTATION).exists())

    def test_output_unlisted_file_and_changed_bytes_rejected(self):
        output = self.root / 'writer'
        output.mkdir()
        writer = package._Writer(output)
        writer.put('safe.txt', b'original')
        (output / 'unlisted.js').write_bytes(b'foreign')
        with self.assertRaisesRegex(ValueError, 'unlisted'):
            package._verify_output_inventory(writer)
        (output / 'unlisted.js').unlink()
        (output / 'safe.txt').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'SHA256 differs'):
            package._verify_output_inventory(writer)

    def test_json_duplicate_keys_and_nonfinite_values_rejected(self):
        for data in (b'{"schema":1,"schema":2}', b'{"x":NaN}'):
            with self.assertRaises(ValueError):
                package._json(data)

    def test_archive_growth_is_bounded_before_hashing_completes(self):
        item = self.inputs['electron']
        real_fdopen = os.fdopen
        class GrowingReader:
            def __init__(self, stream):
                self.stream, self.first = stream, True
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def fileno(self):
                return self.stream.fileno()
            def read(self, size=-1):
                if self.first:
                    self.first = False
                    with Path(item['path']).open('ab') as output:
                        output.write(b'appended during acquisition')
                return self.stream.read(size)
        with patch.object(package.os, 'fdopen', side_effect=lambda *a, **kw: GrowingReader(real_fdopen(*a, **kw))):
            with self.assertRaisesRegex(ValueError, 'grew beyond'):
                with package._checked_file(item['path'], expected=item):
                    self.fail('Changed input must not be yielded')

    def test_small_file_reads_actual_size_and_still_rejects_growth(self):
        target = self.root / 'tiny.bin'
        target.write_bytes(b'abc')
        real_fdopen = os.fdopen
        reads = []
        grow = False
        class ObservedReader:
            def __init__(self, stream):
                self.stream = stream
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def fileno(self):
                return self.stream.fileno()
            def read(self, size=-1):
                reads.append(size)
                if grow:
                    with target.open('ab') as output:
                        output.write(b'grew during read')
                return self.stream.read(size)
        with patch.object(package.os, 'fdopen', side_effect=lambda *a, **kw: ObservedReader(real_fdopen(*a, **kw))):
            self.assertEqual(package._bytes(target), b'abc')
            self.assertEqual(reads, [4])
            with self.assertRaisesRegex(ValueError, 'bounded regular'):
                package._bytes(target, maximum=2)
            self.assertEqual(reads, [4])
            grow = True
            with self.assertRaisesRegex(ValueError, 'changed while being read'):
                package._bytes(target)
            self.assertEqual(reads, [4, 4])


if __name__ == '__main__':
    unittest.main()
