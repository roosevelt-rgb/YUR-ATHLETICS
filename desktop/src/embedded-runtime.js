'use strict';
// Read-only verification of the assembler's fixed sibling Python resource.
// No manifest value is used as a command, argument, search path or environment.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MARKER = '.desktop-distribution.json';
const MAX_FILES = 10000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const PTH_CONTENT = 'python314.zip\n.\nLib/site-packages\n../app\n';
const ARCHIVE = Object.freeze({ name: 'python-3.14.7-embed-amd64.zip', bytes: 12673227, sha256: 'd297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15', source_url: 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip' });
const HASH = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys;
const hash = value => createHash('sha256').update(value).digest('hex');
function invalid(message) { const error = new Error('Bundled Python verification failed: ' + message); error.code = 'EMBEDDED_PYTHON_INVALID'; return error; }
const key = value => value.normalize('NFC').toLowerCase();
function samePath(left, right) { return process.platform === 'win32' ? key(path.resolve(left)) === key(path.resolve(right)) : path.resolve(left) === path.resolve(right); }
function lstat(target) { try { return fs.lstatSync(target, { bigint: true }); } catch { throw invalid('a required resource is missing or unreadable.'); } }
function noLinks(target, directory = false) {
  const absolute = path.resolve(target), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = lstat(current);
    if (info.isSymbolicLink()) throw invalid('symbolic links or junctions are not allowed in packaged resources.');
    if (current !== absolute && !info.isDirectory()) throw invalid('a resource parent is not a directory.');
  }
  // Ancestors are checked with lstat; resolving the actual target also verifies
  // the complete path without requiring unrelated ancestor-directory handles.
  let actual; try { actual = fs.realpathSync.native(absolute); } catch { throw invalid('a packaged path cannot be resolved.'); }
  if (!samePath(actual, absolute)) throw invalid('a packaged resource resolves through another location.');
  const info = lstat(absolute);
  if (directory ? !info.isDirectory() : !info.isFile()) throw invalid('a packaged resource has an unexpected file type.');
  if (!directory && info.nlink !== 1n) throw invalid('hard-linked runtime payloads are not allowed.');
  return info;
}
function signature(info) { return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'); }
function readFile(target, maximum, expected = null) {
  const before = noLinks(target);
  if (before.size > BigInt(maximum) || before.size < 0n || (expected !== null && before.size !== BigInt(expected))) throw invalid('a resource exceeds its declared size or byte limit.');
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || signature(opened) !== signature(before)) throw invalid('a resource changed while it was being opened.');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (!count) throw invalid('a resource ended before its declared size.'); offset += count; }
    if (signature(fs.fstatSync(descriptor, { bigint: true })) !== signature(before) || signature(noLinks(target)) !== signature(before)) throw invalid('a resource changed during verification.');
    return bytes;
  } catch (error) { if (error.code === 'EMBEDDED_PYTHON_INVALID') throw error; throw invalid('a resource could not be read safely.'); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function json(bytes) {
  let source, value;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(source); }
  catch { throw invalid('metadata must be valid UTF-8 JSON.'); }
  // Reviver alone cannot detect duplicate keys. Scan object key tokens after
  // parsing validated JSON; track object scope while skipping string contents.
  const stack = []; let token = '', inString = false, escaped = false, start = -1;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') {
        inString = false; let next = index + 1; while (/\s/.test(source[next] || '') && next < source.length) next++;
        if (source[next] === ':') {
          token = JSON.parse(source.slice(start, index + 1)); const current = stack.at(-1);
          if (!(current instanceof Set) || current.has(token)) throw invalid('metadata contains duplicate object fields.');
          current.add(token);
        }
      }
    } else if (char === '"') { inString = true; start = index; }
    else if (char === '{') stack.push(new Set());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
  }
  return value;
}
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || /[\x00-\x1f\x7f<>:"|?*]/.test(value) || path.posix.isAbsolute(value)) throw invalid('runtime file paths must be bounded relative paths.');
  const parts = value.split('/');
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw invalid('runtime file paths contain unsafe segments.');
  return value;
}
function inventory(root) {
  const names = new Map(); let entries = 0;
  const visit = (directory, prefix = '', depth = 0) => {
    if (depth > 32) throw invalid('runtime directory nesting exceeds its limit.');
    noLinks(directory, true);
    const handle = fs.opendirSync(directory);
    try {
      let entry; while ((entry = handle.readSync())) {
        if (++entries > MAX_FILES * 3) throw invalid('runtime inventory exceeds its entry limit.');
        const name = relativePath(prefix + entry.name), target = path.join(directory, entry.name), info = lstat(target);
        if (info.isSymbolicLink()) throw invalid('symbolic links or junctions are not allowed in runtime inventory.');
        if (info.isDirectory()) visit(target, name + '/', depth + 1);
        else {
          noLinks(target);
          if (name === 'runtime.json') continue;
          const identity = key(name);
          if (names.has(identity) || names.size >= MAX_FILES) throw invalid('runtime inventory contains duplicate or too many files.');
          names.set(identity, name);
        }
      }
    } finally { handle.closeSync(); }
  };
  visit(root); return names;
}

function embeddedPython(root) {
  const appRoot = path.resolve(root), resourceRoot = path.dirname(appRoot), pythonRoot = path.join(resourceRoot, 'python'), markerPath = path.join(appRoot, MARKER);
  let present;
  try { present = fs.lstatSync(markerPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw invalid('distribution metadata cannot be read.');
    // The fixed portable layout and adjacent runtime are independent evidence
    // of packaging; deleting its marker must not enable a host-Python fallback.
    if ((key(path.basename(appRoot)) === 'app' && key(path.basename(resourceRoot)) === 'resources') || fs.existsSync(path.join(pythonRoot, 'runtime.json'))) throw invalid('distribution metadata is missing.');
    return null;
  }
  if (!present.isFile() || present.isSymbolicLink()) throw invalid('distribution metadata is not a regular file.');
  noLinks(appRoot, true); noLinks(resourceRoot, true);
  const markerBytes = readFile(markerPath, 4096), marker = json(markerBytes);
  if (!exact(marker, 'arch,platform,python_manifest_sha256,python_resource,schema') || marker.schema !== 'yur.desktop-distribution.v1' || marker.platform !== 'win32' || marker.arch !== 'x64' || marker.python_resource !== '../python' || typeof marker.python_manifest_sha256 !== 'string' || !HASH.test(marker.python_manifest_sha256)) throw invalid('distribution metadata does not match the fixed Windows x64 layout.');
  if (process.platform !== marker.platform || process.arch !== marker.arch) throw invalid('the bundled runtime does not match this host architecture.');
  noLinks(pythonRoot, true);
  if (path.dirname(pythonRoot) !== resourceRoot) throw invalid('the Python resource escaped its distribution.');
  const manifestPath = path.join(pythonRoot, 'runtime.json'), bytes = readFile(manifestPath, MAX_MANIFEST_BYTES);
  if (hash(bytes) !== marker.python_manifest_sha256) throw invalid('the Python manifest digest differs from distribution metadata.');
  const manifest = json(bytes);
  if (!exact(manifest, 'arch,archive,entrypoint,files,platform,schema,version') || manifest.schema !== 'yur.embedded-python.v1' || manifest.platform !== marker.platform || manifest.arch !== marker.arch || manifest.version !== '3.14.7' || manifest.entrypoint !== 'python.exe' || !exact(manifest.archive, 'bytes,name,sha256,source_url') || Object.keys(ARCHIVE).some(field => manifest.archive[field] !== ARCHIVE[field]) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw invalid('the Python manifest has unsupported fields or runtime identity.');
  const listed = new Map(); let total = 0;
  for (const item of manifest.files) {
    if (!exact(item, 'bytes,path,sha256') || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_FILE_BYTES || typeof item.sha256 !== 'string' || !HASH.test(item.sha256)) throw invalid('a runtime file declaration is invalid.');
    const name = relativePath(item.path), identity = key(name);
    if (identity === 'runtime.json' || listed.has(identity)) throw invalid('runtime file declarations contain duplicates or the manifest itself.');
    listed.set(identity, item); total += item.bytes;
    if (total > MAX_TOTAL_BYTES) throw invalid('runtime payload exceeds its total byte limit.');
  }
  for (const name of ['python.exe', 'python314.dll', 'python314.zip', 'python314._pth']) if (listed.get(name)?.path !== name) throw invalid('a required Python core file is not declared with its fixed name.');
  const actual = inventory(pythonRoot);
  if (actual.size !== listed.size || [...actual].some(([identity, name]) => listed.get(identity)?.path !== name)) throw invalid('runtime inventory differs from the declared payload.');
  for (const item of listed.values()) {
    const payload = readFile(path.join(pythonRoot, ...item.path.split('/')), MAX_FILE_BYTES, item.bytes);
    if (hash(payload) !== item.sha256) throw invalid('a runtime payload fingerprint differs from its manifest.');
    if (item.path === 'python314._pth' && !payload.equals(Buffer.from(PTH_CONTENT, 'utf8'))) throw invalid('Python search paths differ from the fixed isolated configuration.');
  }
  if (hash(readFile(manifestPath, MAX_MANIFEST_BYTES)) !== marker.python_manifest_sha256) throw invalid('the Python manifest changed during verification.');
  if (!readFile(markerPath, 4096).equals(markerBytes)) throw invalid('distribution metadata changed during verification.');
  const finalInventory = inventory(pythonRoot);
  if (finalInventory.size !== actual.size || [...finalInventory].some(([identity, name]) => actual.get(identity) !== name)) throw invalid('runtime inventory changed during verification.');
  return path.join(pythonRoot, 'python.exe');
}

// Reuse the same bounded, link-rejecting resource reader and strict JSON parser
// for other source-owned application metadata. Callers supply their own limits.
module.exports = { embeddedPython, readVerifiedFile: readFile, parseStrictJson: json, MARKER, ARCHIVE, PTH_CONTENT, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_MANIFEST_BYTES };
