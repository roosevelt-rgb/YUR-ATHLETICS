/* Local, inert Markdown presentation. Model text never becomes HTML or code. */
'use strict';
(() => {
  const fence = String.fromCharCode(96).repeat(3);
  const safeUrl = value => {
    try { const url = new URL(value); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null; }
    catch { return null; }
  };
  function inline(host, source, options = {}, depth = 0) {
    if (depth > 8) { host.appendChild(document.createTextNode(source)); return; }
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w])__[^_\n]+__(?![\w])|~~[^~\n]+~~|\*[^*\n]+\*|(?<![\w])_[^_\n]+_(?![\w])|\[[^\]\n]+\]\([^\s)]+\))/g;
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
      host.appendChild(document.createTextNode(source.slice(offset, match.index)));
      const token = match[0]; let node;
      if (token[0] === '`') { node = document.createElement('code'); node.textContent = token.slice(1, -1); }
      else if (token[0] === '[') {
        const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token); const url = safeUrl(parts[2]);
        if (url) {
          node = document.createElement('a'); node.href = url; node.rel = 'noopener noreferrer'; node.target = '_blank';
          node.textContent = parts[1];
          if (options.onLink) node.addEventListener('click', async event => { event.preventDefault(); try { await options.onLink(url); } catch (error) { options.onError?.(error.message); } });
        } else { node = document.createElement('span'); node.textContent = token; }
      } else {
        const wide = token.startsWith('**') || token.startsWith('__') || token.startsWith('~~');
        node = document.createElement(token.startsWith('~~') ? 'del' : wide ? 'strong' : 'em');
        inline(node, token.slice(wide ? 2 : 1, wide ? -2 : -1), options, depth + 1);
      }
      host.appendChild(node); offset = match.index + token.length;
    }
    host.appendChild(document.createTextNode(source.slice(offset)));
  }
  function cells(line) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|')); }
  function tableDivider(line) { return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line); }
  function render(host, value, options = {}, depth = 0) {
    if (depth > 16) { host.appendChild(document.createTextNode(String(value))); return; }
    const lines = String(value).replace(/\r\n?/g, '\n').split('\n');
    const isBoundary = (line, next = '') => !line.trim() || line.startsWith(fence) || /^(#{1,6}\s|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|\s*(?:---+|\*\*\*+|___+)\s*$)/.test(line) || tableDivider(next);
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (line.trimStart().startsWith(fence)) {
        const language = line.trim().slice(3).trim().split(/\s/)[0].slice(0, 40); const content = [];
        i++; while (i < lines.length && !lines[i].trimStart().startsWith(fence)) content.push(lines[i++]);
        if (i < lines.length) i++;
        const text = content.join('\n'); const block = document.createElement('section'); block.className = 'yc-code-block';
        const toolbar = document.createElement('div'); toolbar.className = 'yc-code-toolbar';
        const label = document.createElement('span'); label.textContent = language || 'Code'; toolbar.appendChild(label);
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy code';
        copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; } catch { options.onError?.('Clipboard is unavailable. Select and copy the code.'); } });
        toolbar.appendChild(copy);
        if (options.onOpenCode) {
          const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Open in Studio';
          open.addEventListener('click', async () => { open.disabled = true; try { await options.onOpenCode({ content: text, language }); } catch (error) { options.onError?.(error.message); } finally { open.disabled = false; } }); toolbar.appendChild(open);
        }
        const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = text; pre.appendChild(code); block.append(toolbar, pre); host.appendChild(block); continue;
      }
      const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line);
      if (heading) { const node = document.createElement('h' + heading[1].length); inline(node, heading[2], options); host.appendChild(node); i++; continue; }
      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { host.appendChild(document.createElement('hr')); i++; continue; }
      if (i + 1 < lines.length && tableDivider(lines[i + 1])) {
        const wrapper = document.createElement('div'); wrapper.className = 'yc-table-scroll'; const table = document.createElement('table');
        const head = document.createElement('thead'); const row = document.createElement('tr');
        const names = cells(line); for (const name of names) { const cell = document.createElement('th'); cell.scope = 'col'; inline(cell, name, options); row.appendChild(cell); } head.appendChild(row); table.appendChild(head); i += 2;
        const body = document.createElement('tbody');
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const row = document.createElement('tr'); const values = cells(lines[i++]);
          for (let j = 0; j < names.length; j++) { const cell = document.createElement('td'); inline(cell, values[j] || '', options); row.appendChild(cell); } body.appendChild(row);
        }
        table.appendChild(body); wrapper.appendChild(table); host.appendChild(wrapper); continue;
      }
      if (/^\s*>/.test(line)) {
        const quoted = []; while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*> ?/, ''));
        const node = document.createElement('blockquote'); render(node, quoted.join('\n'), options, depth + 1); host.appendChild(node); continue;
      }
      const item = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
      if (item) {
        const ordered = /^\d/.test(item[2]); const list = document.createElement(ordered ? 'ol' : 'ul');
        if (ordered) list.start = Number.parseInt(item[2], 10);
        while (i < lines.length) {
          const match = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(lines[i]);
          if (!match || /^\d/.test(match[2]) !== ordered) break;
          const li = document.createElement('li'); let text = match[3]; const task = /^\[([ xX])\]\s+/.exec(text);
          if (task) { const check = document.createElement('input'); check.type = 'checkbox'; check.disabled = true; check.checked = task[1] !== ' '; check.setAttribute('aria-label', check.checked ? 'Completed item' : 'Incomplete item'); li.appendChild(check); text = text.slice(task[0].length); }
          inline(li, text, options); list.appendChild(li); i++;
          const continuation = []; while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) continuation.push(lines[i++].trim());
          if (continuation.length) { li.appendChild(document.createElement('br')); inline(li, continuation.join('\n'), options); }
        }
        host.appendChild(list); continue;
      }
      const paragraph = [line]; i++;
      while (i < lines.length && !isBoundary(lines[i], lines[i + 1])) paragraph.push(lines[i++]);
      const node = document.createElement('p'); inline(node, paragraph.join('\n'), options); host.appendChild(node);
    }
  }
  window.yurChatRenderer = Object.freeze({ render, safeUrl });
})();
