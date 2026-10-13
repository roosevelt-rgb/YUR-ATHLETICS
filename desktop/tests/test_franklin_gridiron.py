"""YUR Athletics: Franklin's Gridiron actions, authority parity and prompt addendum.

The edition is chosen per process (YUR_EDITION), so Athletics checks run in child processes.
No Gridiron server, model provider, browser or Electron is started.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

from foundry.franklin_cli import compile_request, edition_addendum, edition_model_check, validate_rpc
from foundry.work_desktop import ACTIONS, GRIDIRON_ACTIONS, GRIDIRON_READ_TOOLS, GRIDIRON_TOOLS, GRIDIRON_WRITE_TOOLS, HOST_AUTHORITY, catalog, validate_arguments


ROOT = Path(__file__).resolve().parents[1]
# The athlete manifest (editions/athletics.json) is each owner's own file and is never committed. These tests read the
# committed sample from a temporary editions folder; edition_addendum() and child processes are pointed at it.
SAMPLE = ROOT / 'tests' / 'fixtures' / 'athletics.sample.json'
MANIFEST = json.loads(SAMPLE.read_text(encoding='utf-8'))
ATHLETE = MANIFEST['athlete']['id']
DRAFT = {'athlete_id': ATHLETE, 'school': 'Fixture University', 'to': 'coach@fixture.example', 'subject': 'Fixture season film',
         'body': 'Coach, here is my updated season film and stat line for your review.'}


SAMPLE_ROOT = None
_SAMPLE_DEFAULTS = None


def setUpModule():
    global SAMPLE_ROOT, _SAMPLE_DEFAULTS
    SAMPLE_ROOT = tempfile.mkdtemp(prefix='yur-edition-sample-')
    shutil.copyfile(SAMPLE, Path(SAMPLE_ROOT) / 'athletics.json')
    # compile_request() calls edition_addendum() with its default root: in this module that is the sample's folder.
    _SAMPLE_DEFAULTS = patch.object(edition_addendum, '__defaults__', (None, SAMPLE_ROOT))
    _SAMPLE_DEFAULTS.start()


def tearDownModule():
    _SAMPLE_DEFAULTS.stop()
    shutil.rmtree(SAMPLE_ROOT, ignore_errors=True)


def environment(edition):
    env = {key: value for key, value in os.environ.items() if key != 'YUR_EDITION'}
    if edition is not None:
        env['YUR_EDITION'] = edition
    env['PYTHONIOENCODING'] = 'utf-8'
    return env


def child_python(code, edition='athletics', data=None):
    result = subprocess.run([sys.executable, '-B', '-c', code], cwd=ROOT, env=environment(edition), input=json.dumps(data),
                            capture_output=True, text=True, encoding='utf-8', timeout=120, check=True)
    return json.loads(result.stdout)


def child_node(code, edition):
    result = subprocess.run(['node', '-e', code], cwd=ROOT, env=environment(edition), capture_output=True, text=True,
                            encoding='utf-8', timeout=60, check=True)
    return json.loads(result.stdout)


PYTHON_LISTS = '''import json
from foundry import work_desktop as w
print(json.dumps({'actions': list(w.ACTIONS), 'authority': w.HOST_AUTHORITY['actions'], 'read': list(w.GRIDIRON_READ_TOOLS),
                  'write': list(w.GRIDIRON_WRITE_TOOLS), 'tools': list(w.GRIDIRON_TOOLS),
                  'payload': sorted(w.catalog()[0]['input_schema']['properties']['payload']['properties'])}))'''
NODE_LISTS = ("const g = require('./src/franklin-gridiron'); process.stdout.write(JSON.stringify({ actions: require('./src/franklin-host').ACTIONS, "
              "read: g.READ_TOOLS, write: g.WRITE_TOOLS, tools: g.GRIDIRON_TOOLS }))")
VALIDATE = '''import json, sys
from foundry.work_desktop import validate_arguments
results = []
for arguments in json.load(sys.stdin):
    try:
        results.append(validate_arguments(arguments) == arguments)
    except ValueError:
        results.append(None)
print(json.dumps(results))'''
CATALOG = '''import json
from foundry.work_tools import tool_catalog
from foundry import work_browser, work_concepts, work_desktop, work_generated, work_specialists
from foundry.work_provider import native_tools
# Franklin's request has no repository root and runs in Work mode (work_engine.py tool catalog).
entries = [*(entry for entry in tool_catalog() if 'repository.read' not in entry['permissions']), *work_specialists.catalog(),
           *work_concepts.catalog(), *work_generated.catalog('work'), *work_browser.catalog(None), *work_desktop.catalog()]
desktop = [entry for entry in entries if entry['name'] == work_desktop.TOOL]
payload = desktop[0]['input_schema']['properties']['payload']['properties']
print(json.dumps({'count': len(native_tools(entries)), 'desktop': len(desktop), 'tool_enum': payload['tool']['enum'],
                  'arguments': payload['arguments']['type'], 'action_enum': desktop[0]['input_schema']['properties']['action']['enum'],
                  'describes': 'gridiron_call' in desktop[0]['description']}))'''


TURN = '''import json, tempfile, uuid
from copy import deepcopy
from pathlib import Path
from foundry.commit_service import CommitService
from foundry.franklin_cli import handle
from foundry.work_desktop import HOST_AUTHORITY
import sys
from foundry import franklin_cli
SAMPLE_ROOT = json.load(sys.stdin)['root']
franklin_cli.edition_addendum.__defaults__ = (None, SAMPLE_ROOT)  # the committed sample, not editions/athletics.json
ATHLETE = json.loads((Path(SAMPLE_ROOT) / 'athletics.json').read_text(encoding='utf-8'))['athlete']['id']
with tempfile.TemporaryDirectory() as folder:
    store = CommitService(Path(folder) / 'journal')
    try:
        store.franklin_configure({'model': 'ollama:fixture-model:cloud', 'open': True, 'draft': ''})
        payload = {'tool': 'scout_film_notes', 'arguments': {'athlete_id': ATHLETE}}
        turns = iter([{'content': '', 'tool_calls': [{'function': {'name': 'desktop_action', 'arguments': {'action': 'gridiron_call', 'payload': payload}}}]},
                      {'content': 'Your film notes are ready.'}])
        seen, contents = [], []
        def adapter(messages, tools):
            contents.extend(message['content'] for message in messages)
            return next(turns)
        request = {'command': 'send', 'text': 'Show me my film notes.', 'request_id': str(uuid.uuid4()),
                   'environment': {'schema': 'yur.franklin.environment.v1', 'authority': deepcopy(HOST_AUTHORITY)}}
        result = handle(request, store=store, model_adapter=adapter, execute_desktop=lambda action, payload, metadata:
                        seen.append([action, payload]) or {'tool': 'scout_film_notes', 'kind': 'read', 'result': {'plays': 3}})
        print(json.dumps({'status': result['requests'][-1]['status'], 'seen': seen, 'integrity': store.verify_integrity()['ok'],
                          'addendum': any('YUR Athletics edition.' in content for content in contents)}))
    finally:
        store.close()'''


# A saved model that runs on this computer: the edition refuses the turn before it is accepted or a model is called.
LOCAL_TURN = '''import json, tempfile, uuid
from copy import deepcopy
from pathlib import Path
from foundry.commit_service import CommitService
from foundry.franklin_cli import handle
from foundry.work_desktop import HOST_AUTHORITY
import sys
from foundry import franklin_cli
SAMPLE_ROOT = json.load(sys.stdin)['root']
franklin_cli.edition_addendum.__defaults__ = (None, SAMPLE_ROOT)  # the committed sample, not editions/athletics.json
with tempfile.TemporaryDirectory() as folder:
    store = CommitService(Path(folder) / 'journal')
    try:
        store.franklin_configure({'model': 'ollama:llama3:latest', 'open': True, 'draft': ''})
        calls = []
        request = {'command': 'send', 'text': 'Hello Franklin.', 'request_id': str(uuid.uuid4()),
                   'environment': {'schema': 'yur.franklin.environment.v1', 'authority': deepcopy(HOST_AUTHORITY)}}
        try:
            handle(request, store=store, model_adapter=lambda messages, tools: calls.append(1) or {'content': 'x'}, execute_desktop=lambda *args: {})
            outcome = 'sent'
        except ValueError as error:
            outcome = str(error)
        print(json.dumps({'outcome': outcome, 'model_calls': len(calls), 'requests': len(store.franklin_snapshot().get('requests', []))}))
    finally:
        store.close()'''


def call(tool, arguments):
    return {'action': 'gridiron_call', 'payload': {'tool': tool, 'arguments': arguments}}


class DefaultDesktopTests(unittest.TestCase):
    def test_without_an_edition_franklin_has_no_gridiron_action_field_or_prompt(self):
        self.assertNotIn('YUR_EDITION', os.environ, 'run the default suite without YUR_EDITION')
        self.assertEqual(len(ACTIONS), 55)
        self.assertFalse(set(GRIDIRON_ACTIONS) & set(ACTIONS))
        self.assertEqual(HOST_AUTHORITY['actions'], list(ACTIONS))
        payload = catalog()[0]['input_schema']['properties']['payload']['properties']
        self.assertNotIn('tool', payload)
        self.assertNotIn('arguments', payload)
        self.assertNotIn('Gridiron', catalog()[0]['description'])
        for arguments in ({'action': 'gridiron_tools', 'payload': {}}, call('scout_card', {'athlete_id': ATHLETE})):
            with self.assertRaisesRegex(ValueError, 'Unsupported Desktop action'):
                validate_arguments(arguments)
        for value in ({}, {'YUR_EDITION': ''}, {'YUR_EDITION': 'unknown-edition'}, {'YUR_EDITION': 'Athletics'}):
            self.assertEqual(edition_addendum(value), '')
        accepted = {'id': str(uuid.uuid4()), 'model': 'ollama:fixture-model', 'environment': {'authority': deepcopy(HOST_AUTHORITY)},
                    'context': [], 'text': 'Show me my film study.'}
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('YUR_EDITION', None)
            instruction = compile_request(accepted)['messages'][0]['content']
        self.assertNotIn('Gridiron', instruction)
        self.assertTrue(instruction.endswith('state unavailable bindings honestly.'))
        # A host that drifted to the Athletics list is refused by the default Desktop's Python.
        drifted = deepcopy(HOST_AUTHORITY)
        drifted['actions'] += list(GRIDIRON_ACTIONS)
        with self.assertRaisesRegex(ValueError, 'authority envelope'):
            validate_rpc({'command': 'send', 'text': 'Show me my film.', 'request_id': str(uuid.uuid4()),
                          'environment': {'schema': 'yur.franklin.environment.v1', 'authority': drifted}})


class AthleticsAuthorityTests(unittest.TestCase):
    def test_python_tool_lists_name_the_admitted_gridiron_tools(self):
        self.assertEqual(GRIDIRON_ACTIONS, ('gridiron_tools', 'gridiron_call'))
        self.assertEqual(GRIDIRON_TOOLS, GRIDIRON_READ_TOOLS + GRIDIRON_WRITE_TOOLS + ('show_page',))
        self.assertEqual(len(GRIDIRON_READ_TOOLS), 11)
        self.assertEqual(GRIDIRON_WRITE_TOOLS, ('maxpreps_sync_now', 'draft_save', 'content_save', 'package_rebuild'))
        for excluded in ('email_send', 'page_publish', 'web_search', 'browser_open', 'browser_read', 'browser_act'):
            self.assertNotIn(excluded, GRIDIRON_TOOLS)

    @unittest.skipUnless(shutil.which('node'), 'Node is required for cross-language action parity')
    def test_host_and_python_authority_lists_stay_identical_and_in_order(self):
        # A drift fails every Franklin send (franklin_cli.validate_rpc compares the envelopes).
        desktop_python, desktop_node = child_python(PYTHON_LISTS, None), child_node(NODE_LISTS, None)
        athletics_python, athletics_node = child_python(PYTHON_LISTS), child_node(NODE_LISTS, 'athletics')
        self.assertEqual(desktop_python['actions'], desktop_node['actions'])
        self.assertEqual(athletics_python['actions'], athletics_node['actions'])
        self.assertEqual(athletics_python['authority'], athletics_python['actions'])
        self.assertEqual(athletics_python['actions'], desktop_python['actions'] + list(GRIDIRON_ACTIONS))
        for key in ('read', 'write', 'tools'):
            self.assertEqual(athletics_python[key], athletics_node[key], key)
        self.assertEqual(sorted(set(athletics_python['payload']) - set(desktop_python['payload'])), ['arguments', 'tool'])
        self.assertEqual(child_python(PYTHON_LISTS, 'unknown-edition')['actions'], desktop_python['actions'])

    def test_franklin_tool_catalog_stays_within_the_native_cap_with_gridiron(self):
        # One multiplexed desktop_action action, not one native tool per Gridiron tool (work_provider: 1..32).
        result = child_python(CATALOG)
        self.assertLessEqual(result['count'], 32)
        self.assertEqual(result['desktop'], 1)
        self.assertEqual(result['tool_enum'], list(GRIDIRON_TOOLS))
        self.assertEqual(result['arguments'], 'object')
        self.assertEqual(result['action_enum'][-2:], list(GRIDIRON_ACTIONS))
        self.assertTrue(result['describes'])

    def test_athletics_franklin_turn_commits_a_gridiron_call_under_the_host_authority(self):
        result = child_python(TURN, data={'root': SAMPLE_ROOT})
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['seen'], [['gridiron_call', {'tool': 'scout_film_notes', 'arguments': {'athlete_id': ATHLETE}}]])
        self.assertTrue(result['integrity'])
        self.assertTrue(result['addendum'])

    def test_athletics_validate_arguments_accepts_and_rejects_gridiron_payloads(self):
        allowed = [{'action': 'gridiron_tools', 'payload': {}}, call('scout_card', {'athlete_id': ATHLETE}),
                   call('scout_board', {'athlete_id': ATHLETE, 'division': 'FCS', 'limit': 25}),
                   call('scout_athlete', {'athlete_id': ATHLETE, 'brief': True}), call('scout_coaches', {}),
                   call('draft_save', DRAFT), call('content_save', {'athlete_id': ATHLETE, 'kind': 'bio', 'title': 'Bio', 'body': 'Line one\nline two'}),
                   call('maxpreps_sync_now', {'athlete_id': ATHLETE}), call('package_rebuild', {'athlete_id': ATHLETE}),
                   call('show_page', {'tab': 'film-study'}), call('show_page', {'tab': 'film-study', 'path': f'/player/{ATHLETE}?tab=film'}),
                   call('show_page', {'tab': 'my-card', 'path': '/coaches'})]
        denied = [{'action': 'gridiron_tools', 'payload': {'tool': 'scout_card'}},
                  {'action': 'gridiron_call', 'payload': {'tool': 'scout_card'}},
                  {'action': 'gridiron_call', 'payload': {'tool': 'scout_card', 'arguments': {}, 'confirmed': True}},
                  call('email_send', {'draft_id': 'fixture-draft'}), call('page_publish', {}), call('web_search', {'query': 'camps'}),
                  call('browser_open', {'url': 'https://example.com'}), call('shell', {}), call(7, {}),
                  call('scout_card', []), call('scout_card', 'athlete'), call('scout_card', {'athlete_id': {'nested': ATHLETE}}),
                  call('scout_card', {'athlete_id': [ATHLETE]}), call('scout_card', {'Athlete-Id': ATHLETE}),
                  call('scout_card', {'athlete_id': 'x\x00'}), call('scout_card', {'athlete_id': None}),
                  call('scout_coaches', {'query': 'x' * 20001}), call('scout_coaches', {f'field_{index}': 'x' for index in range(33)}),
                  call('draft_save', {**DRAFT, 'body': 'x' * 33000}),
                  call('show_page', {}), call('show_page', {'tab': 'Film Study'}), call('show_page', {'tab': 'film-study', 'note': 'extra'})]
        denied += [call('show_page', {'tab': 'my-card', 'path': value}) for value in
                   ('//evil.example/x', 'http://evil.example/', 'player', '/x\\y', '/x#frag', '/a b', '/x\n', '/' + 'x' * 600, 5,
                    # Gridiron's /api/ routes return whole records (family contacts); show_page opens pages only.
                    '/api/athletes', '/api/athletes/other-athlete/drafts', f'/api/athletes/{ATHLETE}', '/API/athletes', '/api', '/api?x=1',
                    '/coaches?division=fbs', f'/player/{ATHLETE}?tab=film&x=1', '/a/b/c', f'/player/{ATHLETE}/')]
        results = child_python(VALIDATE, data=allowed + denied)
        self.assertEqual(results[:len(allowed)], [True] * len(allowed))
        self.assertEqual(results[len(allowed):], [None] * len(denied))


class AthleticsPromptTests(unittest.TestCase):
    def test_addendum_names_the_athlete_origin_sections_and_gridiron_rules(self):
        text = edition_addendum({'YUR_EDITION': 'athletics'})
        athlete, origin = MANIFEST['athlete'], MANIFEST['gridiron']['origin']
        for phrase in (athlete['display_name'], athlete['position'], f'athlete_id "{ATHLETE}"', str(athlete['class_of']), origin,
                       'gridiron_call', 'gridiron_tools', 'show_page', 'browser_read', 'Reach pages through show_page',
                       f'/player/{ATHLETE}?tab=<name>', 'browser_inspect and then browser_click only when show_page cannot reach a page',
                       "Do not open Gridiron /api/ addresses or other athletes' pages, with show_page or browser_navigate",
                       "need the user's yes in the native dialog", 'send nothing', 'untrusted facts', *GRIDIRON_WRITE_TOOLS):
            self.assertIn(phrase, text)
        self.assertNotIn('full Gridiron URL', text, 'Franklin is no longer told to navigate Gridiron by raw URL')
        # The sport and position come from the manifest; Gridiron serves every ?tab= section now.
        self.assertIn(f"{athlete['display_name']}, {athlete['sport']} {athlete['position']} ({athlete['position_code']}), throws {athlete['throws']}", text)
        self.assertNotIn("default tab", text)
        self.assertNotIn('until Gridiron reads', text)
        self.assertTrue(text.startswith('\n\nYUR Athletics edition. '))
        self.assertNotIn('YUR AI Athletics', text)
        for tab in MANIFEST['tabs']:
            if tab['kind'] == 'gridiron':
                self.assertIn(f"{tab['label']} (tab {tab['id']}): {origin}{tab['path']}", text)
            else:
                self.assertNotIn(f"(tab {tab['id']})", text)

    def test_compile_request_appends_the_addendum_only_for_athletics(self):
        accepted = {'id': str(uuid.uuid4()), 'model': 'ollama:fixture-model', 'environment': {'authority': deepcopy(HOST_AUTHORITY)},
                    'context': [], 'text': 'Show me my film study.'}
        with patch.dict(os.environ, {'YUR_EDITION': 'athletics'}):
            instruction = compile_request(accepted)['messages'][0]['content']
        self.assertTrue(instruction.endswith(edition_addendum({'YUR_EDITION': 'athletics'})))
        self.assertIn('state unavailable bindings honestly.\n\nYUR Athletics edition.', instruction)

    def test_a_manifest_that_does_not_read_back_fails_closed(self):
        def broken(change):
            manifest = deepcopy(MANIFEST)
            change(manifest)
            return manifest
        cases = {'missing': None, 'not json': '{', 'duplicate key': '{"edition_id": "athletics", "edition_id": "athletics"}',
                 'array': [], 'oversized': {'padding': 'x' * 70000},
                 'schema': broken(lambda m: m.update({'$schema': 'other'})),
                 'edition id': broken(lambda m: m.update({'edition_id': 'other'})),
                 'localhost origin': broken(lambda m: m['gridiron'].update({'origin': 'http://localhost:3000'})),
                 'remote origin': broken(lambda m: m['gridiron'].update({'origin': 'https://gridiron.example'})),
                 'protocol-relative path': broken(lambda m: m['tabs'][1].update({'path': '//evil.example/x'})),
                 'fragment path': broken(lambda m: m['tabs'][1].update({'path': '/player#x'})),
                 'api path': broken(lambda m: m['tabs'][1].update({'path': '/api/athletes'})),
                 'api path in capitals': broken(lambda m: m['tabs'][1].update({'path': '/API/athletes'})),
                 'athlete name control': broken(lambda m: m['athlete'].update({'display_name': 'Line\nbreak'})),
                 'athlete id': broken(lambda m: m['athlete'].update({'id': '../other'})),
                 'class year': broken(lambda m: m['athlete'].update({'class_of': str(m['athlete']['class_of'])})),
                 'sport in capitals': broken(lambda m: m['athlete'].update({'sport': 'Football'})),
                 'sport with a space': broken(lambda m: m['athlete'].update({'sport': 'track field'})),
                 'sport too long': broken(lambda m: m['athlete'].update({'sport': 'a' * 33})),
                 'sport missing': broken(lambda m: m['athlete'].pop('sport')),
                 'sport not text': broken(lambda m: m['athlete'].update({'sport': 7})),
                 'section id': broken(lambda m: m['tabs'][2].update({'id': 'Film Study'})),
                 'no sections': broken(lambda m: m.update({'tabs': []}))}
        for name, manifest in cases.items():
            with self.subTest(case=name), tempfile.TemporaryDirectory() as folder:
                if manifest is not None:
                    (Path(folder) / 'athletics.json').write_text(manifest if isinstance(manifest, str) else json.dumps(manifest), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'edition manifest is unavailable or invalid'):
                    edition_addendum({'YUR_EDITION': 'athletics'}, root=folder)
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'athletics.json').write_text(json.dumps(MANIFEST), encoding='utf-8')
            self.assertEqual(edition_addendum({'YUR_EDITION': 'athletics'}, root=folder), edition_addendum({'YUR_EDITION': 'athletics'}))

    def test_the_addendum_names_any_sport_and_position_from_the_manifest(self):
        manifest = deepcopy(MANIFEST)
        manifest['athlete'].update({'sport': 'track-and-field', 'position': 'Sprinter', 'position_code': 'SPR', 'throws': 'right'})
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'athletics.json').write_text(json.dumps(manifest), encoding='utf-8')
            text = edition_addendum({'YUR_EDITION': 'athletics'}, root=folder)
        self.assertIn(f"{manifest['athlete']['display_name']}, track and field Sprinter (SPR), throws right", text)
        self.assertNotRegex(text.lower(), r'football|quarterback|\bqb\b')
        # The addendum code itself names no sport or position.
        source = (ROOT / 'foundry' / 'franklin_cli.py').read_text(encoding='utf-8')
        addendum = source[source.index('def edition_addendum('):source.index('def compile_request(')]
        self.assertNotRegex(addendum.lower(), r'football|quarterback|\bqb\b')

    def test_a_sport_without_a_throwing_hand_names_none(self):
        manifest = deepcopy(MANIFEST)
        manifest['athlete'].update({'sport': 'swimming', 'position': 'Freestyle', 'position_code': 'FR'})
        manifest['athlete'].pop('throws')
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'athletics.json').write_text(json.dumps(manifest), encoding='utf-8')
            text = edition_addendum({'YUR_EDITION': 'athletics'}, root=folder)
            self.assertIn(f"{manifest['athlete']['display_name']}, swimming Freestyle (FR), class of {manifest['athlete']['class_of']}", text)
            self.assertNotIn('throws', text)
            manifest['athlete']['throws'] = 'both'
            (Path(folder) / 'athletics.json').write_text(json.dumps(manifest), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'edition manifest is unavailable or invalid'):
                edition_addendum({'YUR_EDITION': 'athletics'}, root=folder)


class AthleticsModelTests(unittest.TestCase):
    """YUR Athletics runs Franklin on Ollama Cloud only; the Desktop keeps every model."""

    def test_the_edition_refuses_a_model_on_this_computer(self):
        edition = {'YUR_EDITION': 'athletics'}
        for model in ('ollama:deepseek-v4-pro:cloud', 'ollama:qwen3.5:397b-cloud', 'deepseek-v4-pro:cloud', 'openai:dedicated-model'):
            with self.subTest(model=model):
                edition_model_check(model, edition)
        for model in ('ollama:llama3:latest', 'ollama:qwen2.5vl:3b', 'llama3.1:8b', 'ollama:gemma3:12b', 'ollama:cloud', 'ollama:cloudy:latest'):
            with self.subTest(model=model), self.assertRaisesRegex(ValueError, 'Ollama Cloud models only'):
                edition_model_check(model, edition)
        for environ in ({}, {'YUR_EDITION': ''}, {'YUR_EDITION': 'other'}):
            edition_model_check('ollama:llama3:latest', environ)

    def test_an_athletics_turn_on_a_local_model_is_refused_before_any_model_call(self):
        result = child_python(LOCAL_TURN, data={'root': SAMPLE_ROOT})
        self.assertIn('Ollama Cloud models only', result['outcome'])
        self.assertEqual([result['model_calls'], result['requests']], [0, 0])

    def test_the_athletics_launchers_default_is_a_cloud_model_the_check_accepts(self):
        launcher = (ROOT / 'Start YUR AI Athletics.cmd').read_text(encoding='utf-8')
        default = launcher.split('set "YUR_FRANKLIN_MODEL=', 1)[1].split('"', 1)[0]
        edition_model_check(default, {'YUR_EDITION': 'athletics'})
        self.assertTrue(default.endswith(':cloud'), default)


if __name__ == '__main__':
    unittest.main()
