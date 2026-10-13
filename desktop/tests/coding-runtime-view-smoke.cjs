'use strict';
// Real Electron DOM/layout with controlled local API promises. No provider or gateway.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const source = path.resolve(__dirname, '../src');
const evidence = path.resolve(__dirname, '../../..', 'evidence/glider-rc6/comprehensive/completion-2026-10-05/coding-runtime-view');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-coding-view-'));
fs.mkdirSync(evidence, { recursive: true });
const attempt = path.join(evidence, 'attempt-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(attempt);
const tracked = ['glider-frame.js', 'glider-frame.css', 'glider-theme.css', 'rc6-observer-view.js', 'rc6-observer-view.css'];
const hashes = () => Object.fromEntries(tracked.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex')]));
const receipt = { started_at: new Date().toISOString(), profile, attempt, checks: [], before: hashes(), limitations: ['Real renderer and product CSS, synthetic host APIs only; native host/gateway authorization is independently tested.', 'No external requests, provider inference, media rendering or installation performed.'] };
app.setPath('userData', path.join(profile, 'electron'));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('mute-audio');
let win;
const run = script => win.webContents.executeJavaScript('(()=>{' + script + '})()', true);
async function until(script, label = script) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await run('return (' + script + ')')) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out: ' + label);
}
async function check(name, action) {
  try { await action(); receipt.checks.push({ name, passed: true }); }
  catch (error) { receipt.checks.push({ name, passed: false, error: error.stack }); }
}
const setup = `
  window.fixture = { calls: [], pending: {}, deferred: new Set(), failures: {}, listeners: [], current: 'rc6', serial: 0, sessionSerial: 0, executed: false };
  const f = window.fixture;
  f.status = key => ({ runtimeKey:key, runtimeName:key==='rc6'?'IntelliFlow':'IntelliFlow Construction V1', scope:key==='rc6'?'coding':'construction-master', running:false, installed:true, workspace:'isolated-'+key, model:'fixture-model', modelSource:'selection', baseUrl:'http://127.0.0.1/fixture', workbench:key==='construction-v1'?{available:true,executable:'C:/fixture/intelliflow-construction-v1.exe',argument:'--open-master-orcha'}:null });
  f.call = (name,args,value) => { f.calls.push({name,args}); if (f.failures[name]) { const message=f.failures[name]; delete f.failures[name]; return Promise.reject(new Error(message)); } if (f.deferred.has(name)) return new Promise((resolve,reject) => f.pending[name]={resolve,reject}); return Promise.resolve(value); };
  f.emit = event => f.listeners.forEach(listener=>listener(event));
  f.resolve = (name,value) => { f.deferred.delete(name); f.pending[name].resolve(value); delete f.pending[name]; };
  f.reject = (name,message) => { f.deferred.delete(name); f.pending[name].reject(new Error(message)); delete f.pending[name]; };
  window.studio={ integration:{info:async()=>({enabled:true})}, ollama:{tags:async()=>({models:[{name:'fixture-model'},{name:'second-model'}]})}, factory:{open:async()=>{}}, window:{minimize(){},toggleMaximize(){},close(){}}, rc6:{
    availableRuntimes:async()=>['rc6','construction-v1'].map(key=>f.status(key)), status:async()=>f.status(f.current),
    chooseRuntime:key=>f.call('chooseRuntime',[key],f.status(key)).then(value=>{f.current=value.runtimeKey;return value}),
    chooseWorkspace:()=>f.call('chooseWorkspace',[],{...f.status(f.current),workspace:'new-isolated-workspace'}),
    connect:model=>f.call('connect',[model],{...f.status(f.current),running:true,model}),
    openWorkbench:()=>f.call('openWorkbench',[],{state:'dispatched',pid:4242}),
    disconnect:()=>{f.emit({type:'bridge.stopped',runtimeKey:f.current,payload:{}});return f.call('disconnect',[],{})},
    createSession:()=>f.call('createSession',[],{session_id:'session-'+(++f.sessionSerial)}),
    submit:(...args)=>f.call('submit',args,{}), interrupt:(...args)=>f.call('interrupt',args,{}),
    approval:(...args)=>f.call('approval',args,{}), onEvent:listener=>{f.listeners.push(listener);return()=>{}},
    inventory:async()=>({capabilities:[]}), health:async()=>({status:'fixture'}), info:async()=>({harness_id:'fixture'}), delegationStatus:async()=>({active:[]}),
    console:(session,command)=>f.call('console',[session,command],{requestId:'console-'+(++f.serial),sessionId:session,runtimeKey:f.current,command,stdout:'fixture-output',code:0,policy:'read-only'})
  }};
  window.yurModelSetup={summarize:({ollama})=>({models:ollama.models.map(model=>({id:'ollama:'+model.name,label:model.name}))})};
`;
async function fresh() {
  await win.loadFile(path.join(profile, 'fixture.html'));
  await run(setup);
  await run(fs.readFileSync(path.join(source, 'rc6-observer-view.js'), 'utf8'));
  await run(fs.readFileSync(path.join(source, 'glider-frame.js'), 'utf8'));
  await run(`window.dispatchEvent(new Event('DOMContentLoaded'));`);
  await until(`document.querySelector('#rc6-runtime')?.options.length===2`);
  await run(`document.querySelector('#glider-coding').click();`);
  await until(`!document.querySelector('#rc6-model').disabled`);
  await run(`const picker=document.querySelector('#rc6-model');picker.value='ollama:fixture-model';picker.dispatchEvent(new Event('change'));`);
}
async function connectedSession() {
  await fresh(); await run(`document.querySelector('#rc6-connect').click()`);
  await until(`!document.querySelector('#rc6-new').disabled`);
  await run(`document.querySelector('#rc6-new').click()`);
  await until(`!document.querySelector('#rc6-prompt').disabled`);
}
async function screenshot(name) {
  try { const image = await Promise.race([win.webContents.capturePage(undefined, { stayHidden:true }), new Promise((_,reject)=>setTimeout(()=>reject(new Error('capture timeout')),3000))]); fs.writeFileSync(path.join(attempt,name+'.png'),image.toPNG()); }
  catch(error) { (receipt.capture_limits ||= []).push(name+': '+error.message); }
}
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('file:')&&!details.url.startsWith('data:')}));
  const css=tracked.filter(name=>name.endsWith('.css')).map(name=>'<link rel="stylesheet" href="'+pathToFileURL(path.join(source,name)).href+'">').join('');
  fs.writeFileSync(path.join(profile,'fixture.html'),'<!doctype html><html><head>'+css+'</head><body style="margin:0"></body></html>');
  await check('RC6 and Construction selector uses actual labels and keeps selected model across a disconnected switch',async()=>{
    await fresh();
    assert.deepEqual(await run(`return [...document.querySelector('#rc6-runtime').options].map(o=>[o.value,o.textContent,o.disabled]);`),[['rc6','IntelliFlow',false],['construction-v1','IntelliFlow Construction V1',false]]);
    await run(`const p=document.querySelector('#rc6-runtime');p.value='construction-v1';p.dispatchEvent(new Event('change'));`);
    await until(`document.querySelector('#rc6-runtime-title').textContent==='IntelliFlow Construction V1'`);
    assert.equal(await run(`return document.querySelector('#rc6-model').value`),'ollama:fixture-model');
    assert.match(await run(`return document.querySelector('#rc6-runtime-scope').textContent`),/department transport is not connected/);
    assert.equal(await run(`return document.querySelector('#rc6-workbench').hidden`),false);
    assert.equal(await run(`return document.querySelector('#rc6-workbench').disabled`),false);
    await run(`document.querySelector('#rc6-workbench').click()`); await until(`fixture.calls.some(c=>c.name==='openWorkbench')`);
  });
  await check('Rejected runtime switch retains prior harness and permits retry',async()=>{
    await fresh(); await run(`fixture.failures.chooseRuntime='Fixture verification rejected';const p=document.querySelector('#rc6-runtime');p.value='construction-v1';p.dispatchEvent(new Event('change'));`);
    await until(`document.querySelector('#rc6-state').textContent==='Fixture verification rejected'`);
    assert.equal(await run(`return document.querySelector('#rc6-runtime').value`),'rc6');
    assert.equal(await run(`return document.querySelector('#rc6-runtime-title').textContent`),'IntelliFlow');
    assert.equal(await run(`return document.querySelector('#rc6-runtime').disabled`),false);
  });
  await check('Connected harness and model are locked; injected change cannot switch the runtime',async()=>{
    await connectedSession();
    assert.deepEqual(await run(`return ['rc6-runtime','rc6-workspace','rc6-model','rc6-refresh-models','rc6-connect'].map(id=>document.getElementById(id).disabled)`),[true,true,true,true,true]);
    await run(`const p=document.querySelector('#rc6-runtime');p.value='construction-v1';p.dispatchEvent(new Event('change'));`);
    assert.equal(await run(`return document.querySelector('#rc6-runtime').value`),'rc6');
    assert.equal(await run(`return fixture.calls.filter(c=>c.name==='chooseRuntime').length`),0);
  });
  await check('Late connect resolution and rejection cannot revive a disconnected runtime or replace its status',async()=>{
    for(const reject of [false,true]){
      await fresh(); await run(`fixture.deferred.add('connect');document.querySelector('#rc6-connect').click();fixture.emit({type:'bridge.stopped',runtimeKey:'rc6',payload:{}});`);
      await run(reject?`fixture.reject('connect','late failure');`:`fixture.resolve('connect',{...fixture.status('rc6'),running:true,model:'late-model'});`);
      await until(`!document.querySelector('#rc6-runtime').disabled`);
      assert.equal(await run(`return document.querySelector('#rc6-new').disabled`),true);
      assert.equal(await run(`return document.querySelector('#rc6-state').textContent`),'IntelliFlow disconnected');
    }
  });
  await check('Session creation rejects duplicate clicks, ignores a disconnected reply and permits retry after failure',async()=>{
    await fresh(); await run(`document.querySelector('#rc6-connect').click()`);await until(`!document.querySelector('#rc6-new').disabled`);
    await run(`fixture.deferred.add('createSession');document.querySelector('#rc6-new').onclick();document.querySelector('#rc6-new').onclick();`);
    assert.equal(await run(`return fixture.calls.filter(c=>c.name==='createSession').length`),1);
    await run(`fixture.emit({type:'bridge.stopped',runtimeKey:'rc6',payload:{}});fixture.resolve('createSession',{session_id:'stale-session'});`);
    await until(`document.querySelector('#rc6-state').textContent==='IntelliFlow disconnected'`);
    assert.equal(await run(`return document.querySelector('#rc6-prompt').disabled`),true);
    await fresh(); await run(`document.querySelector('#rc6-connect').click()`);await until(`!document.querySelector('#rc6-new').disabled`);
    await run(`fixture.failures.createSession='session fixture rejected';document.querySelector('#rc6-new').click();`);
    await until(`document.querySelector('#rc6-state').textContent==='session fixture rejected'`);
    assert.equal(await run(`return document.querySelector('#rc6-new').disabled`),false);
  });
  await check('Workspace reply from earlier harness cannot overwrite the selected runtime',async()=>{
    await fresh();await run(`fixture.deferred.add('chooseWorkspace');document.querySelector('#rc6-workspace').click();const p=document.querySelector('#rc6-runtime');p.value='construction-v1';p.dispatchEvent(new Event('change'));`);
    await until(`document.querySelector('#rc6-runtime-title').textContent==='IntelliFlow Construction V1'`);
    await run(`fixture.resolve('chooseWorkspace',{...fixture.status('rc6'),workspace:'stale-workspace'});`);
    assert.equal(await run(`return document.querySelector('#rc6-runtime-title').textContent`),'IntelliFlow Construction V1');
    assert.equal(await run(`return document.querySelector('#rc6-state').textContent.includes('stale-workspace')`),false);
  });
  await check('Busy submit is single-flight, foreign events are ignored, error recovers controls and HTML remains text',async()=>{
    await connectedSession();await run(`const p=document.querySelector('#rc6-prompt');p.value='<img src=x onerror="fixture.executed=true">';document.querySelector('#rc6-panel form').requestSubmit();p.value='duplicate';document.querySelector('#rc6-panel form').requestSubmit();`);
    assert.equal(await run(`return fixture.calls.filter(c=>c.name==='submit').length`),1);
    assert.equal(await run(`return document.querySelector('#rc6-new').disabled&&document.querySelector('#rc6-send').disabled`),true);
    await run(`fixture.emit({type:'message.complete',runtimeKey:'construction-v1',session_id:'session-1',payload:{}});fixture.emit({type:'message.complete',runtimeKey:'rc6',session_id:'another-session',payload:{}});`);
    assert.equal(await run(`return document.querySelector('#rc6-send').disabled`),true);
    await run(`fixture.emit({type:'message.delta',runtimeKey:'rc6',session_id:'session-1',payload:{delta:'<img src=x onerror="fixture.executed=true">'}});fixture.emit({type:'error',runtimeKey:'rc6',session_id:'session-1',payload:{message:'fixture model error'}});`);
    assert.equal(await run(`return document.querySelector('#rc6-send').disabled||document.querySelector('#rc6-new').disabled`),false);
    assert.equal(await run(`return fixture.executed||!!document.querySelector('#rc6-log img')`),false);
  });
  await check('Compact approval hides raw JSON, retains identity, keeps both decisions visible and sends exact scoped decision',async()=>{
    await connectedSession();await run(`fixture.emit({type:'approval.requested',runtimeKey:'rc6',session_id:'session-1',payload:{kind:'ApprovalRequest',request_id:'request-fixture-7',description:'Read one synthetic awareness record',tool:{name:'mcp_fixture_read'},destination:{model:'fixture-model'},authority_envelope:{envelope_id:'envelope-fixture'},argument_digest:'a'.repeat(64),evidence:'large raw payload '.repeat(1200)}});`);
    const layout=await run(`const card=document.querySelector('.rc6-approval');const box=card.getBoundingClientRect();return {open:card.querySelector('details').open,text:card.innerText,height:box.height,viewport:innerHeight,buttons:[...card.querySelectorAll('button')].map(button=>{const r=button.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}})};`);
    assert.equal(layout.open,false);assert.match(layout.text,/request-fixture-7/);assert.doesNotMatch(layout.text,/large raw payload/);assert.ok(layout.height<350,JSON.stringify(layout));
    for(const box of layout.buttons)assert.ok(box.top>=76&&box.bottom<=layout.viewport,JSON.stringify(layout));
    receipt.approval_layout=layout;await screenshot('compact-approval-1440x960');
    win.setContentSize(1280,800);
    const small=await run(`const log=document.querySelector('#rc6-log');const card=document.querySelector('.rc6-approval');card.scrollIntoView({block:'nearest'});const bounds=log.getBoundingClientRect();return {log:{top:bounds.top,bottom:bounds.bottom},buttons:[...card.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {top:r.top,bottom:r.bottom}})};`);
    for(const box of small.buttons)assert.ok(box.top>=small.log.top&&box.bottom<=small.log.bottom,JSON.stringify(small));
    receipt.approval_layout_1280x800=small;await screenshot('compact-approval-1280x800');win.setContentSize(1440,960);
    await run(`document.querySelector('.rc6-approval button').click()`);await until(`fixture.calls.some(c=>c.name==='approval')`);
    assert.deepEqual(await run(`return fixture.calls.find(c=>c.name==='approval').args`),['session-1','request-fixture-7','approve']);
    assert.equal(await run(`return [...document.querySelectorAll('.rc6-approval button')].every(b=>b.disabled)`),true);
  });
  await check('Disconnected approval card is inert and cannot send a stale choice',async()=>{
    await connectedSession();await run(`fixture.emit({type:'approval.requested',runtimeKey:'rc6',session_id:'session-1',payload:{kind:'ApprovalRequest',request_id:'old-request',description:'fixture'}});fixture.emit({type:'bridge.stopped',runtimeKey:'rc6',payload:{}});document.querySelector('.rc6-approval button').onclick();`);
    assert.equal(await run(`return fixture.calls.filter(c=>c.name==='approval').length`),0);
    assert.equal(await run(`return [...document.querySelectorAll('.rc6-approval button')].every(b=>b.disabled)`),true);
  });
  await check('Repository console prevents busy duplicate, deduplicates reply/event and keeps output inert',async()=>{
    await connectedSession();await run(`document.querySelector('[data-observer-tab="terminal"]').click();fixture.deferred.add('console');const input=document.querySelector('.rc6-observer-console input');input.value='type fixture.txt';input.dispatchEvent(new Event('input'));const form=document.querySelector('.rc6-observer-console');form.requestSubmit();form.requestSubmit();`);
    assert.equal(await run(`return fixture.calls.filter(c=>c.name==='console').length`),1);
    assert.equal(await run(`return document.querySelector('.rc6-observer-console button').disabled`),true);
    await run(`const result={requestId:'console-same',sessionId:'session-1',runtimeKey:'rc6',command:'type fixture.txt',stdout:'<img src=x onerror="fixture.executed=true">',stderr:'fixture warning',code:0,policy:'read-only'};fixture.emit({type:'console.completed',runtimeKey:'rc6',session_id:'session-1',payload:result});fixture.resolve('console',result);`);
    await until(`!document.querySelector('.rc6-observer-console button').disabled`);
    assert.equal(await run(`return document.querySelectorAll('#rc6-observer-terminal .rc6-observer-card').length`),1);
    assert.equal(await run(`return fixture.executed||!!document.querySelector('#rc6-observer-terminal img')`),false);
    assert.match(await run(`return document.querySelector('#rc6-observer-terminal').textContent`),/fixture warning/);
  });
  await check('Console error permits retry and an old session response cannot leak into the next session',async()=>{
    await connectedSession();await run(`document.querySelector('[data-observer-tab="terminal"]').click();fixture.failures.console='fixture console rejected';document.querySelector('.rc6-observer-console input').value='pwd';document.querySelector('.rc6-observer-console').requestSubmit();`);
    await until(`document.querySelector('.rc6-observer-error').textContent==='fixture console rejected'`);
    assert.equal(await run(`return document.querySelector('.rc6-observer-console button').disabled`),false);
    await run(`fixture.deferred.add('console');document.querySelector('.rc6-observer-console input').value='pwd';document.querySelector('.rc6-observer-console').requestSubmit();document.querySelector('#rc6-new').click();`);
    await until(`document.querySelector('#rc6-state').textContent.includes('session-2')`);
    await run(`fixture.resolve('console',{requestId:'console-old',sessionId:'session-1',runtimeKey:'rc6',command:'pwd',stdout:'OLD_PRIVATE_OUTPUT',code:0});`);
    assert.equal(await run(`return document.querySelector('#rc6-observer-terminal').textContent.includes('OLD_PRIVATE_OUTPUT')`),false);
  });
  receipt.after=hashes();receipt.changed=tracked.filter(name=>receipt.before[name]!==receipt.after[name]);
  receipt.passed=receipt.checks.every(check=>check.passed)&&!receipt.changed.length;receipt.completed_at=new Date().toISOString();
  fs.writeFileSync(path.join(attempt,'receipt.json'),JSON.stringify(receipt,null,2));fs.writeFileSync(path.join(evidence,'latest.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt));win.destroy();app.exit(receipt.passed?0:1);
}).catch(error=>{receipt.fatal=error.stack;receipt.passed=false;fs.writeFileSync(path.join(attempt,'receipt.json'),JSON.stringify(receipt,null,2));console.error(error.stack);if(win&&!win.isDestroyed())win.destroy();app.exit(1)});
