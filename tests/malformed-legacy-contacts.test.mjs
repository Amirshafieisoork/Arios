import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAccount} from '../supabase/functions/arios-api/auth.mjs';
import {createSeedState,applyAction} from '../public/domain.mjs';

function fixture(){
 const state=createSeedState();state.users.splice(1,0,{id:'uncorrected-contact',name:'پروندهٔ بدون ورود',role:'worker',phone:'091234567',username:'!',hourlyRate:0,rateHistory:[]});
 const calls={created:0,committed:0},client={auth:{admin:{createUser:async()=>{calls.created++;return{data:{user:{id:crypto.randomUUID()}}};},deleteUser:async()=>({})}}};
 const repo={rateLimit:async()=>({allowed:true}),loadState:async()=>({state:structuredClone(state),revision:1}),commitAccount:async()=>{calls.committed++;return true;}};
 const payload={name:'همکار تازه',phone:'09358887766',role:'worker',password:'fresh-code'};
 return{state,calls,client,repo,payload,create:override=>createAccount(client,repo,state.users.find(u=>u.id==='manager'),{...payload,...override})};
}
test('creating a valid account skips malformed legacy phone/username fields without modifying the contact',async()=>{
 const f=fixture(),result=await f.create({username:'employee.unique'});assert.equal(f.calls.created,1);assert.equal(f.calls.committed,1);assert.equal(result.result.phone,'+989358887766');assert.equal(f.state.users.find(u=>u.id==='uncorrected-contact').phone,'091234567');
});
test('an archived valid phone duplicate is still protected after an earlier malformed contact',async()=>{
 const f=fixture();f.state.users.push({id:'archived-phone',name:'پروندهٔ قبلی',role:'worker',phone:'+989358887766',deletedAt:'2026-10-20T00:00:00Z'});
 await assert.rejects(f.create(),e=>e.code==='ACCOUNT_ARCHIVED');assert.equal(f.calls.created,0);
});
test('malformed phone does not hide independent archived email or username matches',async()=>{
 for(const kind of ['email','username']){const f=fixture(),contact=f.state.users.find(u=>u.id==='uncorrected-contact');contact.deletedAt='2026-10-20T00:00:00Z';contact.email='legacy@example.test';contact.username='legacy.user';
  await assert.rejects(f.create(kind==='email'?{email:'legacy@example.test'}:{username:'legacy.user'}),e=>e.code==='ACCOUNT_ARCHIVED',kind);assert.equal(f.calls.created,0);
 }
});
test('active email and username duplicate checks remain independent of a malformed phone',async()=>{
 for(const [kind,code]of [['email','DUPLICATE_EMAIL'],['username','DUPLICATE_USERNAME']]){const f=fixture(),contact=f.state.users.find(u=>u.id==='uncorrected-contact');contact.email='legacy@example.test';contact.username='legacy.user';
  await assert.rejects(f.create(kind==='email'?{email:'legacy@example.test'}:{username:'legacy.user'}),e=>e.code===code,kind);assert.equal(f.calls.created,0);
 }
});
test('restore can recover valid and contact-only malformed records without rewriting their historical identity',()=>{
 const f=fixture(),worker=f.state.users.find(u=>u.id==='worker');worker.phone='09358887766';worker.deletedAt='2026-10-20T00:00:00Z';applyAction(f.state,'manager','account.restore',{id:'worker'});assert.equal(f.state.users.find(u=>u.id==='worker').deletedAt,undefined);
 const contact=f.state.users.find(u=>u.id==='uncorrected-contact');contact.deletedAt='2026-10-20T00:00:00Z';applyAction(f.state,'manager','account.restore',{id:contact.id});const restored=f.state.users.find(u=>u.id===contact.id);assert.equal(restored.deletedAt,undefined);assert.equal(restored.phone,'091234567');assert.equal(restored.username,'!');
});
test('restore still blocks genuine active phone and username duplicates and fails atomically',()=>{
 for(const kind of ['phone','username']){const f=fixture(),worker=f.state.users.find(u=>u.id==='worker');worker.phone='09358887766';worker.username='existing.worker';worker.deletedAt='2026-10-20T00:00:00Z';
 f.state.users.push({id:'active-duplicate',name:'حساب فعال',role:'worker',phone:kind==='phone'?'+989358887766':'091234567',username:kind==='username'?'existing.worker':'other.worker'});
 const before=structuredClone(f.state);assert.throws(()=>applyAction(f.state,'manager','account.restore',{id:'worker'}),e=>e.code===(kind==='phone'?'DUPLICATE_PHONE':'DUPLICATE_USERNAME'));assert.deepEqual(f.state,before);
 }
});
test('browser and Edge domain identity handling remains identical',async()=>{
 assert.equal(await readFile(new URL('../public/domain.mjs',import.meta.url),'utf8'),await readFile(new URL('../supabase/functions/arios-api/domain.mjs',import.meta.url),'utf8'));
});
