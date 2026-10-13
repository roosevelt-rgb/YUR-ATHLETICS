"""Typed Desktop browser/service/surface contracts; no providers or native launch."""
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import unittest

from foundry.work_desktop import ACTIONS, HOST_AUTHORITY, catalog, validate_arguments


ROOT = Path(__file__).resolve().parents[1]
DOCUMENT = '01234567-89ab-4cde-8fab-0123456789ab'
SHA = 'a' * 64
ID = 'b' * 32
TARGET = {'document_id': DOCUMENT, 'ref': 'c1'}
PACK = {'pack_id': 'fixture:pack-v1', 'expected_content_sha256': SHA}
OPTIONS = {'name': 'Fixture worker', 'goal': 'Perform the reviewed local work.\nReport results.',
           'model': 'fixture-model', 'mode': 'work', 'trigger': {'kind': 'manual'}, 'maxRuns': 1, 'maxFailuresInRow': 1}
ASSIGN = {'code': 'quantity_role', 'expected_sha256': SHA, 'session_id': 'rc6:owned-session', 'text': 'Perform this task.'}
REQUEST = {'composition_id': ID, 'lyrics_id': SHA, 'provider': 'local-score'}


def arguments(action, payload=None):
    return {'action': action, 'payload': {} if payload is None else payload}


class FranklinDesktopCapabilityTests(unittest.TestCase):
    def assertAllowed(self, action, payload=None):
        supplied = arguments(action, payload)
        original = deepcopy(supplied)
        checked = validate_arguments(supplied)
        self.assertEqual(checked, original)
        self.assertIsNot(checked, supplied)
        self.assertEqual(supplied, original)

    def assertDenied(self, action, payload):
        with self.assertRaises(ValueError):
            validate_arguments(arguments(action, payload))

    def test_browser_exact_observed_document_control_and_value_contract(self):
        self.assertAllowed('browser_inspect')
        self.assertAllowed('browser_click', TARGET)
        self.assertAllowed('browser_fill', {**TARGET, 'ref': 'c80', 'value': ''})
        self.assertAllowed('browser_fill', {**TARGET, 'value': "Literal '); text\n\tsecond line"})
        self.assertAllowed('browser_select', {**TARGET, 'value': 'observed-option'})
        self.assertAllowed('browser_fill', {**TARGET, 'value': '\U0001f600' * 4000})
        rejected = [('browser_inspect', {'selector': 'button'}), ('browser_click', {**TARGET, 'value': 'extra'}),
                    ('browser_fill', TARGET), ('browser_click', {**TARGET, 'document_id': DOCUMENT.upper()}),
                    ('browser_click', {**TARGET, 'ref': 'c81'}), ('browser_click', {**TARGET, 'ref': 'c0'}),
                    ('browser_click', {**TARGET, 'ref': '#send'}), ('browser_click', {**TARGET, 'document_id': ID}),
                    ('browser_fill', {**TARGET, 'value': 'x' * 8001}),
                    ('browser_fill', {**TARGET, 'value': '\U0001f600' * 4001}),
                    ('browser_fill', {**TARGET, 'value': '\u7a3f' * 5500}),
                    ('browser_fill', {**TARGET, 'value': 'text\x0bother'}),
                    ('browser_select', {**TARGET, 'value': ['option']}),
                    ('browser_click', {**TARGET, 'script': 'arbitrary()'})]
        for action, payload in rejected:
            with self.subTest(action=action, keys=list(payload)):
                self.assertDenied(action, payload)

    def test_surface_manual_deploy_export_and_owned_role_assignment(self):
        self.assertAllowed('marketplace_deploy', {**PACK, 'options': OPTIONS})
        self.assertAllowed('marketplace_deploy', {**PACK, 'options': {**OPTIONS, 'mode': 'code', 'maxRuns': 500, 'maxFailuresInRow': 20}})
        self.assertAllowed('marketplace_export', PACK)
        self.assertAllowed('workforce_assign', ASSIGN)
        for key, value in [('root', 'D:/unselected'), ('permissions', ['all']), ('active', True)]:
            self.assertDenied('marketplace_deploy', {**PACK, 'options': {**OPTIONS, key: value}})
        for key, value in [('name', ' '), ('goal', ''), ('model', 'line\nmodel'), ('mode', 'shell'),
                           ('trigger', {'kind': 'interval', 'seconds': 60}), ('trigger', {'kind': 'manual', 'cron': '*'}),
                           ('maxRuns', True), ('maxRuns', 501), ('maxFailuresInRow', 0), ('goal', '\u7a3f' * 23000)]:
            with self.subTest(key=key):
                self.assertDenied('marketplace_deploy', {**PACK, 'options': {**OPTIONS, key: value}})
        for payload in [{**PACK, 'expected_content_sha256': 'A' * 64}, {**PACK, 'pack_id': '..fixture'}, {**PACK, 'path': 'D:/export'},
                        {**PACK, 'options': OPTIONS}]:
            self.assertDenied('marketplace_export', payload)
        for key, value in [('code', 'Uppercase'), ('code', 'role-name'), ('session_id', '../foreign'),
                           ('expected_sha256', 'missing'), ('text', ' '), ('text', 'x' * 24001),
                           ('text', '\U0001f600' * 12001), ('text', '\x00')]:
            self.assertDenied('workforce_assign', {**ASSIGN, key: value})
        self.assertDenied('workforce_assign', {**ASSIGN, 'approval': True})

    def test_service_read_and_document_shapes_are_typed(self):
        for action in ('services_status', 'music_state', 'nova_open', 'music_catalog'):
            self.assertAllowed(action)
            self.assertDenied(action, {'endpoint': 'http://127.0.0.1:1234'})
        self.assertAllowed('music_catalog', {'kind': 'variant', 'limit': 50, 'offset': 10000})
        self.assertAllowed('music_document', {'kind': 'composition', 'data': {'title': 'Fixture\ncomposition'}})
        self.assertAllowed('music_document', {'kind': 'lyrics', 'data': {'composition_id': ID, 'text': ''}})
        self.assertAllowed('music_document', {'kind': 'lyrics', 'data': {'composition_id': SHA, 'text': 'Owned fixture lyrics\nsecond line'}})
        for action in ('music_status', 'music_cancel', 'music_resume'):
            self.assertAllowed(action, {'job_id': ID})
            self.assertDenied(action, {'job_id': SHA})
            self.assertDenied(action, {'job_id': ID, 'approved': True})
        for payload in ({'kind': []}, {'kind': 'credentials'}, {'offset': -1}, {'limit': True}, {'limit': 51}):
            self.assertDenied('music_catalog', payload)
        for payload in ({'kind': 'project', 'data': {'title': 'No'}}, {'kind': 'composition', 'data': {'title': ' '}},
                        {'kind': 'composition', 'data': {'title': 'x' * 161}},
                        {'kind': 'lyrics', 'data': {'composition_id': ID, 'text': 'x' * 20001}},
                        {'kind': 'lyrics', 'data': {'composition_id': ID, 'text': '\U0001f600' * 18000}},
                        {'kind': 'lyrics', 'data': {'composition_id': ID, 'text': '\x00'}},
                        {'kind': 'lyrics', 'data': {'composition_id': ID, 'text': 'Fixture', 'rights_attested': True}}):
            self.assertDenied('music_document', payload)

    def test_music_generation_separates_provider_request_from_human_authority(self):
        self.assertAllowed('music_generate', {'request': REQUEST})
        complete = {**REQUEST, 'variants': 4, 'duration': 300, 'tempo': 220, 'seed': 2147483647,
                    'instrumental': False, 'private': True, 'mode': 'custom', 'style': 'Fixture', 'genre': '',
                    'mood': '', 'voice': '', 'harmonies': '', 'negative_tags': '', 'model': '',
                    'song_description': 'Fixture composition', 'style_weight': 0.5, 'creativity': 1}
        self.assertAllowed('music_generate', {'request': complete})
        self.assertAllowed('music_generate', {'request': {**REQUEST, 'provider': 'fixture-cloud', 'private': False}})
        self.assertAllowed('music_generate', {'request': {**REQUEST, 'style': '\U0001f600' * 1000}})
        for key, value in [('provider', 'https://provider.example'), ('composition_id', 'not-observed'),
                           ('variants', True), ('variants', 5), ('duration', 3), ('tempo', 221), ('seed', -1),
                           ('private', 0), ('instrumental', 'false'), ('mode', 'advanced'), ('style', 'x' * 1001),
                           ('model', 'x' * 81), ('song_description', 'x' * 3001), ('genre', '\x00'),
                           ('style_weight', True), ('style_weight', float('nan')), ('creativity', float('inf')),
                           ('style_weight', -0.1), ('creativity', 1.1), ('rights_attested', True), ('external_approved', True),
                           ('idempotency_key', ID), ('endpoint', 'http://127.0.0.1:1234')]:
            with self.subTest(key=key):
                self.assertDenied('music_generate', {'request': {**REQUEST, key: value}})
        for private in (None, True, 0):
            request = {**REQUEST, 'provider': 'fixture-cloud'}
            if private is not None:
                request['private'] = private
            self.assertDenied('music_generate', {'request': request})
        self.assertDenied('music_generate', {'request': REQUEST, 'confirmation': {'confirmed': True}})

    def test_music_exports_exact_distinct_documents_and_never_accepts_a_path(self):
        self.assertAllowed('music_export', {'variant_ids': [ID, SHA]})
        for values in ([], [ID, ID], [ID] * 9, [ID, []], [ID.upper()], 'variant'):
            self.assertDenied('music_export', {'variant_ids': values})
        self.assertDenied('music_export', {'variant_ids': [ID], 'path': 'D:/export.zip'})

    def test_music_draft_is_flat_preparation_with_host_owned_identity(self):
        self.assertAllowed('music_draft', {'mode': 'simple'})
        self.assertAllowed('music_draft', {'mode': 'custom', 'description': '', 'lyrics': 'Exact words\nsecond line',
                                         'title': 'Fixture song', 'style': 'Warm', 'instrumental': False, 'provider': 'suno-api', 'model': 'V6'})
        self.assertAllowed('music_draft', {'mode': 'custom', 'lyrics': '\U0001f600' * 5000})
        self.assertAllowed('open_view', {'view': 'music'})
        for payload in ({}, {'mode': 'work'}, {'mode': []}, {'mode': 'simple', 'request_id': DOCUMENT},
                        {'draft': {'mode': 'simple'}}, {'mode': 'simple', 'tags': ['Pop']}, {'mode': 'simple', 'confirmed': True}):
            self.assertDenied('music_draft', payload)
        for key, value in [('description', 'x' * 3001), ('lyrics', 'x' * 5001), ('title', 'x' * 81), ('style', 'x' * 1001),
                           ('provider', ''), ('provider', 'https://provider'), ('provider', 'x' * 101), ('model', 'x' * 81),
                           ('model', 'model\nname'), ('instrumental', 0), ('lyrics', '\x00'), ('title', 123)]:
            with self.subTest(key=key):
                self.assertDenied('music_draft', {'mode': 'simple', key: value})

    def test_unreal_actions_accept_only_typed_observation_or_reviewed_camera_inputs(self):
        self.assertAllowed('open_view', {'view': 'unreal'})
        for action in ('unreal_status', 'unreal_capture'):
            self.assertAllowed(action)
            self.assertDenied(action, {'project_file': 'D:/unselected/project.uproject'})
        for kind in ('level', 'selection', 'camera', 'assets'):
            self.assertAllowed('unreal_inspect', {'kind': kind})
        for kind in ('job', 'actors', [], None):
            self.assertDenied('unreal_inspect', {'kind': kind})
        camera = {'location': {'x': -10000000, 'y': 0.5, 'z': 10000000}, 'rotation': {'pitch': -360, 'yaw': 360, 'roll': 0}}
        self.assertAllowed('unreal_camera', camera)
        for field, axis, values in [('location', 'x', [True, '1', 10000001, float('nan'), float('inf'), 10 ** 1000]),
                                    ('rotation', 'yaw', [False, -361, 360.01, float('-inf')])]:
            for value in values:
                with self.subTest(field=field, value=str(value)[:25]):
                    self.assertDenied('unreal_camera', {**camera, field: {**camera[field], axis: value}})
        self.assertDenied('unreal_camera', {**camera, 'location': {'x': 0, 'y': 0}})
        self.assertDenied('unreal_camera', {**camera, 'rotation': {**camera['rotation'], 'scale': 1}})
        self.assertDenied('unreal_camera', {**camera, 'approved': True})

    def test_catalog_exposes_new_fields_without_exposing_host_grants(self):
        tool = catalog()[0]
        schema = tool['input_schema']['properties']
        props = schema['payload']['properties']
        self.assertEqual(schema['action']['enum'], list(ACTIONS))
        self.assertEqual(HOST_AUTHORITY['actions'], list(ACTIONS))
        for field in ('document_id', 'ref', 'value', 'kind', 'data', 'request', 'variant_ids', 'options', 'expected_content_sha256',
                      'mode', 'lyrics', 'title', 'style', 'instrumental', 'location', 'rotation'):
            self.assertIn(field, props)
        self.assertFalse(props['request']['additionalProperties'])
        self.assertFalse(props['options']['additionalProperties'])
        self.assertFalse(props['options']['properties']['trigger']['additionalProperties'])
        self.assertNotIn('rights_attested', props['request']['properties'])
        self.assertNotIn('external_approved', props['request']['properties'])
        self.assertNotIn('root', props['options']['properties'])
        self.assertEqual(tool['limits']['service_argument_bytes'], 65536)
        self.assertEqual(tool['limits']['browser_controls'], 80)
        self.assertEqual(len(ACTIONS), 55)
        self.assertEqual(props['mode']['enum'], ['simple', 'custom'])
        self.assertIn('level', props['kind']['enum'])
        self.assertIn('variant', props['kind']['enum'])
        self.assertFalse(props['location']['additionalProperties'])
        self.assertFalse(props['rotation']['additionalProperties'])
        self.assertNotIn('request_id', props)

    @unittest.skipUnless(shutil.which('node'), 'Node is required for cross-language action parity')
    def test_python_actions_equal_the_actual_host_order(self):
        result = subprocess.run(['node', '-e', "process.stdout.write(JSON.stringify(require('./src/franklin-host').ACTIONS))"],
                                cwd=ROOT, check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(list(ACTIONS), json.loads(result.stdout))


if __name__ == '__main__':
    unittest.main()
