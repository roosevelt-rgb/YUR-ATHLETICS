'use strict';
// Actual Franklin Work/OM/Commit -> main host -> preload -> renderer path.
// Local deterministic inference and media provider request adapter are fixtures.
const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yur-franklin-actions-'));
const sourceRoot = path.resolve(__dirname, '..');
const evidence = path.resolve(__dirname, '../../../evidence/glider-rc6/comprehensive/completion-2026-10-05/franklin-desktop-actions');
const attempt = path.join(evidence, 'attempt-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(attempt, { recursive:true });
const monitored = ['src/main.js','src/preload.js','src/franklin-host.js','src/franklin-transport.js','src/conversation-view.js','src/media-view.js','src/media-host.js','src/glider-frame.js','foundry/work_desktop.py','foundry/franklin_cli.py','foundry/franklin_store.py','foundry/work_engine.py','foundry/commit_service.py'];
const fingerprint = () => Object.fromEntries(monitored.map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(sourceRoot,name))).digest('hex')]));
const receipt = { started_at:new Date().toISOString(),home,attempt,checks:[],source_before:fingerprint(),limitations:[
  'Model responses are deterministic localhost fixtures, not cloud model quality or availability proof.',
  'Media request adapter returns synthetic jobs; no image/video inference, provider purchase, or persistent media-job claim.',
  'Franklin Python Work/OM/Commit, desktop host, owner-bound IPC, renderer and Media asset validation are actual product code.'
] };
const calls=[], hostActions=[], modelRequests=[], terminalEvents=[], jobs=[];
let win, modelServer, finalized=false, deadline, holdAsset=false, releaseAsset, heldAsset=false, franklinTransport;
const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=','base64');
const imageId=createHash('sha256').update(imageBytes).digest('hex');
const seedJob={id:'c'.repeat(32),revision:1,state:'completed',created_at:new Date().toISOString(),request:{preset:'flux-klein-image-v1',prompt:'Synthetic saved fixture'},assets:[],provider:{provider:'fixture'}};jobs.push(seedJob);
const workforceRoot=path.join(home,'workforce');const sentinel=path.join(home,'DONOR_EXECUTED');
const put=(name,value)=>{const target=path.join(workforceRoot,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);};
const tripwire=`from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text('must not execute')\nraise RuntimeError('Donor source only')\n`;
put('genome.py',tripwire+'from enum import Enum\nclass Scope(str, Enum):\n    INTERNAL="internal"\nclass Authority(str, Enum):\n    APPROVE="APPROVE"\n    ABSTAIN="ABSTAIN"\nclass Genome: pass\nclass Superagent: pass\nclass EndpointAffinity: pass\n');
put('registry.py',tripwire);put('dispatch_map.py',tripwire);put('docs/README.md','# Isolated workforce fixture');
const profileSource=tripwire+'from ..genome import Genome, Superagent, Scope, Authority\nclass FixtureAgent(Superagent):\n    def __init__(self):\n        super().__init__(Genome(code="fixture_reader",name="Fixture Reader",lineage="fixture",version="1.0",description="Inert profile inspection fixture",affinities=[],receptors=[],cytokines=[],default_authority=Authority.ABSTAIN,max_authority=Authority.APPROVE,rate_limit_per_min=1))\n';
put('agents/fixture_reader.py',profileSource);const profileDigest=createHash('sha256').update(profileSource).digest('hex');
process.env.YUR_GLIDER_RC6='1';process.env.YUR_HARNESS_AUTOSTART='0';process.env.YUR_DESKTOP_HOME=path.join(home,'journal');process.env.YUR_FACTORY_HOME=path.join(home,'factory');
process.env.YUR_WORKFORCE_SOURCE=workforceRoot;process.env.APPDATA=path.join(home,'appdata');process.env.YUR_COPILOT_LIBRARY=path.join(home,'unused-copilot');
process.env.YUR_FACTORY_PYTHON=require('../src/desktop-runtime').desktopPython(sourceRoot);process.env.PYTHONDONTWRITEBYTECODE='1';
process.env.YUR_FRANKLIN_MODEL='franklin-actions-fixture';process.env.YUR_FRANKLIN_API_KEY='local-fixture';
app.setPath('userData',path.join(home,'electron'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-gpu');app.commandLine.appendSwitch('mute-audio');
const mediaModule=require('../src/media-host'),originalMedia=mediaModule.createMediaHost;
mediaModule.createMediaHost=options=>{
  const root=path.resolve(options.getRoot());assert.ok(root.startsWith(home+path.sep));
  const assetPath=path.join(root,'media-assets',imageId+'.png');fs.mkdirSync(path.dirname(assetPath),{recursive:true});fs.writeFileSync(assetPath,imageBytes);
  const item={id:imageId,kind:'image',mime:'image/png',extension:'png',bytes:imageBytes.length,path:assetPath,width:1,height:1};
  return originalMedia({...options,request:async request=>{
    const {action,payload}=request;calls.push({action,payload});let result;
    if(action==='catalog')result={presets:[{id:'flux-klein-image-v1',label:'Fixture image',kind:'image',width:1024,height:1024},{id:'wan22-video-v1',label:'Fixture video',kind:'video',width:832,height:480,frames:49}]};
    else if(action==='list')result={jobs:jobs.slice(0,payload.limit||20)};
    else if(action==='inspect')result=jobs.find(job=>job.id===payload.job_id);
    else if(action==='status')result={ready:true,endpoint:'http://127.0.0.1/synthetic-media',presets:[{id:'flux-klein-image-v1',ready:true},{id:'wan22-video-v1',ready:true}]};
    else if(action==='asset'){
      if(holdAsset){heldAsset=true;await new Promise(resolve=>{releaseAsset=resolve;});holdAsset=false;}
      if(payload.asset_id!==imageId)return {ok:false,error:{message:'Fixture asset is not committed'}};result=item;
    }else if(action==='submit'){
      await new Promise(resolve=>setTimeout(resolve,100));
      result={id:payload.request.request_id.replaceAll('-',''),revision:1,state:'completed',created_at:new Date().toISOString(),request:payload.request,assets:[],provider:{provider:'synthetic-no-generation'}};jobs.unshift(result);
    }else return {ok:false,error:{message:'Fixture forbids operation '+action}};
    return result?{ok:true,result}:{ok:false,error:{message:'Fixture record not found'}};
  }});
};
const hostModule=require('../src/franklin-host'),originalHost=hostModule.createFranklinHost;
hostModule.createFranklinHost=options=>{const host=originalHost(options);return {...host,execute:async(action,payload,identity)=>{
  const row={action,payload,request_id:identity.request_id,mission_id:identity.mission_id,action_id:identity.action_id};hostActions.push(row);
  try{row.result=await host.execute(action,payload,identity);return row.result;}catch(error){row.error=error.message;throw error;}
}};};
const transportModule=require('../src/franklin-transport'),originalTransport=transportModule.createFranklinTransport;
transportModule.createFranklinTransport=options=>(franklinTransport=originalTransport({...options,onEvent:(event,owner)=>{if(/^turn\./.test(event.type))terminalEvents.push(event);options.onEvent(event,owner);}}));
const action=(name,payload={})=>({action:name,payload});
const draft={preset:'flux-klein-image-v1',prompt:'Slate silver pool garden',width:768,height:512,seed:42};
const video={preset:'wan22-video-v1',prompt:'Slow camera move over the synthetic garden',input_asset_id:imageId,width:832,height:480,frames:49,seed:23,negative_prompt:'blurry'};
const plans={
  catalogs:[action('media_catalog'),action('media_status'),action('media_list',{limit:2}),action('media_inspect',{job_id:seedJob.id}),action('workforce_catalog',{query:'fixture'}),action('workforce_profile',{code:'fixture_reader',expected_sha256:profileDigest}),action('model_catalog')],
  image:[action('media_draft',draft)],replacement:[action('media_draft',{...draft,prompt:'Unwanted replacement'})],
  missing:[action('media_draft',{...video,input_asset_id:'b'.repeat(64)})],race:[action('media_draft',video)],video:[action('media_draft',video)]
};
const evaluate=code=>win.webContents.executeJavaScript('(()=>{'+code+'})()',true);
async function until(test,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await test())return;await new Promise(resolve=>setTimeout(resolve,60));}throw new Error('Timed out: '+label);}
const waitUi=(expression,label)=>until(()=>evaluate('return '+expression),label||expression);
async function send(name,during){
  const id=randomUUID(),before=hostActions.length;
  await evaluate(`window.__fixtureRequest=${JSON.stringify(id)};const input=document.getElementById('franklin-input');input.value=${JSON.stringify('ACTION_CASE:'+name+' Use the requested bounded desktop actions and report the outcome.')};input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await waitUi(`!document.getElementById('franklin-send').disabled`);
  // Go through the real assistant form; it creates and commits its own request identity.
  const prior=terminalEvents.length;await evaluate(`document.querySelector('.yur-franklin-form').requestSubmit();`);
  if(during)await during();
  await until(()=>terminalEvents.length>prior,'Franklin turn '+name,45000);
  const terminal=terminalEvents.at(-1);assert.equal(terminal.type,'turn.complete',JSON.stringify(terminal));
  const request=terminal.snapshot.requests.at(-1);assert.equal(request.status,'completed',JSON.stringify(terminal));
  const rows=hostActions.slice(before);assert.equal(rows.length,plans[name].length,'All planned actions reach actual Work host');
  receipt.turns||=[];receipt.turns.push({name,request,events:terminal.snapshot.events});return rows;
}
async function capture(name){try{const shot=await Promise.race([win.webContents.capturePage(undefined,{stayHidden:true}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('capture timeout')),3000))]);fs.writeFileSync(path.join(attempt,name+'.png'),shot.toPNG());}catch(error){(receipt.capture_limits||=[]).push(error.message);}}
async function finish(error){
  if(finalized)return;finalized=true;clearTimeout(deadline);franklinTransport?.shutdown();
  receipt.completed_at=new Date().toISOString();receipt.source_after=fingerprint();receipt.source_changed=monitored.filter(name=>receipt.source_before[name]!==receipt.source_after[name]);
  if(receipt.source_changed.length)error||=new Error('Product changed during validation: '+receipt.source_changed.join(', '));
  receipt.passed=!error;receipt.error=error?.stack;receipt.host_actions=hostActions;receipt.media_calls=calls;receipt.synthetic_model_requests=modelRequests;receipt.terminal_events=terminalEvents;
  if(error&&win&&!win.isDestroyed()){try{receipt.ui=await evaluate('return {error:document.getElementById("franklin-error")?.textContent,media:document.querySelector(".ym-root")?.innerText}');}catch{}}
  if(win&&!win.isDestroyed())win.destroy();modelServer?.closeAllConnections();modelServer?.close();
  fs.writeFileSync(path.join(attempt,'receipt.json'),JSON.stringify(receipt,null,2));fs.writeFileSync(path.join(evidence,'latest.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({passed:!error,error:error?.message,checks:receipt.checks,attempt,home}));app.exit(error?1:0);
}
async function test(){
  try{
    const entered=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));await evaluate('setTimeout(()=>window.studio.launch.enter(),25);');await entered;
    await waitUi(`!!document.getElementById('franklin-toggle')&&!document.getElementById('franklin-input').disabled`);
    await evaluate(`document.getElementById('franklin-toggle').click();`);await waitUi(`!document.getElementById('franklin-model').disabled`);
    const configured=await evaluate(`return window.studio.franklin.configure({model:'openai:franklin-actions-fixture'});`);assert.equal(configured.ok,true);
    const catalogRows=await send('catalogs');for(const row of catalogRows){assert.ok(!row.error,JSON.stringify(row));assert.equal(row.result.trust,'untrusted-source-data');assert.equal(row.result.authority,'context-only');}
    assert.ok(JSON.stringify(catalogRows[4].result).includes('fixture_reader'));assert.ok(JSON.stringify(catalogRows[5].result).includes('Inert profile'));assert.ok(catalogRows[6].result.models.some(m=>m.id==='openai:franklin-actions-fixture'));assert.equal(fs.existsSync(sentinel),false);
    receipt.checks.push('Seven inspected media/model/workforce actions traverse real Work/host callbacks; source donor remains inert and all results are context only');
    const image=(await send('image'))[0];assert.equal(image.result.prepared,true);assert.equal(image.result.submitted,false);assert.equal(image.result.requires_operator_review,true);
    assert.equal(image.result.request_id.replaceAll('-',''),image.action_id);assert.equal(calls.filter(c=>c.action==='submit').length,0);
    assert.deepEqual(await evaluate(`return ['Workflow','Describe your image or video','Width','Height','Seed'].map(label=>document.querySelector('.ym-root [aria-label="'+label+'"]').value);`),[draft.preset,draft.prompt,'768','512','42']);
    assert.match(await evaluate(`return document.querySelector('.ym-status').textContent`),/Review.*Generate/);await capture('franklin-prepared-image');
    receipt.checks.push('Committed Work media_draft reaches actual renderer with exact action-derived id and typed fields; no autosubmit');
    await evaluate(`const button=document.querySelector('.ym-primary');button.click();button.click();`);await until(()=>calls.filter(c=>c.action==='submit').length===1,'single human submit');await waitUi(`!document.querySelector('.ym-primary').disabled`);
    const submitted=calls.find(c=>c.action==='submit').payload.request;assert.equal(submitted.request_id,image.result.request_id);assert.equal(submitted.prompt,draft.prompt);assert.equal(submitted.width,768);assert.equal(submitted.seed,42);
    receipt.checks.push('Actual operator Generate sends exact prepared request once despite duplicate click; synthetic job appears in retained gallery');
    assert.ok(await evaluate(`return !!document.querySelector('[data-media-job="${image.result.request_id.replaceAll('-','')}"]')`));
    await evaluate(`document.querySelector('.ym-root [aria-label="Describe your image or video"]').value='Human draft must survive Coding';document.getElementById('glider-coding').click();`);
    const rejected=(await send('replacement'))[0];assert.ok(rejected.error);assert.equal(await evaluate(`return document.querySelector('.ym-root [aria-label="Describe your image or video"]').value`),'Human draft must survive Coding');assert.equal(await evaluate(`return document.getElementById('rc6-panel').hidden`),true);assert.equal(calls.filter(c=>c.action==='submit').length,1);
    receipt.checks.push('Existing human Media draft hidden beneath Coding is preserved; Franklin replacement is rejected and Media becomes visible');
    await evaluate(`document.querySelector('.ym-root [aria-label="Describe your image or video"]').value='';`);
    const missing=(await send('missing'))[0];assert.ok(missing.error);assert.equal(await evaluate(`return document.querySelector('.ym-root [aria-label="Describe your image or video"]').value`),'');assert.equal(calls.filter(c=>c.action==='submit').length,1);
    receipt.checks.push('Missing selected asset is rejected by real Media host and renderer before any draft or submission');
    holdAsset=true;heldAsset=false;
    const raced=(await send('race',async()=>{await until(()=>heldAsset,'asset resolution begins');await evaluate(`document.querySelector('.ym-root [aria-label="Describe your image or video"]').value='Human edit during asset lookup';`);releaseAsset();}))[0];
    assert.ok(raced.error);assert.equal(await evaluate(`return document.querySelector('.ym-root [aria-label="Describe your image or video"]').value`),'Human edit during asset lookup');
    receipt.checks.push('Operator edits made during asynchronous image lookup survive and invalidate the older Franklin draft');
    await evaluate(`document.querySelector('.ym-root [aria-label="Describe your image or video"]').value='';`);
    const accepted=(await send('video'))[0];assert.equal(accepted.result.prepared,true);assert.equal(calls.filter(c=>c.action==='submit').length,1);
    assert.deepEqual(await evaluate(`return ['Workflow','Video frames','Avoid in video'].map(label=>document.querySelector('.ym-root [aria-label="'+label+'"]').value);`),[video.preset,'49','blurry']);assert.match(await evaluate(`return document.querySelector('.ym-panel').textContent`),/Starting image.*1 × 1/);
    await capture('franklin-prepared-video');await evaluate(`document.querySelector('.ym-primary').click();`);await until(()=>calls.filter(c=>c.action==='submit').length===2,'operator video submit');await waitUi(`!document.querySelector('.ym-primary').disabled`);
    const videoSent=calls.filter(c=>c.action==='submit')[1].payload.request;assert.equal(videoSent.input_asset_id,imageId);assert.equal(videoSent.frames,49);assert.equal(videoSent.request_id,accepted.result.request_id);
    receipt.checks.push('Valid synthetic committed image is resolved through actual asset host; video stays a reviewable draft until operator Generate');
    const final=await evaluate(`return window.studio.franklin.snapshot();`);assert.equal(final.ok,true);assert.equal(final.result.requests.length,6);assert.ok(final.result.events.some(event=>event.type==='franklin.action.completed'));receipt.final_snapshot=final.result;
    assert.equal(fs.existsSync(sentinel),false);assert.equal(hostActions.length,12);receipt.checks.push('Six Franklin missions and action receipts persist through actual CommitService; donor code remains unexecuted');
    await finish();
  }catch(error){await finish(error);}
}
(async()=>{
  modelServer=http.createServer((req,res)=>{
    const reply=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.url==='/api/tags')return reply({models:[{name:'franklin-actions-fixture'},{name:'second-fixture'}]});
    if(req.url==='/api/health')return reply({fixture:true});if(req.url==='/api/models')return reply({models:[]});
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);return res.end();}
    let raw='';req.on('data',chunk=>{raw+=chunk;if(raw.length>2*1024*1024)req.destroy();});req.on('end',()=>{
      try{const body=JSON.parse(raw),messages=body.messages;let index=-1,name;
        for(let n=messages.length-1;n>=0;n--)if(messages[n].role==='user'&&/ACTION_CASE:([a-z]+)/.test(messages[n].content)){index=n;name=messages[n].content.match(/ACTION_CASE:([a-z]+)/)[1];break;}
        assert.ok(plans[name],'Unknown fixture case');const results=messages.slice(index+1).filter(m=>m.role==='tool');modelRequests.push({case:name,tools:body.tools.map(t=>t.function.name),results:results.map(r=>JSON.parse(r.content))});
        const step=plans[name][results.length],message=step?{role:'assistant',content:'',tool_calls:[{id:'fixture_'+name+'_'+results.length,type:'function',function:{name:'desktop_action',arguments:JSON.stringify(step)}}]}:{role:'assistant',content:'Fixture action results inspected. Media remains subject to operator review.'};
        reply({id:'fixture-'+randomUUID(),object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:step?'tool_calls':'stop'}]});
      }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
    });
  });
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+modelServer.address().port;
  process.env.YUR_FRANKLIN_OPENAI_URL=origin+'/v1';process.env.YUR_OLLAMA_URL=origin;process.env.YUR_FOUNDRY_URL=origin;
  app.on('browser-window-created',(_event,created)=>{win=created;win.webContents.setBackgroundThrottling(false);win.setFocusable(false);win.setOpacity(0);win.setPosition(-16000,-16000);win.setSkipTaskbar(true);win.webContents.once('did-finish-load',test);});
  deadline=setTimeout(()=>finish(new Error('Native Franklin actions exceeded three minutes')),180000);require('../src/main');
})().catch(finish);
