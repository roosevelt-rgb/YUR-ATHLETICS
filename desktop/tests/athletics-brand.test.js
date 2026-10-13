"use strict";
// YUR Athletics brand surfaces: the logo set, the launch page (splash), the play art, the ghost
// position canvas on Franklin's page, the product name and Franklin's default model. Renderer-only
// doubles: no Electron window, browser, model or network is started.
const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const shell = require("../src/edition-shell");
const plays = require("../src/athletics-play-art");
const splash = require("../src/athletics-launch");
const { editionLaunchInfo, loadEdition } = require("../src/edition");

const root = path.join(__dirname, "..");
const src = path.join(root, "src");
const read = (name) =>
  fs.readFileSync(path.join(root, ...name.split("/")), "utf8");
// The athlete manifest (editions/athletics.json) is each owner's own file and is never committed. These tests read
// the committed sample, tests/fixtures/athletics.sample.json, from a temporary editions folder.
const SAMPLE_FILE = path.join(__dirname, "fixtures", "athletics.sample.json");
const sampleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yur-edition-sample-"));
fs.copyFileSync(SAMPLE_FILE, path.join(sampleRoot, "athletics.json"));
after(() => fs.rmSync(sampleRoot, { recursive: true, force: true }));
const manifest = JSON.parse(fs.readFileSync(SAMPLE_FILE, "utf8"));
// The name checks below also cover the owner's local manifest when this checkout has one.
const localManifest = path.join(root, "editions", "athletics.json");
const athletes = [manifest.athlete, ...(fs.existsSync(localManifest) ? [JSON.parse(fs.readFileSync(localManifest, "utf8")).athlete] : [])];
const launchInfo = () =>
  JSON.parse(
    JSON.stringify(
      editionLaunchInfo(
        loadEdition({ env: { YUR_EDITION: "athletics" }, root: sampleRoot, log: () => {} }),
      ),
    ),
  );
const brandDir = path.join(src, "athletics-brand", "brand");
const logoSet = path.join(
  root,
  "..",
  "..",
  "desktop-snapshots",
  "athletics-logo-2026-10-12",
);
const flush = async (times = 6) => {
  for (let i = 0; i < times; i++)
    await new Promise((resolve) => setImmediate(resolve));
};

// ─── Logo set ───
const BRAND_FILES = Object.freeze({
  "lockup.svg": "final-v3-master/final/lockup.svg",
  "lockup-light.svg": "final-v3-master/final/lockup-light.svg",
  "y-mark.svg": "final-v3-master/final/y-mark.svg",
  "y-mark-figure.svg": "final-v3-master/final/y-mark-figure.svg",
  "mark-flat.svg": "final-v3-master/final/mark-flat.svg",
  "icon.ico": "final-v3-master/final/yur-athletics.ico",
  "icon-512.png": "final-v3-master/final/icon-512.png",
  "apple-touch-icon.png": "final-v3-master/final/apple-touch-icon.png",
  "favicon-32.png": "final-v3-master/final/favicon-32.png",
  "yur-athletics-master.webp": "brand-master/yur-athletics-master.webp",
});

test("the logo set ships in athletics-brand/brand: exactly the chosen files, light enough, with honest formats", () => {
  assert.deepEqual(
    fs.readdirSync(brandDir).sort(),
    Object.keys(BRAND_FILES).sort(),
  );
  for (const name of Object.keys(BRAND_FILES)) {
    const bytes = fs.readFileSync(path.join(brandDir, name));
    assert.ok(
      bytes.length > 0 && bytes.length <= 300 * 1024,
      `${name} stays under 300 KB (${bytes.length})`,
    );
    if (name.endsWith(".svg")) {
      const svg = bytes.toString("utf8");
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, name);
      assert.match(svg, /<title>YUR Athletics/, name);
      // Brand art is inert: no script, event handler, foreign content or outside reference.
      assert.doesNotMatch(
        svg,
        /<script|<foreignObject|\son[a-z]+=|@import|(?:xlink:)?href="(?!#)|url\((?!#)/i,
        name,
      );
      assert.deepEqual(
        [...new Set(svg.match(/https?:\/\/[^"'\s)]+/g))].sort(),
        name === "mark-flat.svg"
          ? ["http://www.w3.org/2000/svg"]
          : ["http://www.w3.org/1999/xlink", "http://www.w3.org/2000/svg"],
        name,
      );
    }
  }
  assert.deepEqual(
    [...fs.readFileSync(path.join(brandDir, "icon.ico")).subarray(0, 4)],
    [0, 0, 1, 0],
  );
  for (const png of ["icon-512.png", "apple-touch-icon.png", "favicon-32.png"])
    assert.equal(
      fs
        .readFileSync(path.join(brandDir, png))
        .subarray(0, 8)
        .toString("latin1"),
      "\x89PNG\r\n\x1a\n",
      png,
    );
  const webp = fs.readFileSync(
    path.join(brandDir, "yur-athletics-master.webp"),
  );
  assert.equal(
    webp.subarray(0, 4).toString("latin1") +
      webp.subarray(8, 12).toString("latin1"),
    "RIFFWEBP",
  );
  // The lockups draw the final mark inline; their mark slots keep the ya3- prefix.
  for (const name of ["lockup.svg", "lockup-light.svg"])
    assert.match(
      read("src/athletics-brand/brand/" + name),
      /id="ya3-[a-z]+-mark-slot"/,
      name,
    );
});

test(
  "every brand file is a byte-for-byte copy of the owner's logo set",
  { skip: !fs.existsSync(logoSet) && "logo set not present" },
  () => {
    for (const [name, source] of Object.entries(BRAND_FILES))
      assert.ok(
        fs
          .readFileSync(path.join(brandDir, name))
          .equals(fs.readFileSync(path.join(logoSet, ...source.split("/")))),
        name,
      );
  },
);

test("every brand reference points at a shipped file: BRANDS, the finish, the launch page and the manifest icon", () => {
  for (const value of Object.values(shell.BRANDS.athletics).filter((value) =>
    /\.(?:svg|png|ico|webp)$/.test(value),
  ))
    assert.ok(fs.existsSync(path.join(src, ...value.split("/"))), value);
  assert.equal(
    shell.BRANDS.athletics.mark,
    "athletics-brand/brand/y-mark.svg",
    "the small silver mark is named for what it is",
  );
  for (const [, file] of read("src/athletics-brand/athletics.css").matchAll(
    /url\('\.\/(brand\/[^']+)'\)/g,
  ))
    assert.ok(
      fs.existsSync(path.join(src, "athletics-brand", ...file.split("/"))),
      file,
    );
  const html = read("src/athletics-launch.html");
  for (const [, file] of html.matchAll(
    /(?:src|href)="(athletics-brand\/[^"]+)"/g,
  ))
    assert.ok(fs.existsSync(path.join(src, ...file.split("/"))), file);
  assert.ok(fs.existsSync(path.join(src, ...manifest.brand.icon.split("/"))));
  for (const old of ["mark-silver.svg"])
    assert.equal(
      [
        ...Object.values(shell.BRANDS.athletics),
        html,
        read("src/athletics-brand/athletics.css"),
      ].some((value) => value.includes(old)),
      false,
      old,
    );
});

// ─── Launch page (splash) ───
test("the splash page follows the mockup and names no athlete, sport or position itself", () => {
  const html = read("src/athletics-launch.html"),
    glider = read("src/glider-launch.html");
  const csp = (value) =>
    value.match(/Content-Security-Policy"[^>]*content="([^"]+)"/)[1];
  assert.equal(csp(html), csp(glider));
  assert.match(html, /<title>YUR Athletics<\/title>/);
  assert.deepEqual(
    [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1]),
    ["athletics-play-art.js", "athletics-launch.js"],
  );
  assert.doesNotMatch(
    html,
    /<script(?![^>]*\bsrc=)[^>]*>/,
    "no inline script under script-src self",
  );
  assert.deepEqual(
    [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
      (match) => match[1],
    ),
    ["athletics-launch.css", "desktop-theme.css"],
  );
  assert.deepEqual(
    [
      ...html.matchAll(
        /<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g,
      ),
    ].map((match) => match[1]),
    [
      "athletics-brand/brand/favicon-32.png",
      "athletics-brand/brand/icon-512.png",
      "athletics-brand/brand/apple-touch-icon.png",
    ],
  );
  // The hero is the master raster; its baked-in subline is cropped away and the right wording is live text.
  assert.match(
    html,
    /<div class="ath-hero-crop">\s*<img src="athletics-brand\/brand\/yur-athletics-master\.webp" alt="YUR Athletics"/,
  );
  assert.match(
    html,
    /<p class="ath-hero-subline">SUPER INTELLIGENT ANALYTICS<\/p>/,
  );
  assert.doesNotMatch(html, /INTELLIGENCE/);
  assert.match(
    html,
    /<section id="ath-card" class="ath-card" aria-label="Athlete" hidden>/,
  );
  assert.match(
    html,
    /<span id="splash-position" class="ath-card-position"><\/span><span class="ath-card-tm" aria-hidden="true">TM<\/span>/,
  );
  assert.match(
    html,
    /id="splash-tagline" class="ath-card-tagline">THE GAME IS WON OFF THE FIELD</,
  );
  assert.match(html, /<p id="splash-athlete" class="ath-card-athlete"><\/p>/);
  assert.match(html, /id="ath-launch-status"[^>]*>Waking Franklin</);
  assert.match(
    html,
    /<svg id="ath-play" class="ath-play"[^>]*aria-hidden="true"[^>]*hidden><\/svg>/,
  );
  for (const file of [
    "src/athletics-launch.html",
    "src/athletics-launch.js",
    "src/athletics-launch.css",
  ]) {
    const text = read(file);
    for (const athlete of athletes)
      for (const detail of [
        athlete.display_name,
        ...athlete.display_name.split(" "),
        athlete.id,
        String(athlete.class_of),
      ])
        assert.equal(text.includes(detail), false, `${file} names ${detail}`);
    assert.doesNotMatch(text, /football|quarter|\bQB\b/i, file);
  }
  // Only the entry flow and the launch page's own edition call.
  assert.deepEqual(
    [
      ...new Set(
        read("src/athletics-launch.js").match(/studio\??\.launch\??\.\w+/g),
      ),
    ].sort(),
    ["studio.launch.enter", "studio?.launch?.edition", "studio?.launch?.enter"],
  );
});

test("the splash crops the hero at 0.805, sets the subline in Orbitron and frames the page 12px in", () => {
  const css = read("src/athletics-launch.css");
  assert.match(
    css,
    /^@import url\('\.\/athletics-brand\/fonts\/fonts\.css'\);/,
  );
  assert.match(
    css,
    /\.ath-hero-crop \{[^}]*aspect-ratio: 1 \/ 0\.805;[^}]*overflow: hidden;/,
  );
  assert.match(
    css,
    /\.ath-hero-crop img \{[^}]*width: 100%;[^}]*aspect-ratio: 1;/,
  );
  assert.match(
    css,
    /\.ath-hero-subline \{[^}]*color: #c4c4cb;[^}]*font: 400 11px\/1 var\(--ath-display\);[^}]*letter-spacing: 0\.46em;/,
  );
  assert.match(css, /--ath-display: "Orbitron"/);
  assert.match(
    css,
    /\.ath-frame \{[^}]*inset: 12px;[^}]*border: 1px solid rgba\(228, 228, 231, 0\.18\);/,
  );
  assert.match(
    css,
    /\.ath-card-position \{[^}]*font: 900 78px\/1 var\(--ath-display\);[^}]*letter-spacing: -0\.02em;/,
  );
  assert.match(
    css,
    /\.ath-loading-bar \{[^}]*animation: ath-load 3s ease-out both;/,
  );
  for (const match of css.matchAll(/border-radius:\s*([^;]+)/g))
    assert.equal(match[1].trim(), "0");
  // Reduced motion shows the final state: no animation, the play fully drawn, the bar full.
  const reduced = css.slice(
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(
    reduced,
    /\.ath-draw,\s*\.ath-fade,\s*\.ath-card,\s*\.ath-loading-bar \{\s*animation: none !important;/,
  );
  assert.match(reduced, /\.ath-draw \{\s*stroke-dashoffset: 0;/);
  assert.match(reduced, /\.ath-fade \{\s*opacity: 1;/);
  // The still loading line is 72% full (Splash.dc.html's reduced-motion state).
  assert.match(reduced, /\.ath-loading-bar \{\s*transform: scaleX\(0\.72\);/);
  // The hero crop is opaque: the routes pass behind the logo, with no blend mode.
  assert.match(css, /\.ath-hero-crop \{[^}]*background: #000000;/);
  assert.doesNotMatch(css, /mix-blend-mode/);
  const eased = [
    ...css
      .slice(0, css.indexOf("@media (prefers-reduced-motion: reduce)"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{[^{}]*\btransition:/g),
  ].map((match) => match[1].trim());
  assert.deepEqual(eased, [".ath-enter"]);
  assert.match(reduced, /\.ath-enter \{\s*transition: none !important;/);
});

test("the splash model comes from edition:launch: position upper-cased, NAME, CLASS OF YEAR, sport and hand", () => {
  const info = launchInfo();
  const model = splash.splashModel(info);
  assert.deepEqual(model, {
    title: "YUR Athletics",
    position: manifest.athlete.position.toUpperCase(),
    athleteLine: `${manifest.athlete.display_name.toUpperCase()}, CLASS OF ${manifest.athlete.class_of}`,
    sport: manifest.athlete.sport,
    hand: manifest.athlete.throws,
  });
  const other = splash.splashModel({
    enabled: true,
    title: "YUR Athletics",
    athlete: {
      display_name: "Jordan Lee",
      sport: "basketball",
      position: "Point Guard",
      throws: "right",
      class_of: 2029,
    },
  });
  assert.deepEqual(other, {
    title: "YUR Athletics",
    position: "POINT GUARD",
    athleteLine: "JORDAN LEE, CLASS OF 2029",
    sport: "basketball",
    hand: "right",
  });
  for (const empty of [
    null,
    undefined,
    {},
    { enabled: false },
    { enabled: "true", athlete: info.athlete },
    { enabled: true, athlete: "x" },
  ])
    assert.deepEqual(splash.splashModel(empty), {
      title: "YUR Athletics",
      position: "",
      athleteLine: "",
      sport: "",
      hand: "",
    });
  const odd = splash.splashModel({
    enabled: true,
    title: "YUR\nAthletics",
    athlete: {
      display_name: " Pat\u0007 Doe ",
      sport: "Track Field",
      position: "wide\u0000 receiver",
      throws: "both",
      class_of: "2031",
    },
  });
  assert.deepEqual(odd, {
    title: "YURAthletics",
    position: "WIDE RECEIVER",
    athleteLine: "PAT DOE",
    sport: "",
    hand: "",
  });
});

test("the position line fits the card: 78px for an eleven-letter word at 1440px, bounded at any length", () => {
  assert.equal(splash.positionFontSize("QUARTERBACK", 1440), 78);
  assert.equal(splash.positionFontSize("PITCHER", 1440), 78);
  assert.equal(splash.positionFontSize("OUTSIDE LINEBACKER", 1440), 78);
  assert.equal(splash.positionFontSize("LEFT DEFENSIVE TACKLE", 1440), 70, "a longer position shrinks to fit");
  assert.equal(splash.positionFontSize("QB", 1440), 78);
  assert.equal(splash.positionFontSize("QUARTERBACK", 800), 43);
  assert.equal(splash.positionFontSize("X".repeat(80), 800), 28);
  assert.equal(splash.positionFontSize("", 4000), 96);
});

// A small DOM double for the splash: elements, SVG elements, attributes, dataset and style.
function splashDom() {
  const byId = new Map(),
    doc = { activeElement: null };
  const make = (tag, namespace = null) => {
    const node = {
      tagName: tag,
      namespace,
      children: [],
      attributes: {},
      dataset: {},
      hidden: false,
      textContent: "",
      listeners: {},
      style: {
        setProperty(name, value) {
          this[name] = value;
        },
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return this.attributes[name] ?? null;
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
      replaceChildren(...nodes) {
        this.children = [...nodes];
      },
      addEventListener(type, callback) {
        (this.listeners[type] ||= []).push(callback);
      },
      click() {
        for (const callback of this.listeners.click || []) callback({});
      },
      focus() {
        doc.activeElement = node;
      },
    };
    return node;
  };
  doc.createElementNS = (namespace, tag) => make(tag, namespace);
  doc.getElementById = (id) => byId.get(id) || null;
  for (const [id, tag, hidden] of [
    ["ath-launch-status", "p"],
    ["ath-enter", "button", true],
    ["ath-card", "section", true],
    ["splash-position", "span"],
    ["splash-athlete", "p"],
    ["ath-play", "svg", true],
  ]) {
    const node = make(tag);
    node.id = id;
    node.hidden = Boolean(hidden);
    // Like a real <svg>: no hidden property, only the attribute (which drawPlay must remove).
    if (tag === "svg") {
      delete node.hidden;
      node.attributes.hidden = "";
    }
    byId.set(id, node);
  }
  byId.get("ath-launch-status").textContent = "Waking Franklin";
  return doc;
}
function splashWindow(
  reply,
  {
    enter = async () => ({ ok: true, result: { surface: "YUR Athletics" } }),
  } = {},
) {
  const calls = { edition: 0, enter: 0, timers: [] };
  const win = {
    innerWidth: 1440,
    yurAthleticsPlays: plays,
    addEventListener() {},
    setTimeout: (callback, delay) => {
      calls.timers.push({ callback, delay });
      return calls.timers.length;
    },
    studio: {
      launch: {
        edition: async () => {
          calls.edition++;
          return reply;
        },
        enter: async () => {
          calls.enter++;
          return enter();
        },
      },
    },
  };
  return { win, calls };
}

test("the splash fills its card and draws the play from the manifest, then enters after about three seconds", async () => {
  const doc = splashDom(),
    { win, calls } = splashWindow({ ok: true, result: launchInfo() });
  await splash.start(win, doc);
  const $ = (id) => doc.getElementById(id);
  assert.equal(calls.edition, 1);
  assert.equal(
    $("splash-position").textContent,
    manifest.athlete.position.toUpperCase(),
  );
  assert.equal(
    $("splash-athlete").textContent,
    `${manifest.athlete.display_name.toUpperCase()}, CLASS OF ${manifest.athlete.class_of}`,
  );
  assert.equal($("ath-card").hidden, false);
  assert.equal($("splash-position").style.fontSize, "78px");
  const svg = $("ath-play");
  assert.equal("hidden" in svg.attributes, false, "the play is shown");
  assert.equal(svg.dataset.sport, manifest.athlete.sport);
  assert.equal(svg.dataset.side, manifest.athlete.throws);
  assert.equal(
    svg.children.length,
    plays.playArt(manifest.athlete.sport, manifest.athlete.throws).shapes
      .length,
  );
  assert.ok(
    svg.children.every(
      (node) => node.namespace === "http://www.w3.org/2000/svg",
    ),
  );
  const drawn = svg.children.filter(
    (node) => node.attributes.class === "ath-draw",
  );
  assert.ok(
    drawn.length >= 6 &&
      drawn.every(
        (node) =>
          node.attributes.pathLength === "1" &&
          /^\d+(?:\.\d+)?s$/.test(node.style["--d"]),
      ),
  );
  // About three seconds, then the packaged entry flow; nothing enters earlier.
  assert.deepEqual(
    calls.timers.map((timer) => timer.delay),
    [3000],
  );
  assert.equal(splash.ENTER_DELAY_MS, 3000);
  assert.equal(calls.enter, 0);
  calls.timers[0].callback();
  await flush();
  assert.equal(calls.enter, 1);
  assert.equal($("ath-enter").hidden, true);
});

test("a sport without play art draws nothing; a missing edition still enters, and a failed entry can be retried", async () => {
  const doc = splashDom(),
    { win, calls } = splashWindow({
      ok: true,
      result: {
        ...launchInfo(),
        athlete: {
          ...launchInfo().athlete,
          sport: "basketball",
          position: "Point Guard",
        },
      },
    });
  await splash.start(win, doc);
  assert.equal(
    doc.getElementById("splash-position").textContent,
    "POINT GUARD",
  );
  assert.equal("hidden" in doc.getElementById("ath-play").attributes, true);
  assert.deepEqual(doc.getElementById("ath-play").children, []);
  assert.equal(calls.timers.length, 1);

  let outcome = {
    ok: false,
    error: { message: "Desktop entry requires its packaged launch page." },
  };
  const bare = splashDom(),
    second = splashWindow(
      { ok: false, error: { code: "UNTRUSTED_SENDER" } },
      { enter: async () => outcome },
    );
  await splash.start(second.win, bare);
  assert.equal(
    bare.getElementById("ath-card").hidden,
    true,
    "no athlete, no card",
  );
  assert.equal("hidden" in bare.getElementById("ath-play").attributes, true);
  second.calls.timers[0].callback();
  await flush();
  assert.equal(second.calls.enter, 1);
  assert.equal(
    bare.getElementById("ath-launch-status").textContent,
    "Desktop entry requires its packaged launch page.",
  );
  assert.equal(bare.getElementById("ath-enter").hidden, false);
  assert.equal(bare.activeElement, bare.getElementById("ath-enter"));
  outcome = { ok: true, result: { surface: "YUR Athletics" } };
  bare.getElementById("ath-enter").click();
  await flush();
  assert.equal(second.calls.enter, 2);
  assert.equal(bare.getElementById("ath-enter").hidden, true);
  assert.equal(
    bare.getElementById("ath-launch-status").textContent,
    "Waking Franklin",
  );

  const none = splashDom(),
    third = splashWindow(undefined);
  delete third.win.studio.launch.edition;
  await splash.start(third.win, none);
  assert.equal(none.getElementById("ath-card").hidden, true);
  third.calls.timers[0].callback();
  await flush();
  assert.equal(third.calls.enter, 1);
});

test("the launch script starts itself in the page and exports nothing to it but the play art it reads", () => {
  const doc = splashDom(),
    { win, calls } = splashWindow({ ok: true, result: launchInfo() });
  win.document = doc;
  vm.runInNewContext(read("src/athletics-launch.js"), {
    window: win,
    document: doc,
    setImmediate,
  });
  assert.equal(calls.timers.length, 1);
  const scope = {};
  vm.runInNewContext(read("src/athletics-play-art.js"), { window: scope });
  assert.deepEqual([...scope.yurAthleticsPlays.SPORTS], ["football"]);
});

// ─── Play art ───
test("football play art: the passer rolls out to the throwing-hand side and the right hand mirrors the left", () => {
  assert.deepEqual(plays.SPORTS, ["football"]);
  for (const sport of [
    "basketball",
    "baseball",
    "Football",
    "",
    null,
    undefined,
    "__proto__",
    "constructor",
  ])
    assert.equal(plays.playArt(sport, "left"), null, String(sport));
  const left = plays.playArt("football", "left"),
    right = plays.playArt("football", "right");
  assert.equal(left.side, "left");
  assert.equal(right.side, "right");
  assert.equal(plays.playArt("football", "both").side, "right");
  assert.equal(left.viewBox, "0 0 1440 900");
  const role = (art, name) => art.shapes.find((shape) => shape.role === name);
  const end = (d) =>
    d
      .match(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)$/)
      .slice(1)
      .map(Number);
  // A lefty rolls left (x decreases from the snap at 720) and throws to the left side; a righty mirrors it.
  assert.equal(
    role(left, "rollout").attrs.d,
    "M720 790C680 806 640 806 604 798",
  );
  assert.equal(
    role(right, "rollout").attrs.d,
    "M720 790C760 806 800 806 836 798",
  );
  assert.ok(
    end(role(left, "rollout").attrs.d)[0] < 720 &&
      end(role(right, "rollout").attrs.d)[0] > 720,
  );
  assert.deepEqual(end(role(left, "pass").attrs.d), [560, 232]);
  assert.deepEqual(end(role(right, "pass").attrs.d), [880, 232]);
  assert.equal(role(left, "passer").attrs.cx, 720);
  assert.equal(role(right, "passer").attrs.cx, 720);
  assert.equal(role(left, "rollout").attrs.stroke, "#3b82f6");
  // Every shape mirrors across x = 720.
  const xs = (d) =>
    [...d.matchAll(/[MLCQ]([^MLCQZ]+)/g)].flatMap((match) =>
      match[1]
        .trim()
        .split(" ")
        .map(Number)
        .filter((_, index) => index % 2 === 0),
    );
  assert.equal(left.shapes.length, right.shapes.length);
  left.shapes.forEach((shape, index) => {
    const other = right.shapes[index];
    assert.equal(shape.role, other.role);
    if (shape.tag === "circle")
      assert.equal(shape.attrs.cx, 1440 - other.attrs.cx);
    else
      assert.deepEqual(
        xs(shape.attrs.d),
        xs(other.attrs.d).map((x) => 1440 - x),
        shape.role,
      );
  });
  assert.deepEqual(
    plays.mirrorPath([["M", 100, 5], ["C", 1, 2, 3, 4, 5, 6], ["Z"]]),
    [["M", 1340, 5], ["C", 1439, 2, 1437, 4, 1435, 6], ["Z"]],
  );
  assert.equal(plays.pathData([["M", 1, 2], ["L", 3, 4], ["Z"]]), "M1 2L3 4Z");
  assert.ok(
    Object.isFrozen(left) &&
      Object.isFrozen(left.shapes) &&
      Object.isFrozen(left.shapes[0]),
  );
  assert.doesNotMatch(
    JSON.stringify(left),
    /<|script|javascript:|on[a-z]+=/i,
    "plain data, no markup",
  );
  // No labels: the art names no player or position.
  assert.equal(
    left.shapes.some((shape) => shape.tag === "text"),
    false,
  );
});

// ─── Ghost position canvas ───
test("ghost lines: two-word and compound positions split onto two lines, single words stay whole", () => {
  const cases = {
    QUARTERBACK: ["QUARTER", "BACK"],
    Quarterback: ["QUARTER", "BACK"],
    LINEBACKER: ["LINE", "BACKER"],
    "RUNNING BACK": ["RUNNING", "BACK"],
    "WIDE RECEIVER": ["WIDE", "RECEIVER"],
    "POINT GUARD": ["POINT", "GUARD"],
    HALFBACK: ["HALF", "BACK"],
    CORNERBACK: ["CORNER", "BACK"],
    GOALKEEPER: ["GOAL", "KEEPER"],
    SHORTSTOP: ["SHORT", "STOP"],
    "OUTSIDE LINEBACKER": ["OUTSIDE", "LINEBACKER"],
    "LEFT DEFENSIVE TACKLE": ["LEFT DEFENSIVE", "TACKLE"],
    "  tight   end ": ["TIGHT", "END"],
    PITCHER: ["PITCHER"],
    STRIKER: ["STRIKER"],
    SETTER: ["SETTER"],
    CENTER: ["CENTER"],
    BACK: ["BACK"],
    KEEPER: ["KEEPER"],
    GUARD: ["GUARD"],
  };
  for (const [position, lines] of Object.entries(cases))
    assert.deepEqual(shell.ghostLines(position), lines, position);
  for (const empty of ["", "   ", null, undefined, 7, {}])
    assert.deepEqual(shell.ghostLines(empty), [], String(empty));
  assert.deepEqual(shell.ghostLines("wide\u0000 receiver"), [
    "WIDE",
    "RECEIVER",
  ]);
  assert.ok(shell.ghostLines("X".repeat(200)).join("").length <= 40);
  // The shipped position: two lines that read back as the position itself.
  const shipped = shell.ghostLines(manifest.athlete.position);
  assert.equal(shipped.length, 2);
  assert.equal(shipped.join(""), manifest.athlete.position.toUpperCase().replace(/\s+/g, ""));
});

test("ghost size fits the column: min(cap, width / (longest line chars * 0.84))", () => {
  assert.equal(shell.GHOST_CAP, 220);
  assert.equal(shell.GHOST_CHAR_EM, 0.84);
  // The mockup's 1080px column: QUARTER (7 letters) -> floor(1080 / 5.88) = 183px.
  assert.equal(shell.ghostFontSize(["QUARTER", "BACK"], 1080), 183);
  assert.equal(shell.ghostFontSize(["PITCHER"], 2000), 220, "capped");
  assert.equal(
    shell.ghostFontSize(["WIDE", "RECEIVER"], 400),
    Math.floor(400 / (8 * 0.84)),
  );
  assert.equal(shell.ghostFontSize(["LINE", "BACKER"], 336), 66);
  assert.equal(shell.ghostFontSize(["A"], 1000, 90), 90);
  for (const [lines, width] of [
    [[], 800],
    [["QB"], 0],
    [["QB"], -5],
    [["QB"], NaN],
    [null, 800],
  ])
    assert.equal(shell.ghostFontSize(lines, width), 0);
});

function ghostHost(width) {
  const nodes = [];
  const doc = {
    createElement: (tag) => {
      const node = {
        tagName: tag,
        children: [],
        dataset: {},
        style: {},
        attributes: {},
        hidden: false,
        textContent: "",
        className: "",
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        getAttribute(name) {
          return this.attributes[name] ?? null;
        },
        append(...items) {
          this.children.push(...items);
        },
        remove() {
          this.removed = true;
          host.children = host.children.filter((item) => item !== this);
        },
      };
      nodes.push(node);
      return node;
    },
  };
  const host = {
    ownerDocument: doc,
    clientWidth: width,
    children: [{ id: "yur-franklin" }],
    prepend(node) {
      this.children.unshift(node);
    },
  };
  const listeners = new Map(),
    observers = [];
  const win = {
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
    requestAnimationFrame: (callback) => {
      callback();
      return 1;
    },
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.targets = [];
        observers.push(this);
      }
      observe(target) {
        this.targets.push(target);
      }
      disconnect() {
        this.disconnected = true;
      }
    },
  };
  return { host, win, listeners, observers };
}

test("the ghost renders behind Franklin, decorative, and re-fits when his column changes width", () => {
  const { host, win, listeners, observers } = ghostHost(1104);
  const ghost = shell.renderGhost(host, manifest.athlete.position, win);
  const element = host.children[0];
  assert.equal(element, ghost.element);
  assert.equal(
    host.children[1].id,
    "yur-franklin",
    "Franklin stays in his column after the ghost",
  );
  assert.equal(element.className, "yc-edition-ghost");
  assert.equal(element.getAttribute("aria-hidden"), "true");
  assert.deepEqual(
    element.children.map((line) => line.textContent),
    shell.ghostLines(manifest.athlete.position),
  );
  const longest = Math.max(
    ...shell.ghostLines(manifest.athlete.position).map((line) => line.length),
  );
  const expected = (width) =>
    Math.min(220, Math.floor((width - 24) / (longest * 0.84)));
  assert.equal(element.style.fontSize, expected(1104) + "px");
  assert.equal(element.hidden, false);
  // The side browser opens: the column narrows and the observer re-fits it.
  assert.deepEqual(observers[0].targets, [host]);
  host.clientWidth = 520;
  observers[0].callback();
  assert.equal(element.style.fontSize, expected(520) + "px");
  host.clientWidth = 1400;
  listeners.get("resize")();
  assert.equal(element.style.fontSize, expected(1400) + "px");
  host.clientWidth = 700;
  listeners.get("yur:native-layout")();
  assert.equal(element.style.fontSize, expected(700) + "px");
  host.clientWidth = 0;
  observers[0].callback();
  assert.equal(element.hidden, true, "no column, no ghost");
  ghost.dispose();
  assert.equal(observers[0].disconnected, true);
  assert.equal(listeners.size, 0);
  assert.equal(host.children.includes(element), false);
  assert.equal(
    shell.renderGhost(ghostHost(800).host, "", win),
    null,
    "no position, no ghost",
  );
  assert.equal(shell.renderGhost(null, "Quarterback", win), null);
});

test("the ghost styles: transparent fill, hairline stroke, Orbitron 900, no pointer, slow breathing that reduced motion stops", () => {
  const layout = read("src/edition-shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(
    layout,
    /#yur-conversation \.yc-edition-ghost \{[^}]*position: absolute;[^}]*z-index: 0;[^}]*pointer-events: none;/,
  );
  assert.match(
    layout,
    /#yur-conversation \.yc-franklin-main > \.yur-franklin \{ position: relative; z-index: 1; \}/,
  );
  assert.match(
    layout,
    /#yur-conversation \.yc-franklin-main \{ position: relative;/,
  );
  const finish = read("src/athletics-brand/athletics.css");
  assert.match(
    finish,
    /\.yc-edition-ghost \{\s*color: transparent; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1\.5px rgba\(228, 228, 231, \.11\);\s*font-family: var\(--ath-display\); font-weight: 900; letter-spacing: -\.02em;\s*animation: ath-ghost-breathe 9s ease-in-out infinite;/,
  );
  const reduced = finish.slice(
    finish.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(
    reduced,
    /body \*, html\[data-yur-edition="athletics"\] body \*::before \{ animation: none !important;/,
  );
  // Edition only: conversation-view renders it inside applyEdition and nowhere else; the Desktop never loads either stylesheet rule.
  const conversation = read("src/conversation-view.js");
  const calls = [...conversation.matchAll(/renderGhost/g)].map(
    (match) => match.index,
  );
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0] > conversation.indexOf("async function applyEdition(info)"),
  );
  assert.doesNotMatch(
    read("src/studio-editor.html"),
    /edition-shell\.css|athletics/,
  );
});

// ─── Any sport, any position ───
test("no shell code, style, launch page or prompt addendum assumes a sport or a position", () => {
  const python = read("foundry/franklin_cli.py");
  const addendum = python.slice(
    python.indexOf("def edition_addendum("),
    python.indexOf("def compile_request("),
  );
  const files = {
    "src/edition.js": read("src/edition.js"),
    "src/edition-shell.js": read("src/edition-shell.js"),
    "src/edition-shell.css": read("src/edition-shell.css"),
    "src/athletics-brand/athletics.css": read(
      "src/athletics-brand/athletics.css",
    ),
    "src/athletics-launch.html": read("src/athletics-launch.html"),
    "src/athletics-launch.js": read("src/athletics-launch.js"),
    "src/athletics-launch.css": read("src/athletics-launch.css"),
    "src/franklin-gridiron.js": read("src/franklin-gridiron.js"),
    edition_addendum: addendum,
  };
  for (const [name, text] of Object.entries(files)) {
    assert.doesNotMatch(text, /football|quarterback|\bQB\b/i, name);
    for (const athlete of athletes) assert.equal(text.includes(athlete.display_name), false, name);
  }
  // The play-art library is keyed by sport; the manifest picks from it.
  assert.deepEqual(plays.SPORTS, ["football"]);
  assert.match(addendum, /athlete\['sport'\]/);
});

test("with transparency effects off (reduced transparency) the ghost still shows: his column is the one solid surface", () => {
  const finish = read("src/athletics-brand/athletics.css");
  const reduced = finish.slice(finish.indexOf("@media (prefers-reduced-transparency: reduce)"));
  assert.match(reduced, /html\[data-yur-edition="athletics"\] body #yur-conversation \.yc-franklin-main \{ background: #000000; \}/);
  // #yur-franklin outranks the :is() list above it, which makes every panel opaque.
  assert.match(reduced, /html\[data-yur-edition="athletics"\] body #yur-franklin\[data-layout="main"\] \.yur-franklin-panel \{ background: transparent; \}/);
  // And no backdrop blur on his page in any mode: the hairline stays crisp.
  const mainPanel = finish.match(/body \.yur-franklin\[data-layout="main"\] \.yur-franklin-panel \{[^}]*\}/)[0];
  assert.doesNotMatch(mainPanel, /backdrop-filter/);
});

test("play art that cannot be drawn never stops the splash from entering", async () => {
  const doc = splashDom(), { win, calls } = splashWindow({ ok: true, result: launchInfo() });
  win.yurAthleticsPlays = { playArt: () => { throw new Error("fixture art failure"); } };
  await splash.start(win, doc);
  assert.equal(doc.getElementById("splash-position").textContent, manifest.athlete.position.toUpperCase());
  calls.timers[0].callback(); await flush();
  assert.equal(calls.enter, 1);
});
