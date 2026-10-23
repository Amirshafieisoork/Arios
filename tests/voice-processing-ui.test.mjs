import test from 'node:test';
import assert from 'node:assert/strict';
import { retryableTelegramDrafts, retryTelegramDrafts, voiceRetryMessage, wireVoice, stopVoice } from '../public/voice.mjs';

const expiry=new Date(Date.now()+86400000).toISOString();
const draft=(id,patch={})=>({id,source:'telegram',status:'failed',audio:{available:true,expiresAt:expiry},...patch});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('remaining Telegram retry excludes completed, active, unavailable, expired and duplicate drafts',()=>{
 const rows=[draft('failed'),draft('pending',{status:'pending'}),draft('failed'),draft('ready',{status:'ready'}),draft('submitted',{status:'submitted'}),draft('active',{status:'processing'}),draft('text',{source:'text'}),draft('unavailable',{audio:{available:false}}),draft('expired',{audio:{available:true,expiresAt:'2020-01-01T00:00:00Z'}}),draft('bad-date',{audio:{available:true,expiresAt:'invalid'}})];
 const before=structuredClone(rows);
 assert.deepEqual(retryableTelegramDrafts(rows).map(row=>row.id),['failed','pending']);
 assert.deepEqual(rows,before,'selecting retries must preserve the original drafts');
});

test('one explicit batch processes at most ten voices sequentially and reports each real result',async()=>{
 const rows=Array.from({length:13},(_,i)=>draft('voice-'+i)),attempts=[],events=[];let active=0,maxActive=0;
 const result=await retryTelegramDrafts({drafts:rows,limit:99,retry:async id=>{
  active++;maxActive=Math.max(active,maxActive);attempts.push(id);await flush();active--;
  return {id,status:id==='voice-1'?'failed':id==='voice-2'?'processing':'ready',error:'خطای مشخص تبدیل'};
 },onResult:event=>events.push(event)});
 assert.equal(maxActive,1);assert.equal(attempts.length,10);assert.equal(events.length,10);
 assert.deepEqual(result,{attempted:10,ready:8,failed:1,pending:1,remaining:3,stopped:false});
 assert.equal(rows[0].status,'failed','processing results do not rewrite caller data implicitly');
 assert.equal(events[1].result.error,'خطای مشخص تبدیل');
});

test('retrying stops after navigation and after authentication, permission or rate-limit failure',async()=>{
 let active=true,calls=0;
 const navigation=await retryTelegramDrafts({drafts:[draft('one'),draft('two')],isActive:()=>active,retry:async id=>{calls++;active=false;return{id,status:'ready'};}});
 assert.equal(calls,1);assert.equal(navigation.stopped,true);assert.equal(navigation.remaining,1);
 for(const status of[401,403,429]){
  calls=0;
  const result=await retryTelegramDrafts({drafts:[draft('one'),draft('two')],retry:async()=>{calls++;throw Object.assign(new Error('درخواست رد شد'),{status});}});
  assert.equal(calls,1);assert.equal(result.stopped,true);assert.equal(result.failed,1);assert.equal(result.remaining,1);
 }
});

test('a systemic provider failure stops the batch instead of repeating the same quota or key error',async()=>{
 let calls=0;
 const result=await retryTelegramDrafts({drafts:[draft('one'),draft('two')],retry:async id=>{calls++;return{id,status:'failed',error:'اعتبار سرویس کافی نیست',processing:{code:'AI_QUOTA_EXCEEDED'}};}});
 assert.equal(calls,1);assert.equal(result.stopped,true);assert.equal(result.failed,1);assert.equal(result.remaining,1);
});

test('retry messages distinguish successful, failed, queued, active and submitted results',()=>{
 assert.match(voiceRetryMessage({status:'ready'}),/متن ویس.*آماده/);
 assert.equal(voiceRetryMessage({status:'failed',error:'تبدیل گفتار انجام نشد؛ فایل خراب است'}),'تبدیل گفتار انجام نشد؛ فایل خراب است');
 assert.match(voiceRetryMessage({status:'pending'}),/هنوز آماده نشده/);
 assert.match(voiceRetryMessage({status:'processing'}),/در حال پردازش/);
 assert.match(voiceRetryMessage({status:'submitted'}),/قبلاً ثبت شده/);
 assert(!voiceRetryMessage(null).includes('انجام شد'));
});

let sequence=0;
async function mount(t,{retry,rows=[draft('one')],role='manager'}={}){
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document'),messages=[],calls=[],buttons=new Map();
 const button=(dataset={})=>({dataset,disabled:false,textContent:'تلاش دوباره',addEventListener(name,handler){this[name]=handler;}});
 const single=button({voiceRetry:rows[0].id}),all=button(),progress={textContent:''};
 buttons.set('[data-voice-retry]',[single]);buttons.set('[data-voice-retry-all]',[all]);
 const id='retry-ui-'+(++sequence),root={dataset:{voiceUser:id},querySelectorAll:()=>[]};
 const document={visibilityState:'visible',querySelector:selector=>selector==='[data-voice-user]'?root:selector==='[data-voice-retry-all]'?all:selector==='[data-voice-retry-progress]'?progress:null,querySelectorAll:selector=>buttons.get(selector)||[]};
 Object.defineProperty(globalThis,'document',{configurable:true,value:document});
 t.after(()=>{stopVoice();descriptor?Object.defineProperty(globalThis,'document',descriptor):delete globalThis.document;});
 const state={user:{id,role},users:[],projects:[]},ctx={api:{isStatic:false,voice:async()=>({drafts:structuredClone(rows),integration:{aiConfigured:true},telegram:{configured:false}}),voiceRetry:async id=>{calls.push(id);return retry(id);}},refresh:async()=>{},toast:message=>messages.push(message),n:String,icon:String};
 wireVoice(state,ctx);await flush();return{single,all,progress,messages,calls,document};
}

test('a second click cannot duplicate an in-flight retry and the actual failure is shown',async t=>{
 let finish;
 const ui=await mount(t,{retry:()=>new Promise(resolve=>finish=resolve)});
 ui.single.click();ui.single.click();
 assert.deepEqual(ui.calls,['one']);assert.equal(ui.single.disabled,true);assert.equal(ui.single.textContent,'در حال پردازش…');
 assert.equal(ui.all.disabled,true);
 finish({id:'one',status:'failed',error:'فرمت فایل صوتی پشتیبانی نمی‌شود'});await flush();await flush();
 assert.deepEqual(ui.messages,['فرمت فایل صوتی پشتیبانی نمی‌شود']);assert.equal(ui.single.disabled,false);
});

test('workers cannot start the manager batch even from a stale button',async t=>{
 const ui=await mount(t,{role:'worker',retry:async id=>({id,status:'ready'})});
 ui.all.click();await flush();assert.deepEqual(ui.calls,[]);
});

test('manager batch runs eligible voices once and shows completed and failed counts',async t=>{
 const ui=await mount(t,{rows:[draft('one'),draft('two'),draft('ready',{status:'ready'})],retry:async id=>({id,status:id==='one'?'ready':'failed',error:'خطای تبدیل'})});
 ui.all.click();ui.all.click();await flush();await flush();
 assert.deepEqual(ui.calls,['one','two']);assert.match(ui.progress.textContent,/1 پیش‌نویس آمادهٔ بررسی؛ 1 مورد ناموفق/);
 assert.equal(ui.messages.length,1);
});
