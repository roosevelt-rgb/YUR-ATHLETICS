'use strict';
// Real Desktop host/preload/renderer; isolated profile and local model fixture.
// Navigation and computed styles only: no generation, purchase or user mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { nativeFixture } = require('./specialists-smoke.cjs');
process.env.YUR_GLIDER_RC6 = '1';
process.env.YUR_HARNESS_AUTOSTART = '0';
process.env.YUR_MUSIC_APP_ROOT = path.join(__dirname, 'fixtures', 'unconfigured-music');
app.on('browser-window-created', (_event, window) => {
  window.setFocusable(false); window.setOpacity(0); window.setPosition(-16000, -16000); window.setSkipTaskbar(true);
});
const routes = [
  ['home', '#yc-new-chat'], ['activity', '#yc-activity-open'],
  ['agents', '[data-workspace="agents"]'], ['capabilities', '[data-workspace="tools"]'],
  ['workflows', '[data-workspace="workflows"]'], ['vault', '[data-workspace="vault"]'],
  ['projects', '#yc-projects-open'], ['marketplace', '#yc-marketplace-open'],
  ['workforce', '#yc-workforce-open'], ['images-video', '#yc-media-open'],
  ['music', '#yc-music-open'], ['unreal', '#yc-unreal-open'],
  ['deployed-agents', '#yc-lifecycles-open'], ['organism', '#yc-organism-open'],
  ['schedules', '#yc-schedules-open'], ['recent-work', '#yc-recent-work-open'],
  ['settings', '#yc-settings-open'], ['editor', '[data-workspace="files"]'],
  ['coding-harness', '#glider-coding'],
];
const observe = `(() => {
  const rgb = s => (s.match(/[\\d.]+/g) || []).map(Number);
  const visible = n => { const r=n.getBoundingClientRect(),s=getComputedStyle(n); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none'; };
  const regions=[...document.querySelectorAll('body,main,aside,section,form,dialog,textarea,input,select,[class*="card"],[class*="panel"]')].filter(visible).map(n=>{
    const s=getComputedStyle(n),r=n.getBoundingClientRect();
    return {selector:n.id?'#'+n.id:n.tagName.toLowerCase()+'.'+[...n.classList].join('.'),background:s.backgroundColor,color:s.color,width:r.width,height:r.height};
  });
  const unexpectedLight=regions.filter(r=>{const c=rgb(r.background);return c.length>=3&&(c.length<4||c[3]>.9)&&Math.min(...c.slice(0,3))>200&&r.width*r.height>12000;});
  const surface=getComputedStyle(document.body);
  return {body:surface.backgroundColor,color:surface.color,palette:surface.getPropertyValue('--yf-panel').trim(),viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,regions,unexpectedLight};
})()`;
nativeFixture({ prefix: 'desktop-theme', model: 'theme-fixture', gracefulShutdown: true, timeoutMs: 240000,
  handle() { throw new Error('Theme navigation must not submit a model request'); },
  async run(ctx) {
    const { evaluate, waitFor } = ctx;
    const main = BrowserWindow.getAllWindows().find(w => /studio-editor\.html$/.test(w.webContents.getURL()));
    ctx.proof.surfaces = []; ctx.proof.scope = 'First-party Desktop chrome; authored browser/artifact content and OS-native dialogs retain their own colors.';
    const capture = async (name, window = main) => {
      await new Promise(resolve => setTimeout(resolve, 240));
      const observation = await window.webContents.executeJavaScript(observe);
      ctx.proof.surfaces.push({ name, ...observation });
      assert.ok(observation.palette, name + ': shared palette must be loaded');
      assert.deepEqual(observation.unexpectedLight, [], name + ': large unthemed light surface');
      assert.ok(observation.documentWidth <= observation.viewport.width + 1, name + ': document overflows the actual viewport');
      const image = await window.webContents.capturePage(undefined, { stayHidden: true });
      const target = path.join(ctx.tempRoot, 'desktop-theme-' + name + '.png'); fs.writeFileSync(target, image.toPNG()); ctx.screenshots[name] = target;
      ctx.checks.push(name + ': real mounted page uses the shared dark palette with no large light panel');
    };
    await waitFor('document.body.classList.contains("glider-enabled")');
    for (const [menu, action, expected] of [
      ['file','Projects','document.getElementById("yc-preferences-panel").dataset.kind === "project"'],
      ['view','Settings','document.getElementById("yc-preferences-panel").dataset.kind === "settings"'],
      ['edit','Search conversations','document.getElementById("yc-history-search").getBoundingClientRect().height > 0 && document.activeElement === document.getElementById("yc-history-search")'],
      ['help','Using your Desktop','document.querySelector("dialog[open] h2")?.textContent === "Using your Desktop"']
    ]) {
      await evaluate(`document.querySelector('[data-desktop-menu="${menu}"]').click(); true;`);
      await capture('menu-'+menu);
      await evaluate(`[...document.querySelectorAll('dialog[open] .yc-dialog-body button')].find(b=>b.textContent===${JSON.stringify(action)}).click(); true;`);
      await waitFor(expected);
      await evaluate('document.querySelectorAll("dialog[open]").forEach(d=>d.close()); true;');
      ctx.checks.push(menu+' menu dispatches its existing '+action+' workflow');
    }
    for (const [name, selector] of routes) {
      await evaluate('document.getElementById("glider-desktop").click(); document.getElementById("yc-new-chat").click(); true;');
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true;`);
      await capture(name);
      if (name === 'editor') {
        await evaluate('document.getElementById("yc-intelliflow-files-tab").click(); true;');
        await waitFor('!document.querySelector(".yc-studio-body").hidden'); await capture('editor-and-previews');
        const tabsBefore = await evaluate('state.openTabs.length');
        await evaluate('document.querySelector("[data-desktop-menu=file]").focus(); document.querySelector("[data-desktop-menu=file]").click(); true;');
        assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true);
        for (const [key,modifiers] of [['N',['control']],['P',['control','shift']]]) {
          main.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers});
          main.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers});
        }
        await new Promise(resolve=>setTimeout(resolve,80));
        assert.equal(await evaluate('state.openTabs.length'), tabsBefore);
        assert.equal(await evaluate('document.getElementById("palette").classList.contains("hidden")'), true);
        main.webContents.sendInputEvent({type:'keyDown',keyCode:'ESCAPE'});
        main.webContents.sendInputEvent({type:'keyUp',keyCode:'ESCAPE'});
        await waitFor('!document.querySelector("dialog[open]")');
        assert.equal(await evaluate('document.activeElement===document.querySelector("[data-desktop-menu=file]")'), true);
        ctx.checks.push('File menu traps focus, blocks underlying editor shortcuts and restores trigger focus on native Escape');
        await evaluate('window.togglePalette(); true;'); await capture('command-palette');
        await evaluate('window.togglePalette(); window.yurWorkspace.command("mermaid");'); await capture('diagram-preview');
        await evaluate('window.yurWorkspace.command("html");'); await capture('html-preview-chrome');
      }
      if (name === 'coding-harness') {
        for (const tab of ['tools','agents','terminal','activity','system']) {
          await evaluate(`document.querySelector('[data-observer-tab="${tab}"]').click(); true;`);
          await capture('coding-observer-'+tab);
        }
      }
      if (name === 'settings') {
        await waitFor('document.querySelectorAll(".ys-sidebar button[aria-current]").length === 24');
        const pages = await evaluate('[...document.querySelectorAll(".ys-sidebar button[aria-current]")].map(b=>b.textContent)');
        for (const [index,label] of pages.entries()) {
          await evaluate(`[...document.querySelectorAll('.ys-sidebar button[aria-current]')].find(b=>b.textContent===${JSON.stringify(label)}).click(); true;`);
          await capture('settings-'+String(index+1).padStart(2,'0'));
        }
      }
    }
    await evaluate('document.getElementById("glider-desktop").click(); document.getElementById("yc-new-chat").click(); document.getElementById("franklin-toggle").click(); true;');
    await waitFor('!document.getElementById("franklin-panel").hidden'); await capture('franklin');
    await evaluate('document.getElementById("franklin-close").click(); document.getElementById("yc-context-toggle").click(); true;'); await capture('work-details');
    await evaluate('document.getElementById("yc-context-toggle").click(); document.getElementById("yc-browser-toggle").click(); true;'); await capture('browser-chrome');
    await evaluate('document.getElementById("yc-browser-toggle").click(); document.getElementById("glider-foundry").click(); true;');
    let factory;
    const deadline=Date.now()+15000;
    while(Date.now()<deadline) { factory=BrowserWindow.getAllWindows().find(w=>/factory\.html$/.test(w.webContents.getURL())); if(factory&&!factory.webContents.isLoading())break; await new Promise(resolve=>setTimeout(resolve,100)); }
    assert.ok(factory, 'Factory window opens through the actual frame'); await capture('factory', factory); factory.close();
    ctx.proof.window_sizes = [];
    for (const [width,height] of [[1024,768],[800,500]]) {
      main.setContentSize(width,height);
      await new Promise(resolve=>setTimeout(resolve,300));
      ctx.proof.window_sizes.push({ requested_content:{width,height}, content:main.getContentSize(), bounds:main.getBounds(), viewport:await evaluate('({width:innerWidth,height:innerHeight})') });
      for (const [name, selector] of routes.filter(([name]) => ['home','settings','music','images-video','unreal','coding-harness'].includes(name))) {
        await evaluate('document.getElementById("glider-desktop").click(); document.getElementById("yc-new-chat").click(); true;');
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true;`); await capture(name+'-'+width);
      }
    }
    assert.equal(ctx.requests.length,0);
  }
});
