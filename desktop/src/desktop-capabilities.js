'use strict';
// A shared product description, never a tool registry or live health probe.
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readVerifiedFile, parseStrictJson } = require('./embedded-runtime');
const MAX_MANIFEST_BYTES = 24 * 1024, MAX_CONTEXT_BYTES = 32 * 1024;
const MANIFEST_PATH = path.join(__dirname, '..', 'desktop-capabilities.json');
const fields = ['schema', 'identity', 'explanation_policy', 'availability_policy', 'features', 'boundaries'];
const featureFields = ['id', 'label', 'surface', 'summary', 'access', 'requirements', 'limitations', 'sources'];
const access = new Set(['desktop_ui', 'model_tools', 'reference_catalog', 'conditional']);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function text(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Desktop capability text is invalid or exceeds its bound.');
}
function strings(value, maximum, characters, required = false) {
  if (!Array.isArray(value) || value.length > maximum || (required && !value.length)) throw new Error('Desktop capability list is invalid or exceeds its bound.');
  value.forEach(item => text(item, characters));
}
function validateManifest(value) {
  if (!exact(value, fields) || value.schema !== 'yur.desktop-capabilities.v1') throw new Error('Invalid Desktop capability manifest schema or fields.');
  for (const field of ['identity', 'explanation_policy', 'availability_policy']) text(value[field], 2048);
  if (!Array.isArray(value.features) || !value.features.length || value.features.length > 24) throw new Error('Desktop capability manifest requires 1–24 features.');
  const seen = new Set();
  for (const feature of value.features) {
    if (!exact(feature, featureFields) || typeof feature.id !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(feature.id) || seen.has(feature.id)) throw new Error('Invalid or duplicate Desktop feature.');
    seen.add(feature.id); text(feature.label, 160); text(feature.surface, 160); text(feature.summary, 1500);
    if (!access.has(feature.access)) throw new Error('Invalid Desktop feature access classification.');
    for (const key of ['requirements', 'limitations']) strings(feature[key], 12, 800);
    strings(feature.sources, 12, 240, true);
    if (new Set(feature.sources).size !== feature.sources.length) throw new Error('Desktop feature source references must be unique.');
    for (const source of feature.sources) {
      if (/[\\:\t\r\n<>"|?*]/.test(source) || source.startsWith('/') || source.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error('Desktop capability source must be a bounded relative source path.');
    }
  }
  strings(value.boundaries, 24, 1200, true);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_MANIFEST_BYTES) throw new Error('Desktop capability manifest exceeds 24 KiB.');
  return JSON.parse(JSON.stringify(value));
}
function loadCapabilities(file = MANIFEST_PATH) {
  let raw;
  try { raw = readVerifiedFile(file, MAX_MANIFEST_BYTES); }
  catch { throw new Error('Desktop capability manifest is unavailable or exceeds its safe read boundary.'); }
  let parsed;
  try { parsed = parseStrictJson(raw); }
  catch { throw new Error('Desktop capability manifest must be valid UTF-8 JSON without duplicate fields.'); }
  return { manifest: validateManifest(parsed), sha256: createHash('sha256').update(raw).digest('hex') };
}
function compileCapabilities(loaded, mode) {
  if (!exact(loaded, ['manifest', 'sha256']) || typeof loaded.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(loaded.sha256) || mode !== 'chat') throw new Error('Desktop capability Chat context requires its source-file digest and chat mode.');
  const manifest = validateManifest(loaded.manifest);
  const lines = [`YUR AI Desktop — source-owned capability overview (${manifest.schema})`, `Manifest SHA-256: ${loaded.sha256}`, manifest.identity,
    'Explanation policy: ' + manifest.explanation_policy, 'Availability policy: ' + manifest.availability_policy,
    'This conversation uses Chat inside the broader Desktop. Chat can reason over the supplied context but executes no model tool calls. Explain how to use the named desktop controls or switch to Work/Code for admitted tasks. This overview is not a runtime health check or permission grant.', 'Desktop features:'];
  for (const feature of manifest.features) {
    lines.push(`- ${feature.label} (${feature.id}; ${feature.access}; ${feature.surface}): ${feature.summary}`);
    for (const [field, label] of [['requirements', 'Requires'], ['limitations', 'Limits'], ['sources', 'Source references']]) if (feature[field].length) lines.push(`  ${label}: ${feature[field].join('; ')}`);
  }
  lines.push('Desktop boundaries:', ...manifest.boundaries.map(item => '- ' + item), 'Describe available routes accurately. Never claim that describing, selecting or viewing a feature executed it.');
  const context = lines.join('\n');
  if (Buffer.byteLength(context) > MAX_CONTEXT_BYTES) throw new Error('Desktop capability context exceeds its 32 KiB bound.');
  return context;
}
module.exports = { loadCapabilities, compileCapabilities, validateManifest, MANIFEST_PATH, MAX_MANIFEST_BYTES, MAX_CONTEXT_BYTES };
