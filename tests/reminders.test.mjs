import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReminderPlans, tehranReminderWindow, sendTelegramReminder, dispatchNightlyReminders, reminderStatus, handleReminders } from '../supabase/functions/arios-api/reminder-service.mjs';
import { createHmac } from 'node:crypto';
import {handleVoice} from '../supabase/functions/arios-api/voice-service.mjs';

const AT = Date.parse('2026-10-25T17:30:00Z'); // 21:00 Tehran
const TARGET = '2026-10-26';
const TOKEN = '123456:test_only_telegram_token_1234567890';
const SIGNING_KEY = 'c'.repeat(64);
function signedHeaders({timestamp = String(Math.floor(AT / 1000)), nonce = crypto.randomUUID().replaceAll('-', ''), key = SIGNING_KEY, path = '/api/internal/telegram-tick'} = {}) {
  const signature = createHmac('sha256', key).update(`POST\n${path}\n${timestamp}\n${nonce}`).digest('hex');
  return {'Content-Type':'application/json', 'x-arios-scheduler-timestamp':timestamp, 'x-arios-scheduler-nonce':nonce, 'x-arios-scheduler-signature':signature};
}
const tickRequest = (headers, body = '{}') => new Request('https://arios.test/api/internal/telegram-tick', {method:'POST', headers, body});
const tick = (f, request) => handleReminders({repo:f.repo, request, path:'/api/internal/telegram-tick', readJSON:async r=>r.json(), json:respond, fetcher:async()=>assert.fail('No bot configured for authentication tests'), at:AT, clock:()=>AT, pause:async()=>{}});
const respond = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});
function fixture(size = 35) {
  const users = [{id:'manager',name:'مدیر',role:'manager'}, ...Array.from({length:size},(_,i)=>({id:`w${i}`,name:`همکار ${i}`,role:'worker'}))];
  const state = {users, projects: [{id:'p1',name:'پروژهٔ فردا',status:'active',memberIds:users.filter(u=>u.role==='worker').map(u=>u.id),tasks:users.filter(u=>u.role==='worker').map((u,i)=>({id:`t${i}`,title:`نصب و بررسی ${i}`,description:'هماهنگی با مدیر پروژه',assigneeId:u.id,dueDate:TARGET,status:'open'}))}]};
  const links = users.filter(u=>u.role==='worker').map((u,i)=>({user_id:u.id,chat_id:String(10000+i),telegram_user_id:String(10000+i)}));
  const settings = new Map([['integrations',{telegramBotToken:TOKEN}],['telegram_reminders',{enabled:true}]]), rows = new Map(), calls = [];
  const locks = new Map();
  const repo = {
    getSetting:async key=>settings.get(key),setSetting:async(key,value)=>settings.set(key,value),
    loadState:async()=>({state:structuredClone(state)}),listTelegramLinks:async()=>structuredClone(links),
    acquireLock:async(name,token)=>{if(locks.has(name))return false;locks.set(name,token);return true;},releaseLock:async(name,token)=>{if(locks.get(name)===token)locks.delete(name);},
    enqueueReminders:async(targetDate,entries)=>{for(const e of entries){const key=e.userId+targetDate,current=rows.get(key);if(!current)rows.set(key,{id:crypto.randomUUID(),user_id:e.userId,target_date:targetDate,chat_id:e.chatId,body:e.body,task_count:e.taskCount,status:'pending',attempts:0,next_attempt_at:new Date(AT).toISOString(),updated_at:new Date(AT).toISOString()});else if(['pending','cancelled'].includes(current.status))Object.assign(current,{chat_id:e.chatId,body:e.body,task_count:e.taskCount,status:'pending'});}for(const row of rows.values())if(row.target_date===targetDate&&row.status==='pending'&&!entries.some(e=>e.userId===row.user_id))row.status='cancelled';},
    claimReminder:async({targetDate,claim})=>{const row=[...rows.values()].find(row=>row.target_date===targetDate&&row.status==='pending'&&row.attempts<3&&Date.parse(row.next_attempt_at)<=AT);if(!row)return null;Object.assign(row,{status:'sending',claim,attempts:row.attempts+1});return structuredClone(row);},
    finishReminder:async outcome=>{const row=[...rows.values()].find(row=>row.id===outcome.id&&row.claim===outcome.claim&&row.status==='sending');if(!row)return false;Object.assign(row,{status:outcome.status,error_code:outcome.errorCode||null,message_id:outcome.messageId||null,claim:null,sent_at:outcome.status==='sent'?new Date(AT).toISOString():null,...(outcome.status==='pending'?{next_attempt_at:new Date(AT+outcome.retryAfterMs).toISOString()}: {})});return true;},
    listReminders:async()=>[...rows.values()],
  };
  const fetcher=async(url,options)=>{calls.push({url,options});return respond({ok:true,result:{message_id:calls.length}});};
  const run=(options={})=>dispatchNightlyReminders({repo,config:{telegramBotToken:TOKEN},fetcher,at:AT,clock:()=>AT,pause:async()=>{},...options});
  return {state,links,settings,rows,calls,locks,repo,fetcher,run};
}

test('reminder time uses Tehran day boundary, fixed21window, and correct tomorrow across year change',()=>{
  assert.deepEqual(tehranReminderWindow(Date.parse('2026-10-25T17:29:59Z')), {localDate:'2026-10-25',targetDate:TARGET,hour:20,minute:59,eligible:false});
  assert.equal(tehranReminderWindow(AT).eligible,true);
  assert.equal(tehranReminderWindow(Date.parse('2026-10-25T18:30:00Z')).eligible,false);
  assert.equal(tehranReminderWindow(Date.parse('2026-12-31T17:30:00Z')).targetDate,'2027-01-01');
  assert.equal(tehranReminderWindow(Date.parse('2026-10-25T21:00:00Z')).localDate,'2026-10-26');
});

test('plans cover linked active staff, omit revoked tasks and keep bounded plaintext without financial fields',()=>{
  const f=fixture(6),project=f.state.projects[0];
  f.state.users[2].deletedAt='2026-10-25';f.state.users[3].role='customer';
  f.links[3].chat_id='-10000';project.memberIds=project.memberIds.filter(id=>id!=='w4');
  project.tasks.find(t=>t.assigneeId==='w5').status='done';
  project.budget=999999999;project.secret='not permitted';
  const plans=buildReminderPlans(f.state,f.links,TARGET);
  assert.deepEqual(plans.map(p=>p.userId),['w0']);assert.match(plans[0].body,/برنامهٔ فردای شما/);
  assert(!plans[0].body.includes('999999999'));assert(!plans[0].body.includes('not permitted'));
  project.tasks=Array.from({length:300},(_,i)=>({id:`many${i}`,title:'A'.repeat(240),description:'B'.repeat(2000),assigneeId:'w0',dueDate:TARGET,status:'open'}));
  const long=buildReminderPlans(f.state,f.links,TARGET)[0];assert(long.body.length<4096);assert.equal(long.taskCount,300);assert.match(long.body,/وظیفهٔ دیگر/);
});

test('35 linked workers receive one message each; repeating and concurrent ticks never duplicate acknowledged reminders',async()=>{
  const f=fixture(35);
  const results=await Promise.all([f.run(),f.run()]);assert(results.some(r=>r.busy));
  assert.equal(f.calls.length,35);assert.equal(f.rows.size,35);assert([...f.rows.values()].every(row=>row.status==='sent'));
  await f.run();assert.equal(f.calls.length,35);
  for(const {url,options} of f.calls){assert.equal(new URL(url).hostname,'api.telegram.org');assert(url.endsWith('/sendMessage'));assert.equal(options.redirect,'manual');const payload=JSON.parse(options.body);assert.equal(payload.parse_mode,undefined);assert(payload.text.length<4096);}
});

test('outside21Tehran, disabled reminders, and an active globalretryhold cannot send or create outbox items',async()=>{
  const f=fixture();assert((await f.run({at:AT-60000,clock:()=>AT-60000})).skipped);assert.equal(f.rows.size,0);
  f.settings.set('telegram_reminders',{enabled:false});assert((await f.run()).skipped);
  f.settings.set('telegram_reminders',{enabled:true});f.settings.set('telegram_reminder_defer_until',new Date(AT+120000).toISOString());assert((await f.run()).deferred);
  assert.equal(f.calls.length,0);assert.equal(f.rows.size,0);
});

test('a hold installed while waiting for the lock and a manager pause afterclaim both stop sends',async()=>{
  const f=fixture(1);
  f.repo.acquireLock=async()=>{f.settings.set('telegram_reminder_defer_until',new Date(AT+120000).toISOString());return true;};
  assert((await f.run()).deferred);assert.equal(f.calls.length,0);assert.equal(f.rows.size,0);
  const paused=fixture(2),claim=paused.repo.claimReminder;
  paused.repo.claimReminder=async args=>{const row=await claim(args);paused.settings.set('telegram_reminders',{enabled:false});return row;};
  assert.equal((await paused.run()).cancelled,1);assert.equal(paused.calls.length,0);
});

test('bounded batches carry remaining recipients into the next tick rather than dropping member31',async()=>{
  const f=fixture(35);
  assert.equal((await f.run({maxRecipients:30})).sent,30);
  assert.equal([...f.rows.values()].filter(row=>row.status==='pending').length,5);
  assert.equal((await f.run({maxRecipients:30})).sent,5);
  assert.equal(f.calls.length,35);
});

test('blocked recipient is isolated, while429defers the batch and leaves other workers pending',async()=>{
  const f=fixture(3);let sent=0;
  const fetcher=async()=>++sent===1?respond({ok:false,error_code:403,description:TOKEN},403):respond({ok:true,result:{message_id:sent}});
  const result=await f.run({fetcher});assert.equal(result.failed,1);assert.equal(result.sent,2);
  assert(!JSON.stringify([...f.rows.values()]).includes(TOKEN));
  const limited=fixture(3);let calls=0;
  const retry=await limited.run({fetcher:async()=>{calls++;return respond({ok:false,error_code:429,parameters:{retry_after:120},description:TOKEN},429);}});
  assert.equal(calls,1);assert.equal(retry.pending,1);assert.equal([...limited.rows.values()].filter(r=>r.attempts===0).length,2);
  assert.equal(Date.parse(limited.settings.get('telegram_reminder_defer_until')),AT+120000);
  await limited.run({fetcher:async()=>{throw Error('should not send duringhold');}});
});

test('uncertain network/send acknowledgement never automatically retries or falsely reports success',async()=>{
  const f=fixture(1);const result=await f.run({fetcher:async()=>{throw new Error(TOKEN);}});assert.equal(result.unknown,1);
  await f.run();assert.equal(f.calls.length,0);assert.equal([...f.rows.values()][0].status,'unknown');
  const unack=fixture(1);unack.repo.finishReminder=async()=>{throw Error('database unavailable');};
  await assert.rejects(unack.run(),/database unavailable/);assert.equal(unack.calls.length,1);assert.equal([...unack.rows.values()][0].status,'sending');
  await unack.run();assert.equal(unack.calls.length,1);
});

test('revoked accounts, tasks, project access or Telegram links cancel claimed reminders without sending empty messages',async()=>{
  for(const change of [f=>{f.state.users[1].deletedAt='now';},f=>{f.links[0].chat_id='99999';f.links[0].telegram_user_id='99999';},f=>{f.state.projects[0].tasks=[];},f=>{f.state.projects[0].tasks[0].status='done';},f=>{f.state.projects[0].memberIds=[];},f=>{f.state.projects[0].archivedAt='now';}]){
    const f=fixture(1),claim=f.repo.claimReminder;
    f.repo.claimReminder=async args=>{const row=await claim(args);if(row)change(f);return row;};
    const result=await f.run();assert.equal(result.cancelled,1);assert.equal(f.calls.length,0);
  }
});

test('Telegram parsing and redirects never expose secrets and distinguish definite rejection from uncertain outcome',async()=>{
  for(const [response,status] of [[respond({ok:false,error_code:401,description:TOKEN},401),'failed'],[new Response('',{status:302,headers:{Location:'https://other.invalid/'+TOKEN}}),'failed'],[respond({ok:false,error_code:500,description:TOKEN},500),'unknown'],[new Response('notjson',{status:200}),'unknown']]){
    const result=await sendTelegramReminder({token:TOKEN,chatId:'10000',body:'task',fetcher:async()=>response});assert.equal(result.status,status);assert(!JSON.stringify(result).includes(TOKEN));
  }
});

test('only authenticated manager sees safe reminder status and never the private signing key',async()=>{
  const f=fixture(1);await f.run();f.settings.set('telegram_scheduler_signing_key',SIGNING_KEY);
  const data=await reminderStatus({repo:f.repo,user:{role:'manager'},at:AT});assert.equal(data.linkedCount,1);assert.equal(data.assignedCount,1);assert.equal(data.summary.sent,1);assert.equal(data.schedulerConfigured,true);
  const exposed=JSON.stringify(data);for(const secret of [TOKEN,SIGNING_KEY,'chat_id','body','10000'])assert(!exposed.includes(secret));
  for(const role of ['worker','customer','warehouse','accountant',undefined])await assert.rejects(reminderStatus({repo:f.repo,user:{role},at:AT}),e=>e.status===403);
  f.settings.set('telegram_scheduler_signing_key','not a signing key');
  assert.equal((await reminderStatus({repo:f.repo,user:{role:'manager'},at:AT})).schedulerConfigured,false);
});

test('scheduler rejects missing, legacy, expired, future and tampered credentials before state or delivery work',async()=>{
  const base=signedHeaders();
  const invalid=[
    {'Content-Type':'application/json'},
    {'Content-Type':'application/json','x-arios-scheduler-token':'a'.repeat(64)},
    {...base,'x-arios-scheduler-signature':'0'.repeat(64)},
    {...base,'x-arios-scheduler-nonce':'e'.repeat(32)},
    {...base,'x-arios-scheduler-timestamp':String(Math.floor(AT/1000)-1)},
    signedHeaders({timestamp:String(Math.floor(AT/1000)-181)}),
    signedHeaders({timestamp:String(Math.floor(AT/1000)+31)}),
    signedHeaders({path:'/api/other-operation'}),
    signedHeaders({nonce:'not-a-valid-nonce'}),
    signedHeaders({key:'d'.repeat(64)}),
  ];
  for(const headers of invalid){
    const f=fixture(1);f.settings.set('telegram_scheduler_signing_key',SIGNING_KEY);
    f.repo.loadState=async()=>assert.fail('Unauthorized scheduler must not read operational state');
    await assert.rejects(tick(f,tickRequest(headers)),e=>e.status===401&&e.code==='SCHEDULER_UNAUTHORIZED');
    assert.equal(f.locks.size,0);assert.equal(f.calls.length,0);assert.equal(f.rows.size,0);
  }
});

test('valid HMAC permits a tick without caller-selected dates or key disclosure and a consumed nonce cannot replay',async()=>{
  const f=fixture(1);f.settings.set('integrations',{});f.settings.set('telegram_scheduler_signing_key',SIGNING_KEY);
  const headers=signedHeaders(),nonce=headers['x-arios-scheduler-nonce'];
  const response=await tick(f,tickRequest(headers,'{"targetDate":"2099-01-01"}'));
  const data=await response.json();assert.equal(data.ok,true);assert.equal(data.targetDate,TARGET);assert.equal(data.skipped,true);assert.equal(f.settings.get('telegram_reminder_last_tick').at,new Date(AT).toISOString());
  assert(f.locks.has('telegram-scheduler-nonce:'+nonce),'Successful request retains its replay marker');
  assert(!JSON.stringify(data).includes(SIGNING_KEY));
  await assert.rejects(tick(f,tickRequest(headers)),e=>e.status===401&&e.code==='SCHEDULER_UNAUTHORIZED');
  const other=await tick(f,tickRequest(signedHeaders()));assert.equal(other.status,200);
});

test('concurrent signed replay can enter the unattended tick only once',async()=>{
  const f=fixture(1);f.settings.set('integrations',{});f.settings.set('telegram_scheduler_signing_key',SIGNING_KEY);
  const headers=signedHeaders();
  const results=await Promise.allSettled([tick(f,tickRequest(headers)),tick(f,tickRequest(headers))]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejected=results.find(result=>result.status==='rejected');assert.equal(rejected.reason.status,401);assert.equal(rejected.reason.code,'SCHEDULER_UNAUTHORIZED');
  assert.equal(f.calls.length,0);assert.equal(f.locks.size,1);
});

test('accepted timestamp boundaries fit inside the unreleased replay-marker lifetime',async()=>{
  for(const seconds of [-180,30]){
    const f=fixture(1);f.settings.set('integrations',{});f.settings.set('telegram_scheduler_signing_key',SIGNING_KEY);
    const leases=[],acquire=f.repo.acquireLock;f.repo.acquireLock=async(...args)=>{leases.push(args);return acquire(...args);};
    const headers=signedHeaders({timestamp:String(Math.floor(AT/1000)+seconds)});
    assert.equal((await tick(f,tickRequest(headers))).status,200);
    const marker=leases.find(args=>args[0].startsWith('telegram-scheduler-nonce:'));assert.equal(marker[2],300000);
    const replay=await tick(f,tickRequest(headers)).then(()=>false,error=>error.code==='SCHEDULER_UNAUTHORIZED');assert.equal(replay,true);
  }
});


test('all staff roles can receive only their own open tomorrow assignments, while unassigned staff and customers get no message',async()=>{
  const f=fixture(1);
  const extras=[{id:'stock',name:'انبار',role:'warehouse'},{id:'finance',name:'مالی',role:'accountant'},{id:'client',name:'مشتری',role:'customer'},{id:'empty',name:'بدون مأموریت',role:'worker'},{id:'old',name:'قدیمی',role:'worker',deletedAt:'now'}];
  f.state.users.push(...extras);
  for(const [i,user]of [f.state.users[0],...extras].entries())f.links.push({user_id:user.id,chat_id:String(20000+i),telegram_user_id:String(20000+i)});
  f.state.projects[0].memberIds.push('stock','finance','client','empty');
  for(const id of ['manager','stock','finance','client'])f.state.projects[0].tasks.push({id:id+'-own',title:'مأموریت شخصی '+id,assigneeId:id,dueDate:TARGET,status:'open'});
  const plans=buildReminderPlans(f.state,f.links,TARGET);assert.deepEqual(plans.map(row=>row.userId),['manager','w0','stock','finance']);
  for(const id of ['manager','stock','finance']){const row=plans.find(row=>row.userId===id);assert.equal(row.taskCount,1);assert(row.body.includes('مأموریت شخصی '+id));assert(!row.body.includes('نصب و بررسی'));assert(row.body.includes('https://arioshub.ir/login/team'));}
  assert.equal((await f.run()).sent,4);await f.run();assert.equal(f.calls.length,4);assert.equal(f.rows.size,4);
  f.state.projects[0].tasks=[];const next=fixture(0);next.state.users=f.state.users;next.state.projects=f.state.projects;next.links.push(...f.links);assert.equal((await next.run()).sent,0);assert.equal(next.rows.size,0);assert.equal(next.calls.length,0);
});

test('coverage exposes missing account links and last acknowledgement without private Telegram identifiers or another member task content',async()=>{
  const f=fixture(3);f.links.splice(1);f.links.push({user_id:'manager',chat_id:'30000',telegram_user_id:'30000'});
  await f.run();
  const data=await reminderStatus({repo:f.repo,user:{role:'manager'},at:AT});
  assert.equal(data.recipientCount,1);assert.equal(data.linkedCount,2);assert.equal(data.assignedCount,3);assert.equal(data.unlinkedAssignedCount,2);assert.equal(data.lastSentAt,new Date(AT).toISOString());
  assert.equal(data.coverage.find(row=>row.userId==='manager').reason,'linked_no_assignment');assert.equal(data.coverage.find(row=>row.userId==='w1').reason,'unlinked_assigned');
  const serialized=JSON.stringify(data);for(const value of ['30000','10000','نصب و بررسی','chat_id','telegram_user_id',TOKEN])assert(!serialized.includes(value));
});


test('staff Telegram linking does not grant voice or AI privileges to warehouse or accountant roles',async()=>{
  for(const role of ['warehouse','accountant']){
    const user={id:role,name:role,role},state={users:[user]},codes=[];
    const repo={rateLimit:async()=>({allowed:true}),getSetting:async()=>({telegramBotToken:TOKEN}),loadState:async()=>({state}),createLinkCode:async code=>codes.push(code)};
    const request=new Request('https://arios.test/api/telegram/link',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const response=await handleVoice({path:'/api/telegram/link',request,repo,user,fetcher:async()=>assert.fail('Link code creation does not send Telegram messages')});
    assert.equal(response.status,200);assert.equal(codes.length,1);assert.equal(codes[0].userId,role);
    await assert.rejects(handleVoice({path:'/api/voice/text',request:new Request('https://arios.test/api/voice/text',{method:'POST',body:'{}'}),repo,user}),error=>error.status===403);
  }
  await assert.rejects(handleVoice({path:'/api/telegram/link',request:new Request('https://arios.test/api/telegram/link',{method:'POST',body:'{}'}),repo:{},user:{id:'client',role:'customer'}}),error=>error.status===403);
});
