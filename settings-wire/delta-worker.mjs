import {delta} from './settings-delta-v1.mjs';
self.onmessage=async e=>{try{self.postMessage({encoded:JSON.stringify(await delta(...e.data))});}catch{self.postMessage({failed:true});}};
