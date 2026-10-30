import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,publicState} from '../public/domain.mjs';
import {primaryManager,managementRoleDetails,managementRoleSnapshot,applyPrimaryManagerTransfer} from '../public/management-roles.mjs';
import {transferPrimaryManager,authenticate,archiveAccount,resetAccountPassword} from '../supabase/functions/arios-api/auth.mjs';
import {workspaceState} from '../supabase/functions/arios-api/account-state.mjs';
import {createRepository} from '../supabase/functions/arios-api/repository.mjs';
import {renderManagementRoleSettings,wireManagementRoleSettings} from '../public/management-role-settings.mjs';
const owner={id:'manager',role:'manager'};
test('executive title for an additional manager does not change primary ownership',()=>{
  const state=createSeedState();
  state.users.push({id:'executive',name:'مدیرعامل',role:'manager',managementTitle:'مدیرعامل'});
  assert.equal(managementRoleDetails(state,'executive').managementTitle,'مدیرعامل');
  assert.equal(primaryManager(state).id,'manager');
  assert.equal(managementRoleSnapshot(state,'executive').canTransferPrimary,false);
  assert.equal(managementRoleSnapshot(state,'manager').canTransferPrimary,true);
});
const payload=(id='worker',extra={})=>({id,expectedPrimaryManagerId:'manager',expectedVersion:0,requestId:'primary-transfer-request-0001',...extra});
function fixture(initial=createSeedState()){
  let state=structuredClone(initial),revision=7;
  const profiles=new Map(state.users.map(person=>[person.id,{auth_user_id:'auth-'+person.id,domain_user_id:person.id,role:person.role}]));
  const calls=[],settings=new Map(),locks=new Set(),lockCalls=[],identities=new Map([...profiles.values()].map(profile=>[profile.auth_user_id,{id:profile.auth_user_id,email:profile.auth_user_id+'@example.test'}]));
  const commit=input=>{if(input.expectedRevision!==revision)return false;state=structuredClone(input.state);profiles.get(input.targetDomainUserId).role='manager';revision++;return true;};
  const repo={rateLimit:async()=>({allowed:true}),acquireLock:async(name,token,lease)=>{lockCalls.push({name,token,lease});if(locks.has(name))return false;locks.add(name);return true;},releaseLock:async name=>{locks.delete(name);},loadState:async()=>({state:structuredClone(state),revision}),getSetting:async key=>settings.get(key)||null,getProfileByDomainId:async id=>structuredClone(profiles.get(id)||null),getProfile:async id=>structuredClone([...profiles.values()].find(p=>p.auth_user_id===id)||null),listProfileLinks:async()=>[...profiles.values()].map(p=>({domain_user_id:p.domain_user_id,role:p.role})),transferPrimaryManager:async input=>{calls.push(structuredClone(input));return commit(input);}};
  const client={auth:{getUser:async token=>({data:{user:identities.get(token)}}),admin:{getUserById:async id=>({data:{user:identities.get(id)}})}}};
  return{repo,client,calls,profiles,settings,locks,lockCalls,identities,read:()=>structuredClone(state),commit,change:fn=>{fn(state);revision++;}};
}
function unchanged(state,fn,code){const before=structuredClone(state);assert.throws(fn,error=>error.code===code);assert.deepEqual(state,before);}

test('primary designation promotes selected colleague while original account and immutable project history remain technical',()=>{
  const state=createSeedState(),before=structuredClone(state);
  const result=applyPrimaryManagerTransfer(state,'manager',payload());
  assert.equal(result.primaryManagerId,'worker');assert.equal(state.users.find(u=>u.id==='worker').role,'manager');
  assert.deepEqual(managementRoleDetails(state,'manager'),{managementRole:'technical',managementTitle:'مدیر فنی'});
  assert.equal(state.users.find(u=>u.id==='manager').role,'manager');
  for(const key of ['projects','reports','materials','receipts','invoices'])assert.deepEqual(state[key],before[key]);
  assert.equal(managementRoleSnapshot(state,'worker').canTransferPrimary,true);
  assert.equal(managementRoleSnapshot(state,'manager').canTransferPrimary,false);
  assert.equal(state.audit.length,before.audit.length+1);
  const after=structuredClone(state);assert.equal(applyPrimaryManagerTransfer(state,'manager',payload()).replayed,true);assert.deepEqual(state,after);
});

test('only canonical active primary can transfer and version checks prevent stale or forged ownership changes',()=>{
  const state=createSeedState();
  unchanged(state,()=>applyPrimaryManagerTransfer(state,{id:'worker',role:'manager'},payload('worker2')),'FORBIDDEN');
  unchanged(state,()=>applyPrimaryManagerTransfer(state,'manager',payload('manager')),'INVALID_MANAGER_TRANSFER');
  unchanged(state,()=>applyPrimaryManagerTransfer(state,'manager',payload('customer')),'INVALID_PRIMARY_MANAGER');
  unchanged(state,()=>applyPrimaryManagerTransfer(state,'manager',payload('worker',{expectedVersion:1})),'PRIMARY_MANAGER_CHANGED');
  state.users.find(u=>u.id==='worker').deletedAt=new Date().toISOString();
  unchanged(state,()=>applyPrimaryManagerTransfer(state,'manager',payload()),'INVALID_PRIMARY_MANAGER');
  assert.deepEqual(managementRoleDetails(state,{id:'customer',role:'manager'}),{});
  state.primaryManagerVersion=-1;unchanged(state,()=>applyPrimaryManagerTransfer(state,'manager',payload('worker2',{expectedVersion:-1})),'PRIMARY_MANAGER_CHANGED');delete state.primaryManagerVersion;
  state.primaryManagerId='nonexistent';assert.equal(primaryManager(state),null);
  unchanged(state,()=>applyPrimaryManagerTransfer(state,'manager',payload('worker2')),'PRIMARY_MANAGER_REQUIRED');
});

test('a technical manager cannot transfer ownership even though operational manager permissions remain',()=>{
  const state=createSeedState();applyPrimaryManagerTransfer(state,'manager',payload());
  unchanged(state,()=>applyPrimaryManagerTransfer(state,'manager',payload('worker2',{expectedPrimaryManagerId:'worker',expectedVersion:1,requestId:'new-transfer-request-0002'})),'PRIMARY_MANAGER_REQUIRED');
  const next=applyPrimaryManagerTransfer(state,'worker',payload('worker2',{expectedPrimaryManagerId:'worker',expectedVersion:1,requestId:'new-transfer-request-0002'}));
  assert.equal(next.version,2);assert.equal(managementRoleSnapshot(state,'worker2').managementTitle,'مدیر اصلی');
  assert.equal(managementRoleSnapshot(state,'worker').managementTitle,'مدیر فنی');
});

test('real account transfer commits protected profile and state together and both existing sessions resolve current roles',async()=>{
  const f=fixture();const result=await transferPrimaryManager(f.client,f.repo,owner,payload());
  assert.equal(result.state.primaryManagerId,'worker');assert.equal(f.profiles.get('worker').role,'manager');assert.equal(f.profiles.get('manager').role,'manager');assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].actorDomainUserId,'manager');assert.equal(f.calls[0].targetAuthUserId,'auth-worker');
  const promoted=await authenticate(new Request('https://example.test',{headers:{Authorization:'Bearer auth-worker'}}),f.client,f.repo);
  const previous=await authenticate(new Request('https://example.test',{headers:{Authorization:'Bearer auth-manager'}}),f.client,f.repo);
  assert.equal(promoted.user.role,'manager');assert.equal(promoted.user.managementTitle,'مدیر اصلی');assert.equal(previous.user.managementTitle,'مدیر فنی');
  const snapshot=await workspaceState(f.repo,f.read(),'manager');assert.equal(snapshot.managementRoles.canTransferPrimary,false);assert.equal(snapshot.users.find(u=>u.id==='worker').managementTitle,'مدیر اصلی');assert(!JSON.stringify(snapshot).includes('auth-worker'));
});

test('primary transfer requires a matching active login and never creates or promotes missing, banned or blocked identities',async()=>{
  for(const mode of ['missing-profile','mismatch-profile','banned','deleted','blocked']){
    const f=fixture(),before=f.read();
    if(mode==='missing-profile')f.profiles.delete('worker');
    if(mode==='mismatch-profile')f.profiles.get('worker').role='accountant';
    if(mode==='banned')f.identities.get('auth-worker').banned_until=new Date(Date.now()+100000).toISOString();
    if(mode==='deleted')f.identities.get('auth-worker').deleted_at=new Date().toISOString();
    if(mode==='blocked')f.settings.set('auth-security:worker',{blocked:true});
    await assert.rejects(transferPrimaryManager(f.client,f.repo,owner,payload()),error=>error.code==='PRIMARY_MANAGER_LOGIN_REQUIRED');
    assert.equal(f.calls.length,0,mode);assert.deepEqual(f.read(),before,mode);
  }
});

test('state conflicts retry on fresh state without losing concurrent work or issuing a second promotion',async()=>{
  const f=fixture();let attempts=0;
  f.repo.transferPrimaryManager=async input=>{f.calls.push(structuredClone(input));if(++attempts===1){f.change(state=>state.concurrentMarker='preserved');return false;}return f.commit(input);};
  await transferPrimaryManager(f.client,f.repo,owner,payload());assert.equal(f.read().concurrentMarker,'preserved');assert.equal(f.read().primaryManagerVersion,1);assert.equal(attempts,2);
  const g=fixture();g.repo.transferPrimaryManager=async input=>{g.calls.push(input);g.change(state=>applyPrimaryManagerTransfer(state,'manager',payload('worker2',{requestId:'other-request-0002'})));g.profiles.get('worker2').role='manager';return false;};
  await assert.rejects(transferPrimaryManager(g.client,g.repo,owner,payload()),error=>error.code==='PRIMARY_MANAGER_REQUIRED');
  assert.equal(g.calls.length,1);assert.equal(g.read().primaryManagerId,'worker2');assert.equal(g.profiles.get('worker').role,'worker');
});

test('uncertain commit recovery confirms exact request and profile atomically without undoing or duplicating transfer',async()=>{
  const f=fixture();f.repo.transferPrimaryManager=async input=>{f.calls.push(input);f.commit(input);throw Error('lost-response');};
  const result=await transferPrimaryManager(f.client,f.repo,owner,payload());assert.equal(result.result.replayed,true);assert.equal(f.calls.length,1);assert.equal(f.read().primaryManagerVersion,1);
  const auditCount=f.read().audit.length;await transferPrimaryManager(f.client,f.repo,owner,payload());assert.equal(f.calls.length,1);assert.equal(f.read().audit.length,auditCount);
  const g=fixture(),before=g.read();g.repo.transferPrimaryManager=async()=>{throw Error('definite-no-commit');};
  await assert.rejects(transferPrimaryManager(g.client,g.repo,owner,payload()),/definite-no-commit/);assert.deepEqual(g.read(),before);assert.equal(g.profiles.get('worker').role,'worker');
});

test('repository exposes one dedicated atomic primary RPC with server-selected profile identifiers',async()=>{
  const calls=[];const repo=createRepository({from(){throw Error('No table mutation expected');},rpc:async(name,params)=>{calls.push({name,params});return{data:true};}});
  assert.equal(await repo.transferPrimaryManager({expectedRevision:7,state:{marker:'candidate'},actorDomainUserId:'manager',targetDomainUserId:'worker',targetAuthUserId:'auth-worker',expectedPrimaryManagerId:'manager'}),true);
  assert.deepEqual(calls,[{name:'arios_primary_manager_transfer',params:{p_expected_revision:7,p_state:{marker:'candidate'},p_actor_domain_user_id:'manager',p_target_domain_user_id:'worker',p_target_auth_user_id:'auth-worker',p_expected_primary_id:'manager'}}]);
});

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const uiContext=extra=>({e:escape,api:{isStatic:false},...extra});
function uiState(){const state=publicState(createSeedState(),'manager');state.managementRoles={primaryManagerId:'manager',primaryManagerName:state.user.name,version:0,canTransferPrimary:true,managementTitle:'مدیر اصلی'};for(const user of state.users)user.loginEnabled=true;return state;}
test('ownership UI restricts selection to active staff logins and never offers transfer to a technical manager or customer',()=>{
  const state=uiState();state.users.find(u=>u.id==='worker').loginEnabled=false;
  const html=renderManagementRoleSettings(state,uiContext());assert(html.includes('data-primary-manager-transfer'));assert(html.includes('مدیر فنی'));
  state.managementRoles.canTransferPrimary=false;assert(!renderManagementRoleSettings(state,uiContext()).includes('data-primary-manager-transfer'));
  assert.equal(renderManagementRoleSettings({...state,user:{id:'customer',role:'customer'}},uiContext()),'');
});
test('ownership UI requires explicit selection/confirmation and reuses same request identity on an uncertain retry',async t=>{
  const state=uiState();state.users.find(u=>u.id==='worker2').name='<img src=x onerror=alert(1)>';
  const prior=Object.getOwnPropertyDescriptor(globalThis,'document'),events={},mutations=[];let modal;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelectorAll:selector=>selector==='[data-primary-manager-transfer]'?[{addEventListener:(type,callback)=>events[type]=callback}]:[]}});
  t.after(()=>prior?Object.defineProperty(globalThis,'document',prior):delete globalThis.document);
  wireManagementRoleSettings(state,uiContext({modal:value=>modal=value,toast(){},mutate:async(action,data)=>{mutations.push({action,data});if(mutations.length===1)throw Error('uncertain');}}));events.click();
  assert(modal.body.includes('&lt;img'));assert(!modal.body.includes('value="customer"'));
  const unconfirmed=new FormData();unconfirmed.set('id','worker');await assert.rejects(modal.onSubmit(unconfirmed),/تأیید/);assert.equal(mutations.length,0);
  const confirmed=new FormData();confirmed.set('id','worker');confirmed.set('confirmed','on');await assert.rejects(modal.onSubmit(confirmed),/uncertain/);await modal.onSubmit(confirmed);
  assert.equal(mutations[0].action,'account.primary-manager.transfer');assert.equal(mutations[0].data.expectedPrimaryManagerId,'manager');assert.equal(mutations[0].data.expectedVersion,0);assert.equal(mutations[0].data.requestId,mutations[1].data.requestId);
});

test('primary transfer uses the same target security lock and releases it after failures',async()=>{
  const f=fixture(),before=f.read();f.locks.add('account-security:worker');
  await assert.rejects(transferPrimaryManager(f.client,f.repo,owner,payload()),error=>error.code==='REQUEST_IN_PROGRESS');assert.equal(f.calls.length,0);assert.deepEqual(f.read(),before);
  f.locks.clear();f.identities.get('auth-worker').banned_until=new Date(Date.now()+100000).toISOString();
  await assert.rejects(transferPrimaryManager(f.client,f.repo,owner,payload()),error=>error.code==='PRIMARY_MANAGER_LOGIN_REQUIRED');assert.equal(f.locks.size,0);
  assert(f.lockCalls.every(call=>call.name==='account-security:worker'&&call.lease===300000));
});

test('simultaneous archive or password reset cannot block a colleague while ownership is being promoted',async()=>{
  const f=fixture();let releaseIdentity,identityStarted;
  const identityReady=new Promise(resolve=>identityStarted=resolve),identityGate=new Promise(resolve=>releaseIdentity=resolve);
  f.client.auth.admin.getUserById=async id=>{identityStarted();await identityGate;return{data:{user:f.identities.get(id)}};};
  const promotion=transferPrimaryManager(f.client,f.repo,owner,payload());await identityReady;
  try{
    await assert.rejects(archiveAccount(f.client,f.repo,owner,{id:'worker'}),error=>error.code==='REQUEST_IN_PROGRESS');
    await assert.rejects(resetAccountPassword(f.client,f.repo,owner,{id:'worker',password:'123456'}),error=>error.code==='REQUEST_IN_PROGRESS');
    assert.equal(f.settings.size,0,'The competing operation cannot write a temporary/permanent block.');
  }finally{releaseIdentity();}
  await promotion;assert.equal(f.locks.size,0);assert.equal(f.read().primaryManagerId,'worker');
  await assert.rejects(archiveAccount(f.client,f.repo,owner,{id:'worker'}),error=>error.code==='MANAGER_ROLE_PROTECTED');
  await assert.rejects(resetAccountPassword(f.client,f.repo,owner,{id:'worker',password:'123456'}),error=>error.code==='MANAGER_ROLE_PROTECTED');
  assert.equal(f.settings.size,0);assert.equal(f.locks.size,0);
});
