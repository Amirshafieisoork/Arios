import { STATIC_PREVIEW } from './preview-config.mjs';
import { createSeedState, publicState, applyAction } from './domain.mjs';
const KEY='arios-os-isolated-preview-v1';
let memory;
function load(){if(memory)return memory;try{const v=JSON.parse(localStorage.getItem(KEY));if(v?.state?.schemaVersion===1)return memory=v;}catch{}return memory={userId:'manager',state:createSeedState()};}
function save(){try{localStorage.setItem(KEY,JSON.stringify(memory));}catch{}}
async function request(path,options={}){const r=await fetch('/api/'+path,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...options});let d;try{d=await r.json();}catch{throw new Error('پاسخ سرور قابل خواندن نیست.');}if(!r.ok){const err=new Error(d.error?.message||d.error||d.message||'درخواست انجام نشد.');err.status=r.status;throw err;}return d;}
const session=()=>({user:publicState(load().state,load().userId).user,demo:true,capabilities:{ai:false,payments:false}});
export const api={isStatic:STATIC_PREVIEW,
 async session(){return STATIC_PREVIEW?session():request('session');},
 async state(){return STATIC_PREVIEW?publicState(load().state,load().userId):request('state');},
 async login(email,password){return request('login',{method:'POST',body:JSON.stringify({email,password})});},
 async demoLogin(userId){if(STATIC_PREVIEW){load();publicState(memory.state,userId);memory.userId=userId;save();return session();}return request('demo-login',{method:'POST',body:JSON.stringify({userId})});},
 async logout(){if(STATIC_PREVIEW){load();memory.userId='manager';save();return;}return request('logout',{method:'POST',body:'{}'});},
 async action(action,payload){if(STATIC_PREVIEW){const v=load(),result=applyAction(v.state,v.userId,action,payload);save();return {result,state:publicState(v.state,v.userId)};}return request('actions',{method:'POST',body:JSON.stringify({action,payload})});},
 async assistant(payload){if(STATIC_PREVIEW)throw new Error('مدل هوش مصنوعی در نسخهٔ نمایشی متصل نیست؛ می‌توانید تیکت پشتیبانی ثبت کنید.');return request('assistant',{method:'POST',body:JSON.stringify(payload)});},
 resetDemo(){memory={userId:'manager',state:createSeedState()};save();location.hash='dashboard';location.reload();}
};
