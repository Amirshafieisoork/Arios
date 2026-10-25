import test from 'node:test';
import assert from 'node:assert/strict';
import { handleVoice, receiveTelegramUpdates } from '../supabase/functions/arios-api/voice-service.mjs';
import { createRepository } from '../supabase/functions/arios-api/repository.mjs';
import { createSeedState } from '../supabase/functions/arios-api/domain.mjs';

function fixture() {
  const state = createSeedState(), codes = new Map(), links = new Map(), updates = new Map(), buckets = new Map(), rpcCalls = [];
  for (let i=0;i<31;i++) state.users.push({id:`member-${i}`,name:`عضو ${i}`,role:'worker'});
  const settings = new Map([['integrations',{telegramBotToken:'123456:test_only_not_a_real_bot_token',botUsername:'AriosTestBot'}]]);
  const rpc = async (name,p) => {
    rpcCalls.push({name,p});
    if(name==='arios_link_code_create') {
      if(!Number.isSafeInteger(p.p_expires_at))return {data:null,error:{code:'22P02'}};
      for(const [key,row] of codes)if(row.userId===p.p_user_id)codes.delete(key);
      codes.set(p.p_code_hash,{userId:p.p_user_id,expiresAt:p.p_expires_at});
      return {data:null,error:null};
    }
    if(name==='arios_link_code_consume') {
      const row=codes.get(p.p_code_hash),user=state.users.find(user=>user.id===row?.userId);
      if(!row||row.expiresAt<=Date.now()||!user||user.deletedAt||!['manager','worker'].includes(user.role))return {data:[],error:null};
      if([...links.values()].some(link=>link.user_id===row.userId&&link.telegram_user_id!==p.p_telegram_user_id)||links.has(p.p_telegram_user_id)&&links.get(p.p_telegram_user_id).user_id!==row.userId)return {data:null,error:{code:'23505'}};
      const link={user_id:row.userId,telegram_user_id:p.p_telegram_user_id,chat_id:p.p_chat_id};links.set(p.p_telegram_user_id,link);codes.delete(p.p_code_hash);return {data:[link],error:null};
    }
    assert.fail(`Unexpected RPC ${name}`);
  };
  const adapter=createRepository({from(){assert.fail('Unused database query');},rpc});
  let locked=false, pollingCalls=0, incoming=[];
  const repo={
    async loadState(){return {state:structuredClone(state)};},
    async getSetting(key){return settings.get(key)??null;},
    async rateLimit(key,limit){const count=(buckets.get(key)||0)+1;buckets.set(key,count);return {allowed:count<=limit};},
    createLinkCode:adapter.createLinkCode,consumeLinkCode:adapter.consumeLinkCode,
    async getTelegramLink(id){return links.get(id)||null;},
    async getDraft(){return null;},
    async createDraft(){assert.fail('Only /start updates are expected');},
    async acquireLock(){if(locked)return false;locked=true;return true;},
    async releaseLock(){locked=false;},
    async ingestUpdates(items){let inserted=0;for(const item of items){if(!updates.has(item.update_id)){updates.set(item.update_id,{update_id:item.update_id,payload:item,status:'pending'});inserted++;}}return {inserted};},
    async listPendingUpdates(limit){return [...updates.values()].filter(row=>row.status==='pending').slice(0,limit);},
    async setUpdateStatus(id,status){updates.get(id).status=status;},
  };
  const fetcher=async(url,options)=>{assert(new URL(url).pathname.endsWith('/getUpdates'));assert.equal(options.redirect,'manual');pollingCalls++;return new Response(JSON.stringify({ok:true,result:incoming}),{headers:{'Content-Type':'application/json'}});};
  const issue=async(target,actor='manager')=>{
    const request=new Request('https://arios.test/api/telegram/link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:target})});
    const response=await handleVoice({path:'/api/telegram/link',request,repo,user:state.users.find(user=>user.id===actor),fetcher});
    assert.equal(response.status,200);return response.json();
  };
  const accept=async(code,telegramUserId)=>adapter.consumeLinkCode({codeHash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code)))).map(b=>b.toString(16).padStart(2,'0')).join(''),telegramUserId,chatId:telegramUserId});
  return {repo,adapter,state,codes,links,updates,rpcCalls,fetcher,issue,accept,setIncoming(items){incoming=items;},getPollingCalls:()=>pollingCalls,setLocked(value){locked=value;}};
}

test('31 members receive distinct one-use codes with bigint expiry and connect in one reception without AI',async()=>{
  const f=fixture();
  const issued=await Promise.all(Array.from({length:31},(_,i)=>f.issue(`member-${i}`)));
  assert.equal(new Set(issued.map(row=>row.code)).size,31);
  for(const row of issued){assert.match(row.expiresAt,/^\d{4}-\d\d-\d\dT/);assert(Date.parse(row.expiresAt)>Date.now());}
  for(const call of f.rpcCalls){assert.equal(call.name,'arios_link_code_create');assert(Number.isSafeInteger(call.p.p_expires_at));}
  f.setIncoming(issued.map((row,i)=>({update_id:i+1,message:{from:{id:1000+i,is_bot:false},chat:{id:1000+i,type:'private'},text:'/start '+row.code}})));
  const result=await receiveTelegramUpdates({repo:f.repo,fetcher:f.fetcher});
  assert.equal(result.received,31);assert.equal(result.failed,0);assert.equal(result.processed,0);
  assert.equal(f.links.size,31);assert.equal(f.codes.size,0);assert([...f.updates.values()].every(row=>row.status==='processed'));
  assert.equal(await f.accept(issued[0].code,1000),null);
  assert.equal(f.getPollingCalls(),1);
});

test('code replacement invalidates the older code, expiry and concurrent replay cannot create two links',async()=>{
  const f=fixture(),old=await f.issue('member-0'),fresh=await f.issue('member-0');
  assert.equal(await f.accept(old.code,1000),null);
  const both=await Promise.all([f.accept(fresh.code,1000),f.accept(fresh.code,1001)]);
  assert.equal(both.filter(Boolean).length,1);assert.equal(f.links.size,1);
  const expiring=await f.issue('member-1');for(const row of f.codes.values())if(row.userId==='member-1')row.expiresAt=Date.now()-1;
  assert.equal(await f.accept(expiring.code,1002),null);
});

test('archived users cannot issue, use an issued code or forward updates; workers cannot connect another account',async()=>{
  const f=fixture(),pending=await f.issue('member-0');
  f.state.users.find(user=>user.id==='member-0').deletedAt=new Date().toISOString();
  await assert.rejects(f.issue('member-0'),error=>error.status===403);
  await assert.rejects(f.issue('member-1','member-0'),error=>error.status===403);
  await assert.rejects(f.issue('member-1','worker'),error=>error.status===403);
  assert.equal(await f.accept(pending.code,1000),null);assert.equal(f.links.size,0);
  f.setIncoming([{update_id:1,message:{from:{id:1000},chat:{id:-1000,type:'group'},text:'/start '+pending.code}}]);
  await receiveTelegramUpdates({repo:f.repo,fetcher:f.fetcher});assert.equal(f.links.size,0);
});

test('receive-only scheduler obeys the manual-sync lock and does not poll without a configured bot',async()=>{
  const f=fixture();f.setLocked(true);
  assert.equal((await receiveTelegramUpdates({repo:f.repo,fetcher:f.fetcher})).busy,true);assert.equal(f.getPollingCalls(),0);
  f.setLocked(false);const base=f.repo.getSetting;f.repo.getSetting=async key=>key==='integrations'?{}:base(key);
  assert.equal((await receiveTelegramUpdates({repo:f.repo,fetcher:f.fetcher})).configured,false);assert.equal(f.getPollingCalls(),0);
});

test('permanent foreign-account conflicts are discarded instead of starving later valid members',async()=>{
  const f=fixture(),issued=await f.issue('member-0');
  f.repo.consumeLinkCode=async()=>{const error=new Error('Private conflict details');error.code='DUPLICATE_RECORD';error.status=409;throw error;};
  f.setIncoming([{update_id:1,message:{from:{id:1000},chat:{id:1000,type:'private'},text:'/start '+issued.code}}]);
  const result=await receiveTelegramUpdates({repo:f.repo,fetcher:f.fetcher});
  assert.equal(result.failed,1);assert.equal(f.updates.get(1).status,'ignored');
  f.repo.consumeLinkCode=f.adapter.consumeLinkCode;
  const valid=await f.issue('member-1');
  f.setIncoming([{update_id:2,message:{from:{id:1001},chat:{id:1001,type:'private'},text:'/start '+valid.code}}]);
  assert.equal((await receiveTelegramUpdates({repo:f.repo,fetcher:f.fetcher})).failed,0);
  assert.equal(f.links.get('1001').user_id,'member-1');
});

test('repository rejects ISO and invalid expiry before making a storage RPC',()=>{
  const f=fixture();
  for(const expiresAt of [new Date(Date.now()+600000).toISOString(),NaN,Date.now()-1,Date.now()+1000000])assert.throws(()=>f.adapter.createLinkCode({codeHash:'a'.repeat(64),userId:'worker',expiresAt}),error=>error.code==='INVALID_LINK_EXPIRY');
  assert.equal(f.rpcCalls.length,0);
});
