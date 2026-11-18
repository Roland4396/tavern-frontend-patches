// The browser may retain opaque bytes, not plaintext credentials, settings, or prompts.
// Authorization + a fresh no-store manifest is required to reconstruct the document.
import {createHmac,randomBytes} from 'node:crypto';
import {brotliCompress,constants} from 'node:zlib';
import {promisify} from 'node:util';
const br=promisify(brotliCompress),secret=randomBytes(32);
const cache=new Map(),limit=64*1024*1024,inFlight=new Map();let bytes=0;
const mac=(label,owner)=>createHmac('sha256',secret).update(JSON.stringify([label,owner])).digest();
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const cacheKey=(owner,id)=>JSON.stringify([owner,id]);
export function lookup(owner,id){
 const k=cacheKey(owner,id),v=cache.get(k);if(!v)return undefined;
 cache.delete(k);cache.set(k,v);return v;
}
async function part(owner,idKey,raw){
 const id=createHmac('sha256',idKey).update(raw).digest('hex'),k=cacheKey(owner,id);
 if(lookup(owner,id))return id;
 if(inFlight.has(k)){await inFlight.get(k);return id;}
 const task=(async()=>{
   const payload=await br(raw,{params:{[constants.BROTLI_PARAM_QUALITY]:4}});
   if(payload.length>limit)throw Error('oversize settings part');
   cache.set(k,payload);bytes+=payload.length;
   while(bytes>limit||cache.size>128){const first=cache.keys().next().value;bytes-=cache.get(first).length;cache.delete(first);}
 })();
 inFlight.set(k,task);try{await task;}finally{inFlight.delete(k);}return id;
}
export async function manifest(owner,doc,codec){
 if(typeof owner!=='string'||!owner||codec!=='private-cache-v1')throw Error('invalid settings context');
 const key=mac('read-key-v1',owner),idKey=mac('read-id-v1',owner);
 const {settings:stored,...catalog}=doc,settings=JSON.parse(stored),entries=[];
 // Isolate large subtrees without knowing the name or schema of a single extension.
 function peel(parent,prefix,skip=''){
   if(!object(parent))return;
   for(const [k,v] of Object.entries(parent)){
     if(k===skip||entries.length>=12||(!object(v)&&!Array.isArray(v)&&typeof v!=='string'))continue;
     const raw=JSON.stringify(v);
     if(raw.length>=512*1024){entries.push([[...prefix,k],raw]);parent[k]=null;}
   }
 }
 if(object(settings.extension_settings)) for(const [k,v] of Object.entries(settings.extension_settings))peel(v,['settings','extension_settings',k]);
 peel(settings,['settings'],'extension_settings');
 entries.unshift([['catalog'],JSON.stringify(catalog)],[['settings'],JSON.stringify(settings)]);
 const parts=[];
 for(const [path,raw] of entries) parts.push([path,await part(owner,idKey,raw)]);
 if(!parts.every(([,id])=>cache.has(cacheKey(owner,id))))throw Error('settings snapshot exceeds bounded cache');
 return {wire:1,codec,key:key.toString('base64'),parts};
}
