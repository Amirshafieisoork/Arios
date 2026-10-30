import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {applyPersonProfile} from '../public/people-profile.mjs';
import {applyAction,createSeedState,publicState} from '../public/domain.mjs';
import {createAccount} from '../supabase/functions/arios-api/auth.mjs';
import {personProfilePayload,renderPersonDetailsFields,renderPeopleWorkspace} from '../public/people-workspace.mjs';
const details={availability:'available',workStart:'09:00',workEnd:'17:00',hourlyRate:75000,effectiveDate:'2026-10-01'};
const ctx={e:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),n:String,date:String,money:String,today:()=> '2026-10-30'};

test('unified account edit commits role, contact, new labels, hours, dated rate and assignment together while retaining approved wages',()=>{
  const state=createSeedState(),person=state.users.find(user=>user.id==='worker');
  const reports=structuredClone(state.reports),previousRates=structuredClone(person.rateHistory);
  const result=applyAction(state,'manager','account.update',{id:person.id,name:'همکار با پرونده کامل',department:'واحد جدید',skill:'تخصص جدید',role:'worker',personDetails:details,projectIds:['p1'],replaceProjectIds:true});
  const updated=state.users.find(user=>user.id===person.id);
  assert.equal(result.name,'همکار با پرونده کامل');assert.equal(updated.workStart,'09:00');assert.equal(updated.workEnd,'17:00');assert.equal(updated.availability,'available');
  assert(updated.rateHistory.some(rate=>rate.effectiveDate==='2026-10-01'&&rate.hourlyRate===75000));assert.equal(updated.department,'واحد جدید');
  for(const entry of previousRates)assert(updated.rateHistory.some(rate=>rate.effectiveDate===entry.effectiveDate&&rate.hourlyRate===entry.hourlyRate));
  assert.deepEqual(state.reports,reports);
  assert.deepEqual(state.projects.filter(project=>project.memberIds.includes(person.id)).map(project=>project.id),['p1']);
});

test('invalid schedule or conflicting historical rate leaves all account information unchanged',()=>{
  for(const personDetails of [{...details,workEnd:'08:00'},{...details,hourlyRate:1.5},{...details,effectiveDate:'2026-02-30'}]){
    const state=createSeedState(),before=structuredClone(state);
    assert.throws(()=>applyAction(state,'manager','account.update',{id:'worker',name:'Must not persist',personDetails}));assert.deepEqual(state,before);
  }
  const person={role:'worker',hourlyRate:200,rateHistory:[{effectiveDate:'2026-10-01',hourlyRate:200}]},before=structuredClone(person);
  assert.throws(()=>applyPersonProfile(person,{personDetails:details}),error=>error.code==='DUPLICATE_RATE_DATE');assert.deepEqual(person,before);
});

test('person details cannot change a customer or promote an account or overwrite approved report values',()=>{
  const state=createSeedState(),before=structuredClone(state);
  assert.throws(()=>applyAction(state,'worker','account.update',{id:'worker',role:'manager',personDetails:details}),error=>error.status===403);
  assert.throws(()=>applyAction(state,'manager','account.update',{id:'customer',personDetails:details}));
  assert.throws(()=>applyAction(state,'manager','account.update',{id:'worker',personDetails:{role:'manager'}}));
  assert.deepEqual(state,before);
});

test('project selections can be removed explicitly and omitted assignments retain existing legacy behavior',()=>{
  const state=createSeedState();
  const original=state.projects.filter(project=>project.memberIds.includes('worker')).length;assert(original>0);
  applyAction(state,'manager','account.update',{id:'worker',name:'همکار'});
  assert.equal(state.projects.filter(project=>project.memberIds.includes('worker')).length,original);
  applyAction(state,'manager','account.update',{id:'worker',projectIds:[],replaceProjectIds:true});
  assert.equal(state.projects.filter(project=>project.memberIds.includes('worker')).length,0);
  const customer=state.users.find(user=>user.id==='customer');
  assert(state.projects.some(project=>project.customerId===customer.id));
  applyAction(state,'manager','account.update',{id:customer.id,projectIds:[],replaceProjectIds:true});
  assert.equal(state.projects.filter(project=>project.customerId===customer.id).length,0);
});

test('create validates every work field before creating an external authentication identity',async()=>{
  const state=createSeedState();let creates=0,committed;
  const repo={rateLimit:async()=>({allowed:true}),loadState:async()=>({state:structuredClone(state),revision:1}),commitAccount:async value=>{committed=value;return true;}};
  const client={auth:{admin:{createUser:async()=>{creates++;return {data:{user:{id:'auth-new'}}};},deleteUser:async()=>({})}}};
  const base={name:'همکار نو',phone:'09351234567',role:'worker',password:'123456',department:'پشتیبانی تازه',skill:'شبکه تازه',personDetails:details,projectIds:[]};
  await assert.rejects(createAccount(client,repo,state.users.find(user=>user.id==='manager'),{...base,personDetails:{...details,workStart:'22:00',workEnd:'08:00'}}));
  assert.equal(creates,0);
  const result=await createAccount(client,repo,state.users.find(user=>user.id==='manager'),base);
  assert.equal(creates,1);const created=committed.state.users.find(user=>user.id===result.result.id);
  assert.equal(created.department,'پشتیبانی تازه');assert.equal(created.skill,'شبکه تازه');assert.equal(created.workEnd,'17:00');assert.equal(created.rateHistory[0].hourlyRate,75000);
});

test('one form collects optional dated rate, inline labels, schedule and explicit project access',()=>{
  const state=publicState(createSeedState(),'manager'),person=state.users.find(user=>user.id==='worker'),html=renderPersonDetailsFields(state,ctx,person);
  for(const name of ['department','skill','availability','workStart','workEnd','hourlyRate','effectiveDate','projectIds'])assert(html.includes(`name="${name}"`));
  assert.match(html,/datalist/);assert.match(html,/نرخ و دستمزد گزارش‌های قبلی حفظ می‌شود/);
  const data=new FormData();for(const[key,value]of Object.entries({personProfileForm:'1',role:'worker',department:'فنی تازه',skill:'نصب',availability:'leave',workStart:'',workEnd:'',hourlyRate:'',effectiveDate:'2026-10-30'}))data.set(key,value);
  data.append('projectIds','p1');const payload=personProfilePayload(data);
  assert.deepEqual(payload,{department:'فنی تازه',skill:'نصب',personDetails:{availability:'leave',workStart:'',workEnd:''},projectIds:['p1'],replaceProjectIds:true});
  data.set('hourlyRate','0');assert.equal(personProfilePayload(data).personDetails.hourlyRate,0);
  data.set('role','customer');assert.equal(personProfilePayload(data).personDetails,undefined);
});

test('directory displays unambiguous unified actions and encodes person links and user content',()=>{
  const state=publicState(createSeedState(),'manager');state.users.find(user=>user.id==='worker').name='<script>test</script>';
  const html=renderPeopleWorkspace(state,ctx,{supabaseAuth:true,accountActions:()=>'<button>ویرایش پرونده</button>'});
  assert.match(html,/data-people-search/);assert.match(html,/data-people-status/);assert.match(html,/#finance\/person\/worker/);assert.match(html,/&lt;script&gt;/);assert(!html.includes('<script>test'));
});

test('shared people validation uses identical source for browser and edge',async()=>{
  assert.equal(await readFile(new URL('../public/people-profile.mjs',import.meta.url),'utf8'),await readFile(new URL('../supabase/functions/arios-api/people-profile.mjs',import.meta.url),'utf8'));
});
