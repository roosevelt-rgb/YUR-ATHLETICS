'use strict';

const http = require('node:http');
const https = require('node:https');
const { StringDecoder } = require('node:string_decoder');

const DEFAULT_FOUNDRY_URL = 'http://127.0.0.1:8844';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;

function normalizeFoundryUrl(value, setting = 'YUR_FOUNDRY_URL') {
  if (typeof value !== 'string' || value.length > 2048) throw new Error(`${setting} must be an HTTP or HTTPS origin.`);
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${setting} is not a valid URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${setting} must be an HTTP or HTTPS origin without credentials, a path, or a query.`);
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) throw new Error(`${setting} requires HTTPS for a non-loopback service.`);
  return url.origin;
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
}

function createFoundryTransport({
  getBaseUrl = () => DEFAULT_FOUNDRY_URL,
  configured = () => false,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxRequestBytes = MAX_REQUEST_BYTES,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  serviceName = 'Foundry',
  setting = 'YUR_FOUNDRY_URL',
} = {}) {
  for (const [name, value] of Object.entries({ timeoutMs, maxRequestBytes, maxResponseBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Foundry transport ${name}.`);
  }
  let activeRequests = 0;

  function info() {
    return { url: normalizeFoundryUrl(getBaseUrl(), setting), configured: Boolean(configured()), timeoutMs, maxRequestBytes, maxResponseBytes };
  }

  function request(method, apiPath, body, deadlineMs = timeoutMs, options = {}) {
    return new Promise((resolve, reject) => {
      let url, encoded;
      try {
        if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['signal', 'onRecord'].includes(key))) throw new Error('Invalid Foundry request options.');
        if (options.onRecord !== undefined && typeof options.onRecord !== 'function') throw new Error('Invalid Foundry stream callback.');
        if (options.signal && (typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) throw new Error('Invalid Foundry cancellation signal.');
        if (options.signal?.aborted) { const error = new Error('Foundry request cancelled.'); error.code = 'CANCELLED'; throw error; }
        if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > timeoutMs) throw new Error('Invalid Foundry request deadline.');
        if (!['GET', 'POST'].includes(method)) throw new Error('Unsupported Foundry request method.');
        if (typeof apiPath !== 'string' || apiPath.length > 4096 || !apiPath.startsWith('/api/') || /[\\\u0000-\u001f#]/.test(apiPath)) {
          throw new Error('Invalid Foundry API path.');
        }
        url = new URL(normalizeFoundryUrl(getBaseUrl(), setting) + apiPath);
        if (!url.pathname.startsWith('/api/')) throw new Error('Foundry requests must stay under /api/.');
        if (body !== undefined) {
          if (method === 'GET') throw new Error('Foundry GET requests cannot include a body.');
          encoded = JSON.stringify(body);
          if (encoded === undefined || Buffer.byteLength(encoded) > maxRequestBytes) throw new Error('Foundry request exceeds the desktop size limit.');
        }
        if (activeRequests >= 4) throw new Error('Foundry is busy. Wait for a current request to finish.');
      } catch (error) { reject(Object.assign(new Error(error.message.replaceAll('Foundry', serviceName)), { code: error.code })); return; }

      activeRequests += 1;
      let settled = false, timer, response, req;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        activeRequests -= 1;
        if (error) reject(Object.assign(new Error(error.message.replaceAll('Foundry', serviceName)), { code: error.code }));
        else resolve(value);
      };
      const abort = () => {
        finish(Object.assign(new Error('Foundry request cancelled.'), { code: 'CANCELLED' }));
        response?.destroy(); req?.destroy();
      };
      const headers = { Accept: options.onRecord ? 'application/x-ndjson, application/json' : 'application/json' };
      if (encoded !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(encoded);
      }
      const client = url.protocol === 'https:' ? https : http;
      try {
        req = client.request(url, { method, headers }, res => {
          response = res;
          let bytes = 0;
          const chunks = [];
          const streaming = Boolean(options.onRecord) && res.statusCode === 200;
          const decoder = new StringDecoder('utf8');
          let pending = '', records = 0;
          const parseRecords = (text, final = false) => {
            pending += text;
            let end;
            while ((end = pending.indexOf('\n')) >= 0) {
              if (settled) return;
              const line = pending.slice(0, end).replace(/\r$/, '');
              pending = pending.slice(end + 1);
              if (line.trim()) consume(line);
            }
            if (Buffer.byteLength(pending) > maxResponseBytes) throw new Error('Foundry stream record exceeded the desktop size limit.');
            if (final && !settled && pending.trim()) { consume(pending); pending = ''; }
          };
          const consume = line => {
            let record;
            try { record = JSON.parse(line); }
            catch { throw new Error('Foundry returned invalid streaming JSON.'); }
            if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Foundry returned an invalid stream record.');
            if (++records > 32768) throw new Error('Foundry returned too many stream records.');
            options.onRecord(record);
          };
          res.on('data', chunk => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > maxResponseBytes) {
              finish(new Error('Foundry response exceeded the desktop size limit.'));
              res.destroy();
              req.destroy();
              return;
            }
            if (streaming) {
              try { parseRecords(decoder.write(chunk)); }
              catch (error) { finish(error); res.destroy(); req.destroy(); }
            } else chunks.push(chunk);
          });
          res.on('error', () => finish(new Error('Foundry response was interrupted.')));
          res.on('aborted', () => finish(new Error('Foundry response was interrupted.')));
          res.on('end', () => {
            if (settled) return;
            if (streaming) {
              try { parseRecords(decoder.end(), true); finish(null, { status: res.statusCode, records }); }
              catch (error) { finish(error); }
              return;
            }
            const data = Buffer.concat(chunks).toString('utf8');
            let json;
            try { json = JSON.parse(data); }
            catch {
              finish(new Error(`Foundry returned invalid JSON (HTTP ${res.statusCode}).`));
              return;
            }
            // Preserve HTTP failures for the caller; never reinterpret them as an answer.
            finish(null, { status: res.statusCode, json });
          });
        });
        req.on('error', error => finish(new Error(`Foundry request failed at ${url.origin}: ${error.code || 'NETWORK_ERROR'}.`)));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        timer = setTimeout(() => {
          finish(new Error(`Foundry request timed out after ${deadlineMs} ms at ${url.origin}.`));
          response?.destroy();
          req.destroy();
        }, deadlineMs);
        req.end(encoded);
      } catch {
        finish(new Error(`Foundry request could not start at ${url.origin}.`));
        req?.destroy();
      }
    });
  }

  return { info, request };
}

module.exports = { DEFAULT_FOUNDRY_URL, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, normalizeFoundryUrl, isLoopback, createFoundryTransport };
