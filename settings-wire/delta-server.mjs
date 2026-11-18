import {createHash} from 'node:crypto';
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const digest=s=>createHash('sha256').update(s).digest('hex');
const fail=(status)=>{throw Object.assign(new Error(status===409?'settings_revision_conflict':'invalid_settings_delta'),{status})};
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
export function applyDelta(current,body){
 if(!object(current)||!object(body))fail(400);
 if(own(body,'replace')){
   if(!object(body.replace)||!hex(body.base)||Object.keys(body).length!==2)fail(400);
   const old=JSON.stringify(current),next=JSON.stringify(body.replace);
   if(old!==next&&digest(old)!==body.base)fail(409);
   return {data:body.replace,changed:old!==next};
 }
 if(Object.keys(body).length!==1||!Array.isArray(body.changes)||body.changes.length>384)fail(400);
 const paths=new Map(), list=[];
 for(const op of body.changes){
  if(!Array.isArray(op)||![2,3].includes(op.length))fail(400);
  const [p,base]=op;if(!Array.isArray(p)||!p.length||p.length>24||(base!==null&&!hex(base)))fail(400);
  let node=paths,parent=current;
  for(let i=0;i<p.length;i++){
   const k=p[i];if(typeof k!=='string'||k.length>1024||['__proto__','constructor','prototype'].includes(k)||node.has(null))fail(400);
   if(!node.has(k))node.set(k,new Map());node=node.get(k);
   if(i<p.length-1){if(!own(parent,k)||!object(parent[k]))fail(409);parent=parent[k];}
  }
  if(node.size)fail(400);node.set(null,true);
  const k=p.at(-1),exists=own(parent,k),prev=exists?JSON.stringify(parent[k]):undefined;
  if(op.length===2?!exists:(exists&&prev===JSON.stringify(op[2])))continue; // identical retry
  if((exists?digest(prev):null)!==base)fail(409);
  list.push([parent,k,op]);
 }
 for(const [parent,k,op] of list){if(op.length===3)parent[k]=op[2];else delete parent[k];}
 return {data:current,changed:list.length>0};
}
