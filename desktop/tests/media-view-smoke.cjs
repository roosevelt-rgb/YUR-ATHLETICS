'use strict';
// Real renderer DOM, fake operator API. No model, provider, microphone or shell UI.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-media-view-'));
app.setPath('userData', path.join(home, 'electron'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('mute-audio');
const checks = [];
let win;
async function run(script) { return win.webContents.executeJavaScript(script, true); }
async function until(script) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await run(script)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timed out: ' + script);
}
const fixture = `<!doctype html><html><body><main id="media"></main></body></html>`;
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const fixturePath = path.join(home, 'fixture.html');
  fs.writeFileSync(fixturePath, fixture);
  await win.loadFile(fixturePath);
  await run(fs.readFileSync(path.join(__dirname, '../src/media-view.js'), 'utf8'));
  await run(`window.calls=[]; window.jobs=[];
    const stamp=new Date().toISOString();
    window.api={
      catalog:async()=>({presets:[{id:'flux-klein-image-v1',label:'Flux image',kind:'image',width:1024,height:1024},{id:'wan22-video-v1',label:'Wan video',kind:'video',width:832,height:480,frames:49}]}),
      list:async()=>({jobs:window.jobs}),
      status:async()=>({endpoint:'https://media.example.test',ready:true,presets:[{id:'flux-klein-image-v1',ready:true}]}),
      configure:async x=>{calls.push(['configure',x]);return x},
      importImage:async()=>({id:'a'.repeat(64),kind:'image',width:256,height:256}),
      submit:async({request})=>{calls.push(['submit',request]);const j={id:request.request_id.replaceAll('-',''),revision:1,state:'queued',created_at:stamp,request,assets:[],provider:{provider:'comfy-media'}};jobs.unshift(j);return j},
      resume:async({job_id})=>{calls.push(['resume',job_id]);return jobs.find(j=>j.id===job_id)},
      cancel:async({job_id})=>{calls.push(['cancel',job_id]);const j=jobs.find(j=>j.id===job_id);j.state='cancelled';return j},
      asset:async()=>({url:'yur-media://asset/'+ 'a'.repeat(64)}),
      exportAsset:async x=>{calls.push(['export',x]);return {cancelled:false}}
    };
    window.view=YurMediaView.create(document.getElementById('media'),{api}); view.ready;`);
  await until(`!!document.querySelector('.ym-primary')&&!document.querySelector('.ym-primary').disabled`);
  assert.equal(await run(`document.querySelector('[aria-label="Width"]').value`), '1024');
  assert.equal(await run(`getComputedStyle(document.querySelector('[aria-label="Video frames"]').parentElement).display`), 'none');
  checks.push('Image defaults and video-only settings hidden');
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Check connection').click()`);
  await until(`document.querySelector('[aria-label="Image service endpoint"]').value==='https://media.example.test'`);
  assert.equal(await run(`document.querySelector('[aria-label="Video service endpoint"]').value`), 'https://media.example.test');
  checks.push('Existing shared endpoint remains visible for both media kinds');
  await run(`api.status=async()=>({image_endpoint:'https://images.example.test',video_endpoint:'https://video.example.test',endpoint:'',ready:true,presets:[{id:'flux-klein-image-v1',kind:'image',ready:true},{id:'wan22-video-v1',kind:'video',ready:false,notice:'Video worker is unavailable'}]});
    document.querySelector('[aria-label="Image service endpoint"]').value='https://images.example.test';
    document.querySelector('[aria-label="Video service endpoint"]').value='https://video.example.test';
    [...document.querySelectorAll('button')].find(b=>b.textContent==='Save connections').click()`);
  await until(`calls.some(x=>x[0]==='configure') && document.querySelector('.ym-config').textContent.includes('Video worker is unavailable')`);
  assert.deepEqual(await run(`calls.find(x=>x[0]==='configure')[1]`), { image_endpoint: 'https://images.example.test', video_endpoint: 'https://video.example.test' });
  assert.equal(await run(`document.querySelector('[aria-label="Video service endpoint"]').value`), 'https://video.example.test');
  checks.push('Independent image/video endpoint save and per-workflow health remain distinct');
  await run(`const unavailable=document.querySelector('[aria-label="Workflow"]');unavailable.value='wan22-video-v1';unavailable.dispatchEvent(new Event('change'));document.querySelector('form').requestSubmit()`);
  assert.equal(await run(`document.querySelector('.ym-primary').disabled`), true);
  assert.equal(await run(`calls.filter(x=>x[0]==='submit').length`), 0);
  checks.push('Unavailable video cannot inherit a healthy image service');
  await run(`api.status=async()=>({image_endpoint:'https://images.example.test',video_endpoint:'https://video.example.test',ready:true,presets:[{id:'flux-klein-image-v1',ready:true},{id:'wan22-video-v1',ready:true}]});
    [...document.querySelectorAll('button')].find(b=>b.textContent==='Check connection').click()`);
  await until(`!document.querySelector('.ym-primary').disabled`);
  await run(`const image=document.querySelector('[aria-label="Workflow"]');image.value='flux-klein-image-v1';image.dispatchEvent(new Event('change'))`);
  await run(`document.querySelector('[aria-label="Describe your image or video"]').value='Silver abstract sculpture';document.querySelector('form').requestSubmit()`);
  await until(`calls.filter(x=>x[0]==='submit').length===1 && document.querySelectorAll('[data-media-job]').length===1`);
  const imageRequest = await run(`calls.find(x=>x[0]==='submit')[1]`);
  assert.equal(imageRequest.preset, 'flux-klein-image-v1'); assert.equal(imageRequest.prompt, 'Silver abstract sculpture'); assert.equal(imageRequest.width, 1024);
  assert.equal(Object.hasOwn(imageRequest, 'frames'), false);
  checks.push('Image form sends exact typed request and renders durable job');
  await run(`const p=document.querySelector('[aria-label="Workflow"]');p.value='wan22-video-v1';p.dispatchEvent(new Event('change'));document.querySelector('form').requestSubmit()`);
  await until(`document.querySelector('.ym-status').textContent.includes('starting image')`);
  assert.equal(await run(`calls.filter(x=>x[0]==='submit').length`), 1);
  checks.push('Video without starting image is rejected before API submission');
  await run(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Choose starting image').click()`);
  await until(`document.querySelector('.ym-panel').textContent.includes('256 × 256')`);
  await run(`document.querySelector('[aria-label="Describe your image or video"]').value='Slow camera orbit';document.querySelector('form').requestSubmit()`);
  await until(`calls.filter(x=>x[0]==='submit').length===2`);
  const videoRequest = await run(`calls.filter(x=>x[0]==='submit')[1][1]`);
  assert.equal(videoRequest.input_asset_id, 'a'.repeat(64)); assert.equal(videoRequest.frames, 49); assert.equal(videoRequest.width, 832); assert.equal(videoRequest.height, 480);
  checks.push('Video request binds imported image, dimensions and duration');
  await until(`document.querySelectorAll('[data-media-job]').length===2`);
  await run(`[...document.querySelectorAll('[data-media-job] button')].find(b=>b.textContent==='Cancel queued job').click()`);
  await until(`calls.some(x=>x[0]==='cancel')`);
  assert.equal(await run(`calls.filter(x=>x[0]==='cancel').length`), 1);
  checks.push('Cancel names only the selected saved job');
  await run(`view.dispose()`);
  assert.equal(await run(`document.querySelectorAll('.ym-root').length`), 0);
  checks.push('Dispose removes the panel and polling timer');
  const result = { ok: true, checks, profile: home, limitations: ['API is a mock; this fixture does not prove remote generation or native file dialogs'] };
  fs.writeFileSync(path.join(home, 'media-view-receipt.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
