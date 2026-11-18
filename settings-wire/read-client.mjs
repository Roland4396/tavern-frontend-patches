// Cache Storage holds authenticated ciphertext only. The fresh, no-store bootstrap
// provides the per-user key. Cache failures are an ordinary uncached read.
const BANK='st-settings-sealed-v1';
export function supportedCodec(){
 try{return globalThis.crypto?.subtle && globalThis.caches && typeof CompressionStream==='function' && typeof DecompressionStream==='function'?'private-cache-v1':'';}catch{return '';}
}
async function packed(bytes,compress){
 const transform=compress?new CompressionStream('gzip'):new DecompressionStream('gzip');
 return new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer();
}
async function readPart(id,key,cache,request){
 const url='/api/settings/wire-part/'+id, aad=new TextEncoder().encode(id);
 if(cache){
  try{
   const cached=await cache.match(url);
   if(cached){
    const b=new Uint8Array(await cached.arrayBuffer());
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:b.subarray(0,12),additionalData:aad},key,b.subarray(12));
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await packed(clear,false)));
   }
  }catch{try{await cache.delete(url);}catch{}}
 }
 const r=await request(url,{credentials:'same-origin',cache:'no-store'});
 if(!r.ok||r.headers.get('X-ST-Settings-Part')!==id)throw Error('Settings snapshot expired');
 const raw=await r.arrayBuffer(),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
 if(cache){
  try{
   const iv=crypto.getRandomValues(new Uint8Array(12)),z=await packed(raw,true);
   const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,z);
   await cache.put(url,new Response(new Blob([iv,cipher]),{headers:{'Content-Type':'application/octet-stream'}}));
  }catch{ /* e.g. private browsing/storage full: value is already complete */ }
 }
 return value;
}
export async function unpack(m,options={}){
 const request=options.fetch || globalThis.fetch.bind(globalThis);
 if(m?.wire!==1||m.codec!=='private-cache-v1'||!Array.isArray(m.parts)||m.parts.length<2||m.parts.length>14)throw Error('Bad settings manifest');
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(m.key),c=>c.charCodeAt(0)),{name:'AES-GCM'},false,['encrypt','decrypt']);
 let cache;try{cache=await caches.open(BANK);}catch{}
 const root={},rows=new Array(m.parts.length);let next=0;
 async function worker(){for(;;){
  const i=next++;if(i>=m.parts.length)return;
  const [p,id]=m.parts[i];if(!Array.isArray(p)||!p.length||!p.every(k=>typeof k==='string')||!/^[a-f0-9]{64}$/.test(id))throw Error('Bad settings reference');
  rows[i]=[p,await readPart(id,key,cache,request)];
 }}
 await Promise.all(Array.from({length:Math.min(2,rows.length)},worker));
 for(const [p,v] of rows){
  let at=root;
  for(const k of p.slice(0,-1)){if(!Object.hasOwn(at,k)||!at[k]||typeof at[k]!=='object')throw Error('Bad settings tree');at=at[k];}
  const k=p.at(-1);if(at!==root&&(!Object.hasOwn(at,k)||at[k]!==null))throw Error('Missing settings placeholder');
  Object.defineProperty(at,k,{value:v,writable:true,enumerable:true,configurable:true});
 }
 if(!root.catalog||!root.settings)throw Error('Incomplete settings load');
 if(cache)try{
  const keep=new Set(m.parts.map(([,id])=>'/api/settings/wire-part/'+id));
  for(const entry of await cache.keys())if(!keep.has(new URL(entry.url).pathname))await cache.delete(entry);
 }catch{}
 return {...root.catalog,settings:JSON.stringify(root.settings)};
}
