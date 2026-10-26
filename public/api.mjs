import { STATIC_PREVIEW } from './preview-config.mjs';
import { createSeedState, publicState, applyAction, readDossierSubmission } from './domain.mjs';
const KEY='arios-os-isolated-preview-v1';
let memory;
let authMode;
function load(){if(memory)return memory;try{const v=JSON.parse(localStorage.getItem(KEY));if(v?.state?.schemaVersion===1)return memory=v;}catch{}return memory={userId:'manager',state:createSeedState()};}
function save(){try{localStorage.setItem(KEY,JSON.stringify(memory));}catch{}}
async function request(path,options={}){const headers=new Headers(options.headers);if(!(options.body instanceof FormData))headers.set('Content-Type','application/json');const r=await fetch('/api/'+path,{credentials:'same-origin',...options,headers});let d;try{d=await r.json();}catch{throw new Error('پاسخ سرور قابل خواندن نیست.');}if(!r.ok){const err=new Error(d.error?.message||d.error||d.message||'درخواست انجام نشد.');err.status=r.status;err.code=d.code;throw err;}return d;}
const session=()=>({user:publicState(load().state,load().userId).user,demo:true,capabilities:{ai:false,payments:false}});
export const api={isStatic:STATIC_PREVIEW,
 async session(){const data=STATIC_PREVIEW?session():await request('session');authMode=data.authMode;return data;},
 async state(){return STATIC_PREVIEW?publicState(load().state,load().userId):request('state');},
 async login(email,password,portal){return request('login',{method:'POST',body:JSON.stringify({email,password,...(portal?{portal}:{})})});},
 async demoLogin(userId){if(STATIC_PREVIEW){load();publicState(memory.state,userId);memory.userId=userId;save();return session();}return request('demo-login',{method:'POST',body:JSON.stringify({userId})});},
 async logout(){if(STATIC_PREVIEW){load();memory.userId='manager';save();return;}return request('logout',{method:'POST',body:'{}'});},
 async action(action,payload){if(STATIC_PREVIEW){const v=load(),result=applyAction(v.state,v.userId,action,payload);save();return {result,state:publicState(v.state,v.userId)};}return request('actions',{method:'POST',body:JSON.stringify({action,payload})});},
 async dossierRead({projectId,id}){if(STATIC_PREVIEW){const v=load();return {dossierSubmission:readDossierSubmission(v.state,v.userId,projectId,id)};}return request('project-dossiers/read',{method:'POST',body:JSON.stringify({projectId,id})});},
 async assistant(payload){if(STATIC_PREVIEW)throw new Error('مدل هوش مصنوعی در نسخهٔ نمایشی متصل نیست؛ می‌توانید تیکت پشتیبانی ثبت کنید.');return request('assistant',{method:'POST',body:JSON.stringify(payload)});},
 async voice(){if(STATIC_PREVIEW)return {drafts:[],telegram:{configured:false,linked:false},integration:{aiConfigured:false,telegramConfigured:false}};return request('voice');},
 async integrations(payload){if(STATIC_PREVIEW)throw new Error('تنظیم اتصال واقعی در پیش‌نمایش نمایشی امکان‌پذیر نیست.');return request('integrations',{method:'POST',body:JSON.stringify(payload)});},
 async passwordResetRequests(){return request('password-reset/requests');},
 async integrationsTest(){return request('integrations/test',{method:'POST',body:'{}'});},
 async telegramLink(payload={}){return request('telegram/link',{method:'POST',body:JSON.stringify(payload)});},
 async telegramUnlink(payload={}){return request('telegram/unlink',{method:'POST',body:JSON.stringify(payload)});},
 async telegramSync(){return request('telegram/sync',{method:'POST',body:'{}'});},
 async reminders(){return request('reminders');},
 async reminderSettings(payload){return request('reminders/settings',{method:'POST',body:JSON.stringify(payload)});},
 async voiceUpload(file,projectId){
  if(authMode!=='supabase'){const body=new FormData();body.append('file',file);if(projectId)body.append('projectId',projectId);return request('voice/upload',{method:'POST',body});}
  if(!file||typeof file.name!=='string'||!Number.isSafeInteger(file.size)||file.size<1||file.size>20*1024*1024)throw new Error('یک فایل صوتی تا ۲۰ مگابایت انتخاب کنید.');
  const extension=file.name.toLowerCase().split('.').at(-1);
  const mimeType=file.type||({ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',mp3:'audio/mpeg',m4a:'audio/mp4',mp4:'audio/mp4',wav:'audio/wav',webm:'audio/webm',flac:'audio/flac'}[extension]||'application/octet-stream');
  const upload=await request('voice/upload-url',{method:'POST',body:JSON.stringify({fileName:file.name,mimeType,size:file.size,...(projectId?{projectId}:{})})});
  let url;try{url=new URL(upload.uploadUrl);if(url.protocol!=='https:'||url.username||url.password||typeof upload.draftId!=='string'||!upload.draftId)throw new Error();}catch{throw new Error('نشانی امن بارگذاری دریافت نشد؛ دوباره تلاش کنید.');}
  let result;try{result=await fetch(url.href,{method:'PUT',credentials:'omit',redirect:'error',headers:{'Content-Type':mimeType,'x-upsert':'false','cache-control':'max-age=0'},body:file});}catch{throw new Error('بارگذاری صوت کامل نشد؛ اتصال اینترنت را بررسی و دوباره تلاش کنید.');}
  if(!result.ok)throw new Error('بارگذاری صوت کامل نشد؛ فایل را دوباره انتخاب کنید.');
  return request('voice/upload-complete',{method:'POST',body:JSON.stringify({id:upload.draftId})});
 },
 async voiceText(payload){return request('voice/text',{method:'POST',body:JSON.stringify(payload)});},
 async voiceRetry(id){return request('voice/retry',{method:'POST',body:JSON.stringify({id})});},
 async voiceAudio(id){return request('voice/audio',{method:'POST',body:JSON.stringify({id})});},
 async voiceSubmit(id,fields){return request('voice/submit',{method:'POST',body:JSON.stringify({id,fields})});},
 resetDemo(){memory={userId:'manager',state:createSeedState()};save();location.hash='dashboard';location.reload();}
};
