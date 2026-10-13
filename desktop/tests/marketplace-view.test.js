"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.className = ""; this.value = ""; this._text = ""; this.classList = { toggle: () => {} }; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(" "); }
  set innerHTML(_) { throw new Error("Catalog text must stay inert"); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this._text = ""; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  querySelector(selector) { return all(this).find(node => selector.startsWith(".") && node.className.split(" ").includes(selector.slice(1))) || null; }
  remove() {}
}
const all = root => [root, ...root.children.flatMap(all)];
const settle = () => new Promise(resolve => setImmediate(resolve));
const ok = result => ({ ok: true, result });
function setup(marketplace = {}) {
  const host = new Element("main"), window = {}, document = { createElement: tag => new Element(tag) };
  let state;
  const api = { harness: { status: async () => ok({ state: "ready" }), onEvent: callback => { state = callback; return () => {}; } }, marketplace: { packs: async () => ok({ packs: [] }), inventory: async () => ok({ items: [] }), ...marketplace } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/marketplace-view.js"), "utf8"), { window, document });
  const controller = window.yurMarketplaceView.create(host, { api, getModels: () => ["kimi-k3:cloud", "deepseek-v4-pro:cloud"] });
  return { host, window, controller, state: value => state(value), find: label => all(host).find(node => node.tagName === "button" && node.textContent === label), tab: key => all(host).find(node => node.dataset.tab === key).listeners.click() };
}

test("late pack results cannot replace a newer catalog view or resurrect a disposed view", async () => {
  let complete;
  const v = setup({ packs: () => new Promise(resolve => { complete = resolve; }), inventory: async () => ok({ items: [{ id: "listing", name: "Verified catalog listing", kind: "curated", status: "listed" }] }) });
  await settle(); await v.tab("catalog"); await settle();
  complete(ok({ packs: [{ pack_id: "stale", agent_type: "Stale pack" }] })); await settle();
  assert.match(v.host.textContent, /Verified catalog listing/); assert.doesNotMatch(v.host.textContent, /Stale pack/);
  v.tab("packs"); v.controller.dispose(); complete(ok({ packs: [{ pack_id: "late", agent_type: "Disposed pack" }] })); await settle();
  assert.doesNotMatch(v.host.textContent, /Disposed pack/);
});

test("repeated ready status preserves an open deployment form and offers all available cloud models", async () => {
  let requests = 0, triggerDefault;
  const v = setup({ packs: async () => { requests++; return ok({ packs: [{ pack_id: "estimator", agent_type: "Estimator" }] }); } });
  v.window.yurLifecycleTriggerEditor = (_api, initial) => { triggerDefault = initial.kind; return { root: new Element("div"), value: () => initial }; };
  await settle(); v.find("Deploy into studio").listeners.click();
  assert.match(v.host.textContent, /kimi-k3:cloud/); assert.match(v.host.textContent, /deepseek-v4-pro:cloud/);
  assert.equal(triggerDefault, "manual");
  v.state({ state: "ready" }); await settle(); assert.equal(requests, 1); assert.ok(v.host.querySelector(".yu-deploy"));
});

test("catalog search covers the complete loaded inventory and exposes accurate statuses and free prices", async () => {
  const items = Array.from({ length: 205 }, (_, index) => ({ id: `item-${index}`, name: `Listing ${index}`, kind: "curated", status: "listed", price: 0 }));
  items.push({ id: "local-pack", name: "Actual local pack", kind: "pack", status: "forged" });
  const v = setup({ inventory: async () => ok({ items }) }); await settle(); await v.tab("catalog"); await settle();
  assert.match(v.host.textContent, /200 of 206/); assert.match(v.host.textContent, /curated · listed · catalog reference/);
  const search = all(v.host).find(node => node.type === "search"); search.value = "Listing 204"; search.listeners.input();
  assert.match(v.host.textContent, /1 of 1 matching/); assert.match(v.host.textContent, /Listing 204/);
  assert.ok(all(v.host).some(node => node.className === "yu-hint" && node.textContent === "0"));
  search.value = "forged"; search.listeners.input(); assert.ok(v.find("Inspect pack"));
  assert.match(v.host.textContent, /pack · forged · inspect to verify local pack/);
});
