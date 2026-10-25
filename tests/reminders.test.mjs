import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReminderPlans, tehranReminderWindow, sendTelegramReminder, dispatchNightlyReminders, reminderStatus, handleReminders } from '../supabase/functions/arios-api/reminder-service.mjs';
import { sha256 } from '../supabase/functions/arios-api/auth.mjs';

const AT = Date.parse('2026-10-25T17:30:00Z'); // 21:00 Tehran
const TARGET = '2026-10-26';
const TOKEN = '123456:test_only_telegram_token_1234567890';
const respond = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});
function fixture(size = 35) {
  const users = [{id:'manager',name:'مدیر',role:'manager'}, ...Array.from({length:size},(_,i)=>({id:`w${i}`,name:`همکار ${i}`,role:'worker'}))];
  const state = {users, projects: [{id:'p1',name:'پروژهٔ فردا',status:'active',memberIds:users.filter(u=>u.role==='worker').map(u=>u.id),tasks:users.filter(u=>u.role==='worker').map((u,i)=>({id:`t${i}`,title:`نصب و بررسی ${i}`,description:'هماهنگی با مدیر پروژه',assigneeId:u.id,dueDate:TARGET,status:'open'}))}]};
  const links = users.filter(u=>u.role==='worker').map((u,i)=>({user_id:u.id,chat_id:String(10000+i),telegram_user_id:String(10000+i)}));
  const settings = new Map([['integrations',{telegramBotToken:TOKEN}],['telegram_reminders',{enabled:true}]]), rows = new Map(), calls = [];
  let locked = false;
  const repo = {
    getSetting:async key=>settings.get(key),setSetting:async(key,value)=>settings.set(key,value),
    loadState:async()=>({state:structuredClone(state)}),listTelegramLinks:async()=>structuredClone(links),
    acquireLock:async()=>{if(locked)return false;locked=true;return true;},releaseLock:async()=>{locked=false;},
    enqueueReminders:async(targetDate,entries)=>{for(const e of entries){const key=e.userId+targetDate,current=rows.get(key);if(!current)rows.set(key,{id:crypto.randomUUID(),user_id:e.userId,target_date:targetDate,chat_id:e.chatId,body:e.body,task_count:e.taskCount,status:'pending',attempts:0,next_attempt_at:new Date(AT).toISOString(),updated_at:new Date(AT).toISOString()});else if(['pending','cancelled'].includes(current.status))Object.assign(current,{chat_id:e.chatId,body:e.body,task_count:e.taskCount,status:'pending'});}for(const row of rows.values())if(row.target_date===targetDate&&row.status==='pending'&&!entries.some(e=>e.userId===row.user_id))row.status='cancelled';},
    claimReminder:async({targetDate,claim})=>{const row=[...rows.values()].find(row=>row.target_date===targetDate&&row.status==='pending'&&row.attempts<3&&Date.parse(row.next_attempt_at)<=AT);if(!row)return null;Object.assign(row,{status:'sending',claim,attempts:row.attempts+1});return structuredClone(row);},
    finishReminder:async outcome=>{const row=[...rows.values()].find(row=>row.id===outcome.id&&row.claim===outcome.claim&&row.status==='sending');if(!row)return false;Object.assign(row,{status:outcome.status,error_code:outcome.errorCode||null,message_id:outcome.messageId||null,claim:null,sent_at:outcome.status==='sent'?new Date(AT).toISOString():null,...(outcome.status==='pending'?{next_attempt_at:new Date(AT+outcome.retryAfterMs).toISOString()}: {})});return true;},
    listReminders:async()=>[...rows.values()],
  };
  const fetcher=async(url,options)=>{calls.push({url,options});return respond({ok:true,result:{message_id:calls.length}});};
  const run=(options={})=>dispatchNightlyReminders({repo,config:{telegramBotToken:TOKEN},fetcher,at:AT,clock:()=>AT,pause:async()=>{},...options});
  return {state,links,settings,rows,calls,repo,fetcher,run};
}

test('reminder time uses Tehran day boundary, fixed21window, and correct tomorrow across year change',()=>{
  assert.deepEqual(tehranReminderWindow(Date.parse('2026-10-25T17:29:59Z')), {localDate:'2026-10-25',targetDate:TARGET,hour:20,minute:59,eligible:false});
  assert.equal(tehranReminderWindow(AT).eligible,true);
  assert.equal(tehranReminderWindow(Date.parse('2026-10-25T18:30:00Z')).eligible,false);
  assert.equal(tehranReminderWindow(Date.parse('2026-12-31T17:30:00Z')).targetDate,'2027-01-01');
  assert.equal(tehranReminderWindow(Date.parse('2026-10-25T21:00:00Z')).localDate,'2026-10-26');
});

test('plans contain only active linked assigned workers and open tomorrow tasks, with bounded plaintext and no financial fields',()=>{
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

test('archived worker, removed/completedassignment and changedTelegramlink are rechecked after claim',async()=>{
  for(const change of [f=>{f.state.users[1].deletedAt='now';},f=>{f.state.projects[0].tasks=[];},f=>{f.state.projects[0].tasks[0].status='done';},f=>{f.state.projects[0].memberIds=[];},f=>{f.links[0].chat_id='99999';f.links[0].telegram_user_id='99999';}]){
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

test('only authenticated manager sees safe reminder status, and scheduler requests require a valid dedicated token',async()=>{
  const f=fixture(1);await f.run();f.settings.set('telegram_scheduler_auth_hash',await sha256('a'.repeat(64)));
  const data=await reminderStatus({repo:f.repo,user:{role:'manager'},at:AT});assert.equal(data.linkedCount,1);assert.equal(data.assignedCount,1);assert.equal(data.summary.sent,1);assert.equal(data.schedulerConfigured,true);
  const exposed=JSON.stringify(data);for(const secret of [TOKEN,'chat_id','body','10000'])assert(!exposed.includes(secret));
  for(const role of ['worker','customer','warehouse','accountant',undefined])await assert.rejects(reminderStatus({repo:f.repo,user:{role},at:AT}),e=>e.status===403);
  for(const token of ['', 'b'.repeat(64)]){
    const request=new Request('https://arios.test/api/internal/telegram-tick',{method:'POST',headers:{'Content-Type':'application/json','x-arios-scheduler-token':token},body:'{}'});
    await assert.rejects(handleReminders({repo:f.repo,request,path:'/api/internal/telegram-tick',readJSON:async()=>({}),json:respond,at:AT,clock:()=>AT}),e=>e.status===401&&e.code==='SCHEDULER_UNAUTHORIZED');
  }
});

test('a valid scheduler credential permits the unattended tick but not caller-selected dates or leaked credentials',async()=>{
  const f=fixture(1);f.settings.set('integrations',{});f.settings.set('telegram_scheduler_auth_hash',await sha256('a'.repeat(64)));
  const request=new Request('https://arios.test/api/internal/telegram-tick',{method:'POST',headers:{'Content-Type':'application/json','x-arios-scheduler-token':'a'.repeat(64)},body:'{"targetDate":"2099-01-01"}'});
  const response=await handleReminders({repo:f.repo,request,path:'/api/internal/telegram-tick',readJSON:async r=>r.json(),json:respond,fetcher:async()=>assert.fail('No bot configured'),at:AT,clock:()=>AT,pause:async()=>{}});
  const data=await response.json();assert.equal(data.ok,true);assert.equal(data.targetDate,TARGET);assert.equal(data.skipped,true);assert.equal(f.settings.get('telegram_reminder_last_tick').at,new Date(AT).toISOString());
  assert(!JSON.stringify(data).includes('a'.repeat(64)));
});
