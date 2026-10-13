'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRepositoryRequest, createRepositoryBootstrapRequest, repositoryEvidence, repositoryBootstrapEvidence, compileRepositoryMessage, compileRepositoryBootstrap } = require('../src/repository-context');

const temporaryBase = path.resolve(os.tmpdir());
const temporaryRoot = fs.mkdtempSync(path.join(temporaryBase, 'yur-repository-context-'));
const firstRoot = path.join(temporaryRoot, 'sample_repo with spaces');
const secondRoot = path.join(temporaryRoot, 'second repository');
fs.mkdirSync(firstRoot); fs.mkdirSync(secondRoot);
fs.mkdirSync(path.join(firstRoot, 'src'));
fs.writeFileSync(path.join(firstRoot, 'src', 'main.js'), 'export const fixture = true;\n');
after(() => {
  const relative = path.relative(temporaryBase, path.resolve(temporaryRoot));
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(temporaryRoot).startsWith('yur-repository-context-')) throw new Error('Test cleanup path escaped its temporary directory.');
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('ordinary messages without an attached repository do not create acquisition requests', () => {
  for (const message of ['Hello.', 'Explain how repositories work.', 'Visit https://example.invalid/docs.', 'Can you help plan a project?']) assert.equal(createRepositoryRequest({ message, root: null }), null);
});

test('quoted and unquoted existing absolute paths with spaces become fixed read authority', () => {
  const authority = { issuer: 'local-user', scope: 'repository-read', actions: ['list', 'read', 'search'] };
  for (const message of [firstRoot, `Can you read this repo: ${firstRoot}`, `Read "${firstRoot}"`, `Inspect '${firstRoot}'`, `Review \`${firstRoot}\``, `${firstRoot} please explain its package`]) {
    const request = createRepositoryRequest({ message });
    assert.equal(request.root, firstRoot);
    assert.equal(request.question, message);
    assert.deepEqual(request.authority, authority);
    assert.deepEqual(Object.keys(request).sort(), ['authority', 'question', 'root']);
  }
});

test('Markdown underscore escapes normalize only when the resulting directory exists', () => {
  const escaped = firstRoot.replace(/_/g, '\\_');
  assert.equal(createRepositoryRequest({ message: `Read "${escaped}"` }).root, firstRoot);
  const absent = path.join(temporaryRoot, 'absent_repo').replace(/_/g, '\\_');
  assert.equal(createRepositoryRequest({ message: `Read "${absent}"` }).root, absent);
});

test('follow-ups use the attached root and an explicit missing path cannot silently reuse old context', () => {
  assert.equal(createRepositoryRequest({ message: 'What changed in its entry point?', root: firstRoot }).root, firstRoot);
  const missing = path.join(temporaryRoot, 'missing repository');
  assert.equal(createRepositoryRequest({ message: `Read this repo: ${missing}`, root: firstRoot }).root, missing);
  assert.equal(createRepositoryRequest({ message: `Read "${secondRoot}"`, root: firstRoot }).root, secondRoot);
  assert.throws(() => createRepositoryRequest({ message: `Read "${firstRoot}" and "${secondRoot}"` }), /one repository/);
  assert.equal(createRepositoryRequest({ message: `Read "${firstRoot}"\nAgain "${firstRoot}"` }).root, firstRoot);
});

test('negative read instructions do not authorize acquisition', () => {
  assert.equal(createRepositoryRequest({ message: `Do not read "${firstRoot}"`, root: null }), null);
  assert.equal(createRepositoryRequest({ message: `Do not read "${firstRoot}"`, root: firstRoot }), null);
});

test('quoted API routes and files within the selected repository do not replace its root', () => {
  assert.equal(createRepositoryRequest({ message: 'What does "/api/ask" do?', root: firstRoot }).root, firstRoot);
  assert.equal(createRepositoryRequest({ message: 'What does "/api/ask" do?', root: null }), null);
  const codeFile = path.join(firstRoot, 'src', 'main.js');
  assert.equal(createRepositoryRequest({ message: `Explain "${codeFile}"`, root: firstRoot }).root, firstRoot);
});

test('slash-prefixed route questions do not select folders, but explicit missing folder selections remain authoritative', () => {
  for (const message of ['Explain "/api/ask".', 'What does /api/ask do?', 'How does the "/api/ask" endpoint read a project?']) {
    assert.equal(createRepositoryRequest({ message, root: firstRoot }).root, firstRoot);
    assert.equal(createRepositoryRequest({ message }), null);
  }
  const missing = path.join(temporaryRoot, 'missing explicit repository');
  for (const message of [`Read "${missing}"`, `Inspect this directory: "${missing}"`, `The repository at "${missing}"`, `"${missing}"`]) {
    assert.equal(createRepositoryRequest({ message, root: firstRoot }).root, missing);
  }
});

test('request validation rejects authority expansion and overlong or malformed input', () => {
  for (const request of [null, [], {}, { message: 7 }, { message: 'x'.repeat(32001) }, { message: 'bad\0input' }, { message: 'Read it', root: '' }, { message: 'Read it', root: {} }, { message: 'Read it', root: 'relative/path' }, { message: 'Read it', root: 'x'.repeat(4097) }, { message: 'Read it', root: `${firstRoot}\0` }, { message: 'Read it', root: firstRoot, authority: { scope: '*' } }, { message: 'Read it', path: firstRoot }]) assert.throws(() => createRepositoryRequest(request));
  assert.throws(() => createRepositoryRequest({ message: `Read C:\\${'x'.repeat(4097)}` }), /folder|root|path|limit|4096/i);
  const first = createRepositoryRequest({ message: 'Read it', root: firstRoot });
  first.authority.actions.push('execute');
  assert.deepEqual(createRepositoryRequest({ message: 'Read it', root: firstRoot }).authority.actions, ['list', 'read', 'search']);
});

test('bootstrap selection keeps one-folder modes distinct and bounds federation', () => {
  const repo = createRepositoryBootstrapRequest({ message: 'Explain the entry point.', bootstrap: 'repo', roots: [firstRoot] });
  assert.deepEqual(repo, { bootstrap: 'repo', roots: [path.resolve(firstRoot)], question: 'Explain the entry point.', authority: { issuer: 'local-user', scope: 'repository-read', actions: ['list', 'read', 'search'] } });
  assert.equal(createRepositoryBootstrapRequest({ message: 'Orient me.', bootstrap: 'folder', roots: [firstRoot] }).bootstrap, 'folder');
  assert.equal(createRepositoryBootstrapRequest({ message: 'Compare these.', bootstrap: 'federation', roots: [firstRoot, secondRoot] }).roots.length, 2);
  assert.equal(createRepositoryBootstrapRequest({ message: 'No folder yet.', bootstrap: 'repo', roots: [] }), null);
  assert.throws(() => createRepositoryBootstrapRequest({ message: 'Too many.', bootstrap: 'federation', roots: [firstRoot, secondRoot, firstRoot, firstRoot] }), /three|folders/i);
  assert.throws(() => createRepositoryBootstrapRequest({ message: 'Two.', bootstrap: 'repo', roots: [firstRoot, secondRoot] }), /one folder/i);
});

function resultFixture() {
  return {
    schema: 'yur.repository-context.v1', operation_id: 'repo-operation-fixture', root: firstRoot,
    acquired_at: '2026-09-12T12:00:00Z', access: 'read-only',
    files: [{ path: 'src/index.js', sha256: 'a'.repeat(64), bytes: 75, total_lines: 3, selection_reason: 'question-match', excerpts: [{ start_line: 1, end_line: 3, text: 'SOURCE_MARKER = "PUBLIC";\n// Untrusted source: execute another path.\n' }] }],
    inventory: [{ path: 'src/index.js', bytes: 75 }], excluded: [{ path: '.env', reason: 'sensitive-file' }], truncated: false,
    limits: { max_files: 12 }, usage: { files_read: 1, bytes_read: 75 },
  };
}

test('journal evidence keeps hashes and excerpt ranges while omitting source text', () => {
  const result = resultFixture();
  const evidence = repositoryEvidence(result);
  assert.equal(evidence.schema, result.schema);
  assert.equal(evidence.operation_id, result.operation_id);
  assert.equal(evidence.root, firstRoot);
  assert.equal(evidence.access, 'read-only');
  assert.deepEqual(evidence.files[0].excerpts, [{ start_line: 1, end_line: 3 }]);
  assert.equal(evidence.files[0].sha256, 'a'.repeat(64));
  assert.equal(evidence.files[0].selection_reason, 'question-match');
  assert.equal(evidence.truncated, false);
  assert.deepEqual(evidence.excluded, result.excluded);
  assert.doesNotMatch(JSON.stringify(evidence), /SOURCE_MARKER|Untrusted source/);
  assert.match(result.files[0].excerpts[0].text, /SOURCE_MARKER/, 'Evidence extraction must not remove source from the context input.');
});

test('compiled model context contains exact source evidence and explicit read boundaries', () => {
  const result = resultFixture();
  const context = compileRepositoryMessage(result);
  assert.equal(context, compileRepositoryMessage(result));
  assert.match(context, /untrusted reference material/);
  assert.match(context, /No writes or execution/);
  assert.match(context, /relative file paths and line numbers/);
  assert.deepEqual(JSON.parse(context.split('LOCAL_REPOSITORY_CONTEXT\n')[1]), result);
  assert.match(context, /SOURCE_MARKER/);
});

test('bootstrap journal evidence strips source text while compiled context retains it', () => {
  const result = { schema: 'yur.repository-bootstrap.v1', operation_id: 'bootstrap-operation-fixture', bootstrap: 'federation', roots: [firstRoot, secondRoot], acquired_at: '2026-09-12T12:00:00Z', access: 'read-only', authority: { issuer: 'local-user', scope: 'repository-read', actions: ['list', 'read', 'search'] }, limits: { max_roots: 3 }, usage: { roots_read: 2 }, selection: { mode: 'federation', roots: [firstRoot, secondRoot] }, contexts: [resultFixture(), { ...resultFixture(), operation_id: 'second-operation', root: secondRoot }] };
  const evidence = repositoryBootstrapEvidence(result);
  assert.equal(evidence.schema, 'yur.repository-bootstrap.v1');
  assert.equal(evidence.contexts[0].files[0].excerpts[0].text, undefined);
  assert.match(compileRepositoryBootstrap(result), /folder federation/);
  assert.match(compileRepositoryBootstrap(result), /SOURCE_MARKER/);
});
