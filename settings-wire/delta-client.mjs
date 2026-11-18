// Diff immutable snapshots captured by the existing latest-save queue. Arrays are atomic.
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=x=>x!==null && typeof x==='object' && !Array.isArray(x);
const unsafe=k=>['__proto__','constructor','prototype'].includes(k);
function same(a,b) {
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length && keys.every(k=>own(b,k)&&same(a[k],b[k]));
}
async function hash(text) {
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
 return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function delta(baseText,nextText) {
 const before=JSON.parse(baseText),after=JSON.parse(nextText),changes=[];
 let bulk=false;
 function walk(a,b,path){
  if(a===b||bulk)return;
  if(object(a)&&object(b)){
   const ak=Object.keys(a),bk=Object.keys(b);
   // Normal numeric indices always enumerate in numeric order. Preserve deliberate
   // reordering of ordinary map keys (e.g. ordered preset maps), rather than losing it.
   const nonIndex=k=>!(String(k>>>0)===k && (k>>>0)!==4294967295);
   const expected=ak.filter(k=>own(b,k)&&nonIndex(k)).concat(bk.filter(k=>!own(a,k)&&nonIndex(k)));
   const target=bk.filter(nonIndex);
   if(expected.some((k,i)=>k!==target[i])){
      if(!path.length)bulk=true;else changes.push([path,a,b]);
      if(changes.length>384)bulk=true;return;
   }
   for(const k of new Set([...ak,...bk])){
    const av=own(a,k)?a[k]:undefined,bv=own(b,k)?b[k]:undefined;
    if(av===bv)continue;
    if(unsafe(k)||k.length>1024||path.length>=24){if(!same(av,bv))bulk=true;continue;}
    walk(av,bv,[...path,k]); if(bulk)break;
   }
  }else if(!same(a,b)){
   changes.push([path,a,b]);if(changes.length>384)bulk=true;
  }
 }
 walk(before,after,[]);
 if(bulk)return {base:await hash(baseText),replace:after};
 return {changes:await Promise.all(changes.map(async ([p,a,b])=>{
   const op=[p,a===undefined?null:await hash(JSON.stringify(a))];if(b!==undefined)op.push(b);return op;
 }))};
}
export async function deltaText(before,after) {
 if(before.length+after.length > 512*1024 && typeof Worker!=='undefined'){
  try{
   return await new Promise((resolve,reject)=>{
    const w=new Worker(new URL('./settings-delta-worker-v1.mjs',import.meta.url),{type:'module'});
    w.onmessage=e=>{w.terminate();typeof e.data?.encoded==='string'?resolve(e.data.encoded):reject(Error('worker unavailable'));};
    w.onerror=()=>{w.terminate();reject(Error('worker unavailable'));};
    try {w.postMessage([before,after]);}catch(e){w.terminate();reject(e);}
   });
  }catch{ /* A browser without module workers still uses the same checked delta. */ }
 }
 return JSON.stringify(await delta(before,after));
}
