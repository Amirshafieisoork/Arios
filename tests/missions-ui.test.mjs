import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,publicState} from '../public/domain.mjs';
import {tomorrowTehran,assignedMissions,renderMemberMissions,openMissionComposer} from '../public/project-workspace.mjs';
import {telegramMemberChoices,telegramBotStartLink,renderReminderStatus,schedulerHeartbeatHealthy} from '../public/voice.mjs';

const e=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const ctx={e,n:String,date:String};

test('new missions default to tomorrow in Tehran across midnight and calendar year boundaries',()=>{
  assert.equal(tomorrowTehran(new Date('2026-10-24T20:29:59Z')),'2026-10-25');
  assert.equal(tomorrowTehran(new Date('2026-10-24T20:30:00Z')),'2026-10-26');
  assert.equal(tomorrowTehran(new Date('2026-12-31T10:00:00Z')),'2027-01-01');
});

test('mission overview shows workers only their active own assignments and escapes instructions',()=>{
  const state=createSeedState();
  state.projects[0].tasks=[{id:'own',title:'<بازدید>',description:'<script>instruction</script>',assigneeId:'worker',dueDate:'2026-10-26',status:'open'},
    {id:'other',title:'Other worker task',assigneeId:'worker2',dueDate:'2026-10-26',status:'open'},
    {id:'unassigned',title:'Without an owner',assigneeId:null,status:'open'}];
  const worker=publicState(state,'worker');
  assert.deepEqual(assignedMissions(worker).map(task=>task.id),['own']);
  const html=renderMemberMissions(worker,ctx);
  assert(!html.includes('Other worker task'));assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;instruction&lt;/script&gt;'));
  assert(!html.includes('data-mission-create'));assert(!html.includes('data-mission-edit'));
  assert.equal(renderMemberMissions(publicState(state,'customer'),ctx),'');
  const manager=publicState(state,'manager');
  assert.deepEqual(assignedMissions(manager).map(task=>task.id),['own','other']);
  assert(renderMemberMissions(manager,ctx).includes('data-mission-create'));
  state.users.find(user=>user.id==='worker2').deletedAt='2026-10-25T00:00:00Z';
  assert.deepEqual(assignedMissions(publicState(state,'manager')).map(task=>task.id),['own']);
});

test('editing a mission preserves its project id despite the disabled project selector',async t=>{
  const state=publicState(createSeedState(),'manager'),changes=[];
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document');
  const projectSelect={disabled:false,addEventListener(){}};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:()=>({querySelector:()=>projectSelect})}});
  t.after(()=>descriptor?Object.defineProperty(globalThis,'document',descriptor):delete globalThis.document);
  let modal;
  openMissionComposer(state,{...ctx,toast:message=>{throw Error(message);},modal:options=>{modal=options;},mutate:async(action,payload)=>changes.push({action,payload})},{task:{id:'task-1',projectId:'p1',assigneeId:'worker',title:'مأموریت',description:'دستور',dueDate:'2026-10-26',version:4}});
  assert.equal(projectSelect.disabled,true);
  const data=new FormData();data.set('title','مأموریت تازه');data.set('description','فردا بازدید کن');data.set('assigneeId','worker');data.set('dueDate','2026-10-27');
  await modal.onSubmit(data);
  assert.equal(changes[0].action,'task.update');assert.equal(changes[0].payload.projectId,'p1');assert.equal(changes[0].payload.version,4);assert.equal(changes[0].payload.description,'فردا بازدید کن');
});

test('Telegram member picker retains 31 active workers and safe bot links contain only the issued code',()=>{
  const state={user:{id:'manager',role:'manager'},users:[{id:'manager',name:'مدیر',role:'manager'},...Array.from({length:31},(_,index)=>({id:'w'+index,name:'عضو '+index,role:'worker'})),{id:'archived',name:'قدیمی',role:'worker',deletedAt:'2026-10-25'},{id:'customer',role:'customer'}]};
  const rows=telegramMemberChoices(state,[{userId:'w30'}]);
  assert.equal(rows.length,32);assert.equal(rows.filter(row=>row.linked).length,1);assert(rows.find(row=>row.id==='w30')?.linked);
  assert(!rows.some(row=>row.id==='archived'||row.id==='customer'));
  assert.equal(telegramBotStartLink('Arios_bot','abc_123'),'https://t.me/Arios_bot?start=abc_123');
  for(const [name,code] of [['https://evil.example','abc'],['Arios_bot','x?next=evil'],['bot/name','abc'],['Arios_bot','']])assert.equal(telegramBotStartLink(name,code),null);
});

test('reminder status uses server counts and distinguishes missing scheduler from active delivery',()=>{
  const data={enabled:true,configured:true,schedulerConfigured:false,targetDate:'2026-10-26',linkedCount:31,assignedCount:29,summary:{sent:2,failed:1,unknown:1},deliveries:[{name:'<member>',status:'unknown',targetDate:'2026-10-26',taskCount:3,errorCode:'DELIVERY_UNKNOWN'}]};
  const html=renderReminderStatus(data,ctx);
  assert(html.includes('31 عضو متصل'));assert(html.includes('29 عضو با مأموریت'));assert(html.includes('زمان‌بندی سرور هنوز آماده نیست'));assert(html.includes('نتیجهٔ ارسال نامشخص'));assert(html.includes('&lt;member&gt;'));assert(!html.includes('<member>'));
  assert(!html.includes('ارسال پیام آزمایشی'));assert(!html.includes('data-reminder-send'));
  const now=Date.parse('2026-10-25T10:00:00Z');
  const provisioned={...data,schedulerConfigured:true};
  const waiting=renderReminderStatus(provisioned,ctx,{now});
  assert(waiting.includes('منتظر اولین بررسی سرور'));assert(waiting.includes('هنوز دریافت زمان‌بند تأیید نشده'));assert(!waiting.includes('badge green'));
  const fresh={...provisioned,lastTickAt:'2026-10-25T09:59:00Z'};
  const active=renderReminderStatus(fresh,ctx,{now});
  assert(active.includes('badge green'));assert(active.includes('آخرین بررسی سرور'));assert(!active.includes('زمان‌بندی سرور هنوز آماده نیست'));
  assert(schedulerHeartbeatHealthy(fresh,now));
  for(const lastTickAt of ['2026-10-25T09:49:00Z','2026-10-25T10:02:00Z','invalid'])assert(!schedulerHeartbeatHealthy({...fresh,lastTickAt},now));
  const stale=renderReminderStatus({...fresh,lastTickAt:'2026-10-25T09:49:00Z'},ctx,{now});
  assert(stale.includes('نیازمند بررسی زمان‌بند'));assert(!stale.includes('badge green'));
  const disabled=renderReminderStatus({...fresh,enabled:false},ctx,{now});assert(disabled.includes('متوقف'));assert(!disabled.includes('badge green'));
});
