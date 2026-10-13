/* Explicit file acquisition only. Binary data stays in memory, never the journal. */
'use strict';
(() => {
  const TEXT_NAME = /\.(txt|md|json|csv|py|js|ts|tsx|jsx|html|css|yaml|yml|xml|sql)$/i;
  const PRIVATE_NAME = /(^\.env|credentials|recovery.?codes|private.?key|\.keys)/i;
  const PRIVATE_CONTENT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["'][^"'\s]{12,}/i;
  const MAX_IMAGES_BYTES = 12 * 1024 * 1024;
  function evidence(item) {
    return Object.fromEntries(Object.entries(item).filter(([key]) => !['content', 'data_url', 'file'].includes(key)));
  }
  async function nativeRead(api, path, expected = null) {
    if (!api?.attachments?.read) throw new Error('The attachment reader requires the updated Desktop runtime.');
    const response = await api.attachments.read({ path, expected_sha256: expected });
    if (!response?.ok) throw new Error(response?.error?.message || 'Could not read the selected attachment.');
    const record = response.result;
    if (!record || !['image', 'text'].includes(record.kind) || typeof record.name !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('The attachment reader returned an invalid record.');
    if (record.kind === 'image' && !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(record.data_url || '')) throw new Error('The image attachment is not a supported validated image.');
    if (record.kind === 'text' && typeof record.content !== 'string') throw new Error('The document has no extracted text.');
    return record;
  }
  async function files(api, selected, existing = []) {
    if (existing.length + selected.length > 5) throw new Error('Attach up to five files per message.');
    const added = [];
    for (const file of selected) {
      const path = api?.attachments?.pathForFile?.(file);
      if (path) { added.push(await nativeRead(api, path)); continue; }
      if (!TEXT_NAME.test(file.name) || PRIVATE_NAME.test(file.name)) {
        if (file.type?.startsWith('image/')) throw new Error('This pasted image has no saved file path. Save it locally, then attach that file; pasted-image storage is not available yet.');
        throw new Error('Choose a saved text, PDF, Office document or supported image.');
      }
      if (file.size > 64000) throw new Error(`${file.name} exceeds the 64 KB text attachment limit.`);
      const raw = await file.arrayBuffer();
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
      catch { throw new Error('Choose a UTF-8 text file or use the native document reader.'); }
      if (content.includes('\0') || PRIVATE_CONTENT.test(content)) throw new Error('Binary or credential-like content is excluded from text attachments.');
      const digest = await crypto.subtle.digest('SHA-256', raw);
      const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      added.push({ kind: 'text', name: file.name, content, bytes: file.size, sha256, extraction: { truncated: false }, provenance: { operation: 'attachment.read', mode: 'read-only', source: 'selected-browser-file', code_executed: false } });
    }
    return added;
  }
  async function paths(api, selected, existing = []) {
    if (existing.length + selected.length > 5) throw new Error('Attach up to five files per message.');
    const added = [];
    for (const path of selected) added.push(await nativeRead(api, path));
    return added;
  }
  async function fresh(api, selected) {
    const records = [];
    for (const item of selected) records.push(item.path ? await nativeRead(api, item.path, item.sha256) : item);
    return records;
  }
  async function messagesWithImages(api, messages, provider) {
    const selected = messages.flatMap((message, index) => (message.role === 'user' ? message.evidence?.attachments || [] : []).filter(item => item.kind === 'image').map(item => ({ index, item })));
    if (!selected.length) return messages.filter(message => message.role !== 'error').map(message => ({ role: message.role, content: message.content }));
    if (provider !== 'ollama') throw new Error('Image conversations currently require a vision-capable Ollama model. Choose one before sending.');
    if (selected.length > 5) throw new Error('This conversation exceeds five image references. Start a new conversation with the images needed for this task.');
    const images = new Map(); let bytes = 0;
    for (const { index, item } of selected) {
      if (!item.path || !item.sha256) throw new Error('This image has no durable source reference. Attach its saved file again.');
      const record = await nativeRead(api, item.path, item.sha256);
      if (record.kind !== 'image') throw new Error('The selected image source changed type.');
      bytes += record.bytes;
      if (bytes > MAX_IMAGES_BYTES) throw new Error('Image context exceeds 12 MiB. Use smaller images in a new conversation.');
      if (!images.has(index)) images.set(index, []);
      images.get(index).push(record.data_url.slice(record.data_url.indexOf(',') + 1));
    }
    return messages.flatMap((message, index) => message.role === 'error' ? [] : [{ role: message.role, content: message.content, ...(images.has(index) ? { images: images.get(index) } : {}) }]);
  }
  window.yurComposerIntake = Object.freeze({ evidence, files, paths, fresh, messagesWithImages });
})();
