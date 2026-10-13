"""Pure source-release assembly tests; never recursively run the verification CLI."""
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
import zipfile

from scripts.package_source import build_release, collect_sources, read_source, EDITION_ALLOWLIST, EDITION_ART_SUFFIXES, MAX_SOURCE_FILES
from scripts.package_desktop import ATHLETICS_FRANKLIN_MODEL

# The committed sample athlete manifest; editions/athletics.json is each owner's own file and is never committed.
SAMPLE_MANIFEST = "tests/fixtures/athletics.sample.json"


class _LocalHtmlAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'script' and attributes.get('src'):
            self.references.append(attributes['src'])
        if tag == 'link' and 'stylesheet' in (attributes.get('rel') or '').split() and attributes.get('href'):
            self.references.append(attributes['href'])


def _assert_desktop_dependency_closure(content):
    """Verification gate for literal first-party UI assets; never follow a path.

    External dependencies belong to runtime packaging, not the source allowlist.
    Dynamic imports/constructed URLs require separate runtime acceptance.
    """
    missing = []
    for name, data in content.items():
        suffix = PurePosixPath(name).suffix
        if not name.startswith('src/') or suffix not in {'.html', '.js', '.css'}:
            continue
        text = data.decode('utf-8')
        references = []
        if suffix == '.html':
            parser = _LocalHtmlAssets()
            parser.feed(text)
            references.extend((reference, False) for reference in parser.references)
        elif suffix == '.css':
            css = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
            references.extend((match.group(2) or match.group(3), False) for match in re.finditer(
                r'''\burl\(\s*(?:(['"])(.*?)\1|([^\s)'";]+))\s*\)''', css, re.IGNORECASE))
            references.extend((match.group(2), False) for match in re.finditer(
                r'''@import\s+(['"])([^'"]+)\1''', css, re.IGNORECASE))
        # Literal CommonJS imports only. AMD window.require() is a separate loader.
        references.extend((match.group(2), True) for match in re.finditer(
            r'''(?<![\w.])require\(\s*(['"])(\.{1,2}/[^'"]+)\1\s*\)''', text))
        for reference, commonjs in references:
            url = urlsplit(reference)
            if url.scheme or url.netloc or not url.path:
                continue
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), url.path))
            if 'node_modules' in PurePosixPath(resolved).parts:
                continue
            candidates = [resolved]
            if commonjs and not PurePosixPath(resolved).suffix:
                candidates.extend([resolved + '.js', resolved + '.json', resolved + '/index.js'])
            if not any(candidate in content for candidate in candidates):
                missing.append(f'{name} -> {reference} ({resolved})')
    if missing:
        raise ValueError('Source release omits active desktop dependencies: ' + '; '.join(sorted(missing)))


class SourcePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "project"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "src").mkdir()
        (self.root / "src/main.py").write_text("print('reviewed source')\n", encoding="utf-8")
        self.write_allowlist(["scripts/source-files.json", "src/main.py"])

    def tearDown(self):
        self.temporary.cleanup()

    def write_allowlist(self, paths):
        (self.root / "scripts/source-files.json").write_text(json.dumps({
            "format": "yur.source-allowlist.v1", "release_version": "0.2.0", "required": paths
        }), encoding="utf-8")

    def test_allowlist_excludes_unlisted_state_without_reading_it(self):
        ignored = ["src/service-account.json", "src/credentials.json", "src/cache/session.json",
                   "src/.keys/settings.json", "src/settings.local.json", "src/new-donor.py"]
        for name in ignored:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("untrusted fixture: must not enter the archive", encoding="utf-8")
        real_open = os.open

        def guarded_open(path, *args, **kwargs):
            if Path(path).relative_to(self.root).as_posix() in ignored:
                self.fail("Packaging read unlisted state")
            return real_open(path, *args, **kwargs)

        with patch("scripts.package_source.os.open", guarded_open):
            content, version = collect_sources(self.root)
        self.assertEqual(set(content), {"scripts/source-files.json", "src/main.py"})
        self.assertEqual(version, "0.2.0")

    def write_editions(self, editions, document=None):
        (self.root / EDITION_ALLOWLIST).write_text(json.dumps(document or {
            "format": "yur.edition-allowlist.v1", "editions": editions}), encoding="utf-8")

    def test_edition_files_enter_a_release_only_when_their_edition_is_requested(self):
        for name in ("editions/athletics.json", "src/athletics-launch.html"):
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_text("edition-only fixture", encoding="utf-8")
        self.write_editions({"athletics": ["editions/athletics.json", "src/athletics-launch.html"]})
        default, _ = collect_sources(self.root)
        self.assertEqual(set(default), {"scripts/source-files.json", "src/main.py"})
        edition, _ = collect_sources(self.root, ("athletics",))
        self.assertEqual(set(edition), {"scripts/source-files.json", "src/main.py", EDITION_ALLOWLIST,
                                        "editions/athletics.json", "src/athletics-launch.html"})
        self.assertEqual(collect_sources(self.root, ("athletics", "athletics"))[0], edition)
        release = build_release(self.root, ("athletics",))
        with zipfile.ZipFile(release["path"]) as archive:
            attestation = json.loads(archive.read("SOURCE_ATTESTATION.json"))
        self.assertIn("editions/athletics.json", attestation["files"])
        self.assertIn("athletics edition files in scripts/edition-files.json", attestation["source_selection"])
        # An edition release names its edition; the Desktop's release name is unchanged.
        self.assertRegex(Path(release["path"]).name, r"^yur-specialist-factory-[^-]+-athletics-[0-9a-f]{16}-source\.zip$")
        desktop = build_release(self.root)
        self.assertRegex(Path(desktop["path"]).name, r"^yur-specialist-factory-[^-]+-[0-9a-f]{16}-source\.zip$")
        with zipfile.ZipFile(desktop["path"]) as archive:
            self.assertNotIn("editions/athletics.json", archive.namelist())
            self.assertNotIn(EDITION_ALLOWLIST, archive.namelist())
        for editions, document, requested in (
                ({"athletics": ["editions/athletics.json"]}, None, ("other",)),
                ({"athletics": []}, None, ("athletics",)),
                ({"athletics": ["src/main.py"]}, None, ("athletics",)),
                ({"athletics": ["editions/athletics.json", "editions/athletics.json"]}, None, ("athletics",)),
                ({"athletics": [EDITION_ALLOWLIST]}, None, ("athletics",)),
                ({"athletics": ["../outside.json"]}, None, ("athletics",)),
                ({}, {"format": "other", "editions": {}}, ("athletics",)),
                ({}, {"format": "yur.edition-allowlist.v1", "editions": {}, "extra": 1}, ("athletics",))):
            with self.subTest(editions=editions, document=document, requested=requested):
                self.write_editions(editions, document)
                with self.assertRaises(ValueError):
                    collect_sources(self.root, requested)

    def test_release_is_deterministic_and_attests_exact_contents(self):
        first, second = build_release(self.root), build_release(self.root)
        self.assertEqual(first, second)
        self.assertFalse(first["signed"])
        payload = Path(first["path"]).read_bytes()
        self.assertEqual(hashlib.sha256(payload).hexdigest(), first["sha256"])
        with zipfile.ZipFile(first["path"]) as archive:
            attestation = json.loads(archive.read("SOURCE_ATTESTATION.json"))
            self.assertEqual(set(archive.namelist()), {*attestation["files"], "SOURCE_ATTESTATION.json"})
            for name, digest in attestation["files"].items():
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), digest)

    def test_source_changes_create_a_new_release_and_preserve_prior_bytes(self):
        first = build_release(self.root)
        previous = Path(first["path"]).read_bytes()
        (self.root / "src/main.py").write_text("print('next reviewed release')\n", encoding="utf-8")
        second = build_release(self.root)
        self.assertNotEqual(first["path"], second["path"])
        self.assertEqual(Path(first["path"]).read_bytes(), previous)

    def test_conflicting_existing_release_is_never_overwritten(self):
        release = build_release(self.root)
        Path(release["path"]).write_bytes(b"unrelated pre-existing bytes")
        with self.assertRaisesRegex(ValueError, "refusing overwrite"):
            build_release(self.root)
        self.assertEqual(Path(release["path"]).read_bytes(), b"unrelated pre-existing bytes")

    def test_missing_required_source_and_unsafe_allowlist_fail_closed(self):
        self.write_allowlist(["scripts/source-files.json", "src/missing.py"])
        with self.assertRaises(FileNotFoundError):
            collect_sources(self.root)
        for name in ("../escape.py", "src/.keys/settings.json", "src/cache/session.json",
                     "evidence/acceptance.json", "runtime/service.json", "_state/session.json",
                     "_secrets/access.json", "_memory/session.json", "logs/requests.json"):
            self.write_allowlist(["scripts/source-files.json", name])
            with self.subTest(name=name), self.assertRaises(ValueError):
                collect_sources(self.root)

    def test_reparse_release_parent_and_target_are_rejected(self):
        release = build_release(self.root)
        actual_lstat = Path.lstat
        for unsafe in (self.root.parent, self.root / "release", Path(release["path"])):
            def metadata(path, *args, **kwargs):
                if path == unsafe:
                    return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
                return actual_lstat(path, *args, **kwargs)
            with self.subTest(path=unsafe), patch.object(Path, "lstat", metadata):
                with self.assertRaisesRegex(ValueError, "reparse"):
                    build_release(self.root)

    def test_per_file_source_budget_is_enforced(self):
        with self.assertRaisesRegex(ValueError, "budget"):
            read_source(self.root, "src/main.py", 2)

    def test_current_source_release_contains_static_desktop_dependencies(self):
        # package:source runs the verification suite before writing an archive.
        # This prevents a valid allowlist/hash manifest from omitting active UI.
        content, _ = collect_sources(Path(__file__).resolve().parents[1])
        _assert_desktop_dependency_closure(content)

    def test_current_default_release_carries_no_athletics_details_and_the_athletics_build_is_complete(self):
        # The Athletics files hold an athlete's name, class year and local paths; only an Athletics
        # build (package_desktop.py build --edition athletics) ships them, with their dependencies.
        root = Path(__file__).resolve().parents[1]
        default, _ = collect_sources(root)
        athletics = json.loads((root / EDITION_ALLOWLIST).read_text(encoding="utf-8"))["editions"]["athletics"]
        self.assertFalse(set(athletics) & set(default))
        self.assertNotIn(EDITION_ALLOWLIST, default)
        # The details come from the manifest, so this file (a Desktop file) names none of them: neither the committed
        # sample's nor, when this checkout has one, the owner's own editions/athletics.json (never committed).
        local = root / "editions/athletics.json"
        manifests = [json.loads((root / SAMPLE_MANIFEST).read_text(encoding="utf-8"))]
        if local.exists():
            manifests.append(json.loads(local.read_text(encoding="utf-8")))
        details = [detail for manifest in manifests for detail in
                   (*manifest["athlete"]["display_name"].split(), manifest["athlete"]["id"], manifest["gridiron_mcp"]["server"])]
        for name, data in default.items():
            if PurePosixPath(name).suffix in {".js", ".cjs", ".py", ".json", ".html", ".css", ".md", ".cmd"}:
                text = data.decode("utf-8", "replace")
                for detail in details:
                    self.assertNotIn(detail, text, name)
        # A checkout without the owner's manifest builds the Athletics release with the committed sample in its place.
        sample = (root / SAMPLE_MANIFEST).read_bytes()

        def manifest_or_sample(source_root, relative, *args):
            if relative == "editions/athletics.json" and not (Path(source_root) / relative).exists():
                return sample
            return read_source(source_root, relative, *args)
        with patch("scripts.package_source.read_source", manifest_or_sample):
            edition, _ = collect_sources(root, ("athletics",))
        self.assertEqual(set(edition) - set(default), {*athletics, EDITION_ALLOWLIST})
        _assert_desktop_dependency_closure(edition)

    def test_current_release_retains_unified_launcher_and_reproducible_native_regressions(self):
        root = Path(__file__).resolve().parents[1]
        content, _ = collect_sources(root)
        required = json.loads(content['scripts/source-files.json'])['required']
        self.assertEqual(len(required), MAX_SOURCE_FILES)
        for name in ('Start IntelliFlow Unified.cmd', 'tests/desktop-regression-entry.cjs',
                     'foundry/generated_evidence.py', 'foundry/generated_evidence_v1.py',
                     'foundry/generated_evidence_v2.py', 'tests/test_generated_evidence_v2.py',
                     'src/page-runtime-registry.js', 'src/production-view.js', 'src/production-view.css',
                     'tests/page-runtime-registry.test.js', 'tests/production-view.test.js',
                     'tests/run-desktop-regressions.cjs', 'tests/retained-surfaces-acceptance.cjs',
                     'tests/coding-runtime-view-smoke.cjs', 'tests/franklin-desktop-actions-smoke.cjs',
                     'tests/rc6-native-approval-acceptance.cjs', 'tests/fixtures/rc6-approval-model.cjs',
                     'tests/fixtures/rc6-approval-mcp.cjs'):
            self.assertIn(name, content)
        scripts = json.loads(content['package.json'])['scripts']
        for key in ('test:electron', 'test:conversation', 'test:conversation:live', 'test:repository',
                    'test:repository:live', 'test:copilot', 'test:hermes', 'test:workforce',
                    'test:parity', 'test:projects', 'test:attachments', 'test:work', 'test:browser',
                    'test:browser:work', 'test:voice', 'test:specialists', 'test:specialist-forge',
                    'test:specialist-forge:live', 'test:schedules', 'test:artifacts/full',
                    'test:documents', 'test:steering', 'test:construction', 'test:concepts',
                    'test:sources', 'test:specialists-generated', 'test:code:live', 'test:execution:setup'):
            self.assertIn('tests/desktop-regression-entry.cjs', scripts[key], key)
        self.assertEqual(scripts['test:artifact-preview'], 'electron tests/artifact-preview-smoke.cjs')
        self.assertTrue(scripts['test:conversation:live'].endswith('--live-local'))
        self.assertTrue(scripts['test:repository:live'].endswith('--live-local'))

    def test_current_release_retains_desktop_mission_surfaces_and_acceptance_sources(self):
        content, _ = collect_sources(Path(__file__).resolve().parents[1])
        for name in (
            'src/background-lifetime.js', 'tests/background-lifetime.test.js', 'tests/background-native.cjs',
            'src/franklin-browser-actions.js', 'tests/franklin-browser-actions.test.js', 'tests/franklin-browser-native.cjs',
            'src/franklin-services.js', 'tests/franklin-services.test.js', 'docs/franklin-services.md',
            'src/marketplace-export.js', 'tests/marketplace-export.test.js',
            'src/music-assets.js', 'src/music-connection.js', 'src/music-ui-host.js', 'src/music-view.js', 'src/music.css',
            'tests/music-assets.test.js', 'tests/music-connection.test.js', 'tests/music-ui-host.test.js',
            'tests/music-view.test.js', 'tests/music-view-native.cjs', 'tests/music-desktop-native.cjs',
            'tests/music-service-acceptance.cjs', 'src/franklin-unreal.js', 'src/unreal-view.js', 'src/unreal-view.css',
            'tests/franklin-unreal.test.js', 'tests/unreal-view.test.js', 'tests/unreal-view-smoke.cjs',
            'tests/test_franklin_desktop_capabilities.py', 'tests/specialist-forge-smoke.cjs',
            'tests/specialist-forge-live.cjs', 'tests/glider-rc6-smoke.cjs', 'tests/glider-rc6-live.cjs',
            'src/desktop-theme.css', 'tests/desktop-theme.test.js', 'tests/desktop-theme-smoke.cjs',
            'src/terminal-panes.js', 'tests/terminal-panes.test.js', 'tests/terminal-split-smoke.cjs',
        ):
            with self.subTest(source=name):
                self.assertIn(name, content)

    @unittest.skipUnless(os.name == 'nt', 'Actual Windows command launcher acceptance')
    def test_unified_launcher_relocated_profile_fallback_overrides_and_exit_status(self):
        root = Path(__file__).resolve().parents[1]
        folder = self.root / 'relocated launch with spaces'
        folder.mkdir()
        launcher = folder / 'Start IntelliFlow Unified.cmd'
        launcher.write_bytes((root / launcher.name).read_bytes())
        # The real launcher calls this inert sibling. No Electron is started.
        (folder / 'Start YUR AI Desktop.cmd').write_bytes(
            b'@echo off\r\necho UI=%YUR_GLIDER_RC6%\r\necho AUTO=%YUR_HARNESS_AUTOSTART%\r\n'
            b'echo DESKTOP=%YUR_DESKTOP_HOME%\r\necho FACTORY=%YUR_FACTORY_HOME%\r\n'
            b'echo WORKFORCE=%YUR_WORKFORCE_SOURCE%\r\necho ROOT=%YUR_WORKFORCE_ROOT%\r\n'
            b'echo NODE=%ELECTRON_RUN_AS_NODE%\r\nexit /b 19\r\n')
        user = self.root / 'synthetic user'
        corpus = user / 'YUR AI WORKING RP/src/yur_workforce'
        corpus.mkdir(parents=True)
        (corpus / 'genome.py').write_text('# fixture presence only')
        base = {**os.environ, 'APPDATA': str(self.root / 'synthetic appdata'), 'USERPROFILE': str(user),
                'ELECTRON_RUN_AS_NODE': '1', 'YUR_GLIDER_RC6': '0', 'YUR_HARNESS_AUTOSTART': '1'}
        for name in ('YUR_WORKFORCE_SOURCE', 'YUR_WORKFORCE_ROOT'):
            base.pop(name, None)
        for overrides in ({}, {'YUR_WORKFORCE_SOURCE': str(self.root / 'selected workforce'),
                               'YUR_WORKFORCE_ROOT': str(self.root / 'selected root')}):
            with self.subTest(overrides=bool(overrides)):
                result = subprocess.run([os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', str(launcher)],
                                        cwd=folder, env={**base, **overrides}, capture_output=True, text=True,
                                        timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                self.assertEqual(result.returncode, 19, result.stderr)
                values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
                self.assertEqual((values['UI'], values['AUTO'], values['NODE']), ('1', '0', ''))
                self.assertEqual(values['DESKTOP'], str(Path(base['APPDATA']) / 'yur-intelliflow-glider-rc6/conversations'))
                self.assertEqual(values['FACTORY'], str(Path(base['APPDATA']) / 'yur-intelliflow-glider-rc6/factory'))
                self.assertEqual(values['WORKFORCE'], overrides.get('YUR_WORKFORCE_SOURCE', str(corpus)))
                self.assertEqual(values['ROOT'], overrides.get('YUR_WORKFORCE_ROOT', str(corpus)))

    @unittest.skipUnless(os.name == 'nt', 'Actual Windows command launcher acceptance')
    def test_athletics_launcher_sets_edition_profile_and_model_then_uses_desktop_launcher(self):
        root = Path(__file__).resolve().parents[1]
        folder = self.root / 'relocated athletics with spaces'
        (folder / 'editions').mkdir(parents=True)
        launcher = folder / 'Start YUR AI Athletics.cmd'
        launcher.write_bytes((root / launcher.name).read_bytes())
        # The real launcher calls this inert sibling. No Electron is started.
        (folder / 'Start YUR AI Desktop.cmd').write_bytes(
            b'@echo off\r\necho EDITION=%YUR_EDITION%\r\necho UI=%YUR_GLIDER_RC6%\r\necho AUTO=%YUR_HARNESS_AUTOSTART%\r\n'
            b'echo CONFIGURED=%YUR_DESKTOP_GLIDER_CONFIGURED%\r\necho DESKTOP=%YUR_DESKTOP_HOME%\r\necho FACTORY=%YUR_FACTORY_HOME%\r\n'
            b'echo MODEL=%YUR_FRANKLIN_MODEL%\r\necho NODE=%ELECTRON_RUN_AS_NODE%\r\necho ARGS=%*\r\nexit /b 23\r\n')
        base = {**os.environ, 'APPDATA': str(self.root / 'synthetic appdata'), 'ELECTRON_RUN_AS_NODE': '1',
                'YUR_EDITION': 'other', 'YUR_GLIDER_RC6': '0', 'YUR_HARNESS_AUTOSTART': '1',
                'YUR_DESKTOP_HOME': str(self.root / 'desktop journal'), 'YUR_FACTORY_HOME': str(self.root / 'desktop factory')}
        base.pop('YUR_FRANKLIN_MODEL', None)
        base.pop('YUR_FRANKLIN_OPENAI_URL', None)

        def run(environment):
            return subprocess.run([os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', str(launcher), '--dev'],
                                  cwd=folder, env=environment, capture_output=True, text=True, timeout=10,
                                  stdin=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        missing = run(base)
        self.assertEqual(missing.returncode, 1, missing.stderr)
        self.assertIn('edition manifest is missing', missing.stdout)
        self.assertNotIn('EDITION=', missing.stdout)
        (folder / 'editions/athletics.json').write_bytes((root / SAMPLE_MANIFEST).read_bytes())
        # Franklin's default is an Ollama Cloud model (a :cloud tag through the local daemon), never a
        # local one; the user's own YUR_FRANKLIN_MODEL wins. With a dedicated endpoint its model name
        # stays the user's: no ollama: default that the Desktop would list as a bogus 'openai:ollama:...' entry.
        for overrides, model in (({}, ATHLETICS_FRANKLIN_MODEL), ({'YUR_FRANKLIN_MODEL': 'ollama:selected-model'}, 'ollama:selected-model'),
                                 ({'YUR_FRANKLIN_OPENAI_URL': 'http://127.0.0.1:9/v1'}, ''),
                                 ({'YUR_FRANKLIN_OPENAI_URL': 'http://127.0.0.1:9/v1', 'YUR_FRANKLIN_MODEL': 'served-model'}, 'served-model')):
            with self.subTest(model=model):
                result = run({**base, **overrides})
                self.assertEqual(result.returncode, 23, result.stderr)
                values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
                self.assertEqual((values['EDITION'], values['UI'], values['AUTO'], values['CONFIGURED'], values['NODE']),
                                 ('athletics', '1', '0', '1', ''))
                self.assertEqual(values['DESKTOP'], str(Path(base['APPDATA']) / 'yur-ai-athletics/conversations'))
                self.assertEqual(values['FACTORY'], str(Path(base['APPDATA']) / 'yur-ai-athletics/factory'))
                self.assertEqual(values['MODEL'], model)
                self.assertEqual(values['ARGS'], '--dev')

    def test_athletics_launcher_names_yur_athletics_and_defaults_franklin_to_an_ollama_cloud_model(self):
        root = Path(__file__).resolve().parents[1]
        launcher = (root / 'Start YUR AI Athletics.cmd').read_text(encoding='utf-8')
        self.assertIn('\ntitle YUR Athletics\n', launcher)
        self.assertNotIn('YUR AI Athletics', launcher)
        defaults = re.findall(r'set "YUR_FRANKLIN_MODEL=([^"]+)"', launcher)
        self.assertEqual(defaults, [ATHLETICS_FRANKLIN_MODEL], 'the source and packaged launchers agree')
        # ollama:<name>:cloud reaches Ollama Cloud through the local daemon; nothing runs on this computer.
        self.assertRegex(ATHLETICS_FRANKLIN_MODEL, r'^ollama:[a-z0-9][a-z0-9.\-]*:cloud$')
        self.assertNotIn('qwen3.5:9b', launcher)
        self.assertIn('if not defined YUR_FRANKLIN_MODEL if not defined YUR_FRANKLIN_OPENAI_URL set "YUR_FRANKLIN_MODEL=', launcher)
        # The YUR AI Desktop sets no Franklin model, and keeps its own console title unless the Athletics launcher called it.
        desktop = (root / 'Start YUR AI Desktop.cmd').read_text(encoding='utf-8')
        self.assertNotIn('YUR_FRANKLIN_MODEL', desktop)
        self.assertIn('if "%YUR_EDITION%"=="athletics" (\n  title YUR Athletics\n) else (\n  title YUR AI Desktop\n)', desktop)
        self.assertNotIn('YUR_FRANKLIN_MODEL', (root / 'Start IntelliFlow Unified.cmd').read_text(encoding='utf-8'))

    @unittest.skipUnless(os.name == 'nt', 'Actual Windows command launcher acceptance')
    def test_desktop_launcher_title_branch_parses_with_and_without_the_edition(self):
        # A copy without its source stops at the first check, after the title branch; no Electron starts.
        root = Path(__file__).resolve().parents[1]
        folder = self.root / 'desktop launcher check'
        folder.mkdir()
        launcher = folder / 'Start YUR AI Desktop.cmd'
        launcher.write_bytes((root / launcher.name).read_bytes())
        base = {**os.environ, 'YUR_DESKTOP_GLIDER_CONFIGURED': '1'}
        base.pop('YUR_EDITION', None)
        for env in (base, {**base, 'YUR_EDITION': 'athletics'}, {**base, 'YUR_EDITION': 'other'}):
            with self.subTest(edition=env.get('YUR_EDITION')):
                result = subprocess.run([os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', str(launcher)], cwd=folder, env=env,
                                        capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL,
                                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn('The YUR Desktop source is missing', result.stdout)
                self.assertNotIn('was unexpected', result.stdout + result.stderr)

    def test_missing_html_script_is_rejected_even_when_zip_attestation_is_valid(self):
        (self.root / 'src/index.html').write_text('<script src="active.js"></script>', encoding='utf-8')
        (self.root / 'src/active.js').write_text('window.fixture = true;', encoding='utf-8')
        self.write_allowlist(['scripts/source-files.json', 'src/index.html'])
        release = build_release(self.root)
        with zipfile.ZipFile(release['path']) as archive:
            content = {name: archive.read(name) for name in archive.namelist()}
        with self.assertRaisesRegex(ValueError, r'index\.html -> active\.js'):
            _assert_desktop_dependency_closure(content)
        self.write_allowlist(['scripts/source-files.json', 'src/index.html', 'src/active.js'])
        _assert_desktop_dependency_closure(collect_sources(self.root)[0])

    def test_missing_transitive_relative_require_is_rejected(self):
        (self.root / 'src/main.js').write_text("require('./child');", encoding='utf-8')
        (self.root / 'src/child.js').write_text("require('./missing'); require('node:fs');", encoding='utf-8')
        self.write_allowlist(['scripts/source-files.json', 'src/main.js', 'src/child.js'])
        with self.assertRaisesRegex(ValueError, r'child\.js -> \./missing'):
            _assert_desktop_dependency_closure(collect_sources(self.root)[0])

    def test_css_imports_and_font_assets_must_be_explicitly_allowlisted(self):
        (self.root / 'src/theme.css').write_text(
            '@import "fonts.css"; @import url("extra.css");', encoding='utf-8')
        (self.root / 'src/fonts.css').write_text(
            '@font-face { src: url("font.woff2"); }', encoding='utf-8')
        (self.root / 'src/extra.css').write_text(
            '/* url("ignored.css") */ .icon { fill: url(#local); }', encoding='utf-8')
        (self.root / 'src/font.woff2').write_bytes(b'wOF2fixture')
        paths = ['scripts/source-files.json', 'src/theme.css']
        self.write_allowlist(paths)
        with self.assertRaisesRegex(ValueError, r'theme\.css -> fonts\.css'):
            _assert_desktop_dependency_closure(collect_sources(self.root)[0])
        paths.extend(['src/fonts.css', 'src/extra.css'])
        self.write_allowlist(paths)
        with self.assertRaisesRegex(ValueError, r'fonts\.css -> font\.woff2'):
            _assert_desktop_dependency_closure(collect_sources(self.root)[0])
        self.write_allowlist([*paths, 'src/font.woff2'])
        _assert_desktop_dependency_closure(collect_sources(self.root)[0])

    def test_edition_brand_art_ships_only_by_explicit_edition_allowlist_entry(self):
        # Icons, logos and the hero raster belong to an edition: its own list may name them, the
        # YUR AI Desktop allowlist never can, so the default build is exactly as before.
        self.assertEqual(EDITION_ART_SUFFIXES, {'.ico', '.png', '.webp', '.svg'})
        art = {'src/athletics-brand/brand/lockup.svg': b'<svg xmlns="http://www.w3.org/2000/svg"/>',
               'src/athletics-brand/brand/icon.ico': b'\x00\x00\x01\x00',
               'src/athletics-brand/brand/mark.png': b'\x89PNG\r\n\x1a\n',
               'src/athletics-brand/brand/hero.webp': b'RIFF\x04\x00\x00\x00WEBP'}
        for name, data in art.items():
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_bytes(data)
        self.assertFalse(set(art) & set(collect_sources(self.root)[0]))
        self.write_editions({'athletics': list(art)})
        self.assertFalse(set(art) & set(collect_sources(self.root)[0]), 'unrequested, the edition art stays out')
        content, _ = collect_sources(self.root, ('athletics',))
        for name, data in art.items():
            self.assertEqual(content[name], data)
        for name in art:
            with self.subTest(default_allowlist=name):
                self.write_allowlist(['scripts/source-files.json', 'src/main.py', name])
                with self.assertRaisesRegex(ValueError, 'unapproved file type'):
                    collect_sources(self.root)
        self.write_allowlist(['scripts/source-files.json', 'src/main.py'])
        (self.root / 'src/athletics-brand/brand/tool.exe').write_bytes(b'MZ')
        self.write_editions({'athletics': ['src/athletics-brand/brand/tool.exe']})
        with self.assertRaisesRegex(ValueError, 'unapproved file type'):
            collect_sources(self.root, ('athletics',))


if __name__ == "__main__":
    unittest.main()
