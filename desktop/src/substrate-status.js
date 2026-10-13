'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const {resolvePython}=require('./harness-sidecar');
const STATES=new Set(['attested-unpinned','invalid-attestation','grpc-unavailable']);
function validateStatus(value){
 if(!value || !STATES.has(value.state)||value.endpoint!=='[::1]:50051'||value.identity_pinned!==false||value.execution_bound!==false||typeof value.signature_verified!=='boolean')throw Error('Invalid read-only substrate status.');
 if(value.state==='attested-unpinned' && (!value.signature_verified||!Number.isSafeInteger(value.ledger_height)||value.ledger_height<0||!/^[a-f0-9]{16}$/.test(value.fingerprint)))throw Error('Invalid attestation evidence.');
 return value;
}
function createSubstrateStatus({unifiedRoot,appRoot,spawnImpl=spawn,env=process.env}){
 let pending=null;
 return {probe(){
  if(pending)return pending;
  pending=new Promise(resolve=>{
   const bundled=path.join(unifiedRoot,'runtime','harness','python.exe');
   const python=fs.existsSync(bundled)?bundled:resolvePython(unifiedRoot,env);
   if(!python){resolve({ok:false,error:{code:'RUNTIME_UNAVAILABLE',message:'The included read-only substrate status runtime is unavailable.'}});return;}
   const safeEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(env[key])safeEnv[key]=env[key];safeEnv.PYTHONDONTWRITEBYTECODE='1';
   let child,output='',settled=false;
   const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
   const timer=setTimeout(()=>{child?.kill();finish({ok:false,error:{code:'PROBE_TIMEOUT',message:'Read-only spine check timed out.'}});},6000);
   try{
    child=spawnImpl(python,[path.join(appRoot,'foundry','substrate_status.py')],{cwd:appRoot,env:safeEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',data=>{output+=data;if(Buffer.byteLength(output)>65536){child.kill();finish({ok:false,error:{code:'INVALID_RESPONSE',message:'Spine status response exceeded its bound.'}});}});
    child.on('error',()=>finish({ok:false,error:{code:'PROBE_UNAVAILABLE',message:'Read-only spine check could not start.'}}));
    child.on('close',code=>{try{if(code!==0)throw Error();const response=JSON.parse(output);if(!response.ok)throw Error();finish({ok:true,result:validateStatus(response.result)});}catch{finish({ok:false,error:{code:'PROBE_UNAVAILABLE',message:'Read-only spine status is unavailable.'}});}});
   }catch{finish({ok:false,error:{code:'PROBE_UNAVAILABLE',message:'Read-only spine check could not start.'}});}
  }).finally(()=>{pending=null;});return pending;
 }};
}
module.exports={createSubstrateStatus,validateStatus};
