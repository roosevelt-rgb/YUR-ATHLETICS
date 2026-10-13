'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/transcript-position');
function fixture() {
  const events = {}, buttonEvents = {};
  const scroll = { scrollTop: 0, scrollHeight: 2000, clientHeight: 400, nodes: [],
    getBoundingClientRect: () => ({ top: 50 }), querySelectorAll() { return this.nodes; },
    addEventListener(name, fn) { events[name] = fn; }, removeEventListener(name) { delete events[name]; } };
  const button = { hidden: true, addEventListener(name, fn) { buttonEvents[name] = fn; }, removeEventListener(name) { delete buttonEvents[name]; } };
  const view = create(scroll, button);
  function nodes(...tops) { scroll.nodes = tops.map((top, i) => ({ dataset: { messageId: 'message-' + i }, getBoundingClientRect: () => ({ top: 50 + top - scroll.scrollTop, bottom: 50 + top + 200 - scroll.scrollTop }) })); }
  const render = (id, mutation = () => {}) => { const saved = view.before(id); mutation(); view.after(saved); };
  return { scroll, button, view, nodes, events, buttonEvents, render };
}
test('new conversation starts at latest but background progress preserves the reader and reveals jump', () => {
  const f = fixture(); f.nodes(0, 500, 1000, 1500); f.render('a'); assert.equal(f.scroll.scrollTop, 1600);
  f.scroll.scrollTop = 600; f.events.scroll();
  f.render('a', () => { f.scroll.scrollHeight += 300; });
  assert.equal(f.scroll.scrollTop, 600); assert.equal(f.button.hidden, false);
  f.buttonEvents.click(); assert.equal(f.scroll.scrollTop, 1900); assert.equal(f.button.hidden, true);
  f.render('a', () => { f.scroll.scrollHeight += 300; }); assert.equal(f.scroll.scrollTop, 2200);
});
test('anchor offsets survive content changes above the reader and return to separate conversations', () => {
  const f = fixture(); f.nodes(0, 500, 1000, 1500); f.render('a'); f.scroll.scrollTop = 600; f.events.scroll();
  f.render('a', () => { f.nodes(0, 800, 1300, 1800); f.scroll.scrollHeight = 2300; }); assert.equal(f.scroll.scrollTop, 900);
  f.render('b', () => { f.nodes(0, 500, 1000, 1500); f.scroll.scrollHeight = 2000; }); assert.equal(f.scroll.scrollTop, 1600);
  f.scroll.scrollTop = 200; f.events.scroll();
  f.render('a', () => { f.nodes(0, 800, 1300, 1800); f.scroll.scrollHeight = 2300; }); assert.equal(f.scroll.scrollTop, 900);
  f.render('b', () => { f.nodes(0, 500, 1000, 1500); f.scroll.scrollHeight = 2000; }); assert.equal(f.scroll.scrollTop, 200);
});
test('hidden sections and late updates cannot overwrite the saved reading position', () => {
  const f = fixture(); f.nodes(0, 500, 1000, 1500); f.render('a'); f.scroll.scrollTop = 600; f.events.scroll();
  f.scroll.clientHeight = 0; f.scroll.scrollTop = 0; f.render('a'); f.events.scroll(); f.render('a');
  f.scroll.clientHeight = 400; f.render('a'); assert.equal(f.scroll.scrollTop, 600);
  f.view.dispose(); assert.deepEqual(f.events, {}); assert.deepEqual(f.buttonEvents, {});
});
test('a removed anchor clamps the retained absolute position instead of following unrelated content', () => {
  const f = fixture(); f.nodes(0, 500, 1000, 1500); f.render('a'); f.scroll.scrollTop = 900; f.events.scroll();
  f.render('a', () => { f.scroll.nodes = []; f.scroll.scrollHeight = 700; }); assert.equal(f.scroll.scrollTop, 300);
});
