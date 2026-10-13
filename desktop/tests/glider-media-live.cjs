'use strict';
// Explicit live acceptance: one admitted image and one short video on the
// operator-configured media worker. No pod lifecycle or global queue operations.
const { app, dialog, net } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const endpoint = process.env.YUR_MEDIA_LIVE_ENDPOINT;
const restart = process.argv.includes('--verify-restart');
const continuing = process.argv.includes('--continue');
const evidenceLabel = process.env.YUR_MEDIA_EVIDENCE_LABEL || 'media-live';
if (!/^[a-z0-9-]+$/.test(evidenceLabel)) throw new Error('Invalid evidence label');
const evidence = path.resolve(__dirname, '../../..', 'evidence/glider-rc6/comprehensive', evidenceLabel);
fs.mkdirSync(evidence, { recursive: true });
const receiptPath = path.join(evidence, 'media-live-receipt.json');
if (!restart && !continuing && (fs.existsSync(receiptPath) || fs.existsSync(path.join(evidence, 'media-live-progress.json')))) throw new Error('Evidence already exists. Use a new YUR_MEDIA_EVIDENCE_LABEL or explicitly restore the previous receipt.');
const prior = restart ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : continuing ? JSON.parse(fs.readFileSync(path.join(evidence, 'media-live-progress.json'), 'utf8')) : null;
const profile = prior?.profile || fs.mkdtempSync(path.join(os.tmpdir(), 'yur-glider-media-'));
if (path.dirname(profile) !== os.tmpdir() || !path.basename(profile).startsWith('yur-glider-media-')) throw new Error('Only this fixture private profile may be used');
if (!restart && !endpoint) throw new Error('Set YUR_MEDIA_LIVE_ENDPOINT explicitly for paid/cloud rendering acceptance');
process.env.YUR_GLIDER_RC6 = '1'; process.env.YUR_HARNESS_AUTOSTART = '0';
process.env.YUR_DESKTOP_HOME = path.join(profile, 'desktop'); process.env.YUR_FACTORY_HOME = path.join(profile, 'factory');
app.setPath('userData', path.join(profile, 'electron'));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('mute-audio');
const checks = [], captures = [], errors = [], saved = { profile, at: new Date().toISOString(), image: prior?.image, video: prior?.video };
const deadline = setTimeout(() => { fs.writeFileSync(path.join(evidence, 'timeout.json'), JSON.stringify(saved, null, 2)); console.error('Media live acceptance deadline; saved provider receipts must be resumed, never blindly resubmitted.'); app.exit(1); }, 15 * 60 * 1000);
let started = false;
app.on('browser-window-created', (_event, win) => {
  if (started) return; started = true;
  win.webContents.setBackgroundThrottling(false); win.setFocusable(false); win.setOpacity(0); win.setPosition(-16000, -16000); win.setSkipTaskbar(true);
  win.webContents.on('preload-error', (_e, _f, error) => errors.push(error.message));
  win.webContents.once('did-finish-load', async () => {
    const evaluate = code => win.webContents.executeJavaScript(code);
    const wait = async (condition, timeout = 45000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await evaluate(condition)) return; await new Promise(resolve => setTimeout(resolve, 300)); }
      throw new Error('Media acceptance timed out: ' + condition);
    };
    const checkpoint = () => fs.writeFileSync(path.join(evidence, 'media-live-progress.json'), JSON.stringify(saved, null, 2));
    const capture = async name => {
      try { const image = await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true }), new Promise((_, reject) => setTimeout(() => reject(new Error('Capture timed out')), 2500))]); fs.writeFileSync(path.join(evidence, name + '.png'), image.toPNG()); captures.push(name + '.png'); }
      catch (error) { captures.push({ name, error: error.message }); }
    };
    const inspect = id => evaluate(`window.studio.media.inspect({job_id:${JSON.stringify(id)}})`);
    const waitJob = async job => {
      const end = Date.now() + 10 * 60 * 1000;
      let previous = '';
      while (Date.now() < end) {
        const current = await inspect(job.id);
        if (current.state !== previous) { console.log('Live media ' + job.id + ': ' + current.state); previous = current.state; }
        if (current.state === 'failed') throw new Error(current.error || 'Media job failed');
        if (current.state === 'completed') return current;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new Error('Live job retains its receipt but exceeded acceptance wait: ' + job.id);
    };
    const refreshView = async () => { await evaluate(`[...document.querySelectorAll('.ym-head button')].find(b=>b.textContent==='Refresh jobs').click()`); await new Promise(resolve => setTimeout(resolve, 700)); };
    const verifyPreview = async (job, kind) => {
      await refreshView();
      await wait(`!!document.querySelector('[data-media-job="${job.id}"]')`);
      await evaluate(`[...document.querySelectorAll('[data-media-job="${job.id}"] button')].find(b=>b.textContent===${JSON.stringify(kind === 'image' ? 'Show image' : 'Play preview')}).click()`);
      if (kind === 'image') {
        await wait(`(()=>{const image=document.querySelector('[data-media-job="${job.id}"] img');return image&&image.complete&&image.naturalWidth===512&&image.naturalHeight===512})()`);
      } else {
        await wait(`(()=>{const video=document.querySelector('[data-media-job="${job.id}"] video');return video&&video.readyState>=1&&video.videoWidth===512&&video.videoHeight===288&&video.duration>0})()`);
        await evaluate(`const video=document.querySelector('[data-media-job="${job.id}"] video');video.currentTime=Math.min(.25,video.duration/2);true`);
        await wait(`(()=>{const video=document.querySelector('[data-media-job="${job.id}"] video');return video&&!video.seeking&&video.currentTime>0&&video.readyState>=2})()`);
      }
      const asset = await evaluate(`window.studio.media.asset({asset_id:${JSON.stringify(job.assets[0].id)}})`);
      assert.equal(Object.hasOwn(asset, 'path'), false);
      const head = await net.fetch(asset.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), asset.bytes);
      const range = await net.fetch(asset.url, { headers: { Range: 'bytes=0-31' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
      const destination = path.join(evidence, kind + '.' + asset.extension);
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
      await evaluate(`[...document.querySelectorAll('[data-media-job="${job.id}"] button')].find(b=>b.textContent==='Save a copy').click()`);
      const until = Date.now() + 10000; while (!fs.existsSync(destination) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
      const raw = fs.readFileSync(destination); assert.equal(raw.length, asset.bytes); assert.equal(createHash('sha256').update(raw).digest('hex'), asset.id);
      checks.push(`${kind}: native UI decoded dimensions, trusted protocol HEAD/range, exact hashed native export`);
      return destination;
    };
    try {
      await assert.rejects(evaluate('window.studio.media.catalog()'), /Untrusted studio/);
      const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
      await evaluate('setTimeout(()=>window.studio.launch.enter(),25);true'); await loaded;
      await wait('!!document.getElementById("yc-media-open")');
      await evaluate('document.getElementById("yc-media-open").click()');
      await wait('!!document.querySelector(".ym-primary")&&!document.querySelector(".ym-primary").disabled');
      checks.push('Glider splash boundary and real Desktop Images & video navigation');
      if (!restart) {
        const configured = await evaluate(`window.studio.media.configure({endpoint:${JSON.stringify(endpoint)}})`);
        assert.equal(configured.endpoint, endpoint.replace(/\/$/, ''));
        const health = await evaluate('window.studio.media.status()');
        assert.ok(health.presets.every(item => item.ready));
        checks.push('Real configured cloud worker and both admitted models ready');
        if (!saved.image) {
          await evaluate(`document.querySelector('[aria-label="Describe your image or video"]').value='A cinematic modern creative city at blue hour, blue slate architecture, brushed silver details, trees and canal reflections, elegant natural composition, no text';document.querySelector('[aria-label="Width"]').value='512';document.querySelector('[aria-label="Height"]').value='512';document.querySelector('.ym-panel').requestSubmit();true`);
          await wait(`window.studio.media.list({limit:10}).then(r=>r.jobs.some(j=>j.request.preset==='flux-klein-image-v1'))`, 180000);
          saved.image = await evaluate(`window.studio.media.list({limit:10}).then(r=>r.jobs.find(j=>j.request.preset==='flux-klein-image-v1'))`); checkpoint();
        }
        saved.image = await waitJob(saved.image); checkpoint();
        assert.equal(saved.image.validation.passed, true);
        saved.image_export = await verifyPreview(saved.image, 'image'); await capture('image-generation'); checkpoint();
        if (!saved.video) {
          await evaluate(`[...document.querySelectorAll('[data-media-job="${saved.image.id}"] button')].find(b=>b.textContent==='Use as starting image').click();true`);
          await wait(`document.querySelector('.ym-panel').textContent.includes('Starting image · 512 × 512')`);
          await evaluate(`const preset=document.querySelector('[aria-label="Workflow"]');preset.value='wan22-video-v1';preset.dispatchEvent(new Event('change'));document.querySelector('[aria-label="Describe your image or video"]').value='A smooth slow camera glide forward, gentle water reflections and subtle natural motion, preserve the city architecture';document.querySelector('[aria-label="Width"]').value='512';document.querySelector('[aria-label="Height"]').value='288';document.querySelector('[aria-label="Video frames"]').value='17';document.querySelector('.ym-panel').requestSubmit();true`);
          await wait(`window.studio.media.list({limit:10}).then(r=>r.jobs.some(j=>j.request.preset==='wan22-video-v1'))`, 180000);
          saved.video = await evaluate(`window.studio.media.list({limit:10}).then(r=>r.jobs.find(j=>j.request.preset==='wan22-video-v1'))`); checkpoint();
        }
        saved.video = await waitJob(saved.video); checkpoint();
        assert.equal(saved.video.validation.passed, true); assert.equal(saved.video.request.input_asset_id, saved.image.assets[0].id);
        saved.video_export = await verifyPreview(saved.video, 'video'); await capture('video-generation'); checkpoint();
      } else {
        const listing = await evaluate('window.studio.media.list({limit:100})');
        for (const job of [saved.image, saved.video]) {
          const restored = listing.jobs.find(value => value.id === job.id);
          assert.equal(restored.state, 'completed'); assert.deepEqual(restored.receipt, job.receipt); assert.deepEqual(restored.assets, job.assets);
        }
        await verifyPreview(saved.image, 'image'); await verifyPreview(saved.video, 'video');
        checks.push('Second Electron process restored exact job receipts/assets without any generation submission');
      }
      assert.deepEqual(errors, []);
      const result = { ...saved, ok: true, restart, checks, captures, errors, limitations: ['Video integrity check decodes the first frame; artistic quality is a human preview decision', 'No pod lifecycle or cancellation of existing jobs exercised'] };
      fs.writeFileSync(restart ? path.join(evidence, 'media-restart-receipt.json') : receiptPath, JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ ok: true, restart, profile, checks, image_job: saved.image.id, video_job: saved.video.id, evidence }));
      clearTimeout(deadline); app.quit();
    } catch (error) {
      saved.error = error.stack;
      try { saved.ui_status = await evaluate('document.querySelector(".ym-status")?.textContent'); saved.jobs = await evaluate('window.studio.media.list({limit:100})'); } catch {}
      fs.writeFileSync(path.join(evidence, 'media-live-failure.json'), JSON.stringify(saved, null, 2));
      console.error(error.stack); clearTimeout(deadline); app.exit(1);
    }
  });
});
require('../src/main.js');
