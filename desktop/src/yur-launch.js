'use strict';
(() => {
 const wordmark=document.getElementById('wm'),tm=document.getElementById('tm');
 function fit(){const len=Math.max(wordmark.textContent.length,5);const size=Math.max(48,Math.min(230,window.innerWidth*.14,window.innerWidth*.85/len*1.4));wordmark.style.fontSize=size+'px';if(tm)tm.style.fontSize=Math.max(14,size*.15)+'px';}
 fit();window.addEventListener('resize',fit);
 const begin=document.querySelector('.sigil-btn'),badge=document.getElementById('yur-spine-badge'),label=badge.querySelector('.label'),notice=document.getElementById('yur-launch-notice');
 begin.addEventListener('click',async()=>{
  begin.disabled=true;notice.textContent='Opening YUR AI Desktop…';
  try{const result=await window.studio.launch.enter();if(!result?.ok)throw Error(result?.error?.message||'The packaged desktop could not be opened.');}
  catch(error){notice.textContent=error.message;begin.disabled=false;}
 });
 async function check(){
  label.textContent='SPINE — CHECKING';
  try{
   const response=await window.studio.launch.spineStatus();
   if(!response?.ok)throw Error(response?.error?.message||'Read-only spine status unavailable.');
   const status=response.result;
   if(status.state==='attested-unpinned'){
    label.textContent=`SPINE — ATTESTED · UNPINNED · h:${status.ledger_height}`;
    badge.title='Read-only challenge signature verified. Server identity is not pinned; desktop execution is not bound to this substrate.';
   }else{label.textContent=status.state==='invalid-attestation'?'SPINE — INVALID ATTESTATION':'SPINE — gRPC UNAVAILABLE';badge.title='No execution authority or connectivity is inferred.';}
  }catch(error){label.textContent='SPINE — CHECK UNAVAILABLE';badge.title=error.message;}
 }
 badge.addEventListener('click',()=>{void check();});
 // Read-only status only; Genesis opens this packaged app independently.
 if(window.studio?.launch)void check();else{begin.disabled=true;notice.textContent='Packaged YUR AI Desktop bridge is unavailable.';label.textContent='SPINE — NO DESKTOP BRIDGE';}
})();
